/**
 * queue/queue-reliability.js
 *
 * Queue reliability wrapper.
 *
 * This module provides the single entry point that binds together all
 * reliability sub-systems:
 *   - idempotency checking (skip already-completed jobs)
 *   - retry-aware execution with exponential backoff
 *   - error classification (transient / permanent / unknown)
 *   - dead-letter queue for terminally failed jobs
 *   - metrics emission for every outcome
 *   - structured log events for every state transition
 *
 * Public API:
 *
 *   runWithReliability(job, handler, log)
 *     Execute `handler(job)` with full retry loop.
 *     Returns: { outcome, stored, skipped, reason, durationMs }
 *
 *   markJobCompleted(job)
 *     Write the idempotency marker to Redis after successful processing.
 *
 *   checkDuplicate(job)
 *     Return true if the idempotency marker already exists.
 *
 * Log events emitted:
 *   job.skipped_duplicate   – job already processed; skipping
 *   job.attempt_started     – attempt N is beginning
 *   job.attempt_succeeded   – attempt N succeeded
 *   job.attempt_failed      – attempt N failed (includes error + category)
 *   job.retry_scheduled     – next attempt delayed; delayMs included
 *   job.retry_exhausted     – maxAttempts reached
 *   job.dead_lettered       – moved to DLQ
 */

import { getRedisClient }    from "../infrastructure/redis/redis-client.js";
import { classifyError }     from "./error-classifier.js";
import { shouldRetry, calculateBackoffMs, buildRetryPayload, serializeError } from "./retry-policy.js";
import { deadLetterQueue }   from "./dead-letter-queue.js";
import { metrics }           from "./metrics.js";
import { idempotencyRedisKey } from "./job-metadata.js";

// ── Config ─────────────────────────────────────────────────────────────────────

function getDlqTtlSeconds() {
  const value = parseInt(process.env.QUEUE_DLQ_TTL_SECONDS, 10);
  return Number.isFinite(value) && value > 0 ? value : 7 * 24 * 60 * 60;
}

// ── Local idempotency fallback ─────────────────────────────────────────────────

const localIdempotencyStore = new Map();

// ── Idempotency helpers ────────────────────────────────────────────────────────

/**
 * Check whether a job has already been completed successfully.
 *
 * @param {object} job
 * @returns {Promise<boolean>}
 */
export async function checkDuplicate(job) {
  if (!job.idempotencyKey) return false;

  const key   = idempotencyRedisKey(job.idempotencyKey);
  const redis = await getRedisClient();

  if (redis) {
    const value = await redis.get(key);
    return value !== null;
  }

  return localIdempotencyStore.has(key);
}

/**
 * Write the idempotency completion marker after a job is processed.
 *
 * @param {object} job
 * @returns {Promise<void>}
 */
export async function markJobCompleted(job) {
  if (!job.idempotencyKey) return;

  const key   = idempotencyRedisKey(job.idempotencyKey);
  const ttl   = getDlqTtlSeconds();       // same lifetime as DLQ records
  const redis = await getRedisClient();

  const record = JSON.stringify({
    jobId:     job.jobId,
    jobType:   job.jobType,
    sessionId: job.sessionId,
    completedAt: new Date().toISOString()
  });

  if (redis) {
    await redis.set(key, record, { EX: ttl });
  } else {
    localIdempotencyStore.set(key, record);
  }
}

/** Clear local idempotency store (test helper). */
export function _clearLocalIdempotency() {
  localIdempotencyStore.clear();
}

// ── Sleep helper ───────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Core execution loop ────────────────────────────────────────────────────────

/**
 * Execute a job handler with full reliability wrapping.
 *
 * @param {object}   job       – job payload with metadata (jobId, attempt, maxAttempts, …)
 * @param {Function} handler   – async (job) => { stored, skipped, reason }
 * @param {object}   log       – pino child logger scoped to this job
 * @param {object}   [opts]    – optional overrides
 * @param {number}   [opts.backoffBaseMs]  – override backoff base (useful in tests)
 * @param {number}   [opts.backoffMaxMs]   – override backoff max (useful in tests)
 * @returns {Promise<{
 *   outcome: "completed" | "skipped_duplicate" | "dead_lettered",
 *   stored?: number,
 *   skipped?: boolean,
 *   reason?: string,
 *   durationMs: number
 * }>}
 */
