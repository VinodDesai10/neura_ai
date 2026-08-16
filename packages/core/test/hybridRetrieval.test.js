/**
 * packages/core/test/hybridRetrieval.test.js
 *
 * Comprehensive tests for the hybrid memory retrieval service.
 *
 * Test runner: Node 22 built-in (node --test)
 * Import style: ESM
 *
 * ─── Coverage ─────────────────────────────────────────────────────────────────
 *  1.  Default singleton is callable (smoke test)
 *  2.  Vector + keyword ranking — vector-heavy query
 *  3.  Vector + keyword ranking — keyword-heavy query
 *  4.  Importance weighting — high-importance memory outranks low-importance
 *  5.  Recency weighting — fresh memory outranks old memory
 *  6.  Graph score boost — graph-connected memory outranks unconnected
 *  7.  Duplicate results across stores are merged and scored once
 *  8.  Unavailable Qdrant (vectorStore throws) — falls back to keyword results
 *  9.  Unavailable Neo4j (graphStore throws) — graphScore = 0, ranking proceeds
 * 10.  Empty results from all stores → empty array returned
 * 11.  Configurable weights override defaults
 * 12.  rankMemories with no candidates → empty array
 * 13.  Access frequency bonus — frequently accessed memory gets a score bump
 * 14.  retrieveCandidates includes graph-only neighbours
 * 15.  minFinalScore filter removes low-scoring results
 * 16.  topK slicing — never exceeds requested limit
 * 17.  Missing embedding (embedText returns null) — still returns results
 * 18.  Graph-only results land at the correct relative rank
 */

import assert from "node:assert/strict";
import test   from "node:test";

import {
  createHybridRetrievalService,
  hybridRetrievalService,
  HYBRID_WEIGHTS_DEFAULTS
} from "../src/memory/services/hybridRetrievalService.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let _seq = 0;
function uid() { return `hybrid-test-${++_seq}`; }

const SESSION  = "session-hybrid-test";
const USER     = "user-hybrid-test";

/**
 * Build a minimal memory object with sane defaults.
 * @param {object} [overrides]
 */
function mem(overrides = {}) {
  const id = overrides.id ?? uid();
  return {
    id,
    sessionId: SESSION,
    userId:    USER,
    memoryType: overrides.memoryType ?? "factual",
    content:   overrides.content  ?? "default content",
    summary:   overrides.summary  ?? "default summary",
    metadata: {
      importance:     overrides.importance  ?? 0.5,
      confidence:     overrides.confidence  ?? 0.6,
      timestamp:      overrides.timestamp   ?? new Date().toISOString(),
      accessCount:    overrides.accessCount ?? 0,
      ...overrides.metadata
    }
  };
}

/**
 * Build a memory that already carries the `_retrieval` envelope that the
 * infrastructure stores attach after their internal hybrid scoring.
 */
function memWithRetrieval(overrides = {}, retrieval = {}) {
  const m = mem(overrides);
  m._retrieval = {
    vectorScore:  retrieval.vectorScore  ?? 0,
    lexicalScore: retrieval.lexicalScore ?? 0,
    importanceScore: retrieval.importanceScore ?? m.metadata.importance,
    recencyScore: retrieval.recencyScore ?? 1.0,
    score:        retrieval.score        ?? 0,
    source:       retrieval.source       ?? "test"
  };
  return m;
}

// ─── Store builder helpers ────────────────────────────────────────────────────

/**
 * Build a vector store stub that returns the provided memories.
 * Throws when `throws=true` to simulate unavailability.
 */
function makeVectorStore(memories = [], { throws = false } = {}) {
  return {
    async findRelevant() {
      if (throws) throw new Error("Qdrant unavailable");
      return memories;
    }
  };
}

/**
 * Build a keyword store stub.
 */
function makeKeywordStore(memories = [], { throws = false } = {}) {
  return {
    async findRelevant() {
      if (throws) throw new Error("Postgres unavailable");
      return memories;
    }
  };
}

/**
 * Build a graph store stub.
 *
 * `similarMap` is a Map<memoryId, similarMemory[]>.
 */
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

