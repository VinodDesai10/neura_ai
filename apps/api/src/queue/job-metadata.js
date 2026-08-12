/**
 * queue/job-metadata.js
 *
 * Job metadata schema and idempotency key generator.
 *
 * Every job that enters the memory queue carries a standard set of metadata
 * fields that drive reliability: idempotency, retries, and observability.
 *
 * Schema fields:
 *   jobId          – stable UUID for this logical job
 *   jobType        – "process-event-into-memories" | "summarise-session"
 *   sessionId      – owning session
 *   createdAt      – ISO timestamp when first enqueued
 *   attempt        – current attempt number (1-based)
 *   maxAttempts    – ceiling on retries (from env QUEUE_MAX_ATTEMPTS)
 *   idempotencyKey – stable fingerprint derived from job identity
 */

import { createHash, randomUUID } from "node:crypto";

// ── Config ─────────────────────────────────────────────────────────────────────

function readPositiveInt(name, fallback) {
  const value = parseInt(process.env[name], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function getMaxAttempts() {
  return readPositiveInt("QUEUE_MAX_ATTEMPTS", 5);
}

// ── Idempotency key ────────────────────────────────────────────────────────────

/**
 * Derive a stable idempotency key from the job's logical identity.
 *
 * Inputs:
 *   jobType    – string
 *   sessionId  – string
 *   eventId    – optional string (for process-event-into-memories)
 *   content    – optional string (fallback hash anchor)
 *
 * The key is a lowercase hex SHA-256 digest so it is safe to use as a Redis
 * key segment and stable across serialisation round-trips.
 *
 * @param {{ jobType: string, sessionId: string, eventId?: string, content?: string }} params
 * @returns {string}
 */
export function buildIdempotencyKey({ jobType, sessionId, eventId, content }) {
  const parts = [
    jobType     || "unknown",
    sessionId   || "unknown",
    eventId     || "",
    content     ? createHash("sha256").update(content).digest("hex").slice(0, 16) : ""
  ];

  return createHash("sha256")
    .update(parts.join(":"))
    .digest("hex");
}

// ── Metadata builder ───────────────────────────────────────────────────────────

/**
 * Attach standard reliability metadata to a raw job payload.
 *
 * Idempotent: if metadata fields are already present (e.g. on a re-enqueue),
 * they are preserved so jobId and createdAt remain stable across retries.
 *
 * @param {object} job  – raw job payload from memory-orchestrator
 * @returns {object}    – job with metadata fields attached
 */
export function attachJobMetadata(job) {
  const jobType   = job.type     || job.jobType || "unknown";
  const sessionId = job.sessionId || "unknown";
  const eventId   = job.eventId  || job.event?.id || undefined;
  const content   = job.event?.content || job.recentTurns?.map((t) => t.content).join(" ") || undefined;

  const idempotencyKey = job.idempotencyKey || buildIdempotencyKey({
    jobType,
    sessionId,
    eventId,
    content
  });

  return {
    ...job,
    jobId:          job.jobId || randomUUID(),
    jobType,
    sessionId,
    createdAt:      job.createdAt || new Date().toISOString(),
    attempt:        job.attempt   || 1,
    maxAttempts:    job.maxAttempts ?? getMaxAttempts(),
    idempotencyKey
  };
}

/**
 * Build the Redis key used to mark a job as already completed (idempotency check).
 *
 * Format: neura:idempotency:<key>
 *
 * @param {string} idempotencyKey
 * @param {string} [prefix]
 * @returns {string}
 */
export function idempotencyRedisKey(idempotencyKey, prefix) {
  const p = prefix || process.env.REDIS_RUNTIME_PREFIX || "neura";
  return `${p}:idempotency:${idempotencyKey}`;
}
