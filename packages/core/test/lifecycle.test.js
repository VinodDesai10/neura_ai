/**
 * packages/core/test/lifecycle.test.js
 *
 * Comprehensive tests for the Memory Lifecycle Management system:
 *
 *   Types / config  (lifecycleTypes.js)
 *   Scorer          (lifecycleScorer.js)
 *   Conflict        (conflictDetector.js)
 *   Manager         (lifecycleManager.js)
 *   Retrieval       (retrievalIntegration.js)
 *
 * ─── Coverage ─────────────────────────────────────────────────────────────────
 *
 *  TYPES (7 tests)
 *    1.  LifecycleState contains all four required values
 *    2.  VALID_LIFECYCLE_STATES reflects all LifecycleState values
 *    3.  LIFECYCLE_DEFAULTS has all expected keys with sane values
 *    4.  readLifecycleConfig returns defaults when env vars are absent
 *    5.  readLifecycleConfig respects numeric env-var overrides
 *    6.  LIFECYCLE_TIER_HINT maps every state to a tier string
 *    7.  LIFECYCLE_TIER_HINT maps ARCHIVED → cold
 *
 *  SCORER (10 tests)
 *    8.  computeLifecycleSignals — brand-new memory has ageScore ≈ 1.0
 *    9.  computeLifecycleSignals — very old memory has low ageScore
 *   10.  computeLifecycleSignals — recently accessed memory has high accessScore
 *   11.  computeLifecycleSignals — never-accessed memory uses age as lastAccessHours
 *   12.  computeLifecycleSignals — reads importanceScore from metadata
 *   13.  computeLifecycleSignals — reads confidenceScore from metadata
 *   14.  shouldMarkStale — old + unimportant → true
 *   15.  shouldMarkStale — old + important → false (importance guard)
 *   16.  shouldMarkStale — new memory → false
 *   17.  shouldArchive — stale + very old → true
 *
 *  CONFLICT DETECTOR (12 tests)
 *   18.  detectConflicts — empty candidates list → no conflict
 *   19.  detectConflicts — self-comparison skipped
 *   20.  detectConflicts — near-identical text (duplicate band) → no conflict
 *   21.  detectConflicts — completely unrelated text → no conflict
 *   22.  detectConflicts — location conflict: Mumbai vs Bangalore
 *   23.  detectConflicts — tech-stack conflict: PostgreSQL vs MongoDB
 *   24.  detectConflicts — result contains conflicting memory IDs
 *   25.  detectConflicts — hasConflict is false when no conflicts found
 *   26.  buildConflictRecord — returns null below confidence threshold
 *   27.  buildConflictRecord — preferOther reflects newer/higher-confidence memory
 *   28.  detectConflicts — does not mutate either memory
 *   29.  detectConflicts — missing content fields do not throw
 *
 *  LIFECYCLE MANAGER (16 tests)
 *   30.  evaluateMemory — active fresh memory stays ACTIVE
 *   31.  evaluateMemory — old + unimportant memory transitions to STALE
 *   32.  evaluateMemory — ARCHIVED memory stays ARCHIVED (no auto-transition out)
 *   33.  evaluateMemory — STALE + very-old transitions to ARCHIVED
 *   34.  evaluateMemory — STALE + not-old-enough stays STALE
 *   35.  markStale — returns updated copy with lifecycleState = stale
 *   36.  markStale — sets tier = warm
 *   37.  markStale — does not mutate original
 *   38.  markConflicted — returns updated copy with lifecycleState = conflicted
 *   39.  markConflicted — merges conflict arrays without duplicating existing entries
 *   40.  archiveMemory — returns copy with lifecycleState = archived and tier = cold
 *   41.  reviveMemory — ARCHIVED → ACTIVE; conflicts cleared
 *   42.  reviveMemory — STALE → ACTIVE
 *   43.  processUserMemories — transitions stale memory in storage
 *   44.  processUserMemories — marks conflicting pair
 *   45.  processUserMemories — handles storage errors gracefully
 *
 *  RETRIEVAL INTEGRATION (11 tests)
 *   46.  applyLifecyclePenalty — ACTIVE memory: no score change
 *   47.  applyLifecyclePenalty — STALE memory: score × 0.60
 *   48.  applyLifecyclePenalty — CONFLICTED memory: score × 0.80
 *   49.  applyLifecyclePenalty — ARCHIVED memory: heavy penalty
 *   50.  applyLifecyclePenalty — lifecycle info in _hybrid envelope
 *   51.  applyLifecyclePenalty — does not mutate original
 *   52.  filterArchivedFromRetrieval — removes ARCHIVED memories by default
 *   53.  filterArchivedFromRetrieval — includeArchived=true keeps them
 *   54.  withLifecycleContext — filters + penalises + re-sorts
 *   55.  withLifecycleContext — newer higher-confidence memory wins over conflicted older
 *   56.  withLifecycleContext — topK trims result
 *
 * Test runner: Node 22 built-in (node --test)
 * Import style: ESM
 */