export async function runWithReliability(job, handler, log, opts = {}) {
  const startedAt = Date.now();

  // ── Idempotency check ──────────────────────────────────────────────────────
  const isDuplicate = await checkDuplicate(job);

  if (isDuplicate) {
    const durationMs = Date.now() - startedAt;
    log.info(
      { idempotencyKey: job.idempotencyKey, durationMs },
      "job.skipped_duplicate"
    );
    metrics.jobDuplicateSkipped({
      jobId: job.jobId, jobType: job.jobType, sessionId: job.sessionId,
      idempotencyKey: job.idempotencyKey
    });
    return { outcome: "skipped_duplicate", skipped: true, reason: "duplicate", durationMs };
  }

  // ── Retry loop ─────────────────────────────────────────────────────────────
  let currentJob = job;

  while (true) {
    const { attempt, maxAttempts } = currentJob;

    log.info({ attempt, maxAttempts }, "job.attempt_started");

    try {
      const result = await handler(currentJob);

      // ── Success ──────────────────────────────────────────────────────────
      const durationMs = Date.now() - startedAt;

      await markJobCompleted(currentJob);

      log.info(
        { attempt, durationMs, stored: result.stored, skipped: result.skipped },
        "job.attempt_succeeded"
      );
      metrics.jobProcessed({
        jobId: currentJob.jobId, jobType: currentJob.jobType,
        sessionId: currentJob.sessionId, durationMs
      });

      return {
        outcome: "completed",
        stored:  result.stored  ?? 0,
        skipped: result.skipped ?? false,
        reason:  result.reason  ?? undefined,
        durationMs
      };

    } catch (error) {
      // ── Failure ───────────────────────────────────────────────────────────
      const { category, reason: classifyReason } = classifyError(error);
      const durationMs = Date.now() - startedAt;

      log.error(
        {
          attempt,
          durationMs,
          errorCategory:  category,
          classifyReason,
          err:            error
        },
        "job.attempt_failed"
      );
      metrics.jobFailed({
        jobId: currentJob.jobId, jobType: currentJob.jobType,
        sessionId: currentJob.sessionId, attempt, errorCategory: category
      });

      if (shouldRetry(currentJob, category)) {
        // ── Schedule retry ──────────────────────────────────────────────────
        const delayMs  = calculateBackoffMs(attempt, {
          baseMs: opts.backoffBaseMs,
          maxMs:  opts.backoffMaxMs
        });
        const nextJob  = buildRetryPayload(currentJob, error, category);

        log.info(
          {
            attempt,
            nextAttempt: nextJob.attempt,
            maxAttempts: currentJob.maxAttempts,
            delayMs,
            errorCategory: category,
            classifyReason
          },
          "job.retry_scheduled"
        );
        metrics.jobRetried({
          jobId: currentJob.jobId, jobType: currentJob.jobType,
          sessionId: currentJob.sessionId, attempt, delayMs
        });

        await sleep(delayMs);
        currentJob = nextJob;
        continue;

      } else {
        // ── Retries exhausted or permanent failure ──────────────────────────
        if (attempt >= currentJob.maxAttempts) {
          log.warn(
            {
              attempt,
              maxAttempts: currentJob.maxAttempts,
              errorCategory: category
            },
            "job.retry_exhausted"
          );
        }

        const dlqRecord = await deadLetterQueue.push(currentJob, error, category);

        log.error(
          {
            jobId:          dlqRecord.jobId,
            attempts:       dlqRecord.attempts,
            errorCategory:  category,
            failedAt:       dlqRecord.failedAt
          },
          "job.dead_lettered"
        );
        metrics.jobDeadLettered({
          jobId: currentJob.jobId, jobType: currentJob.jobType,
          sessionId: currentJob.sessionId, attempts: attempt
        });

        return {
          outcome: "dead_lettered",
          durationMs: Date.now() - startedAt
        };
      }
    }
  }
}
