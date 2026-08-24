/**
 * apps/api/test/lifecycle-retrieval-scoring.test.js
 *
 * Focused tests for C-5: Lifecycle State propagation into Retrieval Scoring.
 *
 * Verifies that computeHybridScore() and deduplicateAndRerank() correctly
 * apply lifecycle state penalties using the constants defined in lifecycleTypes.js,
 * while preserving all existing scoring behaviour for ACTIVE memories.
 *
 * Test matrix:
 *   L1. ACTIVE memory — score unchanged (no lifecycle penalty)
 *   L2. STALE memory  — score multiplied by staleScorePenalty (default 0.60)
 *   L3. CONFLICTED memory — score multiplied by conflictScorePenalty (default 0.80)
 *   L4. Missing lifecycleState — behaves identically to ACTIVE (backward compat)
 *   L5. Unknown lifecycleState string — treated as ACTIVE (forward compat)
 *   L6. ARCHIVED memory — heavy penalty applied (0.05)
 *   L7. Lifecycle penalty is applied AFTER topical penalty (multiplicative)
 *   L8. Lifecycle metadata propagates through deduplicateAndRerank()
 *   L9. Ranking changes appropriately when lifecycle penalties apply
 *   L10. Existing callers without lifecycleState continue working (backward compat)
 *   L11. lifecycleState and lifecyclePenalty are exposed in the breakdown
 *   L12. Penalty values match the constants in lifecycleTypes.js exactly
 *   L13. STALE memory always ranks below an equivalent ACTIVE memory
 *   L14. CONFLICTED memory always ranks below an equivalent ACTIVE memory
 *   L15. Score is still clamped to [0, 1] after lifecycle penalty
 */

import test   from "node:test";
import assert from "node:assert/strict";

import {
  computeHybridScore,
  deduplicateAndRerank
} from "../src/services/retrieval-scorer.js";

import {
  LifecycleState,
  LIFECYCLE_DEFAULTS,
  readLifecycleConfig
} from "@neura/core";

import {
  FIXTURE_MEMORIES,
  SESSION_A
} from "./fixtures/retrieval-memories.js";

import {
  expectNoDuplicates,
  expectScoresDescending
} from "./helpers/retrieval-assertions.js";

// ─── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Build a minimal retrieval config without a topical penalty
 * (keeps tests focused on lifecycle behaviour).
 */
function cfg(overrides = {}) {
  return {
    topK:                 8,
    vectorWeight:         0.5,
    lexicalWeight:        0.2,
    importanceWeight:     0.2,
    recencyWeight:        0.1,
    recencyHalfLifeHours: 72,
    dedupThreshold:       0.92,
    summaryEveryNTurns:   20,
    // topicalPenalty deliberately omitted — tests lifecycle in isolation
    ...overrides
  };
}

/** Base scoring params shared across lifecycle tests. */
const BASE_PARAMS = {
  vectorScore:     0.70,
  lexicalScore:    3,
  importanceScore: 0.60,
  timestamp:       null,
  sessionId:       SESSION_A,
  querySessionId:  SESSION_A
};

// ─── L1: ACTIVE memory — score unchanged ─────────────────────────────────────

test("L1 – ACTIVE lifecycle: score is identical to no-lifecycle baseline", () => {
  const withActive = computeHybridScore(
    { ...BASE_PARAMS, lifecycleState: LifecycleState.ACTIVE },
    cfg()
  );
  const baseline = computeHybridScore(
    { ...BASE_PARAMS },          // no lifecycleState supplied
    cfg()
  );

  assert.ok(
    Math.abs(withActive.score - baseline.score) < 1e-10,
    `L1 – ACTIVE score (${withActive.score}) must equal baseline score (${baseline.score})`
  );
  assert.equal(withActive.lifecyclePenalty, 1.0, "L1 – ACTIVE penalty must be 1.0 (no deduction)");
  assert.equal(withActive.lifecycleState, LifecycleState.ACTIVE, "L1 – lifecycleState must be ACTIVE");
});

// ─── L2: STALE memory — staleScorePenalty applied ────────────────────────────

