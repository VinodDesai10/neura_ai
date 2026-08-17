/**
 * packages/core/src/memory/lifecycle/lifecycleManager.js
 *
 * Orchestrates lifecycle state transitions for stored memories.
 *
 * ─── Public API ───────────────────────────────────────────────────────────────
 *
 *   evaluateMemory(memory, config?)          → { state, signals, shouldUpdate }
 *   markStale(memory)                        → object  (updated memory)
 *   markConflicted(memory, conflicts)        → object  (updated memory)
 *   archiveMemory(memory)                    → object  (updated memory)
 *   reviveMemory(memory)                     → object  (updated memory)
 *   processUserMemories(userId, storageRouter, config?)  → ProcessResult
 *
 * ─── Rules ────────────────────────────────────────────────────────────────────
 *
 *   evaluateMemory drives transitions.  It is called on every processUserMemories
 *   sweep and returns the recommended new state without mutating anything.
 *   The caller (or processUserMemories) decides whether to persist.
 *
 *   Transitions:
 *     ACTIVE  → STALE      when shouldMarkStale() is true
 *     ACTIVE  → ARCHIVED   not directly — must go through STALE first
 *     STALE   → ARCHIVED   when shouldArchive() is true
 *     STALE   → ACTIVE     when reviveMemory() is called
 *     ARCHIVED → ACTIVE    when reviveMemory() is called (explicit revive)
 *     any     → CONFLICTED when markConflicted() is called externally
 *     CONFLICTED → ARCHIVED when archiveMemory() is called after resolution
 *
 * ─── Tier alignment ───────────────────────────────────────────────────────────
 *
 *   The lifecycle system nudges memories into the right physical tier by
 *   setting `metadata.tier` on the updated record.  The existing tierManager
 *   is used for the final determineTier() call, so tiers stay consistent.
 *
 *   ACTIVE     → HOT or WARM (tierManager decides)
 *   STALE      → WARM (forced)
 *   CONFLICTED → WARM (forced)
 *   ARCHIVED   → COLD (forced)
 *
 * ─── No monolith rule ─────────────────────────────────────────────────────────
 *
 *   Heavy lifting is delegated:
 *     computeLifecycleSignals → lifecycleScorer.js
 *     shouldMarkStale / shouldArchive → lifecycleScorer.js
 *     conflict detection → conflictDetector.js
 *     tier constants → tierManager.js
 */

import { determineTier, Tier } from "../services/tierManager.js";
import { computeLifecycleSignals, shouldMarkStale, shouldArchive } from "./lifecycleScorer.js";
import { detectConflicts } from "./conflictDetector.js";
import {
  LifecycleState,
  LIFECYCLE_TIER_HINT,
  readLifecycleConfig
} from "./lifecycleTypes.js";

// ─── Metadata helpers ─────────────────────────────────────────────────────────

/**
 * Return an updated copy of `memory` with lifecycle state stamped into
 * `metadata.lifecycleState`.  Immutable — original is not mutated.
 *
 * @param {object} memory
 * @param {string} state  - One of LifecycleState values
 * @param {object} [extra] - Additional metadata fields to merge
 * @returns {object}
 */
