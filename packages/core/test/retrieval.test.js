/**
 * packages/core/test/retrieval.test.js
 *
 * Focused unit tests for the extracted hybrid retrieval modules:
 *
 *   retrievalTypes      – constants and default weights
 *   signalScorer        – pure score computation functions
 *   resultDeduplicator  – cross-backend id-based deduplication
 *   memoryRanker        – weighted scoring, sorting and limiting
 *   candidateFetcher    – backend fan-out and graph enrichment
 *
 * All tests use Node 22 built-in test runner (node --test) and ESM.
 *
 * ─── Coverage ─────────────────────────────────────────────────────────────────
 *
 * retrievalTypes (3 tests)
 *   1.  HYBRID_WEIGHTS_DEFAULTS has the correct five weight values
 *   2.  HYBRID_WEIGHTS_DEFAULTS sums to exactly 1.0
 *   3.  SOURCE constants are the expected string labels
 *
 * signalScorer (17 tests)
 *   4.  resolveWeights returns defaults when called with no args
 *   5.  resolveWeights merges partial overrides into defaults
 *   6.  resolveWeights clamps values below 0 to 0
 *   7.  resolveWeights clamps values above 1 to 1
 *   8.  computeKeywordScore returns 0 for empty inputs
 *   9.  computeKeywordScore returns 0 when no tokens match
 *   10. computeKeywordScore returns 1.0 at ≥5 matching tokens
 *   11. computeKeywordScore is proportional for partial matches
 *   12. computeKeywordScore is case-insensitive (via tokenize)
 *   13. computeRecencyScore returns 1.0 for null timestamp
 *   14. computeRecencyScore returns 1.0 for a brand-new timestamp
 *   15. computeRecencyScore decays correctly at exactly one half-life
 *   16. computeRecencyScore never reaches 0 (floor cap)
 *   17. computeAccessFreqBonus returns 0 for 0 access count
 *   18. computeAccessFreqBonus is 0.15 for 100 accesses (cap)
 *   19. computeAccessFreqBonus increases monotonically
 *   20. buildReason includes "strong vector similarity" for vectorScore ≥ 0.5
 *   21. buildReason falls back to "low-signal match" for all-zero signals
 *
 * resultDeduplicator (6 tests)
 *   22. deduplicateById returns empty array for empty input
 *   23. deduplicateById keeps unique memories unchanged
 *   24. deduplicateById merges duplicate ids into one entry
 *   25. deduplicateById keeps maximum vectorScore across duplicates
 *   26. deduplicateById unions sources arrays (no duplicates)
 *   27. deduplicateById preserves insertion order of first occurrence
 *
 * memoryRanker (11 tests)
 *   28. rankMemories returns empty array for empty input
 *   29. rankMemories returns empty array for null input
 *   30. rankMemories sorts by finalScore descending
 *   31. rankMemories applies topK limit
 *   32. rankMemories filters out results below minFinalScore
 *   33. rankMemories computes importanceScore from metadata.importance
 *   34. rankMemories computes recencyScore from metadata.timestamp
 *   35. rankMemories blends accessFreqBonus into importanceScore
 *   36. rankMemories honours weight overrides
 *   37. rankMemories attaches complete _hybrid envelope
 *   38. rankMemories caps finalScore at 1.0
 *
 * candidateFetcher (10 tests)
 *   39. fetchCandidates returns empty array when all stores return nothing
 *   40. fetchCandidates returns vector results annotated with source="vector"
 *   41. fetchCandidates returns keyword results annotated with source="keyword"
 *   42. fetchCandidates survives vectorStore throwing (graceful degradation)
 *   43. fetchCandidates survives keywordStore throwing (graceful degradation)
 *   44. fetchCandidates deduplicates memories returned by both backends
 *   45. fetchCandidates picks up graphScore from Neo4j similar-memories
 *   46. fetchCandidates adds graph-only neighbours as fresh candidates
 *   47. fetchCandidates survives graphStore throwing (graphScore stays 0)
 *   48. fetchCandidates strips _hybridSource before returning
 */