test("L2 – STALE lifecycle: score is multiplied by staleScorePenalty (0.60 default)", () => {
  const active = computeHybridScore({ ...BASE_PARAMS, lifecycleState: LifecycleState.ACTIVE }, cfg());
  const stale  = computeHybridScore({ ...BASE_PARAMS, lifecycleState: LifecycleState.STALE  }, cfg());

  const expectedPenalty = LIFECYCLE_DEFAULTS.staleScorePenalty; // 0.60
  const expectedScore   = Math.min(1, active.score * expectedPenalty);

  assert.ok(
    Math.abs(stale.score - expectedScore) < 1e-9,
    `L2 – STALE score: expected ${expectedScore.toFixed(6)}, got ${stale.score.toFixed(6)}`
  );
  assert.equal(stale.lifecyclePenalty, expectedPenalty, `L2 – lifecycle penalty must be ${expectedPenalty}`);
  assert.equal(stale.lifecycleState, LifecycleState.STALE, "L2 – lifecycleState must be STALE");
  assert.ok(stale.score < active.score, "L2 – STALE score must be strictly less than ACTIVE score");
});

// ─── L3: CONFLICTED memory — conflictScorePenalty applied ────────────────────

test("L3 – CONFLICTED lifecycle: score is multiplied by conflictScorePenalty (0.80 default)", () => {
  const active     = computeHybridScore({ ...BASE_PARAMS, lifecycleState: LifecycleState.ACTIVE     }, cfg());
  const conflicted = computeHybridScore({ ...BASE_PARAMS, lifecycleState: LifecycleState.CONFLICTED }, cfg());

  const expectedPenalty = LIFECYCLE_DEFAULTS.conflictScorePenalty; // 0.80
  const expectedScore   = Math.min(1, active.score * expectedPenalty);

  assert.ok(
    Math.abs(conflicted.score - expectedScore) < 1e-9,
    `L3 – CONFLICTED score: expected ${expectedScore.toFixed(6)}, got ${conflicted.score.toFixed(6)}`
  );
  assert.equal(conflicted.lifecyclePenalty, expectedPenalty, `L3 – lifecycle penalty must be ${expectedPenalty}`);
  assert.equal(conflicted.lifecycleState, LifecycleState.CONFLICTED, "L3 – lifecycleState must be CONFLICTED");
  assert.ok(conflicted.score < active.score, "L3 – CONFLICTED score must be strictly less than ACTIVE score");
});

// ─── L4: Missing lifecycleState — treated as ACTIVE ──────────────────────────

test("L4 – missing lifecycleState: behaves identically to ACTIVE (backward compat)", () => {
  const missing = computeHybridScore({ ...BASE_PARAMS }, cfg());
  const active  = computeHybridScore({ ...BASE_PARAMS, lifecycleState: LifecycleState.ACTIVE }, cfg());

  assert.ok(
    Math.abs(missing.score - active.score) < 1e-10,
    `L4 – missing lifecycleState score (${missing.score}) must equal ACTIVE score (${active.score})`
  );
  assert.equal(missing.lifecyclePenalty, 1.0, "L4 – missing state: penalty must be 1.0");
  assert.equal(missing.lifecycleState, LifecycleState.ACTIVE, "L4 – missing state: effective state must be ACTIVE");
});

// ─── L5: Unknown lifecycleState string — treated as ACTIVE ───────────────────

test("L5 – unknown lifecycleState string: treated as ACTIVE (forward compat)", () => {
  const unknown = computeHybridScore({ ...BASE_PARAMS, lifecycleState: "future_state" }, cfg());
  const active  = computeHybridScore({ ...BASE_PARAMS, lifecycleState: LifecycleState.ACTIVE }, cfg());

  assert.ok(
    Math.abs(unknown.score - active.score) < 1e-10,
    `L5 – unknown state score (${unknown.score}) must equal ACTIVE score (${active.score})`
  );
  assert.equal(unknown.lifecyclePenalty, 1.0, "L5 – unknown state: penalty must be 1.0 (no penalty)");
});

