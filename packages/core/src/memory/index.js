/**
 * packages/core/src/memory/index.js
 *
 * Public barrel for the memory module.
 *
 * Re-exports every symbol that is part of the public @neura/core API from
 * the sub-modules that own them.  Callers outside this package continue to
 * import from `@neura/core` (packages/core/src/index.js) unchanged.
 *
 * ─── Module layout ────────────────────────────────────────────────────────────
 *
 *   entities/
 *     memory-types.js      ← MemoryType enum, MemoryCandidate typedef
 *     memory-metadata.js   ← METADATA_SCHEMA_VERSION, DEFAULT_MEMORY_METADATA, etc.
 *
 *   utils/
 *     pattern-sets.js      ← FACTUAL_PATTERNS, EPISODIC_PATTERNS, SEMANTIC_PATTERNS
 *     scoring-helpers.js   ← scoreMemoryTypeMatch, countMatches
 *
 *   services/
 *     classifier.js        ← classifyMemoryType, classifyMemoryTypeWithConfidence
 *     scorer.js            ← scoreMemoryConfidence, scoreMemoryImportance
 *     extractor.js         ← inferMemoryDomain, shouldStoreMemory,
 *                             summarizeMemoryCandidate, extractMemoryCandidates,
 *                             computeMemoryFingerprint
 *     importanceScorer.js  ← calculateImportance
 *     deduplicationService.js ← normalizeText, similarity, isDuplicate, mergeMemory
 *
 *   repositories/
 *     index.js             ← FactualMemoryRepository, VectorMemoryRepository,
 *                             RelationshipGraphRepository (interface stubs)
 *
 * ─── What @neura/core re-exports from here ────────────────────────────────────
 *
 *   classifyMemoryType
 *   classifyMemoryTypeWithConfidence
 *   summarizeMemoryCandidate
 *   inferMemoryDomain
 *   scoreMemoryConfidence
 *   scoreMemoryImportance
 *   shouldStoreMemory
 *   extractMemoryCandidates
 *   computeMemoryFingerprint
 *   calculateImportance
 *   normalizeText
 *   similarity
 *   isDuplicate
 *   mergeMemory
 *   DEFAULT_DEDUP_THRESHOLD
 */

// ─── Entities ─────────────────────────────────────────────────────────────────

export {
  MemoryType,
  VALID_MEMORY_TYPES
} from "./entities/memory-types.js";

export {
  METADATA_SCHEMA_VERSION,
  HEURISTIC_GENERATOR_ID,
  SUMMARY_GENERATOR_ID,
  HEURISTIC_EXTRACTION_METHOD,
  SUMMARY_EXTRACTION_METHOD,
  DEFAULT_MEMORY_METADATA,
  SUMMARY_MEMORY_METADATA_PRESET
} from "./entities/memory-metadata.js";

// ─── Utils ────────────────────────────────────────────────────────────────────

export {
  FACTUAL_PATTERNS,
  EPISODIC_PATTERNS,
  SEMANTIC_PATTERNS
} from "./utils/pattern-sets.js";

export {
  scoreMemoryTypeMatch,
  countMatches
} from "./utils/scoring-helpers.js";

// ─── Services ─────────────────────────────────────────────────────────────────

export {
  classifyMemoryType,
  classifyMemoryTypeWithConfidence
} from "./services/classifier.js";

export {
  scoreMemoryConfidence,
  scoreMemoryImportance
} from "./services/scorer.js";

export {
  inferMemoryDomain,
  shouldStoreMemory,
  summarizeMemoryCandidate,
  extractMemoryCandidates,
  computeMemoryFingerprint
} from "./services/extractor.js";

// ─── Storage intelligence services ────────────────────────────────────────────

export {
  calculateImportance
} from "./services/importanceScorer.js";

export {
  normalizeText,
  similarity,
  isDuplicate,
  mergeMemory,
  DEFAULT_DEDUP_THRESHOLD
} from "./services/deduplicationService.js";

// ─── Repositories ─────────────────────────────────────────────────────────────

export {
  FactualMemoryRepository,
  VectorMemoryRepository,
  RelationshipGraphRepository
} from "./repositories/index.js";

// ─── Tiered repositories ──────────────────────────────────────────────────────

export { hotRepository }  from "./repositories/hotRepository.js";
export { warmRepository } from "./repositories/warmRepository.js";
export { coldRepository } from "./repositories/coldRepository.js";

// ─── Tier management ──────────────────────────────────────────────────────────

export {
  Tier,
  determineTier,
  promote,
  demote,
  rebalance,
  getRepositoryForTier,
  HOT_WINDOW_MS,
  COLD_AGE_MS,
  WARM_IMPORTANCE_THRESHOLD,
  COLD_IMPORTANCE_THRESHOLD
} from "./services/tierManager.js";

// ─── Storage router ───────────────────────────────────────────────────────────

export {
  storageRouter,
  saveMemory,
  getMemory,
  searchUserMemories,
  updateMemory,
  removeMemory
} from "./services/storageRouter.js";
