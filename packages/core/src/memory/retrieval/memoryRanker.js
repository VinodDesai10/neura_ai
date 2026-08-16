/**
 * packages/core/src/memory/retrieval/memoryRanker.js
 *
 * Weighted scoring, sorting and limiting for the hybrid retrieval pipeline.
 *
 * Takes a pre-fetched list of annotated memory candidates (produced by
 * `candidateFetcher.fetchCandidates`) and applies the full hybrid formula to
 * compute a `finalScore` for each.  Results are returned sorted by
 * `finalScore` descending and trimmed to `topK`.
 *
 * ─── Scoring formula ──────────────────────────────────────────────────────────
 *
 *   finalScore = min(1,
 *     vectorScore             * weights.vector     +
 *     keywordScore            * weights.keyword    +
 *     blendedImportanceScore  * weights.importance +   ← importance + accessFreqBonus
 *     recencyScore            * weights.recency    +
 *     graphScore              * weights.graph
 *   )
 *
 * ─── Public API ───────────────────────────────────────────────────────────────
 *
 *   rankMemories(candidates, options?) → RankedMemory[]
 */

import { readRetrievalConfig } from "@neura/shared";
import { SOURCE }              from "./retrievalTypes.js";
import {
  resolveWeights,
  computeKeywordScore,
  computeRecencyScore,
  computeAccessFreqBonus,
  buildReason
} from "./signalScorer.js";

// ─── Ranker ───────────────────────────────────────────────────────────────────

/**
 * Apply the weighted hybrid formula to a list of candidates and return them
 * sorted by `finalScore` descending, trimmed to `topK`.
 *
 * Candidates are typically produced by `candidateFetcher.fetchCandidates()`
 * but the function is also callable independently — bare memory objects
 * (without a `_hybrid` envelope) are handled gracefully.
 *
 * @param {object[]} candidates  – Annotated candidates or bare memory objects.
 * @param {{
 *   topK?:          number,
 *   weights?:       Partial<import("./retrievalTypes.js").HybridWeights>,
 *   halfLifeHours?: number,
 *   minFinalScore?: number
 * }} [options]
 * @returns {import("./retrievalTypes.js").RankedMemory[]}
 */
export function rankMemories(candidates, options = {}) {
  if (!candidates || candidates.length === 0) return [];

  const cfg      = readRetrievalConfig();
  const topK     = options.topK         ?? cfg.topK;
  const halfLife = options.halfLifeHours ?? cfg.recencyHalfLifeHours;
  const weights  = resolveWeights(options.weights);
  const minScore = options.minFinalScore ?? 0;

  const ranked = candidates.map((memory) => {
    const h    = memory._hybrid || {};
    const meta = memory.metadata || {};

    const vectorScore = h.vectorScore ?? 0;

    // If keywordScore wasn't pre-computed (bare memory object), compute now.
    // There is no query available at rank-only time so it defaults to 0.
    const keywordScore = (h.keywordScore != null)
      ? h.keywordScore
      : computeKeywordScore("", memory.summary || memory.content || "");

    const importanceScore = Math.max(
      0,
      Math.min(1, Number(meta.importance ?? 0))
    );
    const recencyScore = computeRecencyScore(
      meta.timestamp ?? null,
      halfLife
    );
    const graphScore      = h.graphScore   ?? 0;
    const accessFreqBonus = computeAccessFreqBonus(meta.accessCount ?? 0);

    // Blend stored importance with the access-frequency bonus
    const blendedImportance = Math.min(1, importanceScore + accessFreqBonus);

    const finalScore = Math.min(
      1,
      vectorScore       * weights.vector     +
      keywordScore      * weights.keyword    +
      blendedImportance * weights.importance +
      recencyScore      * weights.recency    +
      graphScore        * weights.graph
    );

    const sources = (h.sources && h.sources.length > 0)
      ? h.sources
      : [SOURCE.UNKNOWN];

    const reason = buildReason({
      vectorScore,
      keywordScore,
      importanceScore: blendedImportance,
      recencyScore,
      graphScore,
      sources
    });

    // Strip internal staging `_hybrid` and replace with the final envelope
    const { _hybrid: _old, ...baseMemory } = memory;

    return {
      ...baseMemory,
      _hybrid: {
        finalScore,
        vectorScore,
        keywordScore,
        importanceScore,
        recencyScore,
        graphScore,
        accessFreqBonus,
        sources,
        reason,
        weights
      }
    };
  });

  return ranked
    .filter((m) => m._hybrid.finalScore > minScore)
    .sort((a, b) => b._hybrid.finalScore - a._hybrid.finalScore)
    .slice(0, topK);
}
