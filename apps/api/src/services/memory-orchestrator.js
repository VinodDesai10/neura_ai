import {
  buildContextPrompt,
  computeMemoryFingerprint,
  extractMemoryCandidates
} from "@neura/core";
import { rawEventVault } from "../infrastructure/raw-event-vault.js";
import { factualMemoryStore } from "../infrastructure/factual-memory-store.js";
import { vectorMemoryStore } from "../infrastructure/vector-memory-store.js";
import { workingMemoryStore } from "../infrastructure/working-memory-store.js";
import { redisRuntimeStore } from "../infrastructure/redis-runtime-store.js";
import { openAIAdapter } from "./openai-adapter.js";

function mergeAndRankMemories(memories) {
  const unique = new Map();

  for (const memory of memories) {
    const key = memory.fingerprint || memory.id;
    const existing = unique.get(key);

    if (!existing || existing.metadata.importance < memory.metadata.importance) {
      unique.set(key, memory);
    }
  }

  return Array.from(unique.values())
    .sort((a, b) => b.metadata.importance - a.metadata.importance)
    .slice(0, 20);
}

function inferSessionState(message) {
  const lower = message.toLowerCase();
  const keywords = message
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((term) => term.length > 3)
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
    currentTopic: keywords.join(" ") || "general",
    lastUserIntent: message.slice(0, 180),
    mode,
    lastActivityAt: new Date().toISOString()
  };
}

function buildSeedMemoriesFromEvent(event) {
  return extractMemoryCandidates(event).map((candidate) => ({
    ...candidate,
    id: crypto.randomUUID(),
    sessionId: event.sessionId,
    sourceEventId: event.id,
    fingerprint: computeMemoryFingerprint(candidate.content),
    embedding: null
  }));
}

async function retrieveWorkingSet({ sessionId, message, seedMemories = [] }) {
  const trimmedMsg = message.trim().toLowerCase().replace(/[^a-z0-9\s]/g, "");
  const isSmallTalk = trimmedMsg.split(/\s+/).length <= 2 &&
    ["hi","hello","hey","ok","okay","thanks","bye","yes","no","sure","great","cool","good","nice"].some(w => trimmedMsg.includes(w));

  const relevantSeedMemories = isSmallTalk ? [] : seedMemories.filter(seed => {
    const { scoreQueryOverlap: _score } = { scoreQueryOverlap: (q, c) => {
      const qt = q.toLowerCase().split(/\s+/).filter(t => t.length > 3);
      const ct = new Set(c.toLowerCase().split(/\s+/));
      return qt.reduce((s, t) => s + (ct.has(t) ? 1 : 0), 0);
    }};
    return _score(message, seed.summary || seed.content || "") > 0;
  });

  const cachedRetrieval = await redisRuntimeStore.getCachedRetrieval({
    sessionId,
    message
  });
  const recentTurns = await redisRuntimeStore.getRecentTurns(sessionId);
  const previousWorkingMemory = await workingMemoryStore.read(sessionId);

  if (!isSmallTalk && cachedRetrieval?.activeMemories) {
    const activeMemories = mergeAndRankMemories([
      ...relevantSeedMemories,
      ...cachedRetrieval.activeMemories
    ]);
    await redisRuntimeStore.markMemoryHits(activeMemories);
    await workingMemoryStore.write(sessionId, {
      activeMemories,
      recentContext: recentTurns,
      retrievalCache: {
        hit: true,
        createdAt: cachedRetrieval.createdAt
      }
    });

    return workingMemoryStore.read(sessionId);
  }

  const queryEmbedding = await openAIAdapter.embedText(message);
  const [recentFacts, similarMemories, rawRecentContext] = await Promise.all([
    factualMemoryStore.findRelevant(message, sessionId),
    vectorMemoryStore.findRelevant({ query: message, queryEmbedding, sessionId }),
    rawEventVault.findRecentBySession(sessionId)
  ]);
  const recentContext = recentTurns.length ? recentTurns : rawRecentContext;

  // Carry forward memories already in Redis working memory from the previous turn.
  // This means memories surfaced by turn N are still available on turn N+1 without
  // needing another round-trip to Qdrant/Postgres for the same knowledge.
  const previousMemories = previousWorkingMemory?.activeMemories || [];

  const workingSet = mergeAndRankMemories([
    ...relevantSeedMemories,
    ...previousMemories,
    ...recentFacts,
    ...similarMemories
  ]);

  const finalActiveMemories = isSmallTalk ? [] : (workingSet.length > 0 ? workingSet : []);
  const finalRecentContext = isSmallTalk ? [] : recentContext;

  await redisRuntimeStore.setCachedRetrieval({
    sessionId,
    message,
    activeMemories: finalActiveMemories
  });
  await redisRuntimeStore.markMemoryHits(finalActiveMemories);

  await workingMemoryStore.write(sessionId, {
    activeMemories: finalActiveMemories,
    recentContext: finalRecentContext,
    retrievalCache: {
      hit: false,
      carriedForward: previousMemories.length
    }
  });

  return workingMemoryStore.read(sessionId);
}