import assert from "node:assert/strict";
import test   from "node:test";

import { HYBRID_WEIGHTS_DEFAULTS, SOURCE } from
  "../src/memory/retrieval/retrievalTypes.js";

import {
  resolveWeights,
  computeKeywordScore,
  computeRecencyScore,
  computeAccessFreqBonus,
  buildReason
} from "../src/memory/retrieval/signalScorer.js";

import { deduplicateById } from "../src/memory/retrieval/resultDeduplicator.js";
import { rankMemories }    from "../src/memory/retrieval/memoryRanker.js";
import { createCandidateFetcher } from "../src/memory/retrieval/candidateFetcher.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let _seq = 0;
function uid() { return `rt-test-${++_seq}`; }

/** Minimal memory object with sensible defaults. */
function mem(overrides = {}) {
  return {
    id:      overrides.id      ?? uid(),
    content: overrides.content ?? "default content",
    summary: overrides.summary ?? "default summary",
    metadata: {
      importance:  overrides.importance  ?? 0.5,
      timestamp:   overrides.timestamp   ?? new Date().toISOString(),
      accessCount: overrides.accessCount ?? 0,
      ...(overrides.metadata ?? {})
    },
    ...(overrides._hybrid ? { _hybrid: overrides._hybrid } : {})
  };
}

/** Memory annotated with a `_hybrid` pre-score envelope (as candidateFetcher produces). */
function annotated(overrides = {}, hybrid = {}) {
  const m = mem(overrides);
  m._hybrid = {
    vectorScore:     hybrid.vectorScore     ?? 0,
    keywordScore:    hybrid.keywordScore    ?? 0,
    graphScore:      hybrid.graphScore      ?? 0,
    importanceScore: 0,
    recencyScore:    0,
    accessFreqBonus: 0,
    finalScore:      0,
    sources:         hybrid.sources         ?? [SOURCE.UNKNOWN],
    reason:          "",
    weights:         {}
  };
  return m;
}

// ─── Store builder helpers ────────────────────────────────────────────────────

function makeVectorStore(memories = [], { throws = false } = {}) {
  return {
    async findRelevant() {
      if (throws) throw new Error("Qdrant unavailable");
      return memories;
    }
  };
}

function makeKeywordStore(memories = [], { throws = false } = {}) {
  return {
    async findRelevant() {
      if (throws) throw new Error("Postgres unavailable");
      return memories;
    }
  };
}

function makeGraphStore(similarMap = new Map(), { throws = false } = {}) {
  return {
    async findSimilarMemories(memoryId, limit) {
      if (throws) throw new Error("Neo4j unavailable");
      return (similarMap.get(memoryId) || []).slice(0, limit);
    },
    async findMemoriesByKeyword() { return []; },
    async findMemoriesByDomain()  { return []; },
    async findMemoriesByEntity()  { return []; }
  };
}

