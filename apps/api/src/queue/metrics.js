/**
 * queue/metrics.js
 *
 * Lightweight counter-based metrics for the memory queue.
 *
 * Metrics are emitted as structured log lines and tracked in an in-process
 * counter store.  This gives:
 *   1. Immediate observability via log aggregators (Datadog, CloudWatch, Loki).
 *   2. A queryable counter surface for tests and admin utilities.
 *
 * Counters:
 *   jobs_processed_total         – successfully completed jobs
 *   jobs_failed_total            – jobs that errored on any attempt
 *   jobs_retried_total           – retry-scheduled events
 *   jobs_dead_lettered_total     – jobs moved to DLQ after exhausting attempts
 *   jobs_duplicate_skipped_total – jobs skipped due to idempotency hit
 *
 * All counters reset when the process restarts (in-memory only).
 * For persistent metrics, hook the emitted log lines in your aggregator.
 */

import { logger } from "../lib/logger.js";

const metricsLog = logger.child({ component: "queue-metrics" });

// ── In-process counters ────────────────────────────────────────────────────────

const counters = {
  jobs_processed_total:         0,
  jobs_failed_total:            0,
  jobs_retried_total:           0,
  jobs_dead_lettered_total:     0,
  jobs_duplicate_skipped_total: 0
};

// ── Helper ─────────────────────────────────────────────────────────────────────

function inc(name, labels = {}) {
  if (!(name in counters)) {
    counters[name] = 0;
  }
  counters[name] += 1;
  metricsLog.debug({ metric: name, value: counters[name], ...labels }, `metric:${name}`);
}

// ── Public surface ─────────────────────────────────────────────────────────────

export const metrics = {
  /**
   * Record a successfully processed job.
   * @param {{ jobId, jobType, sessionId, durationMs }} labels
   */
  jobProcessed(labels) {
    inc("jobs_processed_total", labels);
  },

  /**
   * Record a failed job attempt (fired on every failure, including retriable ones).
   * @param {{ jobId, jobType, sessionId, attempt, errorCategory }} labels
   */
  jobFailed(labels) {
    inc("jobs_failed_total", labels);
  },

  /**
   * Record a retry being scheduled.
   * @param {{ jobId, jobType, sessionId, attempt, delayMs }} labels
   */
  jobRetried(labels) {
    inc("jobs_retried_total", labels);
  },

  /**
   * Record a job being moved to the DLQ.
   * @param {{ jobId, jobType, sessionId, attempts }} labels
   */
  jobDeadLettered(labels) {
    inc("jobs_dead_lettered_total", labels);
  },

  /**
   * Record a duplicate job being skipped.
   * @param {{ jobId, jobType, sessionId, idempotencyKey }} labels
   */
  jobDuplicateSkipped(labels) {
    inc("jobs_duplicate_skipped_total", labels);
  },

  /**
   * Snapshot all current counter values.
   * @returns {object}
   */
  snapshot() {
    return { ...counters };
  },

  /** Reset all counters (test helper only). */
  _reset() {
    for (const key of Object.keys(counters)) {
      counters[key] = 0;
    }
  }
};