// ─── L6: ARCHIVED memory — heavy defensive penalty ───────────────────────────

test("L6 – ARCHIVED lifecycle: score is drastically reduced (0.05 multiplier)", () => {
  const active   = computeHybridScore({ ...BASE_PARAMS, lifecycleState: LifecycleState.ACTIVE   }, cfg());
  const archived = computeHybridScore({ ...BASE_PARAMS, lifecycleState: LifecycleState.ARCHIVED }, cfg());

  assert.equal(archived.lifecyclePenalty, 0.05, "L6 – ARCHIVED penalty must be 0.05");
  assert.ok(archived.score < active.score * 0.06, "L6 – ARCHIVED score must be near-zero relative to ACTIVE");
  assert.equal(archived.lifecycleState, LifecycleState.ARCHIVED, "L6 – lifecycleState must be ARCHIVED");
});

// ─── L7: Lifecycle penalty applied AFTER topical penalty ─────────────────────

test("L7 – lifecycle penalty is applied after topical penalty (both multiply the score)", () => {
  const combinedConfig = cfg({
    topicalPenalty: {
      enabled:       true,
      lowThreshold:  0.15,
      highThreshold: 0.30,
      lowPenalty:    0.10,  // will fire: vectorScore=0.05 < 0.15
      mediumPenalty: 0.50
    }
  });

  // Low-relevance scores so topical penalty fires
  const lowRelevanceParams = {
    vectorScore:     0.05,
    lexicalScore:    0,
    importanceScore: 0.80,
    timestamp:       null,
    sessionId:       SESSION_A,
    querySessionId:  SESSION_A
  };

  const activeResult = computeHybridScore(
    { ...lowRelevanceParams, lifecycleState: LifecycleState.ACTIVE },
    combinedConfig
  );
  const staleResult = computeHybridScore(
    { ...lowRelevanceParams, lifecycleState: LifecycleState.STALE },
    combinedConfig
  );

  // With topical penalty (×0.10) AND stale penalty (×0.60), stale should be
  // ~60% of the already-penalised active score
  const expectedStaleScore = Math.min(1, activeResult.score * LIFECYCLE_DEFAULTS.staleScorePenalty);

  assert.ok(
    Math.abs(staleResult.score - expectedStaleScore) < 1e-9,
    `L7 – combined penalty: expected ${expectedStaleScore.toFixed(6)}, got ${staleResult.score.toFixed(6)}`
  );
  assert.equal(staleResult.topicalPenaltyApplied, true,  "L7 – topical penalty must also be applied");
  assert.equal(staleResult.lifecyclePenalty, LIFECYCLE_DEFAULTS.staleScorePenalty, "L7 – lifecycle penalty must be staleScorePenalty");
});

// ─── L8: Lifecycle metadata propagates through deduplicateAndRerank() ─────────

test("L8 – deduplicateAndRerank: lifecycle state from memory.metadata is applied", () => {
  const staleMemory = {
    id:          "mem-stale-test",
    fingerprint: "fp-stale-test",
    sessionId:   SESSION_A,
    content:     "I work as a software engineer.",
    memoryType:  "factual",
    metadata:    {
      importance:     0.70,
      lifecycleState: LifecycleState.STALE
    }
  };

  const activeMemory = {
    id:          "mem-active-test",
    fingerprint: "fp-active-test",
    sessionId:   SESSION_A,
    content:     "I work as a software engineer.",  // identical content & importance
    memoryType:  "factual",
    metadata:    {
      importance:     0.70,
      lifecycleState: LifecycleState.ACTIVE
    }
  };

  // buildScoredEntries only knows fixture IDs; build manually for custom memories
  const scoredEntries = [
    { memory: staleMemory,  vectorScore: 0.70, lexicalScore: 3 },
    { memory: activeMemory, vectorScore: 0.70, lexicalScore: 3 }
  ];

  const results = deduplicateAndRerank(
    [staleMemory, activeMemory],
    { querySessionId: SESSION_A, scoredEntries },
    cfg()
  );

  expectNoDuplicates(results, "L8");
  assert.equal(results.length, 2, "L8 – both memories must be returned");

  // Active memory must rank above stale memory (same base scores, only penalty differs)
  const activeIndex = results.findIndex((r) => r.id === "mem-active-test");
  const staleIndex  = results.findIndex((r) => r.id === "mem-stale-test");

  assert.ok(activeIndex < staleIndex,
    `L8 – ACTIVE memory (pos=${activeIndex}) must rank above STALE memory (pos=${staleIndex})`);

  // Confirm the _retrieval breakdown carries lifecycle information
  assert.equal(
    results[staleIndex]._retrieval.lifecycleState,
    LifecycleState.STALE,
    "L8 – stale memory _retrieval.lifecycleState must be 'stale'"
  );
  assert.equal(
    results[staleIndex]._retrieval.lifecyclePenalty,
    LIFECYCLE_DEFAULTS.staleScorePenalty,
    "L8 – stale memory _retrieval.lifecyclePenalty must be the staleScorePenalty constant"
  );
  assert.equal(
    results[activeIndex]._retrieval.lifecyclePenalty,
    1.0,
    "L8 – active memory _retrieval.lifecyclePenalty must be 1.0"
  );
});