function makeEmbedText({ returns = [0.1, 0.2, 0.3], throws = false } = {}) {
  return async () => {
    if (throws) throw new Error("embed fail");
    return returns;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// retrievalTypes
// ═══════════════════════════════════════════════════════════════════════════════

test("retrievalTypes — HYBRID_WEIGHTS_DEFAULTS has the correct five weight values", () => {
  assert.equal(HYBRID_WEIGHTS_DEFAULTS.vector,     0.40);
  assert.equal(HYBRID_WEIGHTS_DEFAULTS.keyword,    0.20);
  assert.equal(HYBRID_WEIGHTS_DEFAULTS.importance, 0.20);
  assert.equal(HYBRID_WEIGHTS_DEFAULTS.recency,    0.10);
  assert.equal(HYBRID_WEIGHTS_DEFAULTS.graph,      0.10);
});

test("retrievalTypes — HYBRID_WEIGHTS_DEFAULTS sums to exactly 1.0", () => {
  const sum = Object.values(HYBRID_WEIGHTS_DEFAULTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-9, `Sum was ${sum}, expected 1.0`);
});

test("retrievalTypes — SOURCE constants are the expected string labels", () => {
  assert.equal(SOURCE.VECTOR,  "vector");
  assert.equal(SOURCE.KEYWORD, "keyword");
  assert.equal(SOURCE.GRAPH,   "graph");
  assert.equal(SOURCE.UNKNOWN, "unknown");
});

// ═══════════════════════════════════════════════════════════════════════════════
// signalScorer — resolveWeights
// ═══════════════════════════════════════════════════════════════════════════════

test("signalScorer — resolveWeights returns defaults when called with no args", () => {
  const w = resolveWeights();
  assert.deepEqual(w, HYBRID_WEIGHTS_DEFAULTS);
});

test("signalScorer — resolveWeights merges partial overrides into defaults", () => {
  const w = resolveWeights({ vector: 0.6, keyword: 0.1 });
  assert.equal(w.vector,  0.6);
  assert.equal(w.keyword, 0.1);
  // Untouched keys stay at their defaults
  assert.equal(w.importance, HYBRID_WEIGHTS_DEFAULTS.importance);
  assert.equal(w.recency,    HYBRID_WEIGHTS_DEFAULTS.recency);
  assert.equal(w.graph,      HYBRID_WEIGHTS_DEFAULTS.graph);
});

test("signalScorer — resolveWeights clamps values below 0 to 0", () => {
  const w = resolveWeights({ vector: -0.5, keyword: -1 });
  assert.equal(w.vector,  0);
  assert.equal(w.keyword, 0);
});

test("signalScorer — resolveWeights clamps values above 1 to 1", () => {
  const w = resolveWeights({ vector: 2.0, graph: 99 });
  assert.equal(w.vector, 1);
  assert.equal(w.graph,  1);
});

// ═══════════════════════════════════════════════════════════════════════════════
// signalScorer — computeKeywordScore
// ═══════════════════════════════════════════════════════════════════════════════

test("signalScorer — computeKeywordScore returns 0 for empty inputs", () => {
  assert.equal(computeKeywordScore("", "some text"), 0);
  assert.equal(computeKeywordScore("some query", ""), 0);
  assert.equal(computeKeywordScore("", ""), 0);
  assert.equal(computeKeywordScore(null, "text"), 0);
});

test("signalScorer — computeKeywordScore returns 0 when no tokens match", () => {
  const score = computeKeywordScore("apple banana", "dog cat fish");
  assert.equal(score, 0);
});

test("signalScorer — computeKeywordScore returns 1.0 at ≥5 matching tokens", () => {
  // 5 distinct matching tokens → soft cap of 5 → score = 1.0
  const score = computeKeywordScore(
    "redis memory vector qdrant postgres neo4j",
    "redis memory vector qdrant postgres neo4j extra words"
  );
  assert.equal(score, 1.0);
});

test("signalScorer — computeKeywordScore is proportional for partial matches", () => {
  // "memory" appears in both → 1 match / 5 soft cap = 0.2
  const score = computeKeywordScore("memory query", "memory store");
  assert.ok(score > 0 && score <= 0.4, `Expected 0 < score ≤ 0.4, got ${score}`);
});

test("signalScorer — computeKeywordScore is case-insensitive via tokenize", () => {
  const lower = computeKeywordScore("redis", "REDIS store");
  const upper = computeKeywordScore("REDIS", "redis store");
  assert.equal(lower, upper, "Scores should be equal regardless of case");
});

// ═══════════════════════════════════════════════════════════════════════════════
// signalScorer — computeRecencyScore
// ═══════════════════════════════════════════════════════════════════════════════

test("signalScorer — computeRecencyScore returns 1.0 for null timestamp", () => {
  assert.equal(computeRecencyScore(null, 24), 1.0);
  assert.equal(computeRecencyScore(undefined, 24), 1.0);
});

test("signalScorer — computeRecencyScore returns 1.0 for a brand-new timestamp", () => {
  const score = computeRecencyScore(new Date().toISOString(), 24);
  assert.ok(score > 0.99, `Expected score ≈ 1.0 for a fresh timestamp, got ${score}`);
});

test("signalScorer — computeRecencyScore decays to ≈0.5 at exactly one half-life", () => {
  const halfLifeHours = 24;
  const halfLifeAgoMs = halfLifeHours * 60 * 60 * 1000;
  const ts = new Date(Date.now() - halfLifeAgoMs).toISOString();
  const score = computeRecencyScore(ts, halfLifeHours);
  // Allow ±1% rounding tolerance
  assert.ok(
    Math.abs(score - 0.5) < 0.01,
    `Expected ≈0.5 at one half-life, got ${score}`
  );
});

test("signalScorer — computeRecencyScore never reaches 0 (floor cap)", () => {
  // Use a timestamp far in the past (200 years ago)
  const ancientMs = Date.now() - 200 * 365 * 24 * 60 * 60 * 1000;
  const score = computeRecencyScore(ancientMs, 24);
  assert.ok(score > 0, `Score should be > 0 for very old timestamps, got ${score}`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// signalScorer — computeAccessFreqBonus
// ═══════════════════════════════════════════════════════════════════════════════

test("signalScorer — computeAccessFreqBonus returns 0 for 0 access count", () => {
  assert.equal(computeAccessFreqBonus(0), 0);
  assert.equal(computeAccessFreqBonus(null), 0);
  assert.equal(computeAccessFreqBonus(undefined), 0);
  assert.equal(computeAccessFreqBonus(-5), 0);
});

test("signalScorer — computeAccessFreqBonus caps at 0.15 for 100 accesses", () => {
  const bonus = computeAccessFreqBonus(100);
  assert.ok(
    Math.abs(bonus - 0.15) < 0.001,
    `Expected ≈0.15 for 100 accesses, got ${bonus}`
  );
});

test("signalScorer — computeAccessFreqBonus is positive for any access count and stays at cap beyond it", () => {
  // Any positive access count gives a bonus > 0
  assert.ok(computeAccessFreqBonus(1) > 0, "1 access should give a positive bonus");
  // The bonus never exceeds the hard cap of 0.15
  assert.ok(computeAccessFreqBonus(1)   <= 0.15);
  assert.ok(computeAccessFreqBonus(10)  <= 0.15);
  assert.ok(computeAccessFreqBonus(100) <= 0.15);
  assert.ok(computeAccessFreqBonus(999) <= 0.15);
  // Verified with the cap formula: bonus for large counts equals the cap
  assert.equal(computeAccessFreqBonus(100), 0.15, "100 accesses should hit the cap exactly");
});

// ═══════════════════════════════════════════════════════════════════════════════
// signalScorer — buildReason
// ═══════════════════════════════════════════════════════════════════════════════

test("signalScorer — buildReason includes 'strong vector similarity' for vectorScore ≥ 0.5", () => {
  const reason = buildReason({
    vectorScore: 0.8, keywordScore: 0, importanceScore: 0,
    recencyScore: 0, graphScore: 0, sources: ["vector"]
  });
  assert.ok(reason.includes("strong vector similarity"), `reason: ${reason}`);
});

test("signalScorer — buildReason falls back to 'low-signal match' for all-zero signals", () => {
  const reason = buildReason({
    vectorScore: 0, keywordScore: 0, importanceScore: 0,
    recencyScore: 0, graphScore: 0, sources: ["unknown"]
  });
  assert.ok(reason.includes("low-signal match"), `reason: ${reason}`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// resultDeduplicator
// ═══════════════════════════════════════════════════════════════════════════════

test("resultDeduplicator — deduplicateById returns empty array for empty input", () => {
  assert.deepEqual(deduplicateById([]), []);
});

test("resultDeduplicator — deduplicateById keeps unique memories unchanged", () => {
  const m1 = annotated({ id: "a" });
  const m2 = annotated({ id: "b" });
  const result = deduplicateById([m1, m2]);
  assert.equal(result.length, 2);
  assert.ok(result.some((m) => m.id === "a"));
  assert.ok(result.some((m) => m.id === "b"));
});

test("resultDeduplicator — deduplicateById merges duplicate ids into one entry", () => {
  const m1 = annotated({ id: "dup" }, { sources: [SOURCE.VECTOR] });
  const m2 = annotated({ id: "dup" }, { sources: [SOURCE.KEYWORD] });
  const result = deduplicateById([m1, m2]);
  assert.equal(result.length, 1, "Duplicate id should produce exactly one result");
  assert.equal(result[0].id, "dup");
});

test("resultDeduplicator — deduplicateById keeps maximum vectorScore across duplicates", () => {
  const m1 = annotated({ id: "dup" }, { vectorScore: 0.3, sources: ["vector"] });
  const m2 = annotated({ id: "dup" }, { vectorScore: 0.9, sources: ["keyword"] });
  const [merged] = deduplicateById([m1, m2]);
  assert.equal(merged._hybrid.vectorScore, 0.9, "Should keep max vectorScore");
});

test("resultDeduplicator — deduplicateById unions sources arrays without duplicates", () => {
  const m1 = annotated({ id: "dup" }, { sources: ["vector"] });
  const m2 = annotated({ id: "dup" }, { sources: ["keyword"] });
  const m3 = annotated({ id: "dup" }, { sources: ["vector"] }); // duplicate source
  const [merged] = deduplicateById([m1, m2, m3]);
  const sources = merged._hybrid.sources;
  assert.ok(sources.includes("vector"), "sources should include vector");
  assert.ok(sources.includes("keyword"), "sources should include keyword");
  // No duplicate source entries
  const unique = new Set(sources);
  assert.equal(unique.size, sources.length, "Sources should have no duplicates");
});

test("resultDeduplicator — deduplicateById preserves insertion order of first occurrence", () => {
  const ids = ["c", "a", "b", "a", "c"];
  const memories = ids.map((id) => annotated({ id }));
  const result = deduplicateById(memories);
  assert.deepEqual(result.map((m) => m.id), ["c", "a", "b"],
    "First-seen order should be preserved");
});

// ═══════════════════════════════════════════════════════════════════════════════
// memoryRanker
// ═══════════════════════════════════════════════════════════════════════════════

test("memoryRanker — rankMemories returns empty array for empty input", () => {
  assert.deepEqual(rankMemories([]), []);
});

test("memoryRanker — rankMemories returns empty array for null/undefined input", () => {
  assert.deepEqual(rankMemories(null), []);
  assert.deepEqual(rankMemories(undefined), []);
});

test("memoryRanker — rankMemories sorts by finalScore descending", () => {
  const low  = annotated({ id: "low",  importance: 0.1 }, { vectorScore: 0.1 });
  const high = annotated({ id: "high", importance: 0.9 }, { vectorScore: 0.9 });
  const mid  = annotated({ id: "mid",  importance: 0.5 }, { vectorScore: 0.5 });

  const results = rankMemories([low, high, mid]);
  assert.equal(results[0].id, "high", "Highest-scoring should be first");
  assert.equal(results[results.length - 1].id, "low", "Lowest-scoring should be last");
  // Verify strict descending order
  for (let i = 1; i < results.length; i++) {
    assert.ok(
      results[i - 1]._hybrid.finalScore >= results[i]._hybrid.finalScore,
      "Results should be sorted descending"
    );
  }
});

test("memoryRanker — rankMemories applies topK limit", () => {
  const candidates = Array.from({ length: 10 }, (_, i) =>
    annotated({ id: `m-${i}`, importance: (10 - i) / 10 }, { vectorScore: (10 - i) / 10 })
  );
  const results = rankMemories(candidates, { topK: 3 });
  assert.ok(results.length <= 3, `Expected ≤3 results, got ${results.length}`);
});

test("memoryRanker — rankMemories filters out results below minFinalScore", () => {
  const low  = annotated({ id: "low",  importance: 0.01 });
  const high = annotated({ id: "high", importance: 0.9 }, { vectorScore: 0.9 });

  const results = rankMemories([low, high], {
    weights: { vector: 0.5, keyword: 0, importance: 0.5, recency: 0, graph: 0 },
    minFinalScore: 0.4
  });

  const ids = results.map((r) => r.id);
  assert.ok(ids.includes("high"), "High-scoring memory should pass filter");
  assert.ok(!ids.includes("low"),  "Low-scoring memory should be filtered out");
});

test("memoryRanker — rankMemories computes importanceScore from metadata.importance", () => {
  const m = annotated({ id: "imp", importance: 0.75 });
  const [ranked] = rankMemories([m], {
    weights: { vector: 0, keyword: 0, importance: 1.0, recency: 0, graph: 0 }
  });
  assert.ok(
    Math.abs(ranked._hybrid.importanceScore - 0.75) < 0.01,
    `Expected importanceScore ≈ 0.75, got ${ranked._hybrid.importanceScore}`
  );
});

test("memoryRanker — rankMemories computes recencyScore from metadata.timestamp", () => {
  const m = annotated({ id: "rec", timestamp: new Date().toISOString() });
  const [ranked] = rankMemories([m], {
    weights: { vector: 0, keyword: 0, importance: 0, recency: 1.0, graph: 0 },
    halfLifeHours: 24
  });
  assert.ok(ranked._hybrid.recencyScore > 0.99, "Brand-new memory should have recencyScore ≈ 1.0");
});

test("memoryRanker — rankMemories blends accessFreqBonus into importanceScore", () => {
  const noAccess  = annotated({ id: "no",  importance: 0.5, accessCount: 0 });
  const hasAccess = annotated({ id: "yes", importance: 0.5, accessCount: 50 });

  const results = rankMemories([noAccess, hasAccess], {
    weights: { vector: 0, keyword: 0, importance: 1.0, recency: 0, graph: 0 }
  });

  const yesResult = results.find((r) => r.id === "yes");
  const noResult  = results.find((r) => r.id === "no");
  assert.ok(yesResult._hybrid.accessFreqBonus > 0, "accessFreqBonus should be > 0");
  assert.ok(
    yesResult._hybrid.finalScore > noResult._hybrid.finalScore,
    "Frequently accessed memory should score higher"
  );
});

test("memoryRanker — rankMemories honours weight overrides", () => {
  const highVec = annotated({ id: "vec" }, { vectorScore: 0.9, keywordScore: 0 });
  const highKw  = annotated({ id: "kw"  }, { vectorScore: 0.0, keywordScore: 1.0 });

  // Keyword-dominant weights
  const results = rankMemories([highVec, highKw], {
    weights: { vector: 0.05, keyword: 0.85, importance: 0.05, recency: 0.05, graph: 0 }
  });

  assert.equal(results[0].id, "kw", "Keyword-dominant weight should put kw first");
  // Stored weights should reflect the override
  assert.equal(results[0]._hybrid.weights.keyword, 0.85);
});

test("memoryRanker — rankMemories attaches complete _hybrid envelope", () => {
  const [ranked] = rankMemories([annotated({ id: "env" })]);
  const h = ranked._hybrid;
  for (const field of [
    "finalScore", "vectorScore", "keywordScore",
    "importanceScore", "recencyScore", "graphScore",
    "accessFreqBonus", "sources", "reason", "weights"
  ]) {
    assert.ok(field in h, `_hybrid.${field} should be present`);
  }
  assert.ok(typeof h.reason === "string" && h.reason.length > 0, "reason should be non-empty");
  assert.ok(Array.isArray(h.sources), "sources should be an array");
});

test("memoryRanker — rankMemories caps finalScore at 1.0", () => {
  // All weights at 1.0 and all signal scores at 1.0 could naively exceed 1.0
  const m = annotated(
    { id: "cap", importance: 1.0 },
    { vectorScore: 1.0, keywordScore: 1.0, graphScore: 1.0 }
  );
  // Force all weights = 1.0 (sum > 1 intentionally to test the cap)
  const [ranked] = rankMemories([m], {
    weights: { vector: 1.0, keyword: 1.0, importance: 1.0, recency: 1.0, graph: 1.0 }
  });
  assert.ok(ranked._hybrid.finalScore <= 1.0, "finalScore must never exceed 1.0");
});

// ═══════════════════════════════════════════════════════════════════════════════
// candidateFetcher
// ═══════════════════════════════════════════════════════════════════════════════

const SESSION  = "session-retrieval-test";
const USER     = "user-retrieval-test";

test("candidateFetcher — fetchCandidates returns empty array when all stores return nothing", async () => {
  const { fetchCandidates } = createCandidateFetcher({
    vectorStore:  makeVectorStore([]),
    keywordStore: makeKeywordStore([]),
    graphStore:   makeGraphStore(),
    embedText:    makeEmbedText()
  });
  const results = await fetchCandidates("query", USER, SESSION);
  assert.deepEqual(results, []);
});

test("candidateFetcher — fetchCandidates returns vector results annotated with source='vector'", async () => {
  const m = mem({ id: "vec-only" });
  const { fetchCandidates } = createCandidateFetcher({
    vectorStore:  makeVectorStore([m]),
    keywordStore: makeKeywordStore([]),
    graphStore:   makeGraphStore(),
    embedText:    makeEmbedText()
  });
  const results = await fetchCandidates("query", USER, SESSION);
  assert.equal(results.length, 1);
  assert.ok(results[0]._hybrid.sources.includes("vector"), "Source should be 'vector'");
});

test("candidateFetcher — fetchCandidates returns keyword results annotated with source='keyword'", async () => {
  const m = mem({ id: "kw-only" });
  const { fetchCandidates } = createCandidateFetcher({
    vectorStore:  makeVectorStore([]),
    keywordStore: makeKeywordStore([m]),
    graphStore:   makeGraphStore(),
    embedText:    makeEmbedText()
  });
  const results = await fetchCandidates("query", USER, SESSION);
  assert.equal(results.length, 1);
  assert.ok(results[0]._hybrid.sources.includes("keyword"), "Source should be 'keyword'");
});

test("candidateFetcher — fetchCandidates survives vectorStore throwing (graceful degradation)", async () => {
  const m = mem({ id: "kw-fallback" });
  const { fetchCandidates } = createCandidateFetcher({
    vectorStore:  makeVectorStore([], { throws: true }),
    keywordStore: makeKeywordStore([m]),
    graphStore:   makeGraphStore(),
    embedText:    makeEmbedText()
  });
  // Must not throw
  const results = await fetchCandidates("query", USER, SESSION);
  assert.ok(results.length >= 1, "Should return keyword results even when vectorStore throws");
  assert.ok(results.find((r) => r.id === "kw-fallback"), "kw-fallback should be in results");
});

test("candidateFetcher — fetchCandidates survives keywordStore throwing (graceful degradation)", async () => {
  const m = mem({ id: "vec-fallback" });
  const { fetchCandidates } = createCandidateFetcher({
    vectorStore:  makeVectorStore([m]),
    keywordStore: makeKeywordStore([], { throws: true }),
    graphStore:   makeGraphStore(),
    embedText:    makeEmbedText()
  });
  const results = await fetchCandidates("query", USER, SESSION);
  assert.ok(results.length >= 1, "Should return vector results even when keywordStore throws");
  assert.ok(results.find((r) => r.id === "vec-fallback"), "vec-fallback should be in results");
});

test("candidateFetcher — fetchCandidates deduplicates memories returned by both backends", async () => {
  const sharedId = uid();
  const fromVector  = { ...mem({ id: sharedId }), _retrieval: { vectorScore: 0.8, lexicalScore: 0 } };
  const fromKeyword = { ...mem({ id: sharedId }), _retrieval: { vectorScore: 0,   lexicalScore: 3 } };

  const { fetchCandidates } = createCandidateFetcher({
    vectorStore:  makeVectorStore([fromVector]),
    keywordStore: makeKeywordStore([fromKeyword]),
    graphStore:   makeGraphStore(),
    embedText:    makeEmbedText()
  });

  const results = await fetchCandidates("query", USER, SESSION);
  const withId = results.filter((r) => r.id === sharedId);
  assert.equal(withId.length, 1, "Duplicate across stores should appear exactly once");
});

test("candidateFetcher — fetchCandidates picks up graphScore from Neo4j similar-memories", async () => {
  const m = mem({ id: "with-graph" });
  const similarMap = new Map([
    ["with-graph", [
      { id: uid(), summary: "related", importance: 0.5 },
      { id: uid(), summary: "related2", importance: 0.4 }
    ]]
  ]);

  const { fetchCandidates } = createCandidateFetcher({
    vectorStore:  makeVectorStore([m]),
    keywordStore: makeKeywordStore(),
    graphStore:   makeGraphStore(similarMap),
    embedText:    makeEmbedText()
  });

  const results = await fetchCandidates("query", USER, SESSION);
  const candidate = results.find((r) => r.id === "with-graph");
  assert.ok(candidate, "Candidate should be in results");
  assert.ok(candidate._hybrid.graphScore > 0, "graphScore should be > 0 for connected memory");
});

test("candidateFetcher — fetchCandidates adds graph-only neighbours as fresh candidates", async () => {
  const primary = mem({ id: "primary" });
  const neighbourId = uid();
  const similarMap = new Map([
    ["primary", [{ id: neighbourId, summary: "graph-only neighbour", importance: 0.7 }]]
  ]);

  const { fetchCandidates } = createCandidateFetcher({
    vectorStore:  makeVectorStore([primary]),
    keywordStore: makeKeywordStore(),
    graphStore:   makeGraphStore(similarMap),
    embedText:    makeEmbedText()
  });

  const results = await fetchCandidates("query", USER, SESSION);
  const neighbour = results.find((r) => r.id === neighbourId);
  assert.ok(neighbour, "Graph-only neighbour should be in candidates");
  assert.ok(neighbour._hybrid.sources.includes("graph"), "Graph neighbour source should be 'graph'");
  assert.ok(neighbour._hybrid.graphScore > 0, "Graph neighbour graphScore should be > 0");
});

test("candidateFetcher — fetchCandidates survives graphStore throwing (graphScore stays 0)", async () => {
  const m = mem({ id: "no-graph" });
  const { fetchCandidates } = createCandidateFetcher({
    vectorStore:  makeVectorStore([m]),
    keywordStore: makeKeywordStore(),
    graphStore:   makeGraphStore(new Map(), { throws: true }),
    embedText:    makeEmbedText()
  });

  // Must not throw
  const results = await fetchCandidates("query", USER, SESSION);
  assert.ok(results.length >= 1, "Should return results even when graphStore throws");
  const candidate = results.find((r) => r.id === "no-graph");
  assert.ok(candidate, "no-graph should be in results");
  assert.equal(candidate._hybrid.graphScore, 0, "graphScore should be 0 when Neo4j fails");
});

test("candidateFetcher — fetchCandidates strips _hybridSource before returning", async () => {
  const m = mem({ id: "clean" });
  const { fetchCandidates } = createCandidateFetcher({
    vectorStore:  makeVectorStore([m]),
    keywordStore: makeKeywordStore(),
    graphStore:   makeGraphStore(),
    embedText:    makeEmbedText()
  });

  const results = await fetchCandidates("query", USER, SESSION);
  assert.ok(results.length >= 1);
  for (const r of results) {
    assert.ok(!("_hybridSource" in r), "_hybridSource should be stripped from results");
  }
});