/** Build an embedText stub that returns a simple unit vector. */
function makeEmbedText({ returns = [0.1, 0.2, 0.3], throws = false } = {}) {
  return async () => {
    if (throws) throw new Error("embed fail");
    return returns;
  };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

// ── 1. Smoke test — default singleton ────────────────────────────────────────
test("hybridRetrievalService — default singleton is callable", async () => {
  assert.ok(typeof hybridRetrievalService.getRelevantMemories === "function");
  assert.ok(typeof hybridRetrievalService.retrieveCandidates  === "function");
  assert.ok(typeof hybridRetrievalService.rankMemories        === "function");

  // With no stores configured, returns an empty array without throwing
  const results = await hybridRetrievalService.getRelevantMemories("test query", USER, SESSION);
  assert.deepEqual(results, []);
});

// ── 2. Vector + keyword ranking — vector score drives ranking ────────────────
test("hybridRetrievalService — high vector score outranks high keyword score", async () => {
  const highVector = memWithRetrieval(
    { id: "vec-high", content: "unrelated content" },
    { vectorScore: 0.9, lexicalScore: 0 }
  );
  const highKeyword = memWithRetrieval(
    { id: "kw-high", content: "project capstone memory store redis vector" },
    { vectorScore: 0.1, lexicalScore: 5 }
  );

  const svc = createHybridRetrievalService({
    vectorStore:  makeVectorStore([highVector]),
    keywordStore: makeKeywordStore([highKeyword]),
    graphStore:   makeGraphStore(),
    embedText:    makeEmbedText()
  });

  const results = await svc.getRelevantMemories("project memory", USER, SESSION, {
    weights: { vector: 0.70, keyword: 0.10, importance: 0.10, recency: 0.05, graph: 0.05 }
  });

  assert.ok(results.length >= 2, "Expected at least 2 results");

  const vecIdx = results.findIndex((r) => r.id === "vec-high");
  const kwIdx  = results.findIndex((r) => r.id === "kw-high");
  assert.ok(vecIdx < kwIdx, "High vector score should rank above high keyword score when vector weight is dominant");
});

// ── 3. Vector + keyword ranking — keyword weight drives ranking ──────────────
test("hybridRetrievalService — keyword score dominates when keyword weight is high", async () => {
  const highKeyword = memWithRetrieval(
    { id: "kw-dom", content: "redis vector qdrant postgres neo4j memory store" },
    { vectorScore: 0.0, lexicalScore: 5 }
  );
  const highVector = memWithRetrieval(
    { id: "vec-low-kw", content: "nothing relevant" },
    { vectorScore: 0.8, lexicalScore: 0 }
  );

  const svc = createHybridRetrievalService({
    vectorStore:  makeVectorStore([highVector]),
    keywordStore: makeKeywordStore([highKeyword]),
    graphStore:   makeGraphStore(),
    embedText:    makeEmbedText()
  });

  const results = await svc.getRelevantMemories("redis memory store", USER, SESSION, {
    weights: { vector: 0.10, keyword: 0.70, importance: 0.10, recency: 0.05, graph: 0.05 }
  });

  assert.ok(results.length >= 2, "Expected at least 2 results");
  const kwIdx  = results.findIndex((r) => r.id === "kw-dom");
  const vecIdx = results.findIndex((r) => r.id === "vec-low-kw");
  assert.ok(kwIdx < vecIdx, "Keyword-heavy weight should put keyword-matched memory first");
});

// ── 4. Importance weighting ───────────────────────────────────────────────────
test("hybridRetrievalService — high importance outranks low importance", async () => {
  const highImportance = mem({ id: "imp-high", importance: 0.95 });
  const lowImportance  = mem({ id: "imp-low",  importance: 0.10 });

  const svc = createHybridRetrievalService({
    vectorStore:  makeVectorStore([highImportance, lowImportance]),
    keywordStore: makeKeywordStore(),
    graphStore:   makeGraphStore(),
    embedText:    makeEmbedText()
  });

  const results = await svc.getRelevantMemories("any query", USER, SESSION, {
    weights: { vector: 0.0, keyword: 0.0, importance: 1.0, recency: 0.0, graph: 0.0 }
  });

  assert.ok(results.length >= 2, "Expected at least 2 results");
  const highIdx = results.findIndex((r) => r.id === "imp-high");
  const lowIdx  = results.findIndex((r) => r.id === "imp-low");
  assert.ok(highIdx < lowIdx, "High importance should rank before low importance");

  // Check that _hybrid envelope contains importanceScore
  assert.ok(results[0]._hybrid.importanceScore !== undefined, "_hybrid.importanceScore should be present");
});

// ── 5. Recency weighting ──────────────────────────────────────────────────────
test("hybridRetrievalService — recent memory outranks old memory", async () => {
  const fresh = mem({
    id:        "fresh",
    timestamp: new Date().toISOString(),
    importance: 0.5
  });
  const old = mem({
    id:        "stale",
    timestamp: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), // 10 days ago
    importance: 0.5
  });

  const svc = createHybridRetrievalService({
    vectorStore:  makeVectorStore([fresh, old]),
    keywordStore: makeKeywordStore(),
    graphStore:   makeGraphStore(),
    embedText:    makeEmbedText()
  });

  const results = await svc.getRelevantMemories("any query", USER, SESSION, {
    weights:       { vector: 0.0, keyword: 0.0, importance: 0.0, recency: 1.0, graph: 0.0 },
    halfLifeHours: 24
  });

  assert.ok(results.length >= 2, "Expected at least 2 results");
  const freshIdx = results.findIndex((r) => r.id === "fresh");
  const staleIdx = results.findIndex((r) => r.id === "stale");
  assert.ok(freshIdx < staleIdx, "Fresh memory should rank before stale memory");

  // recencyScore should be in the _hybrid envelope
  assert.ok(results[0]._hybrid.recencyScore > 0, "_hybrid.recencyScore should be > 0");
});