// ─── L9: Ranking changes when lifecycle penalties apply ───────────────────────

test("L9 – ranking: CONFLICTED memory is pushed below an otherwise lower-scoring ACTIVE memory", () => {
  /**
   * Scenario:
   *   mem-conflicted: high base scores BUT CONFLICTED (×0.80)
   *   mem-active-low: lower base scores, fully ACTIVE
   *
   * Without lifecycle penalty, mem-conflicted would rank first.
   * With the 0.80 conflict penalty, the scores may flip.
   *
   * We choose values where the flip is guaranteed:
   *   conflicted raw ≈ 0.90×0.5 + (4/5)×0.2 + 0.80×0.2 + 1.0×0.1 + 0.04
   *                  = 0.45 + 0.16 + 0.16 + 0.10 + 0.04 = 0.91
   *   conflicted after ×0.80 → 0.728
   *
   *   active-low raw ≈ 0.75×0.5 + (3/5)×0.2 + 0.70×0.2 + 1.0×0.1 + 0.04
   *                  = 0.375 + 0.12 + 0.14 + 0.10 + 0.04 = 0.775
   *   active-low (×1.0) → 0.775
   *
   * 0.775 > 0.728 → active-low wins. Test guards this.
   */
  const conflictedMemory = {
    id:          "mem-conflicted",
    fingerprint: "fp-conflicted",
    sessionId:   SESSION_A,
    content:     "High-scoring but conflicted.",
    memoryType:  "episodic",
    metadata:    { importance: 0.80, lifecycleState: LifecycleState.CONFLICTED }
  };

  const activeLowMemory = {
    id:          "mem-active-low",
    fingerprint: "fp-active-low",
    sessionId:   SESSION_A,
    content:     "Lower-scoring but active.",
    memoryType:  "episodic",
    metadata:    { importance: 0.70, lifecycleState: LifecycleState.ACTIVE }
  };

  // buildScoredEntries only knows fixture IDs; build manually for custom memories
  const scoredEntries = [
    { memory: conflictedMemory, vectorScore: 0.90, lexicalScore: 4 },
    { memory: activeLowMemory,  vectorScore: 0.75, lexicalScore: 3 }
  ];

  const results = deduplicateAndRerank(
    [conflictedMemory, activeLowMemory],
    { querySessionId: SESSION_A, scoredEntries },
    cfg()
  );

  expectNoDuplicates(results, "L9");
  expectScoresDescending(results, "L9");

  const conflictedPos = results.findIndex((r) => r.id === "mem-conflicted");
  const activeLowPos  = results.findIndex((r) => r.id === "mem-active-low");

  assert.ok(
    activeLowPos < conflictedPos,
    `L9 – ACTIVE low-scoring memory (pos=${activeLowPos}) must rank above ` +
    `CONFLICTED high-scoring memory (pos=${conflictedPos})`
  );
});

