/**
 * packages/core/src/memory/lifecycle/index.js
 *
 * Public barrel for the Memory Lifecycle Management system.
 *
 * ─── What this module provides ────────────────────────────────────────────────
 *
 *   Types / constants (lifecycleTypes.js)
 *     LifecycleState       — ACTIVE | STALE | CONFLICTED | ARCHIVED
 *     VALID_LIFECYCLE_STATES
 *     LIFECYCLE_DEFAULTS
 *     LIFECYCLE_CONFIG_KEYS
 *     LIFECYCLE_TIER_HINT
 *     readLifecycleConfig
 *
 *   Scoring signals (lifecycleScorer.js)
 *     computeLifecycleSignals
 *     shouldMarkStale
 *     shouldArchive
 *
 *   Conflict detection (conflictDetector.js)
 *     detectConflicts
 *     buildConflictRecord
 *
 *   Lifecycle manager (lifecycleManager.js)
 *     evaluateMemory
 *     markStale
 *     markConflicted
 *     archiveMemory
 *     reviveMemory
 *     processUserMemories
 *
 *   Retrieval integration (retrievalIntegration.js)
 *     applyLifecyclePenalty
 *     filterArchivedFromRetrieval
 *     withLifecycleContext
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export {
  LifecycleState,
  VALID_LIFECYCLE_STATES,
  LIFECYCLE_DEFAULTS,
  LIFECYCLE_CONFIG_KEYS,
  LIFECYCLE_TIER_HINT,
  readLifecycleConfig
} from "./lifecycleTypes.js";

// ─── Scorer ───────────────────────────────────────────────────────────────────

export {
  computeLifecycleSignals,
  shouldMarkStale,
  shouldArchive
} from "./lifecycleScorer.js";

// ─── Conflict detection ───────────────────────────────────────────────────────

export {
  detectConflicts,
  buildConflictRecord
} from "./conflictDetector.js";

// ─── Lifecycle manager ────────────────────────────────────────────────────────

export {
  evaluateMemory,
  markStale,
  markConflicted,
  archiveMemory,
  reviveMemory,
  processUserMemories
} from "./lifecycleManager.js";

// ─── Retrieval integration ────────────────────────────────────────────────────

export {
  applyLifecyclePenalty,
  filterArchivedFromRetrieval,
  withLifecycleContext
} from "./retrievalIntegration.js";