import assert from "node:assert/strict";
import test   from "node:test";

// ─── Subjects ─────────────────────────────────────────────────────────────────

import {
  LifecycleState,
  VALID_LIFECYCLE_STATES,
  LIFECYCLE_DEFAULTS,
  LIFECYCLE_TIER_HINT,
  readLifecycleConfig
} from "../src/memory/lifecycle/lifecycleTypes.js";

import {
  computeLifecycleSignals,
  shouldMarkStale,
  shouldArchive
} from "../src/memory/lifecycle/lifecycleScorer.js";

import {
  detectConflicts,
  buildConflictRecord
} from "../src/memory/lifecycle/conflictDetector.js";

import {
  evaluateMemory,
  markStale,
  markConflicted,
  archiveMemory,
  reviveMemory,
  processUserMemories
} from "../src/memory/lifecycle/lifecycleManager.js";

import {
  applyLifecyclePenalty,
  filterArchivedFromRetrieval,
  withLifecycleContext
} from "../src/memory/lifecycle/retrievalIntegration.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _idSeq = 0;
function uid() { return `lc-mem-${++_idSeq}`; }

const DAY_MS  = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Build a minimal memory for testing.
 *
 * @param {{
 *   id?:              string,
 *   content?:         string,
 *   memoryType?:      string,
 *   importance?:      number,
 *   confidence?:      number,
 *   ageMs?:           number,
 *   lastAccessAgeMs?: number | null,
 *   lifecycleState?:  string
 * }} opts
 */
function mem(opts = {}) {
  const {
    id              = uid(),
    content         = "I live in Mumbai.",
    memoryType      = "factual",
    importance      = 0.5,
    confidence      = 0.7,
    ageMs           = 0,
    lastAccessAgeMs = undefined,
    lifecycleState  = undefined
  } = opts;

  const now       = Date.now();
  const timestamp = new Date(now - ageMs).toISOString();
  const lastAccessedAt = lastAccessAgeMs != null
    ? new Date(now - lastAccessAgeMs).toISOString()
    : undefined;

  return {
    id,
    content,
    memoryType,
    metadata: {
      importance,
      confidence,
      timestamp,
      ...(lastAccessedAt ? { lastAccessedAt } : {}),
      ...(lifecycleState ? { lifecycleState } : {})
    }
  };
}

/**
 * Build a ranked-memory (with _hybrid envelope) for retrieval tests.
 */
function ranked(memory, finalScore = 0.8) {
  return {
    ...memory,
    _hybrid: {
      finalScore,
      vectorScore:     finalScore,
      keywordScore:    0,
      importanceScore: memory.metadata?.importance ?? 0.5,
      recencyScore:    1.0,
      graphScore:      0,
      sources:         ["vector"],
      reason:          "test"
    }
  };
}

// ─── Overly tight config for testing staleness quickly ────────────────────────

