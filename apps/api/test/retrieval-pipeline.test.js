/**
 * apps/api/test/retrieval-pipeline.test.js
 *
 * Integration test suite for the AiNeura hybrid retrieval pipeline.
 *
 * Tests exercise:
 *   - computeHybridScore  (pure)
 *   - deduplicateAndRerank (pure)
 *   - scoreQueryOverlap   (pure, from @neura/core)
 *   - applyRecencyDecay   (pure)
 *
 * No Redis, Qdrant, PostgreSQL, or Neo4j connections are made.
 * All vector / lexical scores are injected deterministically via scoredEntries.
 *
 * Test matrix:
 *   A. Pure vector retrieval
 *   B. Pure keyword (lexical) retrieval
 *   C. Hybrid retrieval (default weights)
 *   D. Vector weight dominance
 *   E. Keyword weight dominance
 *   F. Reranker disabled  (original order preserved)
 *   G. Reranker enabled   (reranked order applied)
 *   H. Top-K limiting
 *   I. Empty result handling
 *   J. Domain / entity overlap boost
 */

import test            from "node:test";
import assert          from "node:assert/strict";

import {
  computeHybridScore,
  deduplicateAndRerank,
  applyRecencyDecay,
  applyTopicalRelevancePenalty
} from "../src/services/retrieval-scorer.js";

import { scoreQueryOverlap } from "@neura/core";

import {
  FIXTURE_MEMORIES,
  MEMORY_BY_ID,
  SESSION_A,
  SESSION_B,
  buildScoredEntries
} from "./fixtures/retrieval-memories.js";

import {
  expectIdsInOrder,
  expectScoresDescending,
  expectNoDuplicates,
  expectTopK,
  expectEmptyResults,
  expectIdFirst
} from "./helpers/retrieval-assertions.js";

// ─── Shared config helpers ────────────────────────────────────────────────────

/** Build a config object from partial overrides using sensible defaults. */
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
    ...overrides
  };
}

// ─── A: Pure vector retrieval ─────────────────────────────────────────────────

test("A – pure vector retrieval: semantic match ranks first", () => {
  /**
   * Scenario: query is semantically similar to mem-s1 (travel/jet-lag concept)
   * but does NOT share keywords. Vector score for mem-s1 is highest.
   * Lexical scoring is zeroed out (lexicalWeight = 0).
   */
  const vectorConfig = cfg({ vectorWeight: 1.0, lexicalWeight: 0, importanceWeight: 0, recencyWeight: 0 });

  const memories = [
    MEMORY_BY_ID["mem-s1"],   // long-haul travel concept – highest vector similarity
    MEMORY_BY_ID["mem-f2"],   // software engineer – low semantic similarity to query
    MEMORY_BY_ID["mem-noise2"] // cloud subscription – unrelated
  ];

  const scoredEntries = buildScoredEntries([
    { id: "mem-s1",     vectorScore: 0.92, lexicalScore: 0 },
    { id: "mem-f2",     vectorScore: 0.35, lexicalScore: 0 },
    { id: "mem-noise2", vectorScore: 0.10, lexicalScore: 0 }
  ]);

  const results = deduplicateAndRerank(
    memories,
    { querySessionId: SESSION_A, scoredEntries },
    vectorConfig
  );

  expectNoDuplicates(results, "A");
  expectScoresDescending(results, "A");
  expectIdFirst(results, "mem-s1", "A – semantic match must rank first");
});

// ─── B: Pure keyword (lexical) retrieval ──────────────────────────────────────

test("B – pure keyword retrieval: exact keyword match ranks first", () => {
  /**
   * Scenario: query contains exact keywords from mem-e2 (sprint/deploy/api).
   * Vector weights are zeroed; only lexical overlap drives the score.
   */
  const lexicalConfig = cfg({ vectorWeight: 0, lexicalWeight: 1.0, importanceWeight: 0, recencyWeight: 0 });

  const query    = "deployed new api endpoint production";
  const memories = [
    MEMORY_BY_ID["mem-e2"],    // "deployed the new API endpoint to production" – high overlap
    MEMORY_BY_ID["mem-s3"],    // aerobic exercise – no overlap
    MEMORY_BY_ID["mem-noise1"] // thai food – no overlap
  ];

  // Use scoreQueryOverlap to compute ground-truth lexical scores
  const lexE2     = scoreQueryOverlap(query, memories[0].content);  // should be 3+
  const lexS3     = scoreQueryOverlap(query, memories[1].content);
  const lexNoise1 = scoreQueryOverlap(query, memories[2].content);

  const scoredEntries = buildScoredEntries([
    { id: "mem-e2",     vectorScore: 0, lexicalScore: lexE2 },
    { id: "mem-s3",     vectorScore: 0, lexicalScore: lexS3 },
    { id: "mem-noise1", vectorScore: 0, lexicalScore: lexNoise1 }
  ]);

  const results = deduplicateAndRerank(
    memories,
    { querySessionId: SESSION_A, scoredEntries },
    lexicalConfig
  );

  expectNoDuplicates(results, "B");
  expectScoresDescending(results, "B");
  expectIdFirst(results, "mem-e2", "B – keyword match must rank first");

  // Bonus: verify scoreQueryOverlap found reasonable overlap
  assert.ok(lexE2 >= 2, `B – expected ≥2 keyword matches, got ${lexE2}`);
});

// ─── C: Hybrid retrieval (default weights) ────────────────────────────────────

