/**
 * services/memory-processor.js
 *
 * Processes memory jobs dequeued from the Redis job queue by the memory worker.
 *
 * Supported job types:
 *   - "process-event-into-memories"  – extract, embed, and store memory candidates
 *   - "summarise-session"            – generate a compact session summary memory
 *
 * Changes from original:
 *   - isSimilarMemory() called before every upsert to detect near-duplicates
 *   - Duplicate candidates are logged and skipped (no double-storage)
 *   - "summarise-session" job type handled: calls generateSummaryMemory,
 *     embeds the result, and stores it via vectorMemoryStore
 *   - All new memories are additionally routed through storageRouter so they
 *     are placed in the correct hot/warm/cold tier automatically.
 */

import {
  computeMemoryFingerprint,
  extractMemoryCandidates
} from "@neura/core";
// Use the API-layer storage router so memories are persisted via real Redis
// and PostgreSQL adapters rather than the core-package in-memory singletons.
import { storageRouter } from "../infrastructure/tier/index.js";
import { factualMemoryStore }         from "../infrastructure/factual-memory-store.js";
import { vectorMemoryStore }          from "../infrastructure/vector-memory-store.js";
import { linkBatchMemoryRelationships } from "../infrastructure/relationship-graph-store.js";
import { openAIAdapter }              from "./openai-adapter.js";
import { isSimilarMemory }            from "./deduplication-service.js";
import { generateSummaryMemory }      from "./summary-memory.js";
import { logger }                     from "../lib/logger.js";

const processorLog = logger.child({ component: "memory-processor" });

// ─── Module-level embedding cache ────────────────────────────────────────────
// Avoids re-embedding the same text within a single worker process lifetime.

const embeddingCache = new Map();

// ─── Deduplication helper ─────────────────────────────────────────────────────

/**
 * Fetch existing memories for the session from the in-memory fallback stores
 * (used for dedup comparison without a full DB round-trip in local dev).
 *
 * In production with Qdrant + Postgres, isSimilarMemory() uses fingerprint
 * equality (which the stores already enforce via on-conflict upsert) and
 * embedding cosine similarity.  We pass the in-memory array so the check
 * works in the no-DB fallback path too.
 *
 * @param {string} sessionId
 * @returns {Promise<Array>}
 */
async function getExistingMemoriesForDedup(sessionId) {
  try {
    const [factual, vectors] = await Promise.all([
      factualMemoryStore.all(),
      vectorMemoryStore.all(sessionId)
    ]);
    return [...factual.filter((m) => m.sessionId === sessionId), ...vectors];
  } catch {
    return [];
  }
}

// ─── Job handlers ─────────────────────────────────────────────────────────────

/**
 * Extract memory candidates from a raw event, deduplicate, embed, and store.
 *
 * @param {object} event
 * @returns {Promise<Array>}  list of stored memory objects
 */
async function processEventJob(event) {
  const candidates   = extractMemoryCandidates(event);
  const stored       = [];
  const toLink       = [];

  // Load existing memories once per event (not per candidate) to keep N+1 queries away
  const existing = await getExistingMemoriesForDedup(event.sessionId);

  for (const baseCandidate of candidates) {
    const candidate = {
      id:            crypto.randomUUID(),
      sourceEventId: event.id,
      sessionId:     event.sessionId,
      userId:        event.userId || null,
      memoryType:    baseCandidate.memoryType,
      content:       baseCandidate.content,
      summary:       baseCandidate.summary,
      metadata:      baseCandidate.metadata,
      fingerprint:   computeMemoryFingerprint(baseCandidate.content),
      embedding:     null
    };

    // ── Factual memories: fingerprint dedup is handled by Postgres on-conflict ─
    if (candidate.memoryType === "factual") {
      // Pre-check fingerprint to avoid a DB round-trip for exact duplicates
      const dupCheck = isSimilarMemory(candidate, existing);
      if (dupCheck.isDuplicate && dupCheck.reason === "fingerprint") {
        processorLog.debug(
          { sessionId: event.sessionId, fingerprint: candidate.fingerprint, reason: "fingerprint" },
          "memory.deduplicated"
        );
        continue;
      }

      const storedMemory = await factualMemoryStore.upsert(candidate);
      // Route through the tier system — non-blocking; failure must not break storage
      storageRouter.saveMemory(storedMemory).catch((err) =>
        processorLog.warn({ err, id: storedMemory?.id }, "tier-router.save.failed")
      );
      toLink.push(storedMemory);
      stored.push(storedMemory);
      continue;
    }

    // ── Episodic / semantic: embed first, then dedup ──────────────────────────
    const embeddingKey = `${candidate.memoryType}:${candidate.summary}`;
    if (embeddingCache.has(embeddingKey)) {
      candidate.embedding = embeddingCache.get(embeddingKey);
    } else {
      candidate.embedding = await openAIAdapter.embedText(
        `${candidate.memoryType}: ${candidate.summary}`
      );
      if (candidate.embedding) {
        embeddingCache.set(embeddingKey, candidate.embedding);
      }
    }

    // Near-duplicate check (embedding cosine similarity)
    const dupCheck = isSimilarMemory(candidate, existing);
    if (dupCheck.isDuplicate) {
      processorLog.debug(
        {
          sessionId:  event.sessionId,
          reason:     dupCheck.reason,
          similarity: dupCheck.similarity,
          existingId: dupCheck.existingId
        },
        "memory.deduplicated"
      );
      continue;
    }

    const storedMemory = await vectorMemoryStore.upsert(candidate);
    // Route through the tier system — non-blocking; failure must not break storage
    storageRouter.saveMemory(storedMemory).catch((err) =>
      processorLog.warn({ err, id: storedMemory?.id }, "tier-router.save.failed")
    );
    toLink.push(storedMemory);
    stored.push(storedMemory);
  }

  if (toLink.length > 0) {
    await linkBatchMemoryRelationships(toLink);
  }

  return stored.filter(Boolean);
}

/**
 * Generate a compact session summary and store it as a semantic memory.
 *
 * @param {{ sessionId: string, userId?: string, recentTurns: Array }} job
 * @returns {Promise<Array>}
 */
async function processSummariseJob(job) {
  const summaryMemory = await generateSummaryMemory({
    sessionId:    job.sessionId,
    userId:       job.userId || null,
    recentTurns:  job.recentTurns || [],
    openAIAdapter
  });

  if (!summaryMemory) return [];

  // Embed the summary text
  const embedding = await openAIAdapter.embedText(
    `semantic: ${summaryMemory.summary}`
  );
  summaryMemory.embedding = embedding;

  const stored = await vectorMemoryStore.upsert(summaryMemory);
  if (stored) {
    // Route through the tier system — non-blocking
    storageRouter.saveMemory(stored).catch((err) =>
      processorLog.warn({ err, id: stored?.id }, "tier-router.save.failed")
    );
    await linkBatchMemoryRelationships([stored]);
    return [stored];
  }

  return [];
}

// ─── Main entry point (called by memory-worker.js) ────────────────────────────

/**
 * Route a job to the appropriate handler.
 *
 * @param {object} job
 * @returns {Promise<Array>}
 */
export async function processEventIntoMemories(job) {
  if (job.type === "summarise-session") {
    return processSummariseJob(job);
  }

  // Default: treat the job as a process-event-into-memories job
  const event = job.event || job;
  return processEventJob(event);
}
