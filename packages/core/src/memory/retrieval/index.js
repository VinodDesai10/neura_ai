/**
 * packages/core/src/memory/retrieval/index.js
 *
 * Public barrel for the hybrid retrieval pipeline.
 *
 * This module re-exports every symbol that callers outside this directory
 * need.  Internal cross-module imports should use direct file paths; this
 * barrel is for consumers in `../services/hybridRetrievalService.js` and
 * higher-level packages.
 *
 * ─── Exports ─────────────────────────────────────────────────────────────────
 *
 *   retrievalTypes.js
 *     HYBRID_WEIGHTS_DEFAULTS  – default weight set for the scoring formula
 *     SOURCE                   – backend source label constants
 *
 *   signalScorer.js
 *     resolveWeights           – merge weight overrides into defaults
 *     computeKeywordScore      – token-overlap score (0–1)
 *     computeRecencyScore      – exponential recency decay (0–1]
 *     computeAccessFreqBonus   – log-scaled access-frequency bonus (0–0.15]
 *     buildReason              – human-readable selection reason string
 *
 *   resultDeduplicator.js
 *     deduplicateById          – merge same-id results from multiple backends
 *
 *   candidateFetcher.js
 *     createCandidateFetcher   – factory for the fan-out backend fetcher
 *
 *   memoryRanker.js
 *     rankMemories             – apply weights, sort and limit candidates
 */

// ─── Types and constants ──────────────────────────────────────────────────────
export { HYBRID_WEIGHTS_DEFAULTS, SOURCE } from "./retrievalTypes.js";

// ─── Signal scoring (pure functions) ─────────────────────────────────────────
export {
  resolveWeights,
  computeKeywordScore,
  computeRecencyScore,
  computeAccessFreqBonus,
  buildReason
} from "./signalScorer.js";

// ─── Deduplication ────────────────────────────────────────────────────────────
export { deduplicateById } from "./resultDeduplicator.js";

// ─── Candidate fetcher ────────────────────────────────────────────────────────
export { createCandidateFetcher } from "./candidateFetcher.js";

// ─── Ranker ───────────────────────────────────────────────────────────────────
export { rankMemories } from "./memoryRanker.js";