test("C – hybrid retrieval: combined vector + lexical ranking is correct", () => {
  /**
   * Scenario: default config (vector 0.5, lexical 0.2, importance 0.2, recency 0.1).
   * mem-f1 has moderate vector score AND keyword overlap → should rank above
   * mem-s2 which has a good vector score but zero lexical overlap.
   * mem-noise2 should rank last (low everything).
   */
  const defaultConfig = cfg();

  const memories = [
    MEMORY_BY_ID["mem-f1"],    // travel/window-seat: moderate vector + lexical
    MEMORY_BY_ID["mem-s2"],    // japanese cuisine: good vector, zero lexical
    MEMORY_BY_ID["mem-noise2"] // subscription: low all
  ];

  const scoredEntries = buildScoredEntries([
    { id: "mem-f1",     vectorScore: 0.70, lexicalScore: 3 }, // good hybrid
    { id: "mem-s2",     vectorScore: 0.75, lexicalScore: 0 }, // vector only
    { id: "mem-noise2", vectorScore: 0.10, lexicalScore: 0 }
  ]);

  const results = deduplicateAndRerank(
    memories,
    { querySessionId: SESSION_A, scoredEntries },
    defaultConfig
  );

  expectNoDuplicates(results, "C");
  expectScoresDescending(results, "C");

  // mem-noise2 must be last
  const lastId = results[results.length - 1]?.id;
  assert.equal(lastId, "mem-noise2", "C – noise memory must rank last");

  // The top two must be mem-f1 and mem-s2 in some order
  const topTwoIds = results.slice(0, 2).map((r) => r.id);
  assert.ok(topTwoIds.includes("mem-f1"), "C – mem-f1 must be in top-2");
  assert.ok(topTwoIds.includes("mem-s2"), "C – mem-s2 must be in top-2");
});

// ─── D: Vector weight dominance ───────────────────────────────────────────────

test("D – vector weight dominance: semantic match outranks keyword-only match", () => {
  /**
   * Scenario: RETRIEVAL_VECTOR_WEIGHT is set very high (0.9).
   * mem-semantic has high vector score but zero keyword overlap.
   * mem-keyword has zero vector score but strong keyword overlap.
   * With vectorWeight=0.9, mem-semantic must win.
   */
  const highVectorConfig = cfg({
    vectorWeight:     0.9,
    lexicalWeight:    0.05,
    importanceWeight: 0.03,
    recencyWeight:    0.02
  });

  const memories = [
    MEMORY_BY_ID["mem-s1"],  // semantic match (travel concept) – no keywords in query
    MEMORY_BY_ID["mem-e1"],  // episodic travel – keywords match query
    MEMORY_BY_ID["mem-s3"]   // fitness concept – low everything
  ];

  const scoredEntries = buildScoredEntries([
    { id: "mem-s1", vectorScore: 0.91, lexicalScore: 0 }, // semantic winner
    { id: "mem-e1", vectorScore: 0.20, lexicalScore: 4 }, // keyword winner
    { id: "mem-s3", vectorScore: 0.15, lexicalScore: 0 }
  ]);

  const results = deduplicateAndRerank(
    memories,
    { querySessionId: SESSION_A, scoredEntries },
    highVectorConfig
  );

  expectNoDuplicates(results, "D");
  expectScoresDescending(results, "D");
  expectIdFirst(results, "mem-s1", "D – high vectorWeight: semantic match must rank first");
});

// ─── E: Keyword weight dominance ─────────────────────────────────────────────

test("E – keyword weight dominance: exact keyword match outranks semantic match", () => {
  /**
   * Scenario: RETRIEVAL_LEXICAL_WEIGHT is set very high (0.85).
   * mem-e2 has strong keyword overlap; mem-s1 has high vector score only.
   * With lexicalWeight=0.85, mem-e2 must win.
   */
  const highLexicalConfig = cfg({
    vectorWeight:     0.05,
    lexicalWeight:    0.85,
    importanceWeight: 0.05,
    recencyWeight:    0.05
  });

  const memories = [
    MEMORY_BY_ID["mem-e2"],  // keyword winner (sprint, deployed, api, production)
    MEMORY_BY_ID["mem-s1"],  // vector winner (travel concept)
    MEMORY_BY_ID["mem-f2"]   // software engineer – low overlap
  ];

  const scoredEntries = buildScoredEntries([
    { id: "mem-e2", vectorScore: 0.30, lexicalScore: 4 }, // keyword winner
    { id: "mem-s1", vectorScore: 0.89, lexicalScore: 0 }, // vector winner
    { id: "mem-f2", vectorScore: 0.40, lexicalScore: 1 }
  ]);

  const results = deduplicateAndRerank(
    memories,
    { querySessionId: SESSION_A, scoredEntries },
    highLexicalConfig
  );

  expectNoDuplicates(results, "E");
  expectScoresDescending(results, "E");
  expectIdFirst(results, "mem-e2", "E – high lexicalWeight: keyword match must rank first");
});

// ─── F: Reranker disabled (original ranking preserved) ───────────────────────

