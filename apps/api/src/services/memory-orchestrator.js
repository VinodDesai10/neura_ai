/**
 * services/memory-orchestrator.js
 *
 * Central coordinator for every chat turn:
 *   1. Acquires a session lock to prevent concurrent processing
 *   2. Stores the raw user event and queues a memory job
 *   3. Retrieves the working set via hybrid scoring (vector + lexical + importance + recency)
 *   4. Builds the context prompt and calls the LLM
 *   5. Stores the assistant reply and queues its memory job
 *   6. After every N assistant turns, enqueues a session-summarisation job
 *
 * Changes from original:
 *   - mergeAndRankMemories() replaced by deduplicateAndRerank() from retrieval-scorer
 *   - userId threaded through namespace to all store calls
 *   - shouldSummarise() trigger wired into handleChatTurn
 *   - Small-talk detection centralised via @neura/shared isSmallTalk
 *   - Bug fix: factualMemoryStore and vectorMemoryStore now imported (were missing → ReferenceError in getDebugState)
 *   - Bug fix: consolidationStore now imported from ../infrastructure/consolidation-store.js
 *              (Postgres-backed) instead of the @neura/core in-memory singleton
 */

import {
  buildContextPrompt,
  buildContextPromptParts,
  computeMemoryFingerprint,
  extractMemoryCandidates,
  enrichWithConsolidations
} from "@neura/core";
import { isSmallTalk } from "@neura/shared";
import { rawEventVault }       from "../infrastructure/raw-event-vault.js";
import { workingMemoryStore }  from "../infrastructure/working-memory-store.js";
import { redisRuntimeStore }   from "../infrastructure/redis-runtime-store.js";
// Bug fix: use the Postgres-backed consolidation store (not the @neura/core in-memory singleton)
import { consolidationStore }  from "../infrastructure/consolidation-store.js";
// Bug fix: import stores needed by getDebugState() — were missing, causing ReferenceError at runtime
import { factualMemoryStore }  from "../infrastructure/factual-memory-store.js";
import { vectorMemoryStore }   from "../infrastructure/vector-memory-store.js";
import { openAIAdapter }       from "./openai-adapter.js";
import { buildContextWindow }  from "./context-window.js";
import { deduplicateAndRerank } from "./retrieval-scorer.js";
import { hybridRetrieval } from "./hybrid-retrieval.js";
import { shouldSummarise }      from "./summary-memory.js";
import { attachJobMetadata }    from "../queue/job-metadata.js";
import {
  retrievalRequestsTotal,
  retrievalResultsCount,
  retrievalDurationSeconds
} from "../lib/metrics.js";

// ─── Session state inference ──────────────────────────────────────────────────

function inferSessionState(message) {
  const lower    = message.toLowerCase();
  const keywords = message
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 3)
    .slice(0, 6);

  let mode = "conversation";
  if (lower.includes("implement") || lower.includes("code") || lower.includes("fix")) {
    mode = "implementation";
  } else if (lower.includes("architecture") || lower.includes("design")) {
    mode = "architecture";
  } else if (lower.includes("how") || lower.includes("why") || lower.includes("what")) {
    mode = "explanation";
  }

  return {
    currentTopic:    keywords.join(" ") || "general",
    lastUserIntent:  message.slice(0, 180),
    mode,
    lastActivityAt:  new Date().toISOString()
  };
}

// ─── Seed memory extraction ───────────────────────────────────────────────────

function buildSeedMemoriesFromEvent(event) {
  return extractMemoryCandidates(event).map((candidate) => ({
    ...candidate,
    id:            crypto.randomUUID(),
    sessionId:     event.sessionId,
    userId:        event.userId || null,
    sourceEventId: event.id,
    fingerprint:   computeMemoryFingerprint(candidate.content),
    embedding:     null
  }));
}

// ─── Working-set retrieval ────────────────────────────────────────────────────

