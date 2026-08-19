/**
 * packages/core/src/memory/lifecycle/lifecycleManager.js
 *
 * Thin orchestration layer for memory lifecycle management.
 *
 * ─── Public API ───────────────────────────────────────────────────────────────
 *
 *   evaluateMemory(memory, config?, nowMs?)          → EvaluationResult
 *   markStale(memory)                                → object
 *   markConflicted(memory, conflicts)                → object
 *   archiveMemory(memory)                            → object
 *   reviveMemory(memory)                             → object
 *   processUserMemories(userId, storageRouter, cfg?) → Promise<ProcessResult>
 *
 * ─── Delegation map ───────────────────────────────────────────────────────────
 *
 *   State machine / stamping  →  stateTransitions.js
 *   Conflict pre-filtering    →  conflictCandidates.js
 *   Signal computation        →  lifecycleScorer.js
 *   Conflict detection        →  conflictDetector.js
 *   Type / config constants   →  lifecycleTypes.js
 */

import { readLifecycleConfig, LifecycleState } from "./lifecycleTypes.js";
import { detectConflicts }                      from "./conflictDetector.js";
import { filterConflictCandidates }             from "./conflictCandidates.js";
import {
  applyTransition,
  withLifecycleState,   // re-exported for index.js barrel if needed
  resolveTargetTier,    // re-exported for index.js barrel if needed
  markStale     as _markStale,
  markConflicted as _markConflicted,
  archiveMemory  as _archiveMemory,
  reviveMemory   as _reviveMemory
} from "./stateTransitions.js";
import { NOOP_SYNC_SERVICE } from "./lifecycleSyncService.js";

// ─── Public API — state helpers (re-exported from stateTransitions) ───────────

/** @type {typeof _markStale} */
export const markStale      = _markStale;

/** @type {typeof _markConflicted} */
export const markConflicted = _markConflicted;

/** @type {typeof _archiveMemory} */
export const archiveMemory  = _archiveMemory;

/** @type {typeof _reviveMemory} */
export const reviveMemory   = _reviveMemory;

// ─── Public API — evaluation ──────────────────────────────────────────────────

/**
 * Evaluate the recommended lifecycle state for a memory without mutating it.
 *
 * Delegates entirely to `applyTransition` in stateTransitions.js.
 *
 * @param {object} memory
 * @param {ReturnType<import("./lifecycleTypes.js").readLifecycleConfig>} [config]
 * @param {number} [nowMs]
 * @returns {{
 *   state:        string,
 *   currentState: string,
 *   signals:      import("./lifecycleTypes.js").LifecycleSignals,
 *   shouldUpdate: boolean
 * }}
 */
export function evaluateMemory(memory, config, nowMs) {
  return applyTransition(memory, config ?? readLifecycleConfig(), nowMs);
}

// ─── Public API — batch sweep ─────────────────────────────────────────────────

/**
 * Sweep all memories for a user:
 *   1. Evaluate age / access signals → apply state transitions.
 *   2. Pre-filter conflict candidates (cheap metadata checks).
 *   3. Run full conflict detection only on filtered candidates.
 *   4. Persist any changed memories via storageRouter (tier repositories).
 *   5. Fan out the new lifecycle state to all secondary stores via syncService
 *      (PostgreSQL factual_memories, Qdrant payload, Neo4j Memory node).
 *
 * The conflict pre-filter (stage 2) eliminates unrelated memories before
 * any similarity computation occurs, reducing the effective complexity from
 * O(N²) to O(N × K) where K << N for typical memory sets.
 *
 * Partial-failure handling (stage 5):
 *   A failure in one secondary store never rolls back the tier-repository
 *   update and never aborts the sweep.  Sync failures are captured in
 *   `result.syncFailures` so callers can log / retry them.
 *
 * @param {string} userId
 * @param {{
 *   searchUserMemories: (userId: string) => Promise<object[]>,
 *   updateMemory:       (id: string, patch: object) => Promise<object|null>
 * }} storageRouter
 * @param {ReturnType<import("./lifecycleTypes.js").readLifecycleConfig>} [config]
 * @param {{ syncLifecycleState(memory: object): Promise<object> }} [syncService]
 *   Optional lifecycle sync service.  When omitted the tier update is the
 *   only persistence step (no Postgres/Qdrant/Neo4j propagation).
 * @returns {Promise<{
 *   evaluated:    number,
 *   transitions:  Array<{ id: string, from: string, to: string }>,
 *   conflicts:    Array<{ id: string, conflictCount: number }>,
 *   errors:       Array<{ id: string, error: string }>,
 *   syncFailures: Array<{ id: string, backend: string, error: string }>
 * }>}
 */