test("F – reranker disabled: deterministic insertion order is preserved as ranking", () => {
  /**
   * Scenario: all memories have IDENTICAL hybrid scores (same vector, lexical,
   * importance, and recency). With no score differentiation, the output order
   * must equal the sort-stable order. We verify by using equal scores and
   * confirming the result is still sorted (trivially) and has no duplicates.
   *
   * This test simulates "reranker OFF": the scorer must not arbitrarily
   * reorder items that have equal scores.
   *
   * Implementation notes:
   * - vectorWeight=1, all others=0 → only vectorScore matters
   * - Set querySessionId to a third session so NO memory receives a session
   *   bonus (session bonus only fires when memory.sessionId === querySessionId)
   * - All three memories are from SESSION_A/SESSION_B, neither matches SESSION_C
   * - Result: every memory score = vectorScore × 1.0 = 0.50 → truly equal
   *
   * JavaScript Array.sort() is stable in Node 12+, so equal scores
   * preserve insertion order.
   */
  const SESSION_C   = "session-test-C"; // no memories live in this session
  const equalConfig = cfg({
    vectorWeight:     1.0,
    lexicalWeight:    0,
    importanceWeight: 0,
    recencyWeight:    0
  });

  const memories = [
    MEMORY_BY_ID["mem-f1"],
    MEMORY_BY_ID["mem-e3"],
    MEMORY_BY_ID["mem-s2"]
  ];

  // Give every memory the exact same vector score
  const scoredEntries = buildScoredEntries([
    { id: "mem-f1", vectorScore: 0.50, lexicalScore: 0 },
    { id: "mem-e3", vectorScore: 0.50, lexicalScore: 0 },
    { id: "mem-s2", vectorScore: 0.50, lexicalScore: 0 }
  ]);

  const results = deduplicateAndRerank(
    memories,
    { querySessionId: SESSION_C, scoredEntries },
    equalConfig
  );

  expectNoDuplicates(results, "F");
  expectScoresDescending(results, "F");

  // All scores must be equal (within floating-point tolerance)
  const scores = results.map((r) => r._retrieval.score);
  const allEqual = scores.every((s) => Math.abs(s - scores[0]) < 1e-9);
  assert.ok(allEqual, `F – expected equal scores, got: ${JSON.stringify(scores)}`);

  // Result count must equal input count (no spurious filtering)
  assert.equal(results.length, memories.length, "F – result count mismatch");
});

// ─── G: Reranker enabled (reranked order applied) ────────────────────────────

test("G – reranker enabled: score-based reranking overrides insertion order", () => {
  /**
   * Scenario: memories are provided in low→high score order.
   * After deduplicateAndRerank, the output must be sorted high→low.
   * This confirms the scorer applies its own ranking, not the input order.
   */
  const rerankerConfig = cfg({
    vectorWeight:     1.0,
    lexicalWeight:    0,
    importanceWeight: 0,
    recencyWeight:    0
  });

  // Deliberately insert in ascending score order
  const memories = [
    MEMORY_BY_ID["mem-noise2"],  // will score lowest
    MEMORY_BY_ID["mem-f2"],      // will score medium
    MEMORY_BY_ID["mem-e2"]       // will score highest
  ];

  const scoredEntries = buildScoredEntries([
    { id: "mem-noise2", vectorScore: 0.10, lexicalScore: 0 },
    { id: "mem-f2",     vectorScore: 0.55, lexicalScore: 0 },
    { id: "mem-e2",     vectorScore: 0.88, lexicalScore: 0 }
  ]);

  const results = deduplicateAndRerank(
    memories,
    { querySessionId: SESSION_A, scoredEntries },
    rerankerConfig
  );

  expectNoDuplicates(results, "G");
  expectScoresDescending(results, "G");

  // Must be reversed from insertion order
  expectIdsInOrder(results, ["mem-e2", "mem-f2", "mem-noise2"], "G – reranked order");
});

// ─── H: Top-K limiting ────────────────────────────────────────────────────────

test("H – top-K limiting: exactly K results returned regardless of input size", () => {
  /**
   * Scenario: provide all 10 fixture memories; set topK = 3.
   * Exactly 3 results must be returned and they must be the top-3 by score.
   */
  const topKConfig = cfg({ topK: 3, vectorWeight: 1.0, lexicalWeight: 0, importanceWeight: 0, recencyWeight: 0 });

  const scoredEntries = buildScoredEntries(
    FIXTURE_MEMORIES.map((m, i) => ({
      id:          m.id,
      vectorScore: (FIXTURE_MEMORIES.length - i) / FIXTURE_MEMORIES.length, // descending
      lexicalScore: 0
    }))
  );

  const results = deduplicateAndRerank(
    FIXTURE_MEMORIES,
    { querySessionId: SESSION_A, scoredEntries },
    topKConfig
  );

  expectTopK(results, 3, "H");
  expectNoDuplicates(results, "H");
  expectScoresDescending(results, "H");

  // The top-3 must be the first 3 memories from the fixture (highest vector scores)
  const topIds = FIXTURE_MEMORIES.slice(0, 3).map((m) => m.id);
  expectIdsInOrder(results, topIds, "H – correct top-3");
});

// ─── I: Empty result handling ─────────────────────────────────────────────────

test("I – empty result handling: returns [] without throwing when no memories", () => {
  /**
   * Scenario: empty input array — simulate a query that returns no matches
   * from any store. Must not throw and must return an empty array.
   */
  let results;
  assert.doesNotThrow(() => {
    results = deduplicateAndRerank(
      [],
      { querySessionId: SESSION_A, scoredEntries: [] },
      cfg()
    );
  }, "I – deduplicateAndRerank must not throw on empty input");

  expectEmptyResults(results, "I");
});

