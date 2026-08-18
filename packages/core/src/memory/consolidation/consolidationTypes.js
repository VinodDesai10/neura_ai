/**
 * packages/core/src/memory/consolidation/consolidationTypes.js
 *
 * Constants, enumerations, and JSDoc typedefs for the Memory Consolidation
 * system.
 *
 * ─── What is a ConsolidatedMemory? ────────────────────────────────────────────
 *
 *   A ConsolidatedMemory is a durable knowledge item synthesised from two or
 *   more related source memories.  It is NOT a replacement for the sources —
 *   all source memories are preserved as evidence (provenance).
 *
 *   Example:
 *     Source 1: "I live in Mumbai"              (factual, 2024-01)
 *     Source 2: "My city is Mumbai, India"      (factual, 2024-03)
 *     Consolidated: "User lives in Mumbai, India"  (higher confidence, versioned)
 *
 * ─── Consolidation status flow ────────────────────────────────────────────────
 *
 *   PENDING   → Candidate group identified; consolidation not yet run.
 *   ACTIVE    → Healthy consolidated memory, no conflicts.
 *   CONFLICTED → One or more source memories contradict each other.
 *               The conflict metadata is recorded; no silent resolution.
 *   SUPERSEDED → A newer consolidation of the same topic replaces this one.
 *               The record is kept for provenance but not retrieved by default.
 *   STALE     → All source memories are STALE or ARCHIVED.  Lower retrieval
 *               priority but not removed.
 *
 * ─── Configuration ────────────────────────────────────────────────────────────
 *
 *   Defaults in CONSOLIDATION_DEFAULTS; env-var overrides via CONSOLIDATION_CONFIG_KEYS.
 */

// ─── Status enum ──────────────────────────────────────────────────────────────

/**
 * All valid consolidation status values.
 *
 * @readonly
 * @enum {string}
 */
export const ConsolidationStatus = Object.freeze({
  PENDING:    "pending",
  ACTIVE:     "active",
  CONFLICTED: "conflicted",
  SUPERSEDED: "superseded",
  STALE:      "stale"
});

/**
 * Set of all valid status strings for quick membership checks.
 *
 * @type {Set<string>}
 */
export const VALID_CONSOLIDATION_STATUSES = new Set(
  Object.values(ConsolidationStatus)
);

// ─── Conflict severity enum ────────────────────────────────────────────────────

/**
 * How severe a conflict between source memories is.
 *
 * @readonly
 * @enum {string}
 */
export const ConflictSeverity = Object.freeze({
  NONE:     "none",
  LOW:      "low",     // Slight phrasing difference; probably safe to merge
  MEDIUM:   "medium",  // Factual disagreement on a detail (date, number)
  HIGH:     "high"     // Direct contradiction; manual review recommended
});

// ─── Default configuration ────────────────────────────────────────────────────

/**
 * Default thresholds for the consolidation engine.
 *
 * @type {{
 *   minSourceCount:          number,   // Min sources to form a consolidation
 *   minGroupSimilarity:      number,   // Min token overlap to group two memories
 *   minConsolidationConfidence: number,// Min avg source confidence to produce result
 *   conflictSimilarityHigh:  number,   // Above this → likely duplicate (skip)
 *   conflictSimilarityLow:   number,   // Below this → unrelated (skip)
 *   reConsolidateThreshold:  number,   // Min new-source ratio to trigger re-consolidation
 *   staleSourceFraction:     number,   // Fraction of stale sources → STALE status
 *   maxSourcesPerGroup:      number,   // Cap on sources in one consolidation
 * }}
 */
export const CONSOLIDATION_DEFAULTS = Object.freeze({
  /** Minimum number of source memories to form a consolidated item. */
  minSourceCount:             2,
  /** Minimum token-overlap similarity to group two memories together. */
  minGroupSimilarity:         0.20,
  /** Minimum average source confidence to emit a consolidated result. */
  minConsolidationConfidence: 0.40,
  /**
   * Similarity above this → near-duplicate; do not treat as conflict, just
   * prefer the higher-confidence version.
   */
  conflictSimilarityHigh:     0.88,
  /**
   * Similarity below this → unrelated; skip conflict detection.
   */
  conflictSimilarityLow:      0.25,
  /**
   * If the fraction of sources not in the existing consolidation exceeds
   * this value, trigger re-consolidation.
   */
  reConsolidateThreshold:     0.30,
  /**
   * If this fraction or more of source memories are STALE / ARCHIVED,
   * mark the consolidated memory STALE.
   */
  staleSourceFraction:        0.60,
  /**
   * Maximum number of source memories in a single consolidation group.
   * Guards against runaway groups on large memory sets.
   */
  maxSourcesPerGroup:         20
});

// ─── Env-variable key names ───────────────────────────────────────────────────

/**
 * Mapping from config key → environment variable name.
 *
 * @type {Record<string, string>}
 */
export const CONSOLIDATION_CONFIG_KEYS = Object.freeze({
  minSourceCount:             "CONSOLIDATION_MIN_SOURCE_COUNT",
  minGroupSimilarity:         "CONSOLIDATION_MIN_GROUP_SIMILARITY",
  minConsolidationConfidence: "CONSOLIDATION_MIN_CONFIDENCE",
  conflictSimilarityHigh:     "CONSOLIDATION_CONFLICT_SIMILARITY_HIGH",
  conflictSimilarityLow:      "CONSOLIDATION_CONFLICT_SIMILARITY_LOW",
  reConsolidateThreshold:     "CONSOLIDATION_RECONSOLIDATE_THRESHOLD",
  staleSourceFraction:        "CONSOLIDATION_STALE_SOURCE_FRACTION",
  maxSourcesPerGroup:         "CONSOLIDATION_MAX_SOURCES_PER_GROUP"
});

