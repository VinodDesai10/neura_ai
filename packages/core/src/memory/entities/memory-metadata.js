/**
 * packages/core/src/memory/entities/memory-metadata.js
 *
 * Metadata schema constants and the default metadata shape used when
 * building a MemoryCandidate.  No scoring logic lives here — this is
 * purely data.
 */

// ─── Schema version ───────────────────────────────────────────────────────────

/**
 * Current metadata schema version.  Increment whenever the metadata shape
 * changes in a non-backwards-compatible way.
 *
 * @type {number}
 */
export const METADATA_SCHEMA_VERSION = 3;

// ─── Generator / method labels ────────────────────────────────────────────────

/**
 * Identifier written into `metadata.generatedBy` for the main heuristic
 * extraction pipeline.
 *
 * @type {string}
 */
export const HEURISTIC_GENERATOR_ID = "heuristic-metadata-v3";

/**
 * Identifier written into `metadata.generatedBy` for the LLM-backed
 * session-summary pipeline.
 *
 * @type {string}
 */
export const SUMMARY_GENERATOR_ID = "summary-memory-v1";

/**
 * Identifier written into `metadata.extractionMethod` for the main
 * heuristic extraction pipeline.
 *
 * @type {string}
 */
export const HEURISTIC_EXTRACTION_METHOD = "enhanced-pattern-scoring-analysis";

/**
 * Identifier written into `metadata.extractionMethod` for the LLM-backed
 * session-summary pipeline.
 *
 * @type {string}
 */
export const SUMMARY_EXTRACTION_METHOD = "llm-summarisation";

// ─── Default metadata template ────────────────────────────────────────────────

/**
 * A frozen default metadata object.  The extraction pipeline spreads this
 * and overwrites each field with computed values so no required field is
 * ever accidentally undefined.
 *
 * These defaults are intentionally conservative (mid-range scores, empty
 * arrays) and should never reach a store unchanged — they are only a
 * safety-net starting point.
 *
 * @type {import("./memory-types.js").MemoryCandidateMeta}
 */
export const DEFAULT_MEMORY_METADATA = Object.freeze({
  importance:   0.5,
  confidence:   0.5,
  timestamp:    null,
  domain:       "general",
  domainConfidence: 0.35,
  alternateDomains: [],
  tags:         [],
  role:         "user",
  schemaVersion: METADATA_SCHEMA_VERSION,
  generatedBy:  HEURISTIC_GENERATOR_ID,
  extractionMethod: HEURISTIC_EXTRACTION_METHOD,
  source: {
    eventId:      null,
    sessionId:    null,
    segmentIndex: 0
  },
  signalStrength: 0.25,
  specificity:    0.20,
  permanence:     0.42,
  actionability:  0.15,
  sentiment:      "neutral",
  keywords:       [],
  entities:       [],
  classificationConfidence:   0.5,
  alternativeClassifications: [],
  classificationDebug: {
    factualScore:  0,
    episodicScore: 0,
    semanticScore: 0
  }
});

// ─── Summary-memory metadata preset ──────────────────────────────────────────

/**
 * Metadata preset for LLM-generated session-summary memories.
 * The orchestrator/processor fills in the timestamp and source fields
 * before upserting.
 *
 * These values are deliberately higher than the heuristic defaults because
 * a summary has already been quality-filtered by the LLM.
 *
 * @type {Partial<import("./memory-types.js").MemoryCandidateMeta>}
 */
export const SUMMARY_MEMORY_METADATA_PRESET = Object.freeze({
  importance:       0.72,
  confidence:       0.85,
  domain:           "general",
  domainConfidence: 0.7,
  alternateDomains: [],
  tags:             ["summary", "session-summary"],
  role:             "assistant",
  schemaVersion:    METADATA_SCHEMA_VERSION,
  generatedBy:      SUMMARY_GENERATOR_ID,
  extractionMethod: SUMMARY_EXTRACTION_METHOD,
  signalStrength:   0.75,
  specificity:      0.65,
  permanence:       0.55,
  actionability:    0.4,
  sentiment:        "neutral",
  keywords:         [],
  entities:         []
});