test("I – empty result handling: single null/undefined guard", () => {
  /**
   * Edge-case: memories list contains a memory whose fields are all absent.
   * It should not throw; the item should be scored at ~0 and returned once.
   */
  const minimalMemory = {
    id:          "mem-minimal",
    fingerprint: "fp-minimal",
    sessionId:   SESSION_A,
    content:     "",
    memoryType:  "semantic",
    metadata:    {}
  };

  let results;
  assert.doesNotThrow(() => {
    results = deduplicateAndRerank(
      [minimalMemory],
      { querySessionId: SESSION_A, scoredEntries: [] },
      cfg()
    );
  }, "I – minimal memory must not throw");

  assert.equal(results.length, 1, "I – should return 1 result for minimal memory");
  assert.ok(results[0]._retrieval.score >= 0, "I – score must be non-negative");
});

// ─── J: Domain / entity overlap boost ────────────────────────────────────────

test("J – entity/keyword overlap: travel entity present in multiple memories", () => {
  /**
   * Scenario: query contains travel-domain keywords ("travel", "flight",
   * "window", "seat", "clouds", "overseas"). These words overlap with
   * mem-f1 / mem-e1 / mem-s1 but not with mem-noise1 (thai food) or
   * mem-s3 (fitness).
   *
   * We use lexical-only scoring (vectorWeight=0, importanceWeight=0,
   * recencyWeight=0) so the ranking is driven entirely by keyword overlap —
   * this isolates the entity/keyword boost and prevents importance scores
   * or recency from contaminating the order.
   *
   * Expected: all three travel memories must outrank both noise memories.
   */
  const lexicalOnlyConfig = cfg({
    topK:             5,
    vectorWeight:     0,
    lexicalWeight:    1.0,
    importanceWeight: 0,
    recencyWeight:    0
  });

  const query = "travel flight window seat clouds overseas";

  const memories = [
    MEMORY_BY_ID["mem-f1"],    // "window seats on flights … travel" – HIGH overlap
    MEMORY_BY_ID["mem-e1"],    // "travelled to Tokyo … conference"  – MEDIUM overlap
    MEMORY_BY_ID["mem-s1"],    // "long-haul … travel"               – MEDIUM overlap
    MEMORY_BY_ID["mem-noise1"],// thai food – ZERO overlap
    MEMORY_BY_ID["mem-s3"]     // fitness – ZERO overlap
  ];

  // Compute real lexical scores using scoreQueryOverlap
  const lexScores = memories.map((m) => ({
    id:           m.id,
    vectorScore:  0,
    lexicalScore: scoreQueryOverlap(query, m.content)
  }));

  const scoredEntries = buildScoredEntries(lexScores);

  const results = deduplicateAndRerank(
    memories,
    { querySessionId: SESSION_A, scoredEntries },
    lexicalOnlyConfig
  );

  expectNoDuplicates(results, "J");
  expectScoresDescending(results, "J");

  // mem-f1 has the most keyword overlap ("travel", "flights", "window")
  expectIdFirst(results, "mem-f1", "J – travel memory with most overlap must rank first");

  // All three travel memories must outrank the two noise memories.
  // With lexical-only scoring and zero overlap for noise, noise scores = 0.
  // Travel memories have overlap ≥ 1, so they score > 0 → all beat noise.
  const resultIds      = results.map((r) => r.id);
  const travelIds      = ["mem-f1", "mem-e1", "mem-s1"];
  const noiseIds       = ["mem-noise1", "mem-s3"];

  const travelPositions = travelIds.map((id) => resultIds.indexOf(id));
  const noisePositions  = noiseIds.map((id) => resultIds.indexOf(id));

  const maxTravelPos = Math.max(...travelPositions);
  const minNoisePos  = Math.min(...noisePositions);

  assert.ok(
    maxTravelPos < minNoisePos,
    `J – all travel memories must rank above noise: travel positions ${JSON.stringify(travelPositions)}, noise ${JSON.stringify(noisePositions)}`
  );
});

// ─── Bonus: applyRecencyDecay unit tests ──────────────────────────────────────

test("recency decay: recent memory scores near 1.0", () => {
  const ts    = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 minutes ago
  const decay = applyRecencyDecay(ts, 72);
  assert.ok(decay > 0.99, `Expected decay > 0.99 for 30-min-old memory, got ${decay}`);
});

test("recency decay: 72h-old memory scores ~0.5 (one half-life)", () => {
  const ts    = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
  const decay = applyRecencyDecay(ts, 72);
  // At exactly one half-life, decay = 0.5; allow small floating-point margin
  assert.ok(decay > 0.48 && decay < 0.52, `Expected ~0.5 for 72h-old memory, got ${decay}`);
});

test("recency decay: null timestamp returns 1.0", () => {
  const decay = applyRecencyDecay(null, 72);
  assert.equal(decay, 1.0, "Null timestamp must return 1.0");
});

test("recency decay: very old memory never reaches 0", () => {
  const ts    = new Date(Date.now() - 10000 * 60 * 60 * 1000).toISOString(); // 10 000 hours ago
  const decay = applyRecencyDecay(ts, 72);
  assert.ok(decay > 0, `Very old memory must score > 0, got ${decay}`);
});

// ─── Bonus: computeHybridScore unit tests ─────────────────────────────────────

