/**
 * packages/core/src/memory/lifecycle/stateTransitions.js
 *
 * Pure, stateless lifecycle state-transition helpers.
 *
 * This module owns:
 *   • withLifecycleState  — immutable metadata stamper
 *   • resolveTargetTier   — map lifecycle state → physical tier
 *   • applyTransition     — state-machine: given signals + current state, return next state
 *   • markStale           — convenience wrapper: stamp STALE + WARM tier
 *   • markConflicted      — stamp CONFLICTED + merge conflict records
 *   • archiveMemory       — stamp ARCHIVED + COLD tier
 *   • reviveMemory        — stamp ACTIVE + re-run tierManager
 *
 * ─── Design principles ────────────────────────────────────────────────────────
 *
 *   • No I/O, no side-effects.  All functions are pure (return new objects).
 *   • No circular imports: only imports from lifecycleTypes, lifecycleScorer,
 *     and tierManager (no import of lifecycleManager).
 *   • The state machine rules are the single source of truth for transitions.
 *
 * ─── State machine ────────────────────────────────────────────────────────────
 *
 *   ARCHIVED              → stays ARCHIVED (no auto-transition out)
 *   STALE | CONFLICTED
 *     shouldArchive()     → ARCHIVED
 *     otherwise           → stays (STALE or CONFLICTED)
 *   ACTIVE
 *     shouldMarkStale()   → STALE
 *     otherwise           → stays ACTIVE
 */

import { determineTier, Tier } from "../services/tierManager.js";
import { computeLifecycleSignals, shouldMarkStale, shouldArchive } from "./lifecycleScorer.js";
import { LifecycleState, LIFECYCLE_TIER_HINT, readLifecycleConfig } from "./lifecycleTypes.js";

// ─── Core primitives ──────────────────────────────────────────────────────────

/**
 * Return a shallow-merged copy of `memory` with `lifecycleState` and
 * `updatedAt` stamped into `metadata`, plus any extra metadata fields.
 * The original object is never mutated.
 *
 * @param {object} memory
 * @param {string} state   - One of LifecycleState values
 * @param {object} [extra] - Additional metadata fields to merge in
 * @returns {object}
 */
export function withLifecycleState(memory, state, extra = {}) {
  return {
    ...memory,
    metadata: {
      ...memory.metadata,
      lifecycleState: state,
      updatedAt: new Date().toISOString(),
      ...extra
    }
  };
}

/**
 * Return the physical tier appropriate for a memory in `state`.
 *
 * ACTIVE memories are handed to the existing `determineTier` logic so that
 * HOT vs WARM is decided by access recency and importance — the lifecycle
 * system does not override that.  All other states map to fixed tiers via
 * LIFECYCLE_TIER_HINT.
 *
 * @param {object} memory
 * @param {string} state
 * @returns {string}  tier name
 */
export function resolveTargetTier(memory, state) {
  if (state === LifecycleState.ACTIVE) {
    return determineTier(memory);
  }
  return LIFECYCLE_TIER_HINT[state] ?? Tier.WARM;
}

// ─── State machine ────────────────────────────────────────────────────────────

/**
 * Evaluate the recommended lifecycle state for a memory without mutating it.
 *
 * This is the single authoritative place where the state machine runs.
 * `lifecycleManager.evaluateMemory` delegates to this function.
 *
 * @param {object} memory
 * @param {ReturnType<import("./lifecycleTypes.js").readLifecycleConfig>} [config]
 * @param {number} [nowMs]
 * @returns {{
 *   state:        string,   // recommended next LifecycleState
 *   currentState: string,   // state currently stored in metadata
 *   signals:      import("./lifecycleTypes.js").LifecycleSignals,
 *   shouldUpdate: boolean   // true when recommended state ≠ current state
 * }}
 */
export function applyTransition(memory, config, nowMs) {
  const cfg          = config ?? readLifecycleConfig();
  const currentState = memory?.metadata?.lifecycleState ?? LifecycleState.ACTIVE;
  const signals      = computeLifecycleSignals(memory, nowMs);

  // ARCHIVED memories stay archived unless explicitly revived.
  if (currentState === LifecycleState.ARCHIVED) {
    return { state: LifecycleState.ARCHIVED, currentState, signals, shouldUpdate: false };
  }

  // STALE / CONFLICTED → check for promotion to ARCHIVED
  if (currentState === LifecycleState.STALE || currentState === LifecycleState.CONFLICTED) {
    if (shouldArchive(signals, memory, cfg)) {
      return { state: LifecycleState.ARCHIVED, currentState, signals, shouldUpdate: true };
    }
    return { state: currentState, currentState, signals, shouldUpdate: false };
  }

  // ACTIVE → check for demotion to STALE
  if (shouldMarkStale(signals, memory, cfg)) {
    return { state: LifecycleState.STALE, currentState, signals, shouldUpdate: true };
  }

  // ACTIVE stays ACTIVE
  return { state: LifecycleState.ACTIVE, currentState, signals, shouldUpdate: false };
}

// ─── Mutation helpers ─────────────────────────────────────────────────────────

/**
 * Return a copy of `memory` stamped with STALE state and moved to WARM tier.
 *
 * @param {object} memory
 * @returns {object}
 */
export function markStale(memory) {
  return withLifecycleState(memory, LifecycleState.STALE, { tier: Tier.WARM });
}

/**
 * Return a copy of `memory` stamped with CONFLICTED state, including
 * the supplied conflict records in `metadata.conflicts`.
 *
 * Existing conflicts are merged (deduplicated by conflictingId) so that
 * repeated calls accumulate conflict history rather than overwriting it.
 *
 * @param {object} memory
 * @param {import("./lifecycleTypes.js").ConflictRecord[]} conflicts
 * @returns {object}
 */
export function markConflicted(memory, conflicts) {
  const existing = Array.isArray(memory?.metadata?.conflicts)
    ? memory.metadata.conflicts
    : [];

  // Merge: new conflicts win for the same conflictingId.
  const merged = [...existing];
  for (const newConflict of conflicts) {
    const idx = merged.findIndex((c) => c.conflictingId === newConflict.conflictingId);
    if (idx >= 0) {
      merged[idx] = newConflict;
    } else {
      merged.push(newConflict);
    }
  }

  return withLifecycleState(memory, LifecycleState.CONFLICTED, {
    tier:      Tier.WARM,
    conflicts: merged
  });
}

/**
 * Return a copy of `memory` stamped with ARCHIVED state and moved to COLD tier.
 *
 * @param {object} memory
 * @returns {object}
 */
export function archiveMemory(memory) {
  return withLifecycleState(memory, LifecycleState.ARCHIVED, { tier: Tier.COLD });
}

/**
 * Revive an ARCHIVED, STALE, or CONFLICTED memory back to ACTIVE.
 *
 * Clears the `conflicts` field and re-runs `determineTier` so the memory
 * lands in the right physical tier given its current importance / recency.
 *
 * @param {object} memory
 * @returns {object}
 */
export function reviveMemory(memory) {
  const revivedTier = determineTier(memory);
  return withLifecycleState(memory, LifecycleState.ACTIVE, {
    tier:      revivedTier,
    conflicts: []
  });
}