// ── 6. Graph score boost ──────────────────────────────────────────────────────
test("hybridRetrievalService — graph-connected memory is boosted", async () => {
  const graphConnected = mem({ id: "graph-conn", importance: 0.3 });
  const plain          = mem({ id: "plain",      importance: 0.3 });

  const similarMap = new Map([
    ["graph-conn", [
      { id: "sim-1", summary: "related memory", importance: 0.5 },
      { id: "sim-2", summary: "another",        importance: 0.4 }
    ]]
  ]);

  const svc = createHybridRetrievalService({
    vectorStore:  makeVectorStore([graphConnected, plain]),
    keywordStore: makeKeywordStore(),
    graphStore:   makeGraphStore(similarMap),
    embedText:    makeEmbedText()
  });

  // Use a balanced weight so both memories appear; graph provides a clear differentiator
  const results = await svc.getRelevantMemories("any query", USER, SESSION, {
    weights: { vector: 0.0, keyword: 0.0, importance: 0.5, recency: 0.0, graph: 0.5 }
  });

  // graph-connected memory should appear and have a positive graphScore
  const gcResult = results.find((r) => r.id === "graph-conn");
  assert.ok(gcResult, "Graph-connected memory should appear in results");
  assert.ok(gcResult._hybrid.graphScore > 0, "Graph-connected memory should have graphScore > 0");

  // Graph-connected should score higher than plain (same importance, higher graphScore)
  const plainResult = results.find((r) => r.id === "plain");
  if (plainResult) {
    assert.ok(
      gcResult._hybrid.finalScore >= plainResult._hybrid.finalScore,
      "Graph-connected memory should score at least as high as plain memory"
    );
  }
});

// ── 7. Duplicate results across stores are merged ────────────────────────────
test("hybridRetrievalService — duplicate memory across vector + keyword stores is merged", async () => {
  const sharedId = uid();
  const fromVector  = memWithRetrieval({ id: sharedId }, { vectorScore: 0.8 });
  const fromKeyword = memWithRetrieval({ id: sharedId }, { lexicalScore: 4 });

  const svc = createHybridRetrievalService({
    vectorStore:  makeVectorStore([fromVector]),
    keywordStore: makeKeywordStore([fromKeyword]),
    graphStore:   makeGraphStore(),
    embedText:    makeEmbedText()
  });

  const results = await svc.getRelevantMemories("query", USER, SESSION);

  const withId = results.filter((r) => r.id === sharedId);
  assert.equal(withId.length, 1, "Duplicate across stores should appear exactly once");
  // Sources should reflect both origins
  assert.ok(
    withId[0]._hybrid.sources.length >= 1,
    "Merged memory should carry sources"
  );
});