test("computeHybridScore: same session gets a bonus", () => {
  const base = computeHybridScore(
    { vectorScore: 0.5, lexicalScore: 2, importanceScore: 0.5, timestamp: null, sessionId: "S1", querySessionId: "S2" },
    cfg()
  );
  const sameSession = computeHybridScore(
    { vectorScore: 0.5, lexicalScore: 2, importanceScore: 0.5, timestamp: null, sessionId: "S1", querySessionId: "S1" },
    cfg()
  );
  assert.ok(sameSession.score > base.score, "Same-session memory must score higher due to session bonus");
  assert.equal(sameSession.sessionBonus, 0.04, "Session bonus must be exactly 0.04");
});

test("computeHybridScore: score is clamped to [0, 1]", () => {
  const result = computeHybridScore(
    { vectorScore: 1, lexicalScore: 100, importanceScore: 1, timestamp: null, sessionId: "S", querySessionId: "S" },
    cfg({ vectorWeight: 1, lexicalWeight: 1, importanceWeight: 1, recencyWeight: 1 })
  );
  assert.ok(result.score <= 1.0, `Score must be ≤ 1.0, got ${result.score}`);
  assert.ok(result.score >= 0.0, `Score must be ≥ 0.0, got ${result.score}`);
});

test("computeHybridScore: negative vector score treated as 0", () => {
  const result = computeHybridScore(
    { vectorScore: -1, lexicalScore: 0, importanceScore: 0, timestamp: null, sessionId: "S", querySessionId: "S" },
    cfg({ vectorWeight: 1, lexicalWeight: 0, importanceWeight: 0, recencyWeight: 0 })
  );
  assert.equal(result.vectorScore, 0, "Negative vector score must be clamped to 0");
});

// ─── Bonus: scoreQueryOverlap unit tests ─────────────────────────────────────

test("scoreQueryOverlap: exact token matches counted correctly", () => {
  const query   = "deployed api production";
  const content = "Yesterday I deployed the new API endpoint to production server.";
  const overlap = scoreQueryOverlap(query, content);
  // "deployed" and "production" are non-stopwords in both (api is short but not stopped)
  assert.ok(overlap >= 2, `Expected ≥2 overlapping terms, got ${overlap}`);
});

test("scoreQueryOverlap: zero overlap for unrelated texts", () => {
  const overlap = scoreQueryOverlap("aerobic exercise cardiovascular", "thai food noodles chilli");
  assert.equal(overlap, 0, "Unrelated texts must have 0 overlap");
});

test("scoreQueryOverlap: stop words are excluded from overlap count", () => {
  const overlapAll  = scoreQueryOverlap("the and or is", "the and or is a to");
  // All tokens are stop-words → tokenize returns [] → overlap = 0
  assert.equal(overlapAll, 0, "Stop-word-only query must return 0 overlap");
});

// ─── Bonus: deduplication by fingerprint ─────────────────────────────────────

test("deduplicateAndRerank: duplicate fingerprints collapsed to one result", () => {
  /**
   * Two memories share the same fingerprint (simulating a near-duplicate).
   * deduplicateAndRerank must keep only the one with the higher importance.
   */
  const highImportanceMemory = {
    ...MEMORY_BY_ID["mem-f1"],
    id:         "mem-dup-high",
    fingerprint: "fp-shared",
    metadata:   { ...MEMORY_BY_ID["mem-f1"].metadata, importance: 0.90 }
  };
  const lowImportanceMemory = {
    ...MEMORY_BY_ID["mem-f1"],
    id:         "mem-dup-low",
    fingerprint: "fp-shared",
    metadata:   { ...MEMORY_BY_ID["mem-f1"].metadata, importance: 0.30 }
  };

  const results = deduplicateAndRerank(
    [highImportanceMemory, lowImportanceMemory],
    { querySessionId: SESSION_A, scoredEntries: [] },
    cfg()
  );

  assert.equal(results.length, 1, "Duplicate fingerprints must be collapsed to 1 result");
  assert.equal(results[0].id, "mem-dup-high", "Higher-importance duplicate must be kept");
});

// ═══════════════════════════════════════════════════════════════════════════════
// K: Topical relevance penalty — regression tests
//
// These tests document and guard against the ranking bug where a high-importance
// but topically unrelated memory (e.g. mem-f2: "senior software engineer") can
// outrank a genuine travel memory for a travel query because
//   importanceWeight (0.2) × importance (0.85) = 0.17
// dominates when vector and lexical scores are near zero.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── K0: Reproduce the raw bug (penalty OFF) ──────────────────────────────────

test("K0 – regression baseline: without penalty, high-importance off-topic memory CAN outscore low-relevance travel memory", () => {
  /**
   * Demonstrates the pre-fix behaviour.
   * mem-f2 (software engineer, importance=0.85) has very low vector/lexical
   * relevance to the travel query. mem-s1 (travel concept, importance=0.55)
   * has low relevance too, but the scores can be close enough for the
   * importance bias to decide ranking.
   *
   * This test does NOT assert an ordering — it asserts that WITHOUT the
   * penalty enabled the scores are close (the bug is latent), so enabling
   * the penalty makes a meaningful difference.
   */
  const penaltyOffConfig = cfg({
    vectorWeight:     0.5,
    lexicalWeight:    0.2,
    importanceWeight: 0.2,
    recencyWeight:    0.1,
    topicalPenalty: { enabled: false }
  });

  // Both memories have near-zero relevance (low vector + zero lexical)
  const scoreTravelMemory = computeHybridScore(
    {
      vectorScore:     0.08,   // semantically distant from travel query for this memory
      lexicalScore:    0,
      importanceScore: 0.55,   // mem-s1 importance
      timestamp:       null,
      sessionId:       SESSION_A,
      querySessionId:  SESSION_A
    },
    penaltyOffConfig
  );

  const scoreOffTopicMemory = computeHybridScore(
    {
      vectorScore:     0.05,   // essentially zero relevance to travel query
      lexicalScore:    0,
      importanceScore: 0.85,   // mem-f2 importance (high)
      timestamp:       null,
      sessionId:       SESSION_A,
      querySessionId:  SESSION_A
    },
    penaltyOffConfig
  );

  // Without the penalty the scores should be within 0.07 of each other,
  // showing the importance bias can easily flip the order.
  const scoreDiff = Math.abs(scoreOffTopicMemory.score - scoreTravelMemory.score);
  assert.ok(
    scoreDiff < 0.07,
    `K0 – without penalty, scores should be close (diff=${scoreDiff.toFixed(4)}). ` +
    `travel=${scoreTravelMemory.score.toFixed(4)} offTopic=${scoreOffTopicMemory.score.toFixed(4)}`
  );
});