// ─── Config reader ────────────────────────────────────────────────────────────

/**
 * Read the active consolidation configuration, merging env overrides into
 * CONSOLIDATION_DEFAULTS.
 *
 * @param {Record<string, string>} [env=process.env]
 * @returns {typeof CONSOLIDATION_DEFAULTS}
 */
export function readConsolidationConfig(env = process.env) {
  /** @param {string} key @param {number} fallback */
  function num(key, fallback) {
    const v = Number(env[key]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  }

  return {
    minSourceCount:             Math.max(2, num(CONSOLIDATION_CONFIG_KEYS.minSourceCount,             CONSOLIDATION_DEFAULTS.minSourceCount)),
    minGroupSimilarity:         num(CONSOLIDATION_CONFIG_KEYS.minGroupSimilarity,         CONSOLIDATION_DEFAULTS.minGroupSimilarity),
    minConsolidationConfidence: num(CONSOLIDATION_CONFIG_KEYS.minConsolidationConfidence, CONSOLIDATION_DEFAULTS.minConsolidationConfidence),
    conflictSimilarityHigh:     num(CONSOLIDATION_CONFIG_KEYS.conflictSimilarityHigh,     CONSOLIDATION_DEFAULTS.conflictSimilarityHigh),
    conflictSimilarityLow:      num(CONSOLIDATION_CONFIG_KEYS.conflictSimilarityLow,      CONSOLIDATION_DEFAULTS.conflictSimilarityLow),
    reConsolidateThreshold:     num(CONSOLIDATION_CONFIG_KEYS.reConsolidateThreshold,     CONSOLIDATION_DEFAULTS.reConsolidateThreshold),
    staleSourceFraction:        num(CONSOLIDATION_CONFIG_KEYS.staleSourceFraction,        CONSOLIDATION_DEFAULTS.staleSourceFraction),
    maxSourcesPerGroup:         num(CONSOLIDATION_CONFIG_KEYS.maxSourcesPerGroup,         CONSOLIDATION_DEFAULTS.maxSourcesPerGroup)
  };
}

// ─── JSDoc typedefs ───────────────────────────────────────────────────────────

/**
 * @typedef {object} ConsolidatedMemory
 *
 * A durable consolidated knowledge item synthesised from related source
 * memories.  Source memories are preserved untouched.
 *
 * @property {string}   id              - UUID for this consolidated record
 * @property {string}   userId          - Owner user ID
 * @property {string}   topic           - Human-readable topic label (e.g. "location")
 * @property {string}   summary         - Synthesised summary of the consolidated fact
 * @property {string[]} sourceMemoryIds - Ordered list of source memory IDs (provenance)
 * @property {number}   confidence      - Aggregate confidence (0–1)
 * @property {number}   importanceScore - Aggregate importance (0–1)
 * @property {string}   createdAt       - ISO-8601 creation timestamp
 * @property {string}   updatedAt       - ISO-8601 last-update timestamp
 * @property {number}   version         - Monotonically increasing version counter
 * @property {string}   status          - One of ConsolidationStatus values
 * @property {ConsolidationConflictMeta|null} conflictMeta - Conflict details when status=CONFLICTED
 * @property {string}   memoryType      - The shared memory type of the sources
 * @property {string[]} tags            - Union of source tags
 * @property {string}   domain          - Dominant source domain
 */

/**
 * @typedef {object} ConsolidationConflictMeta
 *
 * Conflict metadata recorded when source memories contradict each other.
 *
 * @property {ConflictSeverityRecord[]} conflicts       - Individual conflict records
 * @property {string[]}                 conflictingIds  - Source memory IDs involved
 * @property {string}                   severity        - Overall ConflictSeverity
 * @property {string}                   resolvedWith    - ID of the preferred source memory
 * @property {string}                   detectedAt      - ISO timestamp
 * @property {string}                   reason          - Human-readable explanation
 */

/**
 * @typedef {object} ConflictSeverityRecord
 *
 * @property {string} memoryIdA     - First conflicting source memory
 * @property {string} memoryIdB     - Second conflicting source memory
 * @property {number} similarity    - Token-overlap similarity
 * @property {string} severity      - ConflictSeverity value
 * @property {string} reason        - Human-readable reason
 */

/**
 * @typedef {object} ConsolidationGroup
 *
 * A group of source memories that are candidates for consolidation.
 *
 * @property {string}   userId       - User who owns all these memories
 * @property {string}   topic        - Inferred topic label
 * @property {string}   memoryType   - Shared memory type
 * @property {object[]} memories     - The actual memory objects
 * @property {string[]} memoryIds    - IDs of the memories
 * @property {number}   avgConfidence - Average source confidence
 * @property {number}   avgImportance - Average source importance
 */

/**
 * @typedef {object} ProvenanceInfo
 *
 * Provenance data returned for a consolidated memory.
 *
 * @property {string}   consolidatedMemoryId - The consolidated memory's ID
 * @property {string[]} sourceMemoryIds      - All source IDs
 * @property {number}   sourceCount          - Number of sources
 * @property {string|null} latestSourceId    - ID of most recent source
 * @property {string|null} latestSourceAt    - Timestamp of most recent source
 * @property {number}   confidence           - Consolidated confidence
 * @property {ConsolidationConflictMeta|null} conflictInfo - Conflict details if any
 * @property {number}   version              - Current consolidation version
 */