// ─── L10: Existing callers without lifecycleState keep working ────────────────

test("L10 – backward compat: computeHybridScore() without lifecycleState does not throw", () => {
  // Simulate the legacy call signature used by callers before C-5
  assert.doesNotThrow(() => {
    computeHybridScore(
      {
        vectorScore:     0.65,
        lexicalScore:    2,
        importanceScore: 0.55,
        timestamp:       null,
        sessionId:       "sess-legacy",
        querySessionId:  "sess-legacy"
        // no lifecycleState
      },
      cfg()
    );
  }, "L10 – legacy call without lifecycleState must not throw");
});

test("L10 – backward compat: deduplicateAndRerank() with memories missing lifecycleState does not throw", () => {
  const legacyMemories = FIXTURE_MEMORIES.map((m) => ({
    ...m,
    metadata: { ...(m.metadata || {}), lifecycleState: undefined }
  }));

  assert.doesNotThrow(() => {
    deduplicateAndRerank(
      legacyMemories,
      { querySessionId: SESSION_A, scoredEntries: [] },
      cfg()
    );
  }, "L10 – deduplicateAndRerank must not throw when memories have no lifecycleState");
});

// ─── L11: lifecycleState and lifecyclePenalty exposed in breakdown ─────────────

test("L11 – breakdown fields: lifecycleState and lifecyclePenalty always present in result", () => {
  const states = [
    LifecycleState.ACTIVE,
    LifecycleState.STALE,
    LifecycleState.CONFLICTED,
    LifecycleState.ARCHIVED,
    undefined       // missing state
  ];

  for (const state of states) {
    const result = computeHybridScore(
      { ...BASE_PARAMS, lifecycleState: state },
      cfg()
    );

    assert.ok(
      "lifecycleState" in result,
      `L11 – lifecycleState field must be present for state=${state}`
    );
    assert.ok(
      "lifecyclePenalty" in result,
      `L11 – lifecyclePenalty field must be present for state=${state}`
    );
    assert.ok(
      typeof result.lifecyclePenalty === "number",
      `L11 – lifecyclePenalty must be a number for state=${state}`
    );
    assert.ok(
      result.lifecyclePenalty > 0 && result.lifecyclePenalty <= 1,
      `L11 – lifecyclePenalty must be in (0, 1] for state=${state}, got ${result.lifecyclePenalty}`
    );
  }
});

// ─── L12: Penalty values match lifecycleTypes.js constants exactly ─────────────

test("L12 – penalty values: stale and conflict penalties match LIFECYCLE_DEFAULTS constants", () => {
  // The scorer must not define its own constants — it must reuse those from lifecycleTypes.js
  const lifecycleCfg = readLifecycleConfig();

  const stale     = computeHybridScore({ ...BASE_PARAMS, lifecycleState: LifecycleState.STALE     }, cfg());
  const conflicted= computeHybridScore({ ...BASE_PARAMS, lifecycleState: LifecycleState.CONFLICTED}, cfg());
  const active    = computeHybridScore({ ...BASE_PARAMS, lifecycleState: LifecycleState.ACTIVE    }, cfg());

  assert.equal(
    stale.lifecyclePenalty,
    lifecycleCfg.staleScorePenalty,
    `L12 – stale penalty must equal readLifecycleConfig().staleScorePenalty (${lifecycleCfg.staleScorePenalty})`
  );
  assert.equal(
    conflicted.lifecyclePenalty,
    lifecycleCfg.conflictScorePenalty,
    `L12 – conflict penalty must equal readLifecycleConfig().conflictScorePenalty (${lifecycleCfg.conflictScorePenalty})`
  );
  assert.equal(
    active.lifecyclePenalty,
    1.0,
    "L12 – active penalty must be 1.0 (readLifecycleConfig has no multiplier for ACTIVE)"
  );

  // Confirm the constants themselves match the documented defaults
  assert.equal(lifecycleCfg.staleScorePenalty,    LIFECYCLE_DEFAULTS.staleScorePenalty,    "L12 – staleScorePenalty default");
  assert.equal(lifecycleCfg.conflictScorePenalty, LIFECYCLE_DEFAULTS.conflictScorePenalty, "L12 – conflictScorePenalty default");
});