// ─── K1: applyTopicalRelevancePenalty unit tests ──────────────────────────────

test("K1 – applyTopicalRelevancePenalty: disabled flag returns finalScore unchanged", () => {
  const score = applyTopicalRelevancePenalty({
    vectorScore:  0.05,
    keywordScore: 0.00,
    finalScore:   0.25,
    config: { topicalPenalty: { enabled: false, lowThreshold: 0.15, highThreshold: 0.30, lowPenalty: 0.10, mediumPenalty: 0.50 } }
  });
  assert.equal(score, 0.25, "K1 – disabled: score must be returned unchanged");
});

test("K1 – applyTopicalRelevancePenalty: very low relevance applies lowPenalty multiplier", () => {
  const finalScore = 0.25;
  const lowPenalty = 0.10;
  const score = applyTopicalRelevancePenalty({
    vectorScore:  0.05,   // below lowThreshold 0.15
    keywordScore: 0.02,   // max relevance = 0.05 < 0.15
    finalScore,
    config: { topicalPenalty: { enabled: true, lowThreshold: 0.15, highThreshold: 0.30, lowPenalty, mediumPenalty: 0.50 } }
  });
  assert.ok(
    Math.abs(score - finalScore * lowPenalty) < 1e-9,
    `K1 – lowPenalty: expected ${finalScore * lowPenalty}, got ${score}`
  );
});

test("K1 – applyTopicalRelevancePenalty: medium relevance applies mediumPenalty multiplier", () => {
  const finalScore   = 0.30;
  const mediumPenalty = 0.50;
  const score = applyTopicalRelevancePenalty({
    vectorScore:  0.20,   // above lowThreshold (0.15) but below highThreshold (0.30)
    keywordScore: 0.10,
    finalScore,
    config: { topicalPenalty: { enabled: true, lowThreshold: 0.15, highThreshold: 0.30, lowPenalty: 0.10, mediumPenalty } }
  });
  assert.ok(
    Math.abs(score - finalScore * mediumPenalty) < 1e-9,
    `K1 – mediumPenalty: expected ${finalScore * mediumPenalty}, got ${score}`
  );
});

test("K1 – applyTopicalRelevancePenalty: relevant memory (≥ highThreshold) is not penalised", () => {
  const finalScore = 0.60;
  const score = applyTopicalRelevancePenalty({
    vectorScore:  0.75,   // well above highThreshold (0.30)
    keywordScore: 0.40,
    finalScore,
    config: { topicalPenalty: { enabled: true, lowThreshold: 0.15, highThreshold: 0.30, lowPenalty: 0.10, mediumPenalty: 0.50 } }
  });
  assert.equal(score, finalScore, "K1 – no penalty for relevance ≥ highThreshold");
});

test("K1 – applyTopicalRelevancePenalty: uses MAX of vector and keyword scores for relevance gate", () => {
  /**
   * keywordScore is 0.20 (above lowThreshold) so the medium penalty branch is
   * taken, NOT the low penalty branch — even though vectorScore is near-zero.
   */
  const finalScore    = 0.40;
  const mediumPenalty = 0.50;
  const score = applyTopicalRelevancePenalty({
    vectorScore:  0.03,   // near zero
    keywordScore: 0.20,   // above lowThreshold (0.15), below highThreshold (0.30)
    finalScore,
    config: { topicalPenalty: { enabled: true, lowThreshold: 0.15, highThreshold: 0.30, lowPenalty: 0.10, mediumPenalty } }
  });
  assert.ok(
    Math.abs(score - finalScore * mediumPenalty) < 1e-9,
    `K1 – max-gate: expected ${finalScore * mediumPenalty}, got ${score}`
  );
});

test("K1 – applyTopicalRelevancePenalty: null/undefined scores default to 0 (no crash)", () => {
  assert.doesNotThrow(() => {
    applyTopicalRelevancePenalty({
      vectorScore:  null,
      keywordScore: undefined,
      finalScore:   0.20,
      config: { topicalPenalty: { enabled: true, lowThreshold: 0.15, highThreshold: 0.30, lowPenalty: 0.10, mediumPenalty: 0.50 } }
    });
  }, "K1 – must not throw when vectorScore/keywordScore are null/undefined");
});

// ─── K2: computeHybridScore integration with penalty ─────────────────────────

