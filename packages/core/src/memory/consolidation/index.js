/**
 * packages/core/src/memory/consolidation/index.js
 *
 * Public barrel for the Memory Consolidation module.
 *
 * ─── Module structure ─────────────────────────────────────────────────────────
 *
 *   consolidationTypes.js      — Constants, enums, config reader, JSDoc typedefs
 *   candidateGrouping.js       — Lifecycle eligibility, token grouping, topic inference
 *   conflictResolution.js      — Conflict detection, severity, status determination
 *   consolidationBuilder.js    — Build a new ConsolidatedMemory from a group
 *   consolidationVersioning.js — Version updates, re-consolidation decisions, provenance
 *   consolidationEngine.js     — Thin orchestrator: candidate discovery + sweep
 *   consolidationStore.js      — Repository interface + in-memory adapter
 *   consolidationRetrieval.js  — Retrieval pipeline integration (scoring, enrichment)
 *
 * ─── Public API ───────────────────────────────────────────────────────────────
 *
 *   Types / constants
 *     ConsolidationStatus, VALID_CONSOLIDATION_STATUSES
 *     ConflictSeverity
 *     CONSOLIDATION_DEFAULTS, CONSOLIDATION_CONFIG_KEYS
 *     readConsolidationConfig
 *
 *   Candidate grouping
 *     groupConsolidationCandidates
 *     inferTopic
 *     buildConsolidationTokenSet
 *     isEligibleForConsolidation
 *
 *   Engine (orchestration + re-exports)
 *     findConsolidationCandidates
 *     consolidateMemories
 *     updateConsolidatedMemory
 *     shouldReConsolidate
 *     getProvenance
 *     runConsolidationSweep
 *
 *   Store
 *     createInMemoryDriver
 *     createConsolidationStore
 *     consolidationStore
 *
 *   Retrieval integration
 *     applyConsolidationScorePenalty
 *     enrichWithConsolidations
 *     withSourceEvidence
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export {
  ConsolidationStatus,
  VALID_CONSOLIDATION_STATUSES,
  ConflictSeverity,
  CONSOLIDATION_DEFAULTS,
  CONSOLIDATION_CONFIG_KEYS,
  readConsolidationConfig
} from "./consolidationTypes.js";

// ─── Candidate grouping ───────────────────────────────────────────────────────

export {
  groupConsolidationCandidates,
  inferTopic,
  buildConsolidationTokenSet,
  isEligibleForConsolidation
} from "./candidateGrouping.js";

// ─── Engine (orchestration) ───────────────────────────────────────────────────
//
// consolidateMemories, updateConsolidatedMemory, shouldReConsolidate, and
// getProvenance are re-exported through consolidationEngine.js so callers
// have a single import point for the full public API.

export {
  findConsolidationCandidates,
  consolidateMemories,
  updateConsolidatedMemory,
  shouldReConsolidate,
  getProvenance,
  runConsolidationSweep
} from "./consolidationEngine.js";

// ─── Store ────────────────────────────────────────────────────────────────────

export {
  createInMemoryDriver,
  createConsolidationStore,
  consolidationStore
} from "./consolidationStore.js";

// ─── Retrieval integration ─────────────────────────────────────────────────────

export {
  applyConsolidationScorePenalty,
  enrichWithConsolidations,
  withSourceEvidence
} from "./consolidationRetrieval.js";