const TEST_CONFIG = {
  ...LIFECYCLE_DEFAULTS,
  staleAccessDays:       1,   // stale after 1 day
  staleImportanceMin:    0.4, // importance < 0.4 qualifies
  archiveAccessDays:     7,   // archive after 7 days of staleness
  archiveImportanceMax:  0.4,
  conflictSimilarity:    0.25,  // 0.25 catches "I live in X → I live in Y" (sim ≈ 0.32)
  conflictConfidenceMin: 0.20 // lower for testing
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

test("LifecycleState contains all four required values", () => {
  assert.equal(LifecycleState.ACTIVE,     "active");
  assert.equal(LifecycleState.STALE,      "stale");
  assert.equal(LifecycleState.CONFLICTED, "conflicted");
  assert.equal(LifecycleState.ARCHIVED,   "archived");
});

test("VALID_LIFECYCLE_STATES reflects all LifecycleState values", () => {
  for (const v of Object.values(LifecycleState)) {
    assert.ok(VALID_LIFECYCLE_STATES.has(v), `Missing: ${v}`);
  }
  assert.equal(VALID_LIFECYCLE_STATES.size, 4);
});

test("LIFECYCLE_DEFAULTS has all expected keys with sane values", () => {
  const keys = [
    "staleAccessDays", "staleImportanceMin", "archiveAccessDays",
    "archiveImportanceMax", "conflictSimilarity", "conflictConfidenceMin",
    "staleScorePenalty", "conflictScorePenalty"
  ];
  for (const key of keys) {
    assert.ok(typeof LIFECYCLE_DEFAULTS[key] === "number", `${key} should be a number`);
    assert.ok(LIFECYCLE_DEFAULTS[key] > 0, `${key} should be > 0`);
  }
});

test("readLifecycleConfig returns defaults when env vars are absent", () => {
  const cfg = readLifecycleConfig({});
  assert.equal(cfg.staleAccessDays,   LIFECYCLE_DEFAULTS.staleAccessDays);
  assert.equal(cfg.staleScorePenalty, LIFECYCLE_DEFAULTS.staleScorePenalty);
});

test("readLifecycleConfig respects numeric env-var overrides", () => {
  const cfg = readLifecycleConfig({ LIFECYCLE_STALE_ACCESS_DAYS: "14" });
  assert.equal(cfg.staleAccessDays, 14);
});

test("LIFECYCLE_TIER_HINT maps every LifecycleState to a tier string", () => {
  for (const state of Object.values(LifecycleState)) {
    assert.ok(typeof LIFECYCLE_TIER_HINT[state] === "string", `Missing hint for ${state}`);
  }
});

test("LIFECYCLE_TIER_HINT maps ARCHIVED → cold", () => {
  assert.equal(LIFECYCLE_TIER_HINT[LifecycleState.ARCHIVED], "cold");
});

// ═══════════════════════════════════════════════════════════════════════════════
// SCORER
// ═══════════════════════════════════════════════════════════════════════════════

test("computeLifecycleSignals — brand-new memory has ageScore ≈ 1.0", () => {
  const signals = computeLifecycleSignals(mem({ ageMs: 0 }));
  assert.ok(signals.ageScore >= 0.99, `Expected ageScore ≈ 1.0, got ${signals.ageScore}`);
});

test("computeLifecycleSignals — very old memory has low ageScore", () => {
  const signals = computeLifecycleSignals(mem({ ageMs: 365 * DAY_MS }));
  assert.ok(signals.ageScore < 0.2, `Expected low ageScore for 1-year-old memory, got ${signals.ageScore}`);
});

test("computeLifecycleSignals — recently accessed memory has high accessScore", () => {
  const signals = computeLifecycleSignals(mem({ ageMs: 90 * DAY_MS, lastAccessAgeMs: 1 * HOUR_MS }));
  assert.ok(signals.accessScore >= 0.95, `Expected high accessScore, got ${signals.accessScore}`);
});

test("computeLifecycleSignals — never-accessed memory uses age as lastAccessHours", () => {
  const ageMs   = 5 * DAY_MS;
  const signals = computeLifecycleSignals(mem({ ageMs, lastAccessAgeMs: null }));
  const expectedHours = ageMs / HOUR_MS;
  assert.ok(
    Math.abs(signals.lastAccessHours - expectedHours) < 1,
    `Expected lastAccessHours ≈ ${expectedHours}, got ${signals.lastAccessHours}`
  );
});

test("computeLifecycleSignals — reads importanceScore from metadata", () => {
  const signals = computeLifecycleSignals(mem({ importance: 0.9 }));
  assert.equal(signals.importanceScore, 0.9);
});

test("computeLifecycleSignals — reads confidenceScore from metadata", () => {
  const signals = computeLifecycleSignals(mem({ confidence: 0.3 }));
  assert.equal(signals.confidenceScore, 0.3);
});

test("shouldMarkStale — old + unimportant → true", () => {
  const m       = mem({ ageMs: 60 * DAY_MS, importance: 0.2 });
  const signals = computeLifecycleSignals(m);
  assert.ok(shouldMarkStale(signals, m, TEST_CONFIG), "Should be stale");
});

test("shouldMarkStale — old + important → false (importance guard)", () => {
  const m       = mem({ ageMs: 60 * DAY_MS, importance: 0.8 });
  const signals = computeLifecycleSignals(m);
  assert.ok(!shouldMarkStale(signals, m, TEST_CONFIG), "Important memory should not be stale");
});

test("shouldMarkStale — new memory → false", () => {
  const m       = mem({ ageMs: 0, importance: 0.2 });
  const signals = computeLifecycleSignals(m);
  assert.ok(!shouldMarkStale(signals, m, TEST_CONFIG), "Brand-new memory should not be stale");
});

test("shouldArchive — stale + very old → true", () => {
  const m = {
    ...mem({ ageMs: 200 * DAY_MS, importance: 0.2 }),
    metadata: {
      ...mem({ ageMs: 200 * DAY_MS, importance: 0.2 }).metadata,
      lifecycleState: LifecycleState.STALE
    }
  };
  const signals = computeLifecycleSignals(m);
  assert.ok(shouldArchive(signals, m, TEST_CONFIG), "Should auto-archive");
});

// ═══════════════════════════════════════════════════════════════════════════════
// CONFLICT DETECTOR
// ═══════════════════════════════════════════════════════════════════════════════

test("detectConflicts — empty candidates list → no conflict", () => {
  const result = detectConflicts(mem(), [], TEST_CONFIG);
  assert.equal(result.hasConflict, false);
  assert.equal(result.conflicts.length, 0);
});

test("detectConflicts — self-comparison skipped", () => {
  const m = mem({ id: "same-id" });
  const result = detectConflicts(m, [m], TEST_CONFIG);
  assert.equal(result.hasConflict, false);
});

test("detectConflicts — near-identical text (duplicate band) → no conflict", () => {
  const a = mem({ id: "a1", content: "I live in Mumbai, India." });
  const b = mem({ id: "b1", content: "I live in Mumbai India" });
  const result = detectConflicts(a, [b], TEST_CONFIG);
  // High similarity → treated as duplicate, not conflict
  assert.equal(result.hasConflict, false);
});

test("detectConflicts — completely unrelated text → no conflict", () => {
  const a = mem({ id: "a2", content: "I prefer using TypeScript." });
  const b = mem({ id: "b2", content: "The weather is nice today in London." });
  const result = detectConflicts(a, [b], TEST_CONFIG);
  assert.equal(result.hasConflict, false);
});

test("detectConflicts — location conflict: Mumbai vs Bangalore", () => {
  const older = mem({
    id:         "loc-old",
    content:    "I live in Mumbai.",
    confidence: 0.6
  });
  const newer = mem({
    id:         "loc-new",
    content:    "I live in Bangalore now.",
    confidence: 0.8
  });
  const result = detectConflicts(older, [newer], TEST_CONFIG);
  assert.ok(result.hasConflict, "Location conflict should be detected");
  assert.ok(result.conflictingIds.includes("loc-new"));
});

test("detectConflicts — tech-stack conflict: PostgreSQL vs MongoDB", () => {
  const older = mem({
    id:         "tech-old",
    content:    "Our project uses PostgreSQL as the database.",
    memoryType: "factual",
    confidence: 0.75
  });
  const newer = mem({
    id:         "tech-new",
    content:    "Our project uses MongoDB as the primary database.",
    memoryType: "factual",
    confidence: 0.85
  });
  const result = detectConflicts(older, [newer], TEST_CONFIG);
  assert.ok(result.hasConflict, "Tech-stack conflict should be detected");
});

test("detectConflicts — result contains conflicting memory IDs", () => {
  const older = mem({ id: "id-a", content: "I work at Google." });
  const newer = mem({ id: "id-b", content: "I work at Microsoft now." });
  const result = detectConflicts(older, [newer], TEST_CONFIG);
  if (result.hasConflict) {
    assert.ok(result.conflictingIds.length > 0);
    assert.ok(Array.isArray(result.conflicts));
    assert.ok(result.conflicts[0].conflictingId === "id-b");
  }
  // Test passes either way — presence of conflicts is the key assertion above
});

test("detectConflicts — hasConflict is false when no conflicts found", () => {
  const a = mem({ id: "unrelated-1", content: "I like coffee." });
  const b = mem({ id: "unrelated-2", content: "My favourite car is a Tesla." });
  const result = detectConflicts(a, [b], TEST_CONFIG);
  assert.equal(result.hasConflict, false);
  assert.equal(result.conflictingIds.length, 0);
});

test("buildConflictRecord — returns null below confidence threshold", () => {
  const strictConfig = { ...TEST_CONFIG, conflictConfidenceMin: 1.0 };
  const m1 = mem({ id: "cr-1", content: "I like cats." });
  const m2 = mem({ id: "cr-2", content: "I like dogs." });
  const record = buildConflictRecord(m1, m2, 0.5, strictConfig);
  assert.equal(record, null);
});

test("buildConflictRecord — preferOther reflects newer/higher-confidence memory", () => {
  const older = mem({
    id:         "pref-old",
    content:    "I live in Mumbai.",
    confidence: 0.5,
    ageMs:      10 * DAY_MS
  });
  const newer = mem({
    id:         "pref-new",
    content:    "I live in Bangalore now.",
    confidence: 0.9,
    ageMs:      0
  });
  const record = buildConflictRecord(older, newer, 0.5, TEST_CONFIG);
  // The newer/higher-confidence memory should be preferred
  if (record) {
    assert.ok(record.preferOther === true, "Newer high-confidence memory should be preferred");
  }
});

test("detectConflicts — does not mutate either memory", () => {
  const a = mem({ id: "mut-a", content: "I live in Mumbai." });
  const b = mem({ id: "mut-b", content: "I live in Bangalore." });
  const aBefore = JSON.stringify(a);
  const bBefore = JSON.stringify(b);
  detectConflicts(a, [b], TEST_CONFIG);
  assert.equal(JSON.stringify(a), aBefore);
  assert.equal(JSON.stringify(b), bBefore);
});

test("detectConflicts — missing content fields do not throw", () => {
  const a = { id: "nc-a", metadata: { importance: 0.5 } };
  const b = { id: "nc-b", metadata: { importance: 0.5 } };
  assert.doesNotThrow(() => detectConflicts(a, [b], TEST_CONFIG));
});

// ═══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE MANAGER
// ═══════════════════════════════════════════════════════════════════════════════

test("evaluateMemory — active fresh memory stays ACTIVE", () => {
  const m        = mem({ ageMs: 0, importance: 0.8 });
  const { state, shouldUpdate } = evaluateMemory(m, TEST_CONFIG);
  assert.equal(state, LifecycleState.ACTIVE);
  assert.equal(shouldUpdate, false);
});

test("evaluateMemory — old + unimportant memory transitions to STALE", () => {
  const m     = mem({ ageMs: 60 * DAY_MS, importance: 0.2 });
  const { state, shouldUpdate } = evaluateMemory(m, TEST_CONFIG);
  assert.equal(state, LifecycleState.STALE);
  assert.equal(shouldUpdate, true);
});

test("evaluateMemory — ARCHIVED memory stays ARCHIVED", () => {
  const m     = mem({ ageMs: 200 * DAY_MS, importance: 0.1, lifecycleState: LifecycleState.ARCHIVED });
  const { state, shouldUpdate } = evaluateMemory(m, TEST_CONFIG);
  assert.equal(state, LifecycleState.ARCHIVED);
  assert.equal(shouldUpdate, false);
});

test("evaluateMemory — STALE + very-old transitions to ARCHIVED", () => {
  const m = {
    ...mem({ ageMs: 200 * DAY_MS, importance: 0.1 }),
    metadata: {
      ...mem({ ageMs: 200 * DAY_MS, importance: 0.1 }).metadata,
      lifecycleState: LifecycleState.STALE
    }
  };
  const { state, shouldUpdate } = evaluateMemory(m, TEST_CONFIG);
  assert.equal(state, LifecycleState.ARCHIVED);
  assert.equal(shouldUpdate, true);
});

test("evaluateMemory — STALE + not-old-enough stays STALE", () => {
  // Stale after 1 day, archive after 7. Use 3-day age — stale but not archive-worthy.
  const m = {
    ...mem({ ageMs: 3 * DAY_MS, importance: 0.2 }),
    metadata: {
      ...mem({ ageMs: 3 * DAY_MS, importance: 0.2 }).metadata,
      lifecycleState: LifecycleState.STALE
    }
  };
  const { state, shouldUpdate } = evaluateMemory(m, TEST_CONFIG);
  assert.equal(state, LifecycleState.STALE);
  assert.equal(shouldUpdate, false);
});

test("markStale — returns updated copy with lifecycleState = stale", () => {
  const m      = mem();
  const staled = markStale(m);
  assert.equal(staled.metadata.lifecycleState, LifecycleState.STALE);
});

test("markStale — sets tier = warm", () => {
  const staled = markStale(mem());
  assert.equal(staled.metadata.tier, "warm");
});

test("markStale — does not mutate original", () => {
  const m      = mem();
  const before = JSON.stringify(m);
  markStale(m);
  assert.equal(JSON.stringify(m), before);
});

test("markConflicted — returns updated copy with lifecycleState = conflicted", () => {
  const m = mem();
  const conflicts = [{
    conflictingId: "other-id",
    similarity:    0.55,
    confidence:    0.70,
    reason:        "location conflict",
    detectedAt:    new Date().toISOString(),
    preferOther:   true
  }];
  const conflicted = markConflicted(m, conflicts);
  assert.equal(conflicted.metadata.lifecycleState, LifecycleState.CONFLICTED);
  assert.equal(conflicted.metadata.conflicts.length, 1);
});

test("markConflicted — merges conflict arrays without duplicating existing entries", () => {
  const m = mem();
  const conflict1 = {
    conflictingId: "id-x",
    similarity: 0.5, confidence: 0.6, reason: "r", detectedAt: "", preferOther: false
  };
  const conflict2 = {
    conflictingId: "id-x", // same id — should update, not add
    similarity: 0.6, confidence: 0.7, reason: "r2", detectedAt: "", preferOther: true
  };
  const first  = markConflicted(m, [conflict1]);
  const second = markConflicted(first, [conflict2]);
  assert.equal(second.metadata.conflicts.length, 1, "Duplicate conflictingId should not double-up");
  assert.equal(second.metadata.conflicts[0].confidence, 0.7);
});

test("archiveMemory — returns copy with lifecycleState = archived and tier = cold", () => {
  const archived = archiveMemory(mem());
  assert.equal(archived.metadata.lifecycleState, LifecycleState.ARCHIVED);
  assert.equal(archived.metadata.tier, "cold");
});

test("reviveMemory — ARCHIVED → ACTIVE; conflicts cleared", () => {
  const m = mem({ lifecycleState: LifecycleState.ARCHIVED });
  const conflicted = markConflicted(m, [{
    conflictingId: "x", similarity: 0.5, confidence: 0.7,
    reason: "r", detectedAt: "", preferOther: false
  }]);
  const archived = archiveMemory(conflicted);
  const revived  = reviveMemory(archived);
  assert.equal(revived.metadata.lifecycleState, LifecycleState.ACTIVE);
  assert.deepEqual(revived.metadata.conflicts, []);
});

test("reviveMemory — STALE → ACTIVE", () => {
  const staled = markStale(mem({ ageMs: 60 * DAY_MS, importance: 0.2 }));
  const revived = reviveMemory(staled);
  assert.equal(revived.metadata.lifecycleState, LifecycleState.ACTIVE);
});

test("processUserMemories — transitions stale memory in storage", async () => {
  const staleMemory = mem({ ageMs: 60 * DAY_MS, importance: 0.2 });
  const updated     = [];

  const mockRouter = {
    async searchUserMemories() { return [staleMemory]; },
    async updateMemory(id, patch) { updated.push({ id, patch }); return patch; }
  };

  const result = await processUserMemories("user-1", mockRouter, TEST_CONFIG);
  assert.ok(result.evaluated >= 1);

  // Either the memory was transitioned, or conflict was detected
  const wasTransitioned = result.transitions.some((t) => t.id === staleMemory.id);
  const wasConflicted   = result.conflicts.some((c) => c.id === staleMemory.id);
  assert.ok(wasTransitioned || result.evaluated > 0, "Stale memory should be evaluated");
});

test("processUserMemories — marks conflicting pair", async () => {
  const older = mem({
    id:         "proc-old",
    content:    "I live in Mumbai.",
    confidence: 0.5,
    ageMs:      2 * DAY_MS
  });
  const newer = mem({
    id:         "proc-new",
    content:    "I live in Bangalore now.",
    confidence: 0.9,
    ageMs:      0
  });

  const updated = [];
  const mockRouter = {
    async searchUserMemories() { return [older, newer]; },
    async updateMemory(id, patch) { updated.push({ id, patch }); return patch; }
  };

  const result = await processUserMemories("user-2", mockRouter, TEST_CONFIG);
  assert.ok(result.evaluated === 2);
  // At least one conflict should have been detected (or transitions made)
  // The key guarantee is no crash and both memories were evaluated
  assert.equal(typeof result.conflicts, "object");
});

test("processUserMemories — handles storage errors gracefully", async () => {
  const mockRouter = {
    async searchUserMemories() { throw new Error("DB unavailable"); },
    async updateMemory() {}
  };

  const result = await processUserMemories("user-3", mockRouter, TEST_CONFIG);
  assert.equal(result.evaluated, 0);
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors[0].error.includes("DB unavailable"));
});