export const memoryOrchestrator = {
  async handleChatTurn({ sessionId, message }) {
    const lockToken = await redisRuntimeStore.acquireSessionLock(sessionId);

    if (!lockToken) {
      const error = new Error("Session is already processing a chat turn");
      error.statusCode = 409;
      throw error;
    }

    try {
      await redisRuntimeStore.setSessionState(sessionId, inferSessionState(message));
      const userEvent = await rawEventVault.append({
        sessionId,
        role: "user",
        content: message
      });
      const seedMemories = buildSeedMemoriesFromEvent(userEvent);
      const trimmedForSeed = message.trim().toLowerCase().replace(/[^a-z0-9\s]/g, "");
      const isSmallTalkTurn = trimmedForSeed.split(/\s+/).length <= 2 &&
        ["hi","hello","hey","ok","okay","thanks","bye","yes","no","sure","great","cool","good","nice","how are you"].some(w => trimmedForSeed.includes(w));
      const filteredSeedMemories = isSmallTalkTurn ? [] : seedMemories;

      await redisRuntimeStore.appendRecentTurn(sessionId, {
        id: userEvent.id,
        role: "user",
        content: message,
        createdAt: userEvent.createdAt
      });
      await redisRuntimeStore.enqueueMemoryJob({
        type: "process-event-into-memories",
        sessionId,
        eventId: userEvent.id,
        role: userEvent.role,
        event: userEvent
      });

      const workingMemory = await retrieveWorkingSet({
        sessionId,
        message,
        seedMemories: filteredSeedMemories
      });
      const prompt = buildContextPrompt({
        userMessage: message,
        activeMemories: workingMemory.activeMemories,
        recentContext: workingMemory.recentContext
      });

      const reply = await openAIAdapter.generateResponse(prompt);
      const assistantEvent = await rawEventVault.append({
        sessionId,
        role: "assistant",
        content: reply
      });
      await redisRuntimeStore.appendRecentTurn(sessionId, {
        id: assistantEvent.id,
        role: "assistant",
        content: reply,
        createdAt: assistantEvent.createdAt
      });
      await redisRuntimeStore.enqueueMemoryJob({
        type: "process-event-into-memories",
        sessionId,
        eventId: assistantEvent.id,
        role: assistantEvent.role,
        event: assistantEvent
      });

      return {
        sessionId,
        reply,
        workingMemory,
        sessionState: await redisRuntimeStore.getSessionState(sessionId)
      };
    } finally {
      await redisRuntimeStore.releaseSessionLock(sessionId, lockToken);
    }
  },

  async getDebugState(sessionId) {
    return {
      rawEvents: await rawEventVault.all(),
      factualMemories: await factualMemoryStore.all(),
      vectorMemories: await vectorMemoryStore.all(sessionId),
      workingMemory: await workingMemoryStore.all(),
      recentTurns: await redisRuntimeStore.getRecentTurns(sessionId),
      sessionState: await redisRuntimeStore.getSessionState(sessionId),
      memoryQueue: await redisRuntimeStore.getMemoryQueueSnapshot()
    };
  },

  async getRedisContext(sessionId) {
    const allWorkingMemory = await workingMemoryStore.all();

    return {
      sessionId,
      workingMemory: allWorkingMemory[sessionId] || (await workingMemoryStore.read(sessionId)),
      recentTurns: await redisRuntimeStore.getRecentTurns(sessionId),
      sessionState: await redisRuntimeStore.getSessionState(sessionId),
      memoryQueue: await redisRuntimeStore.getMemoryQueueSnapshot(),
      updatedAt: new Date().toISOString()
    };
  }
};
