/**
 * packages/core/src/memory/lifecycle/retrievalIntegration.js
 *
 * Integrates lifecycle state into the hybrid retrieval pipeline.
 *
 * ─── Behaviour ────────────────────────────────────────────────────────────────
 *
 *   ACTIVE     → normal retrieval, no score adjustment
 *   STALE      → finalScore × staleScorePenalty (default 0.60)
 *   CONFLICTED → finalScore × conflictScorePenalty (default 0.80) +
 *                conflict metadata attached to _hybrid envelope
 *   ARCHIVED   → excluded from normal retrieval unless `includeArchived=true`
 *
 * ─── Public API ───────────────────────────────────────────────────────────────
 *
 *   applyLifecyclePenalty(rankedMemory, config?)
 *     → RankedMemory   (score adjusted, lifecycle info in _hybrid)
 *
 *   filterArchivedFromRetrieval(rankedMemories, options?)
 *     → RankedMemory[]
 *
 *   withLifecycleContext(rankedMemories, options?)
 *     → RankedMemory[]  (apply penalties + filter in one pass)
 */

import { LifecycleState, readLifecycleConfig } from "./lifecycleTypes.js";

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Apply a lifecycle penalty to a single ranked memory.
 *
 * Modifies `_hybrid.finalScore` in-place on a shallow copy (the original
 * is not mutated) and adds `_hybrid.lifecycle` metadata with:
 *   - state:           the lifecycle state
 *   - penaltyApplied:  the multiplier used (1.0 = no penalty)
 *   - conflicts:       array of ConflictRecord from metadata.conflicts (if any)
 *
 * @param {object} rankedMemory  - A RankedMemory object (has a `_hybrid` envelope).
 * @param {ReturnType<import("./lifecycleTypes.js").readLifecycleConfig>} [config]
 * @returns {object}  Updated RankedMemory with adjusted score.
 */
export function applyLifecyclePenalty(rankedMemory, config) {
  const cfg   = config ?? readLifecycleConfig();
  const state = rankedMemory?.metadata?.lifecycleState ?? LifecycleState.ACTIVE;
  const h     = rankedMemory?._hybrid ?? {};

  let penalty     = 1.0;
  let penaltyNote = null;

  switch (state) {
    case LifecycleState.STALE:
      penalty     = cfg.staleScorePenalty;
      penaltyNote = `stale penalty ×${penalty}`;
      break;
    case LifecycleState.CONFLICTED:
      penalty     = cfg.conflictScorePenalty;
      penaltyNote = `conflict penalty ×${penalty}`;
      break;
    case LifecycleState.ARCHIVED:
      // Archived should be filtered out, but if it slips through penalise
      // heavily so it never surfaces above live memories.
      penalty     = 0.1;
      penaltyNote = "archived — heavy penalty";
      break;
    default:
      // ACTIVE — no change
      break;
  }

  const adjustedFinalScore = Math.max(0, Math.min(1, (h.finalScore ?? 0) * penalty));

  const lifecycle = {
    state,
    penaltyApplied: penalty,
    penaltyNote,
    conflicts: Array.isArray(rankedMemory?.metadata?.conflicts)
      ? rankedMemory.metadata.conflicts
      : []
  };

  // Build the reason string incorporating lifecycle context.
  const baseReason = h.reason ?? "";
  const lifecycleReason = penaltyNote
    ? `${baseReason} [lifecycle: ${penaltyNote}]`
    : baseReason;

  return {
    ...rankedMemory,
    _hybrid: {
      ...h,
      finalScore: adjustedFinalScore,
      reason:     lifecycleReason,
      lifecycle
    }
  };
}

/**
 * Remove ARCHIVED memories from a ranked list.
 *
 * @param {object[]} rankedMemories  - Output of rankMemories().
 * @param {{ includeArchived?: boolean }} [options]
 * @returns {object[]}
 */
export function filterArchivedFromRetrieval(rankedMemories, options = {}) {
  if (options.includeArchived) return rankedMemories;

  return rankedMemories.filter(
    (m) => (m?.metadata?.lifecycleState ?? LifecycleState.ACTIVE) !== LifecycleState.ARCHIVED
  );
}

/**
 * Apply lifecycle penalties and archive filtering to a full ranked list.
 *
 * This is the convenience function to call after `rankMemories()`.
 * Internally it:
 *   1. Filters out ARCHIVED memories (unless `options.includeArchived = true`).
 *   2. Applies score penalties to STALE and CONFLICTED memories.
 *   3. Re-sorts by the adjusted `_hybrid.finalScore` descending.
 *   4. Trims to `topK` if provided.
 *
 * @param {object[]} rankedMemories
 * @param {{
 *   includeArchived?: boolean,
 *   topK?:            number,
 *   config?:          ReturnType<import("./lifecycleTypes.js").readLifecycleConfig>
 * }} [options]
 * @returns {object[]}
 */
export function withLifecycleContext(rankedMemories, options = {}) {
  const cfg = options.config ?? readLifecycleConfig();

  // Step 1: filter archived
  const visible = filterArchivedFromRetrieval(rankedMemories, options);

  // Step 2: apply penalties
  const penalised = visible.map((m) => applyLifecyclePenalty(m, cfg));

  // Step 3: re-sort by adjusted score
  penalised.sort((a, b) => (b._hybrid?.finalScore ?? 0) - (a._hybrid?.finalScore ?? 0));

  // Step 4: trim to topK if provided
  if (typeof options.topK === "number" && options.topK > 0) {
    return penalised.slice(0, options.topK);
  }

  return penalised;
}