async function retrieveWorkingSet({ sessionId, userId, message, seedMemories = [] }) {
  const smallTalk = isSmallTalk(message);

  // Filter seed memories to those with any lexical overlap with the message
  const relevantSeedMemories = smallTalk ? [] : seedMemories.filter((seed) => {
    const terms  = message.toLowerCase().split(/\s+/).filter((t) => t.length > 3);
    const text   = (seed.summary || seed.content || "").toLowerCase();
    return terms.some((t) => text.includes(t));
  });

  const recentTurns           = await redisRuntimeStore.getRecentTurns(sessionId);
  const previousWorkingMemory = await workingMemoryStore.read(sessionId);

  // ── Retrieval cache hit ──────────────────────────────────────────────────
  const cachedRetrieval = await redisRuntimeStore.getCachedRetrieval({ sessionId, message });

  if (!smallTalk && cachedRetrieval?.activeMemories) {
    const retrievalStart = process.hrtime.bigint();
    const reranked = deduplicateAndRerank(
      [...relevantSeedMemories, ...cachedRetrieval.activeMemories],
      { querySessionId: sessionId }
    );
    // ── Consolidation enrichment (cache-hit path) ────────────────────────
    // Inject consolidated memories for the user after the first ranked result.
    // Fails silently — enrichWithConsolidations catches all store errors
    // internally and returns the original ranked list unchanged.
    const activeMemories = await enrichWithConsolidations(
      reranked,
      consolidationStore,
      { userId, topK: 3 }
    );
    const retrievalDurationSec = Number(process.hrtime.bigint() - retrievalStart) / 1e9;

    try {
      retrievalRequestsTotal.inc({ cache_hit: "true" });
      retrievalResultsCount.observe({ cache_hit: "true" }, activeMemories.length);
      retrievalDurationSeconds.observe({ cache_hit: "true" }, retrievalDurationSec);
    } catch {
      // Instrumentation must never break retrieval
    }

    await redisRuntimeStore.markMemoryHits(activeMemories);
    await workingMemoryStore.write(sessionId, {
      activeMemories,
      recentContext: recentTurns,
      retrievalCache: { hit: true, createdAt: cachedRetrieval.createdAt }
    });
    return workingMemoryStore.read(sessionId);
  }

  // ── Full retrieval ───────────────────────────────────────────────────────
  // H-1 fix: hybridRetrieval.getRelevantMemories() is the single retrieval
  // path.  It fans out to Postgres (keyword) and Qdrant (vector) internally,
  // handles embedding, and enriches with Neo4j graph scores — so Postgres and
  // Qdrant are each queried exactly once per turn.  The previous direct calls
  // to factualMemoryStore.findRelevant() and vectorMemoryStore.findRelevant()
  // (and the standalone openAIAdapter.embedText()) have been removed to
  // eliminate the duplicate queries.
  const retrievalStart = process.hrtime.bigint();

  const [rawRecentContext, hybridMemories] = await Promise.all([
    rawEventVault.findRecentBySession(sessionId),
    // Hybrid retrieval — queries Postgres + Qdrant + Neo4j once.
    // Failures are silenced internally; an empty array is returned
    // when all backends are unavailable so the turn proceeds normally.
    hybridRetrieval.getRelevantMemories(message, userId, sessionId).catch(() => [])
  ]);

  const recentContext    = recentTurns.length ? recentTurns : rawRecentContext;
  const previousMemories = previousWorkingMemory?.activeMemories || [];

  // Normalise hybrid memories: translate the _hybrid envelope into the
  // _retrieval shape expected by deduplicateAndRerank().
  const normaliseHybrid = (m) => {
    if (!m._hybrid || m._retrieval) return m;
    return {
      ...m,
      _retrieval: {
        vectorScore:     m._hybrid.vectorScore    ?? 0,
        lexicalScore:    (m._hybrid.keywordScore  ?? 0) * 5,  // undo normalisation
        importanceScore: m._hybrid.importanceScore ?? 0,
        recencyScore:    m._hybrid.recencyScore    ?? 0,
        score:           m._hybrid.finalScore      ?? 0,
        source:          (m._hybrid.sources || ["hybrid"]).join("+")
      }
    };
  };

  // hybridMemories already contains everything from both stores (Postgres
  // keyword results + Qdrant vector results + graph neighbours).  The separate
  // recentFacts / similarMemories arrays are no longer fetched individually.
  const allCandidates = [
    ...relevantSeedMemories,
    ...previousMemories,
    ...hybridMemories.map(normaliseHybrid)
  ];

  const scoredEntries = allCandidates
    .filter((m) => m._retrieval)
    .map((m) => ({
      memory:      m,
      vectorScore: m._retrieval.vectorScore  || 0,
      lexicalScore: m._retrieval.lexicalScore || 0
    }));

  const workingSet = deduplicateAndRerank(
    allCandidates,
    { querySessionId: sessionId, scoredEntries }
  );

  const finalActiveMemories = smallTalk ? [] : workingSet;
  const finalRecentContext  = smallTalk ? [] : recentContext;

  // ── Consolidation enrichment (full retrieval path) ───────────────────────
  // Inject consolidated memories for the user into the ranked working set.
  // Only runs when there are active memories and a userId is present.
  // Fails silently — enrichWithConsolidations catches all store errors
  // internally and returns the original list unchanged.
  const enrichedActiveMemories = await enrichWithConsolidations(
    finalActiveMemories,
    consolidationStore,
    { userId, topK: 3 }
  );

  const retrievalDurationSec = Number(process.hrtime.bigint() - retrievalStart) / 1e9;

  try {
    retrievalRequestsTotal.inc({ cache_hit: "false" });
    retrievalResultsCount.observe({ cache_hit: "false" }, enrichedActiveMemories.length);
    retrievalDurationSeconds.observe({ cache_hit: "false" }, retrievalDurationSec);
  } catch {
    // Instrumentation must never break retrieval
  }

  await redisRuntimeStore.setCachedRetrieval({
    sessionId,
    message,
    activeMemories: enrichedActiveMemories
  });
  await redisRuntimeStore.markMemoryHits(enrichedActiveMemories);
  await workingMemoryStore.write(sessionId, {
    activeMemories:  enrichedActiveMemories,
    recentContext:   finalRecentContext,
    retrievalCache:  { hit: false, carriedForward: previousMemories.length }
  });

  return workingMemoryStore.read(sessionId);
}