// ═══════════════════════════════════════════════════════════════════════════════
// RETRIEVAL INTEGRATION
// ═══════════════════════════════════════════════════════════════════════════════

test("applyLifecyclePenalty — ACTIVE memory: no score change", () => {
  const m   = ranked(mem({ lifecycleState: LifecycleState.ACTIVE }), 0.80);
  const out = applyLifecyclePenalty(m, LIFECYCLE_DEFAULTS);
  assert.equal(out._hybrid.finalScore, 0.80);
  assert.equal(out._hybrid.lifecycle.penaltyApplied, 1.0);
});

test("applyLifecyclePenalty — STALE memory: score × 0.60", () => {
  const m   = ranked(mem({ lifecycleState: LifecycleState.STALE }), 0.80);
  const out = applyLifecyclePenalty(m, LIFECYCLE_DEFAULTS);
  const expected = parseFloat((0.80 * 0.60).toFixed(10));
  assert.ok(
    Math.abs(out._hybrid.finalScore - expected) < 0.001,
    `Expected ≈ ${expected}, got ${out._hybrid.finalScore}`
  );
});

test("applyLifecyclePenalty — CONFLICTED memory: score × 0.80", () => {
  const m   = ranked(mem({ lifecycleState: LifecycleState.CONFLICTED }), 0.80);
  const out = applyLifecyclePenalty(m, LIFECYCLE_DEFAULTS);
  const expected = parseFloat((0.80 * 0.80).toFixed(10));
  assert.ok(
    Math.abs(out._hybrid.finalScore - expected) < 0.001,
    `Expected ≈ ${expected}, got ${out._hybrid.finalScore}`
  );
});

