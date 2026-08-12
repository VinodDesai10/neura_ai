/**
 * queue/retry-policy.js
 *
 * Retry policy engine for memory-queue jobs.
 *
 * Policy:
 *   - maxAttempts  = QUEUE_MAX_ATTEMPTS  (default 5)
 *   - Base delay   = QUEUE_BACKOFF_BASE_MS (default 1 000 ms)
 *   - Max delay    = QUEUE_BACKOFF_MAX_MS  (default 30 000 ms)
 *   - Strategy     = exponential backoff with ±20 % full-jitter
 *
 * Delay formula (before jitter):
 *   baseMs × 2^(attempt - 1)   clamped to maxMs
 *
 * Jitter:
 *   delayMs × uniform(0.8, 1.2)  (full ±20 %)
 *
 * Attempt sequence for defaults (before jitter):
 *   Attempt 1 → failed → wait ~1 000 ms → attempt 2
 *   Attempt 2 → failed → wait ~2 000 ms → attempt 3
 *   Attempt 3 → failed → wait ~4 000 ms → attempt 4
 *   Attempt 4 → failed → wait ~8 000 ms → attempt 5
 *   Attempt 5 → failed → DLQ (no more retries)
 */

// ── Config helpers ─────────────────────────────────────────────────────────────

function readPositiveNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function getBackoffBaseMs() {
  return readPositiveNumber("QUEUE_BACKOFF_BASE_MS", 1000);
}

export function getBackoffMaxMs() {
  return readPositiveNumber("QUEUE_BACKOFF_MAX_MS", 30_000);
}

// ── Core calculations ──────────────────────────────────────────────────────────

/**
 * Calculate the delay in milliseconds before the next retry attempt.
 *
 * @param {number} attempt        – the attempt that just failed (1-based)
 * @param {object} [options]
 * @param {number} [options.baseMs]   – override base delay
 * @param {number} [options.maxMs]    – override maximum delay
 * @param {number} [options.jitter]   – jitter fraction (default 0.2 = ±20%)
 * @returns {number}                  – milliseconds to wait before next attempt
 */
export function calculateBackoffMs(attempt, options = {}) {
  const baseMs  = options.baseMs  ?? getBackoffBaseMs();
  const maxMs   = options.maxMs   ?? getBackoffMaxMs();
  const jitter  = options.jitter  ?? 0.2;

  // Exponential: base * 2^(attempt-1), clamped to max
  const exponential = Math.min(baseMs * Math.pow(2, attempt - 1), maxMs);

  // Full ±jitter: multiply by a uniform random in [1-jitter, 1+jitter]
  const factor = 1 - jitter + Math.random() * jitter * 2;

  return Math.round(exponential * factor);
}

/**
 * Determine whether a job should be retried.
 *
 * @param {object} job          – job with attempt and maxAttempts fields
 * @param {string} errorCategory – "transient" | "permanent" | "unknown"
 * @returns {boolean}
 */
export function shouldRetry(job, errorCategory) {
  if (errorCategory === "permanent") return false;

  const attempt     = job.attempt     || 1;
  const maxAttempts = job.maxAttempts ?? 5;

  // attempt is the one that just failed; retry only if we have room left
  return attempt < maxAttempts;
}

/**
 * Build the next-attempt payload for a job that should be retried.
 * Increments attempt and records the last error summary.
 *
 * @param {object} job         – current job payload (with metadata)
 * @param {Error}  error       – the error that caused this failure
 * @param {string} errorCategory
 * @returns {object}           – updated job payload ready to re-enqueue
 */
export function buildRetryPayload(job, error, errorCategory) {
  const nextAttempt = (job.attempt || 1) + 1;
  return {
    ...job,
    attempt:       nextAttempt,
    lastError:     serializeError(error),
    lastErrorCategory: errorCategory,
    retriedAt:     new Date().toISOString()
  };
}

// ── Error serialisation ────────────────────────────────────────────────────────

/**
 * Produce a serialisation-safe summary of an error.
 *
 * @param {Error|unknown} error
 * @returns {{ message: string, name: string, stack?: string, code?: string, status?: number }}
 */
export function serializeError(error) {
  if (!error || typeof error !== "object") {
    return { message: String(error), name: "UnknownError" };
  }

  return {
    message:    error.message    || String(error),
    name:       error.name       || "Error",
    stack:      error.stack      || undefined,
    code:       error.code       || undefined,
    status:     error.status     || error.statusCode || undefined
  };
}