function withLifecycleState(memory, state, extra = {}) {
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
 * Return the physical tier that should hold a memory with `state`.
 *
 * For ACTIVE memories we let the existing tier manager decide (it considers
 * last-access recency and importance).  For STALE, CONFLICTED, and ARCHIVED
 * we override with the lifecycle tier hint.
 *
 * @param {object} memory
 * @param {string} state
 * @returns {string}  tier name
 */
function resolveTargetTier(memory, state) {
  if (state === LifecycleState.ACTIVE) {
    return determineTier(memory); // existing logic handles HOT / WARM / COLD
  }
  return LIFECYCLE_TIER_HINT[state] ?? Tier.WARM;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Evaluate the recommended lifecycle state for a memory without mutating it.
 *
 * @param {object} memory
 * @param {ReturnType<import("./lifecycleTypes.js").readLifecycleConfig>} [config]
 * @param {number} [nowMs]
 * @returns {{
 *   state:        string,    // recommended LifecycleState
 *   currentState: string,    // state currently stored in metadata
 *   signals:      import("./lifecycleTypes.js").LifecycleSignals,
 *   shouldUpdate: boolean    // true when recommended state ≠ current state
 * }}
 */
export function evaluateMemory(memory, config, nowMs) {
  const cfg          = config ?? readLifecycleConfig();
  const currentState = memory?.metadata?.lifecycleState ?? LifecycleState.ACTIVE;
  const signals      = computeLifecycleSignals(memory, nowMs);

  // ARCHIVED memories stay archived unless explicitly revived.
  if (currentState === LifecycleState.ARCHIVED) {
    return { state: LifecycleState.ARCHIVED, currentState, signals, shouldUpdate: false };
  }

  // STALE → ARCHIVED promotion
  if (currentState === LifecycleState.STALE || currentState === LifecycleState.CONFLICTED) {
    if (shouldArchive(signals, memory, cfg)) {
      return { state: LifecycleState.ARCHIVED, currentState, signals, shouldUpdate: true };
    }
    // Stay stale/conflicted
    return { state: currentState, currentState, signals, shouldUpdate: false };
  }

  // ACTIVE → STALE
  if (shouldMarkStale(signals, memory, cfg)) {
    return { state: LifecycleState.STALE, currentState, signals, shouldUpdate: true };
  }

  // ACTIVE stays ACTIVE
  return { state: LifecycleState.ACTIVE, currentState, signals, shouldUpdate: false };
}

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
      merged[idx] = newConflict; // update existing record
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

/**
 * Sweep all memories for a user, evaluate their lifecycle state, run
 * conflict detection, and persist any state changes via `storageRouter`.
 *
 * @param {string}  userId
 * @param {{
 *   searchUserMemories: (userId: string) => Promise<object[]>,
 *   updateMemory:       (id: string, patch: object) => Promise<object|null>
 * }} storageRouter
 * @param {ReturnType<import("./lifecycleTypes.js").readLifecycleConfig>} [config]
 * @returns {Promise<{
 *   evaluated: number,
 *   transitions: Array<{ id: string, from: string, to: string }>,
 *   conflicts:   Array<{ id: string, conflictCount: number }>,
 *   errors:      Array<{ id: string, error: string }>
 * }>}
 */
export async function processUserMemories(userId, storageRouter, config) {
  const cfg = config ?? readLifecycleConfig();

  /** @type {object[]} */
  let allMemories;
  try {
    allMemories = await storageRouter.searchUserMemories(userId);
  } catch (err) {
    return {
      evaluated:   0,
      transitions: [],
      conflicts:   [],
      errors:      [{ id: "load", error: err instanceof Error ? err.message : String(err) }]
    };
  }

  const transitions = [];
  const conflictsOut = [];
  const errors       = [];

  for (const memory of allMemories) {
    if (!memory?.id) continue;

    try {
      const currentState = memory?.metadata?.lifecycleState ?? LifecycleState.ACTIVE;

      // Skip archived — no automatic transitions out of ARCHIVED.
      if (currentState === LifecycleState.ARCHIVED) continue;

      // ── Step 1: evaluate age / access signals ───────────────────────────────
      const evaluation = evaluateMemory(memory, cfg);
      let updated      = memory;
      let newState     = currentState;

      if (evaluation.shouldUpdate) {
        if (evaluation.state === LifecycleState.ARCHIVED) {
          updated  = archiveMemory(memory);
        } else if (evaluation.state === LifecycleState.STALE) {
          updated  = markStale(memory);
        }
        newState = evaluation.state;
      }

      // ── Step 2: conflict detection (run for ACTIVE and STALE memories) ──────
      if (
        newState !== LifecycleState.ARCHIVED &&
        newState !== LifecycleState.CONFLICTED
      ) {
        // Compare against all other memories (exclude self)
        const peers  = allMemories.filter((m) => m.id !== memory.id);
        const result = detectConflicts(updated, peers, cfg);

        if (result.hasConflict) {
          updated   = markConflicted(updated, result.conflicts);
          newState  = LifecycleState.CONFLICTED;
          conflictsOut.push({
            id:            memory.id,
            conflictCount: result.conflicts.length
          });
        }
      }

      // ── Step 3: persist if anything changed ─────────────────────────────────
      const stateChanged = newState !== currentState;
      const conflictsChanged =
        newState === LifecycleState.CONFLICTED &&
        currentState !== LifecycleState.CONFLICTED;

      if (stateChanged || conflictsChanged) {
        await storageRouter.updateMemory(memory.id, { metadata: updated.metadata });
        transitions.push({ id: memory.id, from: currentState, to: newState });
      }
    } catch (err) {
      errors.push({
        id:    memory.id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return {
    evaluated:   allMemories.length,
    transitions,
    conflicts:   conflictsOut,
    errors
  };
}