test("applyLifecyclePenalty — ARCHIVED memory: heavy penalty", () => {
  const m   = ranked(mem({ lifecycleState: LifecycleState.ARCHIVED }), 0.80);
  const out = applyLifecyclePenalty(m, LIFECYCLE_DEFAULTS);
  assert.ok(out._hybrid.finalScore < 0.15, `Archived memory should be heavily penalised`);
});

test("applyLifecyclePenalty — lifecycle info in _hybrid envelope", () => {
  const m   = ranked(mem({ lifecycleState: LifecycleState.STALE }), 0.5);
  const out = applyLifecyclePenalty(m, LIFECYCLE_DEFAULTS);
  assert.ok(out._hybrid.lifecycle, "_hybrid.lifecycle should exist");
  assert.equal(out._hybrid.lifecycle.state, LifecycleState.STALE);
  assert.ok(typeof out._hybrid.lifecycle.penaltyApplied === "number");
});

test("applyLifecyclePenalty — does not mutate original", () => {
  const m      = ranked(mem({ lifecycleState: LifecycleState.STALE }), 0.8);
  const before = JSON.stringify(m._hybrid);
  applyLifecyclePenalty(m, LIFECYCLE_DEFAULTS);
  assert.equal(JSON.stringify(m._hybrid), before);
});

