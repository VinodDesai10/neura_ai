/**
 * packages/core/src/memory/retrieval/retrievalTypes.js
 *
 * Shared constants, default weight set, and JSDoc type definitions for the
 * hybrid retrieval pipeline.  All other retrieval modules import from here
 * rather than declaring their own defaults, keeping a single source of truth.
 */

// ─── Default weight set ───────────────────────────────────────────────────────

/**
 * Default weights for the hybrid scoring formula.
 *
 *   finalScore =
 *     vectorScore     * weights.vector     +   (default 0.40)
 *     keywordScore    * weights.keyword    +   (default 0.20)
 *     importanceScore * weights.importance +   (default 0.20)
 *     recencyScore    * weights.recency    +   (default 0.10)
 *     graphScore      * weights.graph          (default 0.10)
 *
 * All weights should sum to 1.0.  Individual weights can be overridden per
 * call via the `options.weights` parameter in `rankMemories` or
 * `getRelevantMemories`.
 *
 * @type {{ vector: number, keyword: number, importance: number, recency: number, graph: number }}
 */
export const HYBRID_WEIGHTS_DEFAULTS = {
  vector:     0.40,
  keyword:    0.20,
  importance: 0.20,
  recency:    0.10,
  graph:      0.10
};

// ─── Source labels ────────────────────────────────────────────────────────────

/** Retrieval backend source label constants. */
export const SOURCE = {
  VECTOR:  "vector",
  KEYWORD: "keyword",
  GRAPH:   "graph",
  UNKNOWN: "unknown"
};

// ─── JSDoc typedefs (documentation only — JS has no type enforcement) ─────────

/**
 * @typedef {object} HybridWeights
 * @property {number} vector     - Weight for cosine similarity from Qdrant (0–1)
 * @property {number} keyword    - Weight for token-overlap keyword score (0–1)
 * @property {number} importance - Weight for stored importance metadata (0–1)
 * @property {number} recency    - Weight for exponential recency decay (0–1)
 * @property {number} graph      - Weight for Neo4j graph-neighbourhood score (0–1)
 */

/**
 * @typedef {object} HybridEnvelope
 * @property {number}   finalScore       - Weighted combination of all signals
 * @property {number}   vectorScore      - Cosine similarity contribution
 * @property {number}   keywordScore     - Keyword-overlap contribution
 * @property {number}   importanceScore  - Stored importance value
 * @property {number}   recencyScore     - Exponential decay factor
 * @property {number}   graphScore       - Graph-neighbourhood contribution
 * @property {number}   accessFreqBonus  - Log-scaled access-frequency bonus
 * @property {string[]} sources          - Backend(s) that produced this result
 * @property {string}   reason           - Human-readable selection explanation
 * @property {HybridWeights} weights     - The effective weights used
 */

/**
 * @typedef {object} RankedMemory
 * @property {string}        id
 * @property {string}        content
 * @property {string}        [summary]
 * @property {object}        metadata
 * @property {HybridEnvelope} _hybrid
 */
