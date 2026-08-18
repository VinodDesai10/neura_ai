/**
 * packages/core/src/memory/consolidation/consolidationRetrieval.js
 *
 * Integrates consolidated memories into the hybrid retrieval pipeline.
 *
 * ─── Behaviour ────────────────────────────────────────────────────────────────
 *
 *   ACTIVE     → retrieved normally; scored as a regular memory but tagged
 *                as a consolidation so the caller can treat it distinctly.
 *   STALE      → retrieved with a reduced score (staleScorePenalty).
 *   CONFLICTED → retrieved with a conflict score penalty; the conflict
 *                metadata is attached in the _consolidation envelope.
 *   SUPERSEDED → excluded from normal retrieval.
 *
 * ─── Public API ───────────────────────────────────────────────────────────────
 *
 *   enrichWithConsolidations(rankedMemories, consolidationStore, options?)
 *     → Promise<RankedMemory[]>
 *       Merges the top consolidated memories for the user into the
 *       already-ranked result list without displacing source memories.
 *
 *   withSourceEvidence(consolidated, consolidationStore, storageRouter, options?)
 *     → Promise<{ consolidated, sources }>
 *       Fetch a consolidated memory and all its source memories together.
 *
 *   applyConsolidationScorePenalty(rankedConsolidated, config?)
 *     → object
 *       Apply lifecycle-style score penalties to a ranked consolidated memory.
 */

import { LifecycleState, readLifecycleConfig } from "../lifecycle/lifecycleTypes.js";
import { ConsolidationStatus }                 from "./consolidationTypes.js";

// ─── Score penalty for consolidated memories ──────────────────────────────────

/**
 * Apply status-based score penalties to a ranked consolidated memory.
 *
 * ACTIVE     → no penalty
 * STALE      → × staleScorePenalty  (default 0.60)
 * CONFLICTED → × conflictScorePenalty (default 0.80)
 * SUPERSEDED → × 0.05  (effectively hidden)
 *
 * @param {{
 *   consolidatedMemory: import("./consolidationTypes.js").ConsolidatedMemory,
 *   score: number,
 *   [key: string]: any
 * }} rankedConsolidated
 * @param {ReturnType<import("../lifecycle/lifecycleTypes.js").readLifecycleConfig>} [config]
 * @returns {object}  Shallow copy with adjusted score and _consolidation metadata.
 */
export function applyConsolidationScorePenalty(rankedConsolidated, config) {
  const cfg    = config ?? readLifecycleConfig();
  const status = rankedConsolidated?.consolidatedMemory?.status ?? ConsolidationStatus.ACTIVE;

  let penalty = 1.0;
  let penaltyNote = null;

  switch (status) {
    case ConsolidationStatus.STALE:
      penalty     = cfg.staleScorePenalty;
      penaltyNote = `consolidation stale ×${penalty}`;
      break;
    case ConsolidationStatus.CONFLICTED:
      penalty     = cfg.conflictScorePenalty;
      penaltyNote = `consolidation conflicted ×${penalty}`;
      break;
    case ConsolidationStatus.SUPERSEDED:
      penalty     = 0.05;
      penaltyNote = "consolidation superseded";
      break;
    default:
      break; // ACTIVE → no penalty
  }

  const adjustedScore = Math.max(0, Math.min(1, (rankedConsolidated.score ?? 0) * penalty));

  return {
    ...rankedConsolidated,
    score: adjustedScore,
    _consolidation: {
      ...(rankedConsolidated._consolidation ?? {}),
      status,
      penalty,
      penaltyNote,
      conflictMeta: rankedConsolidated?.consolidatedMemory?.conflictMeta ?? null
    }
  };
}

// ─── Retrieval integration ────────────────────────────────────────────────────

/**
 * Merge the top consolidated memories for a user into a ranked result list.
 *
 * Consolidated memories are NOT ranked by vector similarity (they have no
 * embedding yet).  Instead they are scored by (confidence × importanceScore)
 * and inserted at the appropriate position in the ranking.
 *
 * Consolidated memories are ALWAYS positioned after at least one real source
 * memory — they supplement, never displace, the evidence.
 *
 * Source memories that are already in the ranked list are NOT duplicated
 * even if they also appear as sources of a returned consolidation.
 *
 * @param {object[]} rankedMemories   - Current ranked result (RankedMemory[])
 * @param {{
 *   findByUserId: (userId: string) => Promise<import("./consolidationTypes.js").ConsolidatedMemory[]>
 * }} consolidationStore
 * @param {{
 *   userId?:           string,
 *   topK?:             number,
 *   includeSuperseded?: boolean,
 *   config?:            ReturnType<import("../lifecycle/lifecycleTypes.js").readLifecycleConfig>
 * }} [options]
 * @returns {Promise<object[]>}  Merged result set
 */
export async function enrichWithConsolidations(rankedMemories, consolidationStore, options = {}) {
  const userId = options.userId;
  if (!userId) return rankedMemories;

  let consolidations = [];
  try {
    consolidations = await consolidationStore.findByUserId(userId);
  } catch {
    return rankedMemories; // gracefully degrade if store fails
  }

  const cfg = options.config ?? readLifecycleConfig();

  // Filter out superseded unless explicitly requested
  const eligible = consolidations.filter((c) => {
    if (c.status === ConsolidationStatus.SUPERSEDED && !options.includeSuperseded) return false;
    return true;
  });

  if (eligible.length === 0) return rankedMemories;

  // Score each consolidation
  const ranked = eligible.map((c) => {
    const baseScore = c.confidence * c.importanceScore;
    return applyConsolidationScorePenalty(
      { consolidatedMemory: c, score: baseScore, isConsolidation: true },
      cfg
    );
  });

  // Sort by adjusted score descending
  ranked.sort((a, b) => b.score - a.score);

  // Cap the number of consolidations injected into the result
  const maxConsolidations = Math.min(options.topK ?? 3, ranked.length);
  const toInject = ranked.slice(0, maxConsolidations);

  // Inject after the first regular memory to ensure evidence precedes synthesis
  const result = [...rankedMemories];
  if (result.length === 0) {
    result.push(...toInject);
  } else {
    // Insert after index 0 (preserving top-ranked source as first result)
    result.splice(1, 0, ...toInject);
  }

  return result;
}

/**
 * Fetch a consolidated memory together with all its source memories.
 *
 * This is the primary provenance query entry point for callers that want
 * to display both the synthesised fact and the evidence behind it.
 *
 * @param {string} consolidatedId
 * @param {{
 *   get: (id: string) => Promise<import("./consolidationTypes.js").ConsolidatedMemory|null>
 * }} consolidationStoreRef
 * @param {{
 *   getMemory: (id: string) => Promise<object|null>
 * }} storageRouter
 * @returns {Promise<{
 *   consolidated: import("./consolidationTypes.js").ConsolidatedMemory|null,
 *   sources:      object[]
 * }>}
 */
export async function withSourceEvidence(consolidatedId, consolidationStoreRef, storageRouter) {
  const consolidated = await consolidationStoreRef.get(consolidatedId);
  if (!consolidated) return { consolidated: null, sources: [] };

  const sources = (
    await Promise.all(
      (consolidated.sourceMemoryIds ?? []).map((id) => storageRouter.getMemory(id))
    )
  ).filter(Boolean);

  return { consolidated, sources };
}
