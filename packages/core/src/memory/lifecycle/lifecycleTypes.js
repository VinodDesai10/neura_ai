/**
 * packages/core/src/memory/lifecycle/lifecycleTypes.js
 *
 * Constants, enumerations, and default configuration for the Memory
 * Lifecycle Management system.
 *
 * ─── Lifecycle states ─────────────────────────────────────────────────────────
 *
 *   ACTIVE      Memory is current, accurate, and actively retrieved.
 *               Stored in HOT or WARM tier depending on access recency.
 *
 *   STALE       Memory has not been accessed in a long time or its
 *               importance has dropped below the stale threshold.
 *               Retrieved with a reduced score penalty; moved to WARM.
 *
 *   CONFLICTED  A newer memory contradicts this one.  Both records are
 *               preserved.  The newer/higher-confidence memory is preferred
 *               during retrieval; this record carries conflict metadata so
 *               the AI can surface the change to the user.
 *
 *   ARCHIVED    Memory is obsolete or explicitly retired.  Excluded from
 *               normal retrieval unless the caller explicitly opts in.
 *               Moved to COLD tier.
 *
 * ─── State transitions ────────────────────────────────────────────────────────
 *
 *   ACTIVE  ──► STALE       (access drought / importance decay)
 *   ACTIVE  ──► CONFLICTED  (newer contradicting memory detected)
 *   ACTIVE  ──► ARCHIVED    (explicit archive or auto-archive on conflict)
 *   STALE   ──► ACTIVE      (revive: access / importance restored)
 *   STALE   ──► ARCHIVED    (extended staleness)
 *   CONFLICTED ──► ARCHIVED (after resolution)
 *   ARCHIVED   ──► ACTIVE   (explicit revive)
 *
 * ─── Configuration ────────────────────────────────────────────────────────────
 *
 *   All numeric thresholds are in LIFECYCLE_DEFAULTS and can be overridden
 *   via environment variables (see LIFECYCLE_CONFIG_KEYS).
 */

// ─── State enum ───────────────────────────────────────────────────────────────

/**
 * All valid lifecycle state values.
 *
 * @readonly
 * @enum {string}
 */
export const LifecycleState = Object.freeze({
  ACTIVE:     "active",
  STALE:      "stale",
  CONFLICTED: "conflicted",
  ARCHIVED:   "archived"
});

/**
 * Set of all valid lifecycle state strings for quick membership checks.
 *
 * @type {Set<string>}
 */
export const VALID_LIFECYCLE_STATES = new Set(Object.values(LifecycleState));

// ─── Default thresholds ───────────────────────────────────────────────────────

/**
 * Default lifecycle configuration.
 *
 * Every value can be overridden via environment variables.
 * Use `readLifecycleConfig()` to get the active configuration.
 *
 * @type {{
 *   staleAccessDays:        number,  // No access in N days → STALE
 *   staleImportanceMin:     number,  // Importance below this → eligible for STALE
 *   archiveAccessDays:      number,  // No access in N days (and STALE) → ARCHIVED
 *   archiveImportanceMax:   number,  // Importance must be below this to auto-archive
 *   conflictSimilarity:     number,  // Token overlap ≥ this triggers conflict check
 *   conflictConfidenceMin:  number,  // Conflict only reported when confidence ≥ this
 *   staleScorePenalty:      number,  // Multiplier applied to STALE retrieval scores (0–1)
 *   conflictScorePenalty:   number,  // Multiplier applied to CONFLICTED scores (0–1)
 * }}
 */
export const LIFECYCLE_DEFAULTS = Object.freeze({
  /** Days without any access before a memory becomes STALE. */
  staleAccessDays:       30,
  /** Importance floor — a memory with importance below this is eligible to go STALE. */
  staleImportanceMin:    0.3,
  /** Days without access before a STALE memory auto-archives. */
  archiveAccessDays:     120,
  /** Importance ceiling for auto-archive (prevents archiving important memories). */
  archiveImportanceMax:  0.4,
  /** Minimum token-overlap similarity to trigger a conflict check.
   *  Set to 0.25 to catch "I live in X → I live in Y" style conflicts
   *  (Jaccard similarity ≈ 0.32 for these short location/employment claims). */
  conflictSimilarity:    0.25,
  /** Minimum conflict-detection confidence to record the conflict. */
  conflictConfidenceMin: 0.50,
  /** Score multiplier applied to STALE memories during retrieval (reduces score). */
  staleScorePenalty:     0.60,
  /** Score multiplier applied to CONFLICTED memories during retrieval. */
  conflictScorePenalty:  0.80
});

// ─── Env-variable key names ───────────────────────────────────────────────────

/**
 * Mapping from config key → environment variable name.
 * Populated by `readLifecycleConfig()`.
 *
 * @type {Record<string, string>}
 */
