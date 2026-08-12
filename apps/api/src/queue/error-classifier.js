/**
 * queue/error-classifier.js
 *
 * Classifies errors into three tiers:
 *   "transient"  – temporary; should be retried with backoff
 *   "permanent"  – deterministic failure; retrying will not help
 *   "unknown"    – unrecognised; treated as transient by the retry engine
 *                  (conservative: retry first, DLQ if still failing)
 *
 * Classification rules (evaluated in order):
 *
 *   TRANSIENT
 *     - Network: ECONNRESET, ECONNREFUSED, ETIMEDOUT, ENOTFOUND, EHOSTUNREACH,
 *                EPIPE, ECONNABORTED, EAI_AGAIN, ENETUNREACH, ENOBUFS
 *     - HTTP status: 408, 425, 429, 500, 502, 503, 504
 *     - Error message substrings: timeout, ECONNRESET, rate limit, socket hang up,
 *       connection reset, network, ENOTFOUND, socket closed, redis connection,
 *       resource exhausted, service unavailable, too many requests
 *     - Error.name: AbortError (fetch timeout), FetchError
 *
 *   PERMANENT
 *     - HTTP status: 400, 401, 403, 404, 422
 *     - Substrings: invalid payload, missing required, validation error,
 *       malformed, unknown job type, invalid job, schema error, not a function,
 *       cannot read properties, is not a constructor
 *     - Error.name: SyntaxError, TypeError, RangeError, URIError
 *     - Custom property: error.permanent === true
 */

// ── Category constants ─────────────────────────────────────────────────────────

export const TRANSIENT = "transient";
export const PERMANENT = "permanent";
export const UNKNOWN   = "unknown";

// ── Lookup tables ──────────────────────────────────────────────────────────────

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "EPIPE",
  "ECONNABORTED",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENOBUFS",
  "EADDRNOTAVAIL"
]);

const TRANSIENT_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Lower-cased substrings – checked against error.message.toLowerCase() */
const TRANSIENT_SUBSTRINGS = [
  "timeout",
  "econnreset",
  "rate limit",
  "socket hang up",
  "connection reset",
  "network error",
  "enotfound",
  "socket closed",
  "redis connection",
  "resource exhausted",
  "service unavailable",
  "too many requests",
  "upstream connect error",
  "connect timeout",
  "read timeout",
  "write timeout",
  "socket timeout",
  "request timed out"
];

const TRANSIENT_ERROR_NAMES = new Set(["AbortError", "FetchError"]);

const PERMANENT_STATUS_CODES = new Set([400, 401, 403, 404, 422]);

/** Lower-cased substrings indicating a deterministic/validation failure */
const PERMANENT_SUBSTRINGS = [
  "invalid payload",
  "missing required",
  "validation error",
  "malformed",
  "unknown job type",
  "invalid job",
  "schema error",
  "not a function",
  "cannot read properties",
  "is not a constructor",
  "is not defined",
  "invalid argument",
  "bad request",
  "unauthorized",
  "forbidden",
  "not found"
];

const PERMANENT_ERROR_NAMES = new Set(["SyntaxError", "TypeError", "RangeError", "URIError"]);

// ── Classifier ─────────────────────────────────────────────────────────────────

/**
 * Classify an error as transient, permanent, or unknown.
 *
 * @param {Error|unknown} error
 * @returns {{ category: "transient"|"permanent"|"unknown", reason: string }}
 */
export function classifyError(error) {
  // Non-Error objects – treat as unknown
  if (!error || typeof error !== "object") {
    return { category: UNKNOWN, reason: "non-error-value" };
  }

  // Explicit override via custom property
  if (error.permanent === true) {
    return { category: PERMANENT, reason: "explicit-permanent-flag" };
  }
  if (error.transient === true) {
    return { category: TRANSIENT, reason: "explicit-transient-flag" };
  }

  const message    = (error.message || "").toLowerCase();
  const statusCode = error.status || error.statusCode || error.code;
  const errorCode  = error.code || "";
  const errorName  = error.name || "";

  // ── Transient checks ───────────────────────────────────────────────────────

  if (TRANSIENT_CODES.has(errorCode)) {
    return { category: TRANSIENT, reason: `node-error-code:${errorCode}` };
  }

  if (typeof statusCode === "number" && TRANSIENT_STATUS_CODES.has(statusCode)) {
    return { category: TRANSIENT, reason: `http-status:${statusCode}` };
  }

  if (TRANSIENT_ERROR_NAMES.has(errorName)) {
    return { category: TRANSIENT, reason: `error-name:${errorName}` };
  }

  for (const substring of TRANSIENT_SUBSTRINGS) {
    if (message.includes(substring)) {
      return { category: TRANSIENT, reason: `message-substring:${substring}` };
    }
  }

  // ── Permanent checks ───────────────────────────────────────────────────────

  if (typeof statusCode === "number" && PERMANENT_STATUS_CODES.has(statusCode)) {
    return { category: PERMANENT, reason: `http-status:${statusCode}` };
  }

  if (PERMANENT_ERROR_NAMES.has(errorName)) {
    return { category: PERMANENT, reason: `error-name:${errorName}` };
  }

  for (const substring of PERMANENT_SUBSTRINGS) {
    if (message.includes(substring)) {
      return { category: PERMANENT, reason: `message-substring:${substring}` };
    }
  }

  // ── Fallback ───────────────────────────────────────────────────────────────

  return { category: UNKNOWN, reason: "unrecognised-error" };
}

/**
 * Return true when an error should be retried (transient or unknown).
 *
 * @param {Error|unknown} error
 * @returns {boolean}
 */
export function isRetryable(error) {
  const { category } = classifyError(error);
  return category === TRANSIENT || category === UNKNOWN;
}