export async function processUserMemories(userId, storageRouter, config, syncService) {
  const cfg          = config ?? readLifecycleConfig();
  const syncSvc      = syncService ?? NOOP_SYNC_SERVICE;

  /** @type {object[]} */
  let allMemories;
  try {
    allMemories = await storageRouter.searchUserMemories(userId);
  } catch (err) {
    return {
      evaluated:    0,
      transitions:  [],
      conflicts:    [],
      errors:       [{ id: "load", error: err instanceof Error ? err.message : String(err) }],
      syncFailures: []
    };
  }

  const transitions  = [];
  const conflictsOut = [];
  const errors       = [];
  const syncFailures = [];

  for (const memory of allMemories) {
    if (!memory?.id) continue;

    try {
      const currentState = memory?.metadata?.lifecycleState ?? LifecycleState.ACTIVE;

      // Skip archived — no automatic transitions out of ARCHIVED.
      if (currentState === LifecycleState.ARCHIVED) continue;

      // ── Step 1: evaluate age / access signals ──────────────────────────────
      const evaluation = applyTransition(memory, cfg);
      let updated      = memory;
      let newState     = currentState;

      if (evaluation.shouldUpdate) {
        if (evaluation.state === LifecycleState.ARCHIVED) {
          updated  = _archiveMemory(memory);
        } else if (evaluation.state === LifecycleState.STALE) {
          updated  = _markStale(memory);
        }
        newState = evaluation.state;
      }

      // ── Step 2: conflict detection (ACTIVE and STALE only) ─────────────────
      if (
        newState !== LifecycleState.ARCHIVED &&
        newState !== LifecycleState.CONFLICTED
      ) {
        // Pre-filter: only pass candidates that share type, category, and tokens.
        // This is the key optimisation — eliminates O(n²) similarity calls for
        // unrelated memories.
        const candidates = filterConflictCandidates(updated, allMemories);
        const result     = detectConflicts(updated, candidates, cfg);

        if (result.hasConflict) {
          updated  = _markConflicted(updated, result.conflicts);
          newState = LifecycleState.CONFLICTED;
          conflictsOut.push({
            id:            memory.id,
            conflictCount: result.conflicts.length
          });
        }
      }

      // ── Step 3: persist tier repositories if anything changed ──────────────
      const stateChanged     = newState !== currentState;
      const conflictsChanged =
        newState === LifecycleState.CONFLICTED &&
        currentState !== LifecycleState.CONFLICTED;

      if (stateChanged || conflictsChanged) {
        await storageRouter.updateMemory(memory.id, { metadata: updated.metadata });
        transitions.push({ id: memory.id, from: currentState, to: newState });

        // ── Step 4: fan out to secondary stores ─────────────────────────────
        // syncLifecycleState never throws — it returns a SyncResult.
        const syncResult = await syncSvc.syncLifecycleState(updated);
        if (!syncResult.success) {
          for (const failure of syncResult.failures) {
            syncFailures.push({ id: memory.id, ...failure });
          }
        }
      }
    } catch (err) {
      errors.push({
        id:    memory.id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return {
    evaluated:    allMemories.length,
    transitions,
    conflicts:    conflictsOut,
    errors,
    syncFailures
  };
}
