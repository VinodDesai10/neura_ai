/**
 * @neura/core
 *
 * Public API barrel. All domain logic lives in feature modules:
 *
 *   utils/    – internal helpers (not re-exported)
 *   memory/   – classification, extraction, scoring, fingerprint
 *   retrieval/– query overlap, memory relatedness
 *   prompts/  – LLM context prompt builder
 *
 * Shared constants and utilities live in @neura/shared and are re-exported
 * from here so callers that already depend on @neura/core keep working
 * without changes.
 */

// ─── Re-export everything from @neura/shared ─────────────────────────────────
//
// Preserves backward compatibility: any code that imported STOP_TERMS,
// tokenize, RETRIEVAL_DEFAULTS, etc. from @neura/core continues to work.

export {
  STOP_TERMS,
  LOW_SIGNAL_PHRASES,
  SMALL_TALK_WORDS,
  DOMAIN_RULES,
  ENTITY_PATTERNS,
  readPositiveNumber,
  clampScore,
  unique,
  tokenize,
  hasLowSignalContent,
  isSmallTalk,
  NeuraError,
  NotFoundError,
  SessionConflictError,
  RateLimitError,
  RETRIEVAL_DEFAULTS,
  readRetrievalConfig
} from "@neura/shared";

// ─── Memory module ────────────────────────────────────────────────────────────

export {
  classifyMemoryType,
  classifyMemoryTypeWithConfidence,
  summarizeMemoryCandidate,
  inferMemoryDomain,
  scoreMemoryConfidence,
  scoreMemoryImportance,
  shouldStoreMemory,
  extractMemoryCandidates,
  computeMemoryFingerprint,
  calculateImportance,
  normalizeText,
  similarity,
  isDuplicate,
  mergeMemory,
  DEFAULT_DEDUP_THRESHOLD,
  // ─── Tiered repositories ──────────────────────────────────────────────────
  hotRepository,
  warmRepository,
  coldRepository,
  createHotRepository,
  createWarmRepository,
  createColdRepository,
  // ─── Tier management ──────────────────────────────────────────────────────
  Tier,
  determineTier,
  promote,
  demote,
  rebalance,
  getRepositoryForTier,
  HOT_WINDOW_MS,
  COLD_AGE_MS,
  WARM_IMPORTANCE_THRESHOLD,
  COLD_IMPORTANCE_THRESHOLD,
  // ─── Storage router ───────────────────────────────────────────────────────
  storageRouter,
  saveMemory,
  getMemory,
  searchUserMemories,
  updateMemory,
  removeMemory,
  // ─── Hybrid retrieval ─────────────────────────────────────────────────────
  createHybridRetrievalService,
  hybridRetrievalService,
  HYBRID_WEIGHTS_DEFAULTS,
  // ─── Memory Graph ─────────────────────────────────────────────────────────
  ENTITY_TYPE,
  VALID_ENTITY_TYPES,
  REL_TYPE,
  VALID_REL_TYPES,
  extractEntities,
  extractRelationships
} from "./memory/index.js";

// ─── Retrieval module ─────────────────────────────────────────────────────────

export {
  scoreQueryOverlap,
  computeMemoryRelatedness
} from "./retrieval/index.js";

// ─── Prompts module ───────────────────────────────────────────────────────────

export {
  buildContextPrompt
} from "./prompts/index.js";