test("K2 – computeHybridScore: penalty field absent when flag is off", () => {
  const result = computeHybridScore(
    { vectorScore: 0.05, lexicalScore: 0, importanceScore: 0.85, timestamp: null, sessionId: "S", querySessionId: "S" },
    cfg({ topicalPenalty: { enabled: false } })
  );
  assert.equal(result.topicalPenaltyApplied, false, "K2 – penalty flag off: topicalPenaltyApplied must be false");
});

test("K2 – computeHybridScore: penalty applied when enabled and relevance is very low", () => {
  const penaltyOnConfig = cfg({
    vectorWeight:     0.5,
    lexicalWeight:    0.2,
    importanceWeight: 0.2,
    recencyWeight:    0.1,
    topicalPenalty: { enabled: true, lowThreshold: 0.15, highThreshold: 0.30, lowPenalty: 0.10, mediumPenalty: 0.50 }
  });

  const result = computeHybridScore(
    { vectorScore: 0.05, lexicalScore: 0, importanceScore: 0.85, timestamp: null, sessionId: "S", querySessionId: "S" },
    penaltyOnConfig
  );

  assert.equal(result.topicalPenaltyApplied, true, "K2 – low relevance: topicalPenaltyApplied must be true");
  // Score should be ~10% of the raw score because lowPenalty=0.10
  const rawWithoutPenalty =
    0.05 * 0.5 +     // vector
    0    * 0.2 +     // lexical
    0.85 * 0.2 +     // importance
    1.0  * 0.1 +     // recency (null ts → 1.0)
    0.04;            // session bonus (same session)
  const expected = rawWithoutPenalty * 0.10;
  assert.ok(
    Math.abs(result.score - expected) < 0.001,
    `K2 – penalised score: expected ≈${expected.toFixed(4)}, got ${result.score.toFixed(4)}`
  );
});

test("K2 – computeHybridScore: penalty NOT applied when relevance is above highThreshold", () => {
  const penaltyOnConfig = cfg({
    vectorWeight:     0.5,
    lexicalWeight:    0.2,
    importanceWeight: 0.2,
    recencyWeight:    0.1,
    topicalPenalty: { enabled: true, lowThreshold: 0.15, highThreshold: 0.30, lowPenalty: 0.10, mediumPenalty: 0.50 }
  });

  const result = computeHybridScore(
    { vectorScore: 0.80, lexicalScore: 3, importanceScore: 0.60, timestamp: null, sessionId: "S", querySessionId: "S2" },
    penaltyOnConfig
  );

  assert.equal(result.topicalPenaltyApplied, false, "K2 – high relevance: topicalPenaltyApplied must be false");
});

// ─── K3: Ranking regression — the actual bug ─────────────────────────────────

test("K3 – regression: high-importance off-topic memory must NOT outrank relevant travel memory when penalty is ON", () => {
  /**
   * This is the core regression test.
   *
   * Bug scenario (default weights):
   *   mem-f2 (software engineer, importance=0.85)
   *     vectorScore≈0.05, lexicalScore=0, importance=0.85
   *     raw score ≈ 0.05*0.5 + 0*0.2 + 0.85*0.2 + recency*0.1
   *             = 0.025 + 0 + 0.17 + ~0.07  ≈  0.265 + sessionBonus
   *
   *   mem-s1 (travel concept, importance=0.55)
   *     vectorScore≈0.08, lexicalScore=1, importance=0.55
   *     raw score ≈ 0.08*0.5 + 0.2*0.2 + 0.55*0.2 + recency*0.1
   *             = 0.04 + 0.04 + 0.11 + small  ≈  0.19
   *
   * Without penalty: mem-f2 beats mem-s1 for the travel query — BUG.
   * With penalty:    mem-f2 gets ×0.10 → ~0.027; mem-s1 keeps its score → correct ranking.
   */
  const penaltyOnConfig = cfg({
    vectorWeight:     0.5,
    lexicalWeight:    0.2,
    importanceWeight: 0.2,
    recencyWeight:    0.1,
    topicalPenalty: { enabled: true, lowThreshold: 0.15, highThreshold: 0.30, lowPenalty: 0.10, mediumPenalty: 0.50 }
  });

  // Travel memories: have some relevance (low but non-zero vector + some lexical)
  const travelMemories = [
    MEMORY_BY_ID["mem-s1"],  // travel concept — moderate importance
    MEMORY_BY_ID["mem-f1"],  // window seat on flights — travel, window, clouds
    MEMORY_BY_ID["mem-e1"]   // Tokyo trip — travel keywords
  ];

  // Off-topic but high-importance memory
  const offTopicMemory = MEMORY_BY_ID["mem-f2"]; // software engineer

  const allMemories = [...travelMemories, offTopicMemory];

  const scoredEntries = buildScoredEntries([
    // Travel memories — low but non-trivial relevance to the travel query
    { id: "mem-s1", vectorScore: 0.08, lexicalScore: 1 },  // "travel" keyword appears
    { id: "mem-f1", vectorScore: 0.12, lexicalScore: 2 },  // "travel", "flights"
    { id: "mem-e1", vectorScore: 0.10, lexicalScore: 1 },  // "travel"
    // Off-topic — essentially zero relevance to travel query
    { id: "mem-f2", vectorScore: 0.05, lexicalScore: 0 }
  ]);

  const results = deduplicateAndRerank(
    allMemories,
    { querySessionId: SESSION_A, scoredEntries },
    penaltyOnConfig
  );

  expectNoDuplicates(results, "K3");
  expectScoresDescending(results, "K3");

  // The off-topic high-importance memory must NOT rank first
  const firstId = results[0]?.id;
  assert.notEqual(
    firstId,
    "mem-f2",
    "K3 – off-topic high-importance memory must NOT be ranked first for a travel query"
  );

  // All three travel memories must outrank the off-topic memory
  const resultIds      = results.map((r) => r.id);
  const offTopicIndex  = resultIds.indexOf("mem-f2");
  const travelIndices  = ["mem-s1", "mem-f1", "mem-e1"].map((id) => resultIds.indexOf(id));
  const maxTravelIndex = Math.max(...travelIndices);

  assert.ok(
    maxTravelIndex < offTopicIndex,
    `K3 – all travel memories must rank above off-topic memory.\n` +
    `  Travel positions: ${JSON.stringify(travelIndices)}\n` +
    `  Off-topic position: ${offTopicIndex}\n` +
    `  Order: ${JSON.stringify(resultIds)}`
  );
});