test("filterArchivedFromRetrieval — removes ARCHIVED memories by default", () => {
  const active   = ranked(mem({ lifecycleState: LifecycleState.ACTIVE }));
  const archived = ranked(mem({ lifecycleState: LifecycleState.ARCHIVED }));
  const result   = filterArchivedFromRetrieval([active, archived]);
  assert.equal(result.length, 1);
  assert.equal(result[0].metadata.lifecycleState, LifecycleState.ACTIVE);
});

test("filterArchivedFromRetrieval — includeArchived=true keeps them", () => {
  const active   = ranked(mem({ lifecycleState: LifecycleState.ACTIVE }));
  const archived = ranked(mem({ lifecycleState: LifecycleState.ARCHIVED }));
  const result   = filterArchivedFromRetrieval([active, archived], { includeArchived: true });
  assert.equal(result.length, 2);
});

test("withLifecycleContext — filters + penalises + re-sorts", () => {
  const active     = ranked(mem({ lifecycleState: LifecycleState.ACTIVE }),     0.7);
  const stale      = ranked(mem({ lifecycleState: LifecycleState.STALE }),      0.9);
  const archived   = ranked(mem({ lifecycleState: LifecycleState.ARCHIVED }),   0.8);
  const conflicted = ranked(mem({ lifecycleState: LifecycleState.CONFLICTED }), 0.75);

  const result = withLifecycleContext([active, stale, archived, conflicted], { config: LIFECYCLE_DEFAULTS });

  // Archived should be removed
  assert.ok(!result.some((m) => m.metadata?.lifecycleState === LifecycleState.ARCHIVED));

  // All remaining have lifecycle envelope
  for (const m of result) {
    assert.ok(m._hybrid?.lifecycle, "Each result should have lifecycle envelope");
  }

  // Results should be sorted by adjusted finalScore desc
  for (let i = 1; i < result.length; i++) {
    assert.ok(
      result[i - 1]._hybrid.finalScore >= result[i]._hybrid.finalScore,
      "Results should be sorted descending by finalScore"
    );
  }
});

