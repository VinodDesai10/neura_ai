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
 *   - After each event job, a non-blocking consolidation sweep runs against the
 *     PostgreSQL-backed consolidationStore so ConsolidatedMemory records survive
 *     process restarts (C-2).
 */

import {
  computeMemoryFingerprint,
  extractMemoryCandidates,
  runConsolidationSweep
} from "@neura/core";
// Use the API-layer storage router so memories are persisted via real Redis
// and PostgreSQL adapters rather than the core-package in-memory singletons.
import { storageRouter } from "../infrastructure/tier/index.js";
// PostgreSQL-backed consolidation store (falls back to in-memory when Postgres
// is not configured — safe to import unconditionally).
import { consolidationStore } from "../infrastructure/consolidation-store.js";
import { factualMemoryStore }         from "../infrastructure/factual-memory-store.js";
import { vectorMemoryStore }          from "../infrastructure/vector-memory-store.js";
import { linkBatchMemoryRelationships } from "../infrastructure/relationship-graph-store.js";
import { openAIAdapter }              from "./openai-adapter.js";
import { isSimilarMemory }            from "./deduplication-service.js";
import { generateSummaryMemory }      from "./summary-memory.js";
import { persistMemoryGraph }         from "./graphPipeline.js";
import { logger }                     from "../lib/logger.js";
// H-4: per-session distributed lock — prevents concurrent workers from both
// passing the dedup check before either write completes.
import { redisRuntimeStore }          from "../infrastructure/redis-runtime-store.js";

const processorLog = logger.child({ component: "memory-processor" });

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
 * H-4: the entire read-dedup-write section is serialised behind a per-session
 * distributed lock (Redis SET NX EX; local-Map fallback) so concurrent workers
 * processing jobs for the same session cannot both pass deduplication before
 * either write completes.  Different sessions are never blocked by each other.
 *
 * @param {object} event
 * @returns {Promise<Array>}  list of stored memory objects
 */
async function processEventJob(event) {
  const candidates = extractMemoryCandidates(event);

  // ── Acquire per-session memory-processing lock (H-4) ─────────────────────
  // TTL of 30 s covers the worst-case latency of embedding + multi-store
  // writes.  The lock is keyed on :proc-lock (distinct from the orchestrator's
  // :lock) so chat-turn serialisation is never affected.
  //
  // On lock failure we log a warning and return an empty list — the job will
  // be retried by the reliability wrapper, by which time the holding worker
  // will have finished and released the lock.
  const procLockToken = await redisRuntimeStore.acquireMemoryProcessingLock(event.sessionId);
  if (!procLockToken) {
    processorLog.warn(
      { sessionId: event.sessionId },
      "memory.proc-lock.contention – skipping; job will be retried"
    );
    const err = new Error("memory-processing lock contended — will retry");
    // Mark as transient so the reliability wrapper retries rather than DLQ-ing
    err.code = "ECONNRESET"; // any transient code works; picked for classifier compat
    throw err;
  }

  const stored = [];
  const toLink = [];

  try {
    // Load existing memories once per event (not per candidate) to keep N+1 queries away.
    // This read happens INSIDE the lock so no concurrent worker can overlap it
    // with a write for the same session.
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
        // Async graph extraction — must never block or fail memory storage
        persistMemoryGraph(storedMemory).catch(() => {});
        toLink.push(storedMemory);
        stored.push(storedMemory);
        continue;
      }

      // ── Episodic / semantic: embed first, then dedup ──────────────────────
      // Caching is handled by openAIAdapter.embedText via redisRuntimeStore
      // (TTL-backed, no unbounded in-process Map needed here).
      candidate.embedding = await openAIAdapter.embedText(
        `${candidate.memoryType}: ${candidate.summary}`
      );

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
      // Async graph extraction — must never block or fail memory storage
      persistMemoryGraph(storedMemory).catch(() => {});
      toLink.push(storedMemory);
      stored.push(storedMemory);
    }
  } finally {
    // Always release the lock — even if an error aborted the loop — so the
    // next job for this session is not locked out indefinitely.
    await redisRuntimeStore.releaseMemoryProcessingLock(event.sessionId, procLockToken);
  }

  if (toLink.length > 0) {
    await linkBatchMemoryRelationships(toLink);
  }

  // ── Non-blocking consolidation sweep ─────────────────────────────────────
  // After new memories are stored, opportunistically run a consolidation sweep
  // for the user so ConsolidatedMemory records are kept up to date in the
  // PostgreSQL-backed consolidationStore.  Failures must never block or fail
  // the memory storage step above.
  const userId = event?.userId || event?.event?.userId || null;
  if (userId) {
    runConsolidationSweep(userId, storageRouter, consolidationStore).catch((err) =>
      processorLog.warn({ err, userId }, "consolidation.sweep.failed")
    );
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
    // Async graph extraction — must never block or fail memory storage
    persistMemoryGraph(stored).catch(() => {});
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