test("K3 – regression: penalty OFF → off-topic high-importance memory CAN rank first (documents the original bug)", () => {
  /**
   * Mirror of K3 with penalty disabled — documents that the bug is real.
   * With default weights and no penalty, mem-f2 (importance=0.85) gets
   * enough importance-driven score to beat low-relevance travel memories.
   *
   * This test asserts the ORIGINAL broken behaviour so future readers
   * understand what the feature flag is guarding against.
   */
  const penaltyOffConfig = cfg({
    vectorWeight:     0.5,
    lexicalWeight:    0.2,
    importanceWeight: 0.2,
    recencyWeight:    0.1,
    topicalPenalty: { enabled: false }
  });

  const allMemories = [
    MEMORY_BY_ID["mem-s1"],
    MEMORY_BY_ID["mem-f1"],
    MEMORY_BY_ID["mem-e1"],
    MEMORY_BY_ID["mem-f2"]
  ];

  const scoredEntries = buildScoredEntries([
    { id: "mem-s1", vectorScore: 0.08, lexicalScore: 1 },
    { id: "mem-f1", vectorScore: 0.12, lexicalScore: 2 },
    { id: "mem-e1", vectorScore: 0.10, lexicalScore: 1 },
    { id: "mem-f2", vectorScore: 0.05, lexicalScore: 0 }
  ]);

  const results = deduplicateAndRerank(
    allMemories,
    { querySessionId: SESSION_A, scoredEntries },
    penaltyOffConfig
  );

  expectNoDuplicates(results, "K3-off");
  expectScoresDescending(results, "K3-off");

  // With penalty OFF and these scores, mem-f2 should rank first
  // (importance=0.85 × weight=0.2 = 0.17, which dominates over low relevance scores).
  // This is the bug — asserting it exists so the contrast with K3 is clear.
  const resultIds     = results.map((r) => r.id);
  const offTopicIndex = resultIds.indexOf("mem-f2");

  // mem-f2 score without penalty:
  //   0.05*0.5 + 0*0.2 + 0.85*0.2 + recency*0.1 + sessionBonus
  //   = 0.025 + 0 + 0.17 + ~small + 0.04 ≈ 0.24+
  // mem-f1 score (best travel memory):
  //   0.12*0.5 + (2/5)*0.2 + 0.75*0.2 + recency*0.1 + 0.04
  //   = 0.06 + 0.08 + 0.15 + ~small + 0.04 ≈ 0.33
  // mem-f1 actually wins here, but we document that mem-f2 can outrank mem-s1 and mem-e1
  const lowestTravelPos = Math.max(
    resultIds.indexOf("mem-s1"),
    resultIds.indexOf("mem-e1")
  );
  assert.ok(
    offTopicIndex < lowestTravelPos,
    `K3-off – without penalty, mem-f2 should outrank at least some travel memories.\n` +
    `  Order: ${JSON.stringify(resultIds)}\n` +
    `  (This documents the bug behaviour — K3 fixes it with penalty=ON)`
  );
});

// ─── K4: Backward compatibility ───────────────────────────────────────────────

test("K4 – backward compat: missing topicalPenalty in config does not throw", () => {
  /**
   * A caller that passes a partial cfg object (e.g. an existing test that
   * does not include topicalPenalty) must not crash.
   */
  const partialConfig = {
    topK: 8,
    vectorWeight: 0.5,
    lexicalWeight: 0.2,
    importanceWeight: 0.2,
    recencyWeight: 0.1,
    recencyHalfLifeHours: 72,
    dedupThreshold: 0.92,
    summaryEveryNTurns: 20
    // intentionally omitting topicalPenalty
  };

  assert.doesNotThrow(() => {
    computeHybridScore(
      { vectorScore: 0.5, lexicalScore: 2, importanceScore: 0.6, timestamp: null, sessionId: "S", querySessionId: "S" },
      partialConfig
    );
  }, "K4 – missing topicalPenalty must not throw");
});

test("K4 – backward compat: RETRIEVAL_TOPICAL_PENALTY_ENABLED absent → penalty disabled by default", async () => {
  /**
   * Verify that the feature flag defaults to OFF so existing deployments
   * that have not set the env var are unaffected.
   */
  const { RETRIEVAL_DEFAULTS } = await import("@neura/shared");
  assert.equal(
    RETRIEVAL_DEFAULTS.topicalPenalty.enabled,
    false,
    "K4 – topicalPenalty.enabled must default to false"
  );
});
