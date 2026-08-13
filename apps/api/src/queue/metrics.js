/**
 * queue/metrics.js
 *
 * Metrics façade for the memory queue.
 *
 * Dual-track instrumentation:
 *   1. Structured log lines (Datadog, CloudWatch, Loki) — unchanged behaviour.
 *   2. Prometheus counters + histogram via the shared registry in lib/metrics.js.
 *
 * Counters (in-process + Prometheus):
 *   jobs_processed_total         – successfully completed jobs
 *   jobs_failed_total            – jobs that errored on any attempt
 *   jobs_retried_total           – retry-scheduled events
 *   jobs_dead_lettered_total     – jobs moved to DLQ after exhausting attempts
 *   jobs_duplicate_skipped_total – jobs skipped due to idempotency hit
 *
 * Histogram (Prometheus only):
 *   queue_processing_duration_seconds – end-to-end job duration
 *
 * In-process counters reset on restart; Prometheus counters also reset but
 * are scraped frequently enough that a counter-reset is visible in PromQL via
 * `increase()`.
 */

import { logger } from "../lib/logger.js";
import {
  jobsProcessedTotal,
  jobsFailedTotal,
  jobsRetriedTotal,
  jobsDeadLetteredTotal,
  jobsDuplicateSkippedTotal,
  jobProcessingDuration
} from "../lib/metrics.js";

const metricsLog = logger.child({ component: "queue-metrics" });

// ── In-process counters (kept for snapshot() / tests) ─────────────────────────

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
    const jobType = labels.jobType ?? "unknown";
    jobsProcessedTotal.inc({ job_type: jobType });
    if (typeof labels.durationMs === "number") {
      jobProcessingDuration.observe(
        { job_type: jobType, outcome: "completed" },
        labels.durationMs / 1000
      );
    }
  },

  /**
   * Record a failed job attempt (fired on every failure, including retriable ones).
   * @param {{ jobId, jobType, sessionId, attempt, errorCategory }} labels
   */
  jobFailed(labels) {
    inc("jobs_failed_total", labels);
    jobsFailedTotal.inc({
      job_type:       labels.jobType       ?? "unknown",
      error_category: labels.errorCategory ?? "unknown"
    });
  },

  /**
   * Record a retry being scheduled.
   * @param {{ jobId, jobType, sessionId, attempt, delayMs }} labels
   */
  jobRetried(labels) {
    inc("jobs_retried_total", labels);
    jobsRetriedTotal.inc({ job_type: labels.jobType ?? "unknown" });
  },

  /**
   * Record a job being moved to the DLQ.
   * @param {{ jobId, jobType, sessionId, attempts }} labels
   */
  jobDeadLettered(labels) {
    inc("jobs_dead_lettered_total", labels);
    jobsDeadLetteredTotal.inc({ job_type: labels.jobType ?? "unknown" });
    if (typeof labels.durationMs === "number") {
      jobProcessingDuration.observe(
        { job_type: labels.jobType ?? "unknown", outcome: "dead_lettered" },
        labels.durationMs / 1000
      );
    }
  },

  /**
   * Record a duplicate job being skipped.
   * @param {{ jobId, jobType, sessionId, idempotencyKey }} labels
   */
  jobDuplicateSkipped(labels) {
    inc("jobs_duplicate_skipped_total", labels);
    jobsDuplicateSkippedTotal.inc({ job_type: labels.jobType ?? "unknown" });
    if (typeof labels.durationMs === "number") {
      jobProcessingDuration.observe(
        { job_type: labels.jobType ?? "unknown", outcome: "skipped_duplicate" },
        labels.durationMs / 1000
      );
    }
  },

  /**
   * Snapshot all current in-process counter values.
   * @returns {object}
   */
  snapshot() {
    return { ...counters };
  },

  /** Reset all in-process counters (test helper only). */
  _reset() {
    for (const key of Object.keys(counters)) {
      counters[key] = 0;
    }
  }
};