async function withSessionLock(sessionId, operation) {
  const lockToken = await redisRuntimeStore.acquireSessionLock(sessionId);

  if (!lockToken) {
    const error = new Error("Session is already processing a memory operation");
    error.statusCode = 409;
    throw error;
  }

  try {
    return await operation();
  } finally {
    await redisRuntimeStore.releaseSessionLock(sessionId, lockToken);
  }
}

async function appendEventAndQueue({ sessionId, userId, role, content }) {
  const event = await rawEventVault.append({
    sessionId,
    userId: userId || null,
    role,
    content
  });

  await redisRuntimeStore.appendRecentTurn(sessionId, {
    id: event.id,
    role: event.role,
    content: event.content,
    createdAt: event.createdAt
  });

  await redisRuntimeStore.enqueueMemoryJob(attachJobMetadata({
    type: "process-event-into-memories",
    sessionId,
    userId: userId || null,
    eventId: event.id,
    role: event.role,
    event
  }));

  return event;
}

async function syncWorkingMemoryRecentContext(sessionId) {
  const currentWorkingMemory = await workingMemoryStore.read(sessionId);
  const recentContext = await redisRuntimeStore.getRecentTurns(sessionId);

  return workingMemoryStore.write(sessionId, {
    ...currentWorkingMemory,
    activeMemories: currentWorkingMemory.activeMemories || [],
    recentContext
  });
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export const memoryOrchestrator = {
  /**
   * Retrieve the context that ChatGPT should use before answering.
   *
   * This deliberately does not append a user event or call the LLM. The
   * ChatGPT MCP connector uses it as the read phase of a memory turn.
   */
  async prepareMemoryContext({ sessionId, userId, message }) {
    return withSessionLock(sessionId, async () => {
      await redisRuntimeStore.setSessionState(sessionId, inferSessionState(message));

      const workingMemory = await retrieveWorkingSet({
        sessionId,
        userId,
        message,
        seedMemories: []
      });

      return {
        sessionId,
        workingMemory,
        sessionState: await redisRuntimeStore.getSessionState(sessionId)
      };
    });
  },

  /**
   * Persist a complete ChatGPT turn without generating a reply.
   *
   * ChatGPT supplies the assistant text after it has used the context from
   * prepareMemoryContext(). Both sides are written to the same raw event
   * vault, recent-turn store, and background memory queue as the native chat
   * path.
   */
  async recordMemoryTurn({ sessionId, userId, userMessage, assistantMessage }) {
    return withSessionLock(sessionId, async () => {
      await redisRuntimeStore.setSessionState(
        sessionId,
        inferSessionState(userMessage)
      );

      const userEvent = await appendEventAndQueue({
        sessionId,
        userId,
        role: "user",
        content: userMessage
      });

      const assistantEvent = await appendEventAndQueue({
        sessionId,
        userId,
        role: "assistant",
        content: assistantMessage
      });

      const previousSessionState =
        await redisRuntimeStore.getSessionState(sessionId) || {};
      const assistantTurnCount =
        (Number(previousSessionState.assistantTurnCount) || 0) + 1;

      await redisRuntimeStore.setSessionState(sessionId, {
        assistantTurnCount
      });

      let memoryJobsQueued = 2;

      if (shouldSummarise(assistantTurnCount)) {
        const recentTurns = await redisRuntimeStore.getRecentTurns(sessionId);
        await redisRuntimeStore.enqueueMemoryJob(attachJobMetadata({
          type: "summarise-session",
          sessionId,
          userId: userId || null,
          recentTurns
        }));
        memoryJobsQueued += 1;
      }

      return {
        sessionId,
        userEventId: userEvent.id,
        assistantEventId: assistantEvent.id,
        memoryJobsQueued,
        workingMemory: await syncWorkingMemoryRecentContext(sessionId),
        sessionState: await redisRuntimeStore.getSessionState(sessionId)
      };
    });
  },

  async handleChatTurn({ sessionId, userId, message }) {
    const lockToken = await redisRuntimeStore.acquireSessionLock(sessionId);

    if (!lockToken) {
      const error = new Error("Session is already processing a chat turn");
      error.statusCode = 409;
      throw error;
    }

    try {
      await redisRuntimeStore.setSessionState(sessionId, inferSessionState(message));

      // ── Store user event ────────────────────────────────────────────────
      const userEvent = await rawEventVault.append({
        sessionId,
        userId: userId || null,
        role:    "user",
        content: message
      });
      const smallTalkTurn    = isSmallTalk(message);
      const seedMemories     = smallTalkTurn ? [] : buildSeedMemoriesFromEvent({ ...userEvent, userId });

      await redisRuntimeStore.appendRecentTurn(sessionId, {
        id:        userEvent.id,
        role:      "user",
        content:   message,
        createdAt: userEvent.createdAt
      });
      await redisRuntimeStore.enqueueMemoryJob(attachJobMetadata({
        type:      "process-event-into-memories",
        sessionId,
        userId:    userId || null,
        eventId:   userEvent.id,
        role:      userEvent.role,
        event:     userEvent
      }));

      // ── Retrieve working set ────────────────────────────────────────────
      const workingMemory = await retrieveWorkingSet({
        sessionId,
        userId,
        message,
        seedMemories
      });

      // ── Generate response ───────────────────────────────────────────────
      const promptParts = buildContextPromptParts({
        userMessage:    message,
        activeMemories: workingMemory.activeMemories,
        recentContext:  workingMemory.recentContext
      });
      const prompt = buildContextPrompt({
        userMessage:    message,
        activeMemories: workingMemory.activeMemories,
        recentContext:  workingMemory.recentContext
      });
      const generation = await openAIAdapter.generateResponseWithUsage(prompt);
      const reply = generation.text;
      const contextWindow = buildContextWindow({
        promptParts,
        activeMemories: workingMemory.activeMemories,
        recentContext:  workingMemory.recentContext,
        generation
      });

      // ── Store assistant event ───────────────────────────────────────────
      const assistantEvent = await rawEventVault.append({
        sessionId,
        userId: userId || null,
        role:    "assistant",
        content: reply
      });
      await redisRuntimeStore.appendRecentTurn(sessionId, {
        id:        assistantEvent.id,
        role:      "assistant",
        content:   reply,
        createdAt: assistantEvent.createdAt
      });
      await redisRuntimeStore.enqueueMemoryJob(attachJobMetadata({
        type:      "process-event-into-memories",
        sessionId,
        userId:    userId || null,
        eventId:   assistantEvent.id,
        role:      assistantEvent.role,
        event:     assistantEvent
      }));

      // ── Summarisation trigger ───────────────────────────────────────────
      // Increment per-session assistant turn counter and check threshold
      const sessionState = await redisRuntimeStore.getSessionState(sessionId) || {};
      const assistantTurns = (Number(sessionState.assistantTurnCount) || 0) + 1;
      await redisRuntimeStore.setSessionState(sessionId, { assistantTurnCount: assistantTurns });

      if (shouldSummarise(assistantTurns)) {
        const recentTurns = await redisRuntimeStore.getRecentTurns(sessionId);
        await redisRuntimeStore.enqueueMemoryJob(attachJobMetadata({
          type:        "summarise-session",
          sessionId,
          userId:      userId || null,
          recentTurns
        }));
      }

      return {
        sessionId,
        reply,
        workingMemory,
        contextWindow,
        sessionState: await redisRuntimeStore.getSessionState(sessionId)
      };
    } finally {
      await redisRuntimeStore.releaseSessionLock(sessionId, lockToken);
    }
  },

  async getDebugState(sessionId) {
    return {
      rawEvents:      await rawEventVault.all(),
      factualMemories: await factualMemoryStore.all(),
      vectorMemories:  await vectorMemoryStore.all(sessionId),
      workingMemory:   await workingMemoryStore.all(),
      recentTurns:     await redisRuntimeStore.getRecentTurns(sessionId),
      sessionState:    await redisRuntimeStore.getSessionState(sessionId),
      memoryQueue:     await redisRuntimeStore.getMemoryQueueSnapshot()
    };
  },

  async getRedisContext(sessionId) {
    const allWorkingMemory = await workingMemoryStore.all();
    return {
      sessionId,
      workingMemory:  allWorkingMemory[sessionId] || (await workingMemoryStore.read(sessionId)),
      recentTurns:    await redisRuntimeStore.getRecentTurns(sessionId),
      sessionState:   await redisRuntimeStore.getSessionState(sessionId),
      memoryQueue:    await redisRuntimeStore.getMemoryQueueSnapshot(),
      updatedAt:      new Date().toISOString()
    };
  }
};