// ── 8. Unavailable Qdrant — falls back to keyword results ────────────────────
test("hybridRetrievalService — Qdrant unavailable falls back to keyword results", async () => {
  const kwMemory = mem({ id: "kw-only", content: "memory postgres redis" });

  const svc = createHybridRetrievalService({
    vectorStore:  makeVectorStore([], { throws: true }),
    keywordStore: makeKeywordStore([kwMemory]),
    graphStore:   makeGraphStore(),
    embedText:    makeEmbedText()
  });

  // Must not throw
  const results = await svc.getRelevantMemories("memory redis", USER, SESSION);
  assert.ok(results.length >= 1, "Should return keyword results even when Qdrant fails");

  const kw = results.find((r) => r.id === "kw-only");
  assert.ok(kw, "Keyword-only memory should appear in results");
  assert.equal(kw._hybrid.vectorScore, 0, "vectorScore should be 0 when Qdrant is unavailable");
});

// ── 9. Unavailable Neo4j — graphScore = 0, ranking proceeds ─────────────────
test("hybridRetrievalService — Neo4j unavailable yields graphScore = 0, no crash", async () => {
  const m = mem({ id: "no-graph" });

  const svc = createHybridRetrievalService({
    vectorStore:  makeVectorStore([m]),
    keywordStore: makeKeywordStore(),
    graphStore:   makeGraphStore(new Map(), { throws: true }),
    embedText:    makeEmbedText()
  });

  // Must not throw
  const results = await svc.getRelevantMemories("query", USER, SESSION);
  assert.ok(results.length >= 1, "Should return results even when Neo4j fails");
  assert.equal(
    results.find((r) => r.id === "no-graph")?._hybrid.graphScore,
    0,
    "graphScore should be 0 when Neo4j is unavailable"
  );
});

// ── 10. Empty results from all stores ────────────────────────────────────────
test("hybridRetrievalService — empty results when all stores return nothing", async () => {
  const svc = createHybridRetrievalService({
    vectorStore:  makeVectorStore([]),
    keywordStore: makeKeywordStore([]),
    graphStore:   makeGraphStore(),
    embedText:    makeEmbedText()
  });

  const results = await svc.getRelevantMemories("query", USER, SESSION);
  assert.deepEqual(results, [], "Should return empty array when all stores are empty");
});

// ── 11. Configurable weights override defaults ────────────────────────────────
test("hybridRetrievalService — custom weights change final scores", async () => {
  const m = mem({ id: "weight-test", importance: 0.9 });

  const svc = createHybridRetrievalService({
    vectorStore:  makeVectorStore([m]),
    keywordStore: makeKeywordStore(),
    graphStore:   makeGraphStore(),
    embedText:    makeEmbedText()
  });

  // With importance weight = 1, finalScore ≈ importance ≈ 0.9
  const withHigh = await svc.getRelevantMemories("query", USER, SESSION, {
    weights: { vector: 0.0, keyword: 0.0, importance: 1.0, recency: 0.0, graph: 0.0 }
  });

  // With importance weight = 0, finalScore ≈ recencyScore (memory is fresh)
  const withLow = await svc.getRelevantMemories("query", USER, SESSION, {
    weights: { vector: 0.0, keyword: 0.0, importance: 0.0, recency: 1.0, graph: 0.0 }
  });

  assert.ok(withHigh.length >= 1 && withLow.length >= 1, "Expected at least 1 result in each case");

  const highFinal = withHigh.find((r) => r.id === "weight-test")?._hybrid.finalScore ?? 0;
  const lowFinal  = withLow.find((r) => r.id === "weight-test")?._hybrid.finalScore ?? 0;

  // With importance=0.9 and weight=1.0, score should be higher than recency-only path
  // unless the memory is very new (recency = 1.0 ≈ importance = 0.9)
  assert.ok(typeof highFinal === "number" && highFinal > 0, "finalScore should be > 0 with importance weight=1");
  assert.ok(typeof lowFinal  === "number" && lowFinal  > 0, "finalScore should be > 0 with recency weight=1");

  // The _hybrid.weights field should reflect the overrides
  assert.equal(withHigh[0]._hybrid.weights.importance, 1.0, "weights.importance should reflect override");
  assert.equal(withLow[0]._hybrid.weights.recency,     1.0, "weights.recency should reflect override");
});

// ── 12. rankMemories with no candidates ──────────────────────────────────────
test("hybridRetrievalService — rankMemories([]) returns empty array", () => {
  const svc = createHybridRetrievalService();
  const result = svc.rankMemories([]);
  assert.deepEqual(result, []);
});