// ─── L13: STALE memory always ranks below equivalent ACTIVE memory ─────────────

test("L13 – STALE always ranks below ACTIVE memory with identical base scores", () => {
  const makeMemory = (id, fingerprint, lifecycleState) => ({
    id, fingerprint,
    sessionId:  SESSION_A,
    content:    "Identical content for ranking comparison",
    memoryType: "factual",
    metadata:   { importance: 0.65, lifecycleState }
  });

  const staleM  = makeMemory("mem-stale-l13",  "fp-stale-l13",  LifecycleState.STALE);
  const activeM = makeMemory("mem-active-l13", "fp-active-l13", LifecycleState.ACTIVE);

  // buildScoredEntries only knows fixture IDs; build manually for custom memories
  const scoredEntries = [
    { memory: staleM,  vectorScore: 0.65, lexicalScore: 2 },
    { memory: activeM, vectorScore: 0.65, lexicalScore: 2 }  // identical
  ];

  const results = deduplicateAndRerank(
    [staleM, activeM],
    { querySessionId: SESSION_A, scoredEntries },
    cfg()
  );

  const activePos = results.findIndex((r) => r.id === "mem-active-l13");
  const stalePos  = results.findIndex((r) => r.id === "mem-stale-l13");

  assert.ok(
    activePos < stalePos,
    `L13 – ACTIVE (pos=${activePos}) must always rank above STALE (pos=${stalePos}) when base scores are equal`
  );
});

// ─── L14: CONFLICTED memory always ranks below equivalent ACTIVE memory ────────

test("L14 – CONFLICTED always ranks below ACTIVE memory with identical base scores", () => {
  const makeMemory = (id, fingerprint, lifecycleState) => ({
    id, fingerprint,
    sessionId:  SESSION_A,
    content:    "Identical content for ranking comparison",
    memoryType: "factual",
    metadata:   { importance: 0.65, lifecycleState }
  });

  const conflictedM = makeMemory("mem-conflicted-l14", "fp-conflicted-l14", LifecycleState.CONFLICTED);
  const activeM     = makeMemory("mem-active-l14",     "fp-active-l14",     LifecycleState.ACTIVE);

  // buildScoredEntries only knows fixture IDs; build manually for custom memories
  const scoredEntries = [
    { memory: conflictedM, vectorScore: 0.65, lexicalScore: 2 },
    { memory: activeM,     vectorScore: 0.65, lexicalScore: 2 }
  ];

  const results = deduplicateAndRerank(
    [conflictedM, activeM],
    { querySessionId: SESSION_A, scoredEntries },
    cfg()
  );

  const activePos     = results.findIndex((r) => r.id === "mem-active-l14");
  const conflictedPos = results.findIndex((r) => r.id === "mem-conflicted-l14");

  assert.ok(
    activePos < conflictedPos,
    `L14 – ACTIVE (pos=${activePos}) must always rank above CONFLICTED (pos=${conflictedPos}) when base scores are equal`
  );
});

// ─── L15: Score is still clamped to [0, 1] after lifecycle penalty ─────────────

test("L15 – score clamping: lifecycle penalty never drives score below 0 or above 1", () => {
  const extremeParams = {
    vectorScore:     1.0,
    lexicalScore:    100,
    importanceScore: 1.0,
    timestamp:       null,
    sessionId:       SESSION_A,
    querySessionId:  SESSION_A
  };

  const highCfg = cfg({ vectorWeight: 1, lexicalWeight: 1, importanceWeight: 1, recencyWeight: 1 });

  for (const state of Object.values(LifecycleState)) {
    const result = computeHybridScore({ ...extremeParams, lifecycleState: state }, highCfg);
    assert.ok(result.score >= 0, `L15 – score must be ≥ 0 for state=${state}, got ${result.score}`);
    assert.ok(result.score <= 1, `L15 – score must be ≤ 1 for state=${state}, got ${result.score}`);
  }
});
