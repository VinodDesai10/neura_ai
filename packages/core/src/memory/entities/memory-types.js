/**
 * packages/core/src/memory/entities/memory-types.js
 *
 * Pure data definitions for the memory domain — no logic, no imports.
 * Import these constants everywhere a memory type string is needed so
 * the values are never hard-coded in multiple places.
 */

// ─── Memory type enum ──────────────────────────────────────────────────────────

/**
 * The three first-class memory types used throughout the AiNeura system.
 *
 * - FACTUAL   : stable user facts (name, preferences, decisions)
 * - EPISODIC  : time-bound events tied to a session or moment in time
 * - SEMANTIC  : conceptual knowledge, summaries, and patterns
 *
 * @readonly
 * @enum {string}
 */
export const MemoryType = Object.freeze({
  FACTUAL:  "factual",
  EPISODIC: "episodic",
  SEMANTIC: "semantic"
});

/**
 * All valid memory type string values as a `Set` for quick membership checks.
 *
 * @type {Set<string>}
 */
export const VALID_MEMORY_TYPES = new Set(Object.values(MemoryType));

// ─── MemoryCandidate shape (JSDoc only — JS runtime carries no types) ─────────

/**
 * @typedef {object} MemoryCandidate
 *
 * A pre-storage memory object produced by the extraction pipeline.
 * Fields are filled progressively: the extractor sets everything except
 * `id`, `fingerprint`, and `embedding`, which are added by the processor
 * before the candidate is written to a store.
 *
 * @property {string}              memoryType   - One of MemoryType values
 * @property {string}              content      - Raw text of the memory
 * @property {string}              summary      - ≤140-char truncation of content
 * @property {MemoryCandidateMeta} metadata     - Rich scoring + provenance metadata
 *
 * Optional fields added by the memory processor before storage:
 * @property {string}              [id]         - UUID assigned by the processor
 * @property {string}              [sessionId]  - Session the event belongs to
 * @property {string|null}         [userId]     - User the session belongs to
 * @property {string}              [sourceEventId] - ID of the originating raw event
 * @property {string}              [fingerprint]   - Sorted token bag for dedup
 * @property {number[]|null}       [embedding]     - OpenAI embedding vector
 */

/**
 * @typedef {object} MemoryCandidateMeta
 *
 * @property {number}   importance            - 0–1 weighted importance score
 * @property {number}   confidence            - 0–1 extraction confidence
 * @property {string}   timestamp             - ISO-8601 creation timestamp
 * @property {string}   domain                - Primary content domain label
 * @property {number}   domainConfidence      - 0–1 domain classification confidence
 * @property {string[]} alternateDomains      - Other candidate domains (up to 3)
 * @property {string[]} tags                  - Topic tags inferred from content
 * @property {string}   role                  - "user" | "assistant"
 * @property {number}   schemaVersion         - Monotonically increasing schema version
 * @property {string}   generatedBy           - Generator identifier string
 * @property {string}   extractionMethod      - Human-readable extraction method label
 * @property {{ eventId: string, sessionId: string, segmentIndex: number }} source
 * @property {number}   signalStrength        - 0–1 information density score
 * @property {number}   specificity           - 0–1 concreteness score
 * @property {number}   permanence            - 0–1 expected longevity score
 * @property {number}   actionability         - 0–1 task/decision relevance score
 * @property {"positive"|"negative"|"neutral"} sentiment
 * @property {string[]} keywords              - Top-N TF-IDF-like keywords
 * @property {Array<{type: string, value: string}>} entities - Named entities
 * @property {number}   classificationConfidence
 * @property {Array<{type: string, confidence: number}>} alternativeClassifications
 * @property {{ factualScore: number, episodicScore: number, semanticScore: number }} classificationDebug
 */