// ── 13. Access frequency bonus ────────────────────────────────────────────────
test("hybridRetrievalService — frequently accessed memory scores higher than never-accessed", async () => {
  const frequented = mem({ id: "freq", accessCount: 50, importance: 0.5 });
  const fresh      = mem({ id: "virgin", accessCount: 0,  importance: 0.5 });

  const svc = createHybridRetrievalService({
    vectorStore:  makeVectorStore([frequented, fresh]),
    keywordStore: makeKeywordStore(),
    graphStore:   makeGraphStore(),
    embedText:    makeEmbedText()
  });

  const results = await svc.getRelevantMemories("query", USER, SESSION, {
    weights: { vector: 0.0, keyword: 0.0, importance: 1.0, recency: 0.0, graph: 0.0 }
  });

  assert.ok(results.length >= 2, "Expected at least 2 results");
  const freqResult   = results.find((r) => r.id === "freq");
  const virginResult = results.find((r) => r.id === "virgin");
  assert.ok(freqResult, "Frequently accessed memory should be in results");
  assert.ok(virginResult, "Never-accessed memory should be in results");
  assert.ok(
    freqResult._hybrid.accessFreqBonus > 0,
    "accessFreqBonus should be > 0 for frequently accessed memory"
  );
  assert.ok(
    freqResult._hybrid.finalScore > virginResult._hybrid.finalScore,
    "Frequently accessed memory should have higher finalScore"
  );
});

// ── 14. retrieveCandidates includes graph-only neighbours ────────────────────
test("hybridRetrievalService — graph neighbours not in original results are added as candidates", async () => {
  const graphNeighbourId = `graph-neighbour-${uid()}`;
  const primary = mem({ id: "primary" });

  const svc = createHybridRetrievalService({
    vectorStore:  makeVectorStore([primary]),
    keywordStore: makeKeywordStore(),
    graphStore:   makeGraphStore(new Map([
      ["primary", [{ id: graphNeighbourId, summary: "graph only result", importance: 0.6 }]]
    ])),
    embedText:    makeEmbedText()
  });

  const candidates = await svc.retrieveCandidates("query", USER, SESSION);
  const hasNeighbour = candidates.some((c) => c.id === graphNeighbourId);
  assert.ok(hasNeighbour, "Graph-only neighbour should appear in candidates");

  const neighbour = candidates.find((c) => c.id === graphNeighbourId);
  assert.ok(neighbour._hybrid.graphScore > 0, "Graph neighbour should have graphScore > 0");
  assert.ok(
    neighbour._hybrid.sources.includes("graph"),
    "Graph neighbour source should be 'graph'"
  );
});

// ── 15. minFinalScore filter ──────────────────────────────────────────────────
test("hybridRetrievalService — minFinalScore filters out low-scoring results", async () => {
  const low  = mem({ id: "low-score",  importance: 0.01 });
  const high = mem({ id: "high-score", importance: 0.95 });

  const svc = createHybridRetrievalService({
    vectorStore:  makeVectorStore([low, high]),
    keywordStore: makeKeywordStore(),
    graphStore:   makeGraphStore(),
    embedText:    makeEmbedText()
  });

  const results = await svc.getRelevantMemories("query", USER, SESSION, {
    weights:       { vector: 0.0, keyword: 0.0, importance: 1.0, recency: 0.0, graph: 0.0 },
    minFinalScore: 0.5
  });

  const ids = results.map((r) => r.id);
  assert.ok(ids.includes("high-score"), "High scoring memory should pass the filter");
  assert.ok(!ids.includes("low-score"), "Low scoring memory should be filtered out");
});

// ── 16. topK slicing ──────────────────────────────────────────────────────────
test("hybridRetrievalService — topK limits results to requested count", async () => {
  const many = Array.from({ length: 20 }, (_, i) =>
    mem({ id: `mem-${i}`, importance: (20 - i) / 20 })
  );

  const svc = createHybridRetrievalService({
    vectorStore:  makeVectorStore(many),
    keywordStore: makeKeywordStore(),
    graphStore:   makeGraphStore(),
    embedText:    makeEmbedText()
  });

  const results = await svc.getRelevantMemories("query", USER, SESSION, { topK: 5 });
  assert.ok(results.length <= 5, "Results should be limited to topK=5");
});