export const LIFECYCLE_CONFIG_KEYS = Object.freeze({
  staleAccessDays:       "LIFECYCLE_STALE_ACCESS_DAYS",
  staleImportanceMin:    "LIFECYCLE_STALE_IMPORTANCE_MIN",
  archiveAccessDays:     "LIFECYCLE_ARCHIVE_ACCESS_DAYS",
  archiveImportanceMax:  "LIFECYCLE_ARCHIVE_IMPORTANCE_MAX",
  conflictSimilarity:    "LIFECYCLE_CONFLICT_SIMILARITY",
  conflictConfidenceMin: "LIFECYCLE_CONFLICT_CONFIDENCE_MIN",
  staleScorePenalty:     "LIFECYCLE_STALE_SCORE_PENALTY",
  conflictScorePenalty:  "LIFECYCLE_CONFLICT_SCORE_PENALTY"
});

// ─── Config reader ────────────────────────────────────────────────────────────

/**
 * Read the active lifecycle configuration, merging environment-variable
 * overrides into `LIFECYCLE_DEFAULTS`.
 *
 * @param {Record<string, string>} [env=process.env]  Optional env override for testing.
 * @returns {typeof LIFECYCLE_DEFAULTS}
 */
export function readLifecycleConfig(env = process.env) {
  /** @param {string} key @param {number} fallback */
  function num(key, fallback) {
    const v = Number(env[key]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  }

  return {
    staleAccessDays:       num(LIFECYCLE_CONFIG_KEYS.staleAccessDays,       LIFECYCLE_DEFAULTS.staleAccessDays),
    staleImportanceMin:    num(LIFECYCLE_CONFIG_KEYS.staleImportanceMin,     LIFECYCLE_DEFAULTS.staleImportanceMin),
    archiveAccessDays:     num(LIFECYCLE_CONFIG_KEYS.archiveAccessDays,      LIFECYCLE_DEFAULTS.archiveAccessDays),
    archiveImportanceMax:  num(LIFECYCLE_CONFIG_KEYS.archiveImportanceMax,   LIFECYCLE_DEFAULTS.archiveImportanceMax),
    conflictSimilarity:    num(LIFECYCLE_CONFIG_KEYS.conflictSimilarity,     LIFECYCLE_DEFAULTS.conflictSimilarity),
    conflictConfidenceMin: num(LIFECYCLE_CONFIG_KEYS.conflictConfidenceMin,  LIFECYCLE_DEFAULTS.conflictConfidenceMin),
    staleScorePenalty:     num(LIFECYCLE_CONFIG_KEYS.staleScorePenalty,      LIFECYCLE_DEFAULTS.staleScorePenalty),
    conflictScorePenalty:  num(LIFECYCLE_CONFIG_KEYS.conflictScorePenalty,   LIFECYCLE_DEFAULTS.conflictScorePenalty)
  };
}

// ─── Tier mapping ──────────────────────────────────────────────────────────────

/**
 * Recommended storage tier for each lifecycle state.
 * The lifecycle manager uses this when writing the updated memory back.
 *
 * ACTIVE → HOT or WARM (decided by the existing tierManager.determineTier)
 * STALE  → WARM  (keep accessible but not hot)
 * CONFLICTED → WARM (still retrievable, just penalised)
 * ARCHIVED → COLD (archive tier)
 *
 * @type {Record<string, string>}
 */
export const LIFECYCLE_TIER_HINT = Object.freeze({
  [LifecycleState.ACTIVE]:     "warm",  // tierManager may promote to hot
  [LifecycleState.STALE]:      "warm",
  [LifecycleState.CONFLICTED]: "warm",
  [LifecycleState.ARCHIVED]:   "cold"
});

// ─── JSDoc typedefs ───────────────────────────────────────────────────────────

/**
 * @typedef {object} LifecycleSignals
 * @property {number} ageScore        - 0–1: 1 = brand new, 0 = very old
 * @property {number} accessScore     - 0–1: normalised recency of last access
 * @property {number} importanceScore - 0–1: stored importance (pass-through)
 * @property {number} confidenceScore - 0–1: stored confidence (pass-through)
 * @property {number} freshness       - 0–1: composite freshness (age + access)
 * @property {number} ageHours        - raw age of the memory in hours
 * @property {number} lastAccessHours - hours since last access (or ageHours if never)
 */

/**
 * @typedef {object} ConflictRecord
 * @property {string}  conflictingId    - ID of the memory that conflicts
 * @property {number}  similarity       - token-overlap similarity (0–1)
 * @property {number}  confidence       - confidence this is a real conflict (0–1)
 * @property {string}  reason           - human-readable explanation
 * @property {string}  detectedAt       - ISO timestamp of detection
 * @property {boolean} preferOther      - true when the other memory should win retrieval
 */

/**
 * @typedef {object} ConflictDetectionResult
 * @property {boolean}         hasConflict    - whether any conflict was found
 * @property {ConflictRecord[]} conflicts      - individual conflict records
 * @property {string[]}        conflictingIds - convenience array of IDs
 */