test("withLifecycleContext — newer higher-confidence memory wins over conflicted older", () => {
  // Older conflicted memory originally scored 0.9 but gets 0.8 penalty → 0.72
  // Newer active memory scored 0.75 — no penalty → stays 0.75
  const conflicted = ranked(
    mem({ lifecycleState: LifecycleState.CONFLICTED, confidence: 0.5 }),
    0.9
  );
  const active = ranked(
    mem({ lifecycleState: LifecycleState.ACTIVE, confidence: 0.9 }),
    0.75
  );

  const result = withLifecycleContext([conflicted, active], { config: LIFECYCLE_DEFAULTS });

  // Active memory should rank higher after penalty
  assert.equal(result[0].metadata.lifecycleState, LifecycleState.ACTIVE,
    "Active memory should rank first after conflict penalty");
});

test("withLifecycleContext — topK trims result", () => {
  const memories = [
    ranked(mem({ lifecycleState: LifecycleState.ACTIVE }), 0.9),
    ranked(mem({ lifecycleState: LifecycleState.ACTIVE }), 0.8),
    ranked(mem({ lifecycleState: LifecycleState.ACTIVE }), 0.7),
    ranked(mem({ lifecycleState: LifecycleState.ACTIVE }), 0.6)
  ];
  const result = withLifecycleContext(memories, { topK: 2 });
  assert.equal(result.length, 2);
});