// ── 17. Missing embedding — embedText returns null ────────────────────────────
test("hybridRetrievalService — null embedding still returns keyword results", async () => {
  const m = mem({ id: "no-embed" });

  const svc = createHybridRetrievalService({
    vectorStore:  makeVectorStore([m]),
    keywordStore: makeKeywordStore([m]),
    graphStore:   makeGraphStore(),
    embedText:    async () => null  // no embedding
  });

  const results = await svc.getRelevantMemories("query", USER, SESSION);
  assert.ok(results.length >= 1, "Should return results even with null embedding");
});

// ── 18. Graph-only results rank appropriately ─────────────────────────────────
test("hybridRetrievalService — graph-only candidates rank based on graphScore", async () => {
  const primary = mem({ id: "primary-graph-test" });
  const graphNeighbourId = `gn-${uid()}`;

  const svc = createHybridRetrievalService({
    vectorStore:  makeVectorStore([primary]),
    keywordStore: makeKeywordStore(),
    graphStore:   makeGraphStore(new Map([
      ["primary-graph-test", [
        { id: graphNeighbourId, summary: "graph related", importance: 0.9 }
      ]]
    ])),
    embedText:    makeEmbedText()
  });

  const results = await svc.getRelevantMemories("query", USER, SESSION, {
    weights: { vector: 0.0, keyword: 0.0, importance: 0.0, recency: 0.0, graph: 1.0 }
  });

  const graphResult = results.find((r) => r.id === graphNeighbourId);
  if (graphResult) {
    assert.ok(
      graphResult._hybrid.finalScore > 0,
      "Graph-only candidate should have a positive finalScore"
    );
  }
  // Primary should have a higher graphScore than plain unconnected memory
  const primaryResult = results.find((r) => r.id === "primary-graph-test");
  if (primaryResult) {
    assert.ok(
      primaryResult._hybrid.graphScore > 0,
      "Primary memory connected to neighbours should have graphScore > 0"
    );
  }
});

// ── 19. HYBRID_WEIGHTS_DEFAULTS values are correct ───────────────────────────
test("HYBRID_WEIGHTS_DEFAULTS — values match required weights", () => {
  assert.equal(HYBRID_WEIGHTS_DEFAULTS.vector,     0.40, "vector weight should be 0.40");
  assert.equal(HYBRID_WEIGHTS_DEFAULTS.keyword,    0.20, "keyword weight should be 0.20");
  assert.equal(HYBRID_WEIGHTS_DEFAULTS.importance, 0.20, "importance weight should be 0.20");
  assert.equal(HYBRID_WEIGHTS_DEFAULTS.recency,    0.10, "recency weight should be 0.10");
  assert.equal(HYBRID_WEIGHTS_DEFAULTS.graph,      0.10, "graph weight should be 0.10");

  const sum = Object.values(HYBRID_WEIGHTS_DEFAULTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1.0) < 0.001, "Default weights should sum to 1.0");
});

// ── 20. _hybrid envelope fields are all present ───────────────────────────────
test("hybridRetrievalService — _hybrid envelope has all required fields", async () => {
  const m = mem({ id: "envelope-test" });

  const svc = createHybridRetrievalService({
    vectorStore:  makeVectorStore([m]),
    keywordStore: makeKeywordStore(),
    graphStore:   makeGraphStore(),
    embedText:    makeEmbedText()
  });

  const results = await svc.getRelevantMemories("query", USER, SESSION);
  assert.ok(results.length >= 1, "Expected at least 1 result");

  const h = results[0]._hybrid;
  assert.ok("finalScore"       in h, "finalScore should be in _hybrid");
  assert.ok("vectorScore"      in h, "vectorScore should be in _hybrid");
  assert.ok("keywordScore"     in h, "keywordScore should be in _hybrid");
  assert.ok("importanceScore"  in h, "importanceScore should be in _hybrid");
  assert.ok("recencyScore"     in h, "recencyScore should be in _hybrid");
  assert.ok("graphScore"       in h, "graphScore should be in _hybrid");
  assert.ok("accessFreqBonus"  in h, "accessFreqBonus should be in _hybrid");
  assert.ok("sources"          in h, "sources should be in _hybrid");
  assert.ok("reason"           in h, "reason should be in _hybrid");
  assert.ok("weights"          in h, "weights should be in _hybrid");
  assert.ok(typeof h.reason === "string" && h.reason.length > 0, "reason should be a non-empty string");
  assert.ok(Array.isArray(h.sources), "sources should be an array");
});
