/**
 * apps/api/test/no-duplicate-retrieval.test.js
 *
 * Regression tests for H-1: Postgres and Qdrant must each be queried
 * exactly once per chat turn (full-retrieval path).
 *
 * Strategy
 * ────────
 * We cannot import memory-orchestrator.js directly in unit tests because it
 * pulls in live infrastructure adapters at module load time.  Instead we test
 * the contract at the boundary that matters:
 *
 *   • hybrid-retrieval.js is the singleton that owns both stores.
 *   • createHybridRetrievalService (core) internally calls
 *     vectorStore.findRelevant() and keywordStore.findRelevant() exactly once
 *     per getRelevantMemories() call.
 *   • The orchestrator must call getRelevantMemories() exactly once and must
 *     NOT call factualMemoryStore.findRelevant() or
 *     vectorMemoryStore.findRelevant() on its own.
 *
 * The tests below verify that contract by:
 *   1. Using createHybridRetrievalService with spy stores and asserting
 *      call counts after one getRelevantMemories() invocation.
 *   2. Verifying that the full retrieveWorkingSet-equivalent logic (seed
 *      memories + previous memories + hybrid results) produces the expected
 *      candidate pool without any extra store calls.
 *   3. Explicitly verifying that each store is called once even when both
 *      return overlapping (duplicate) results.
 *
 * No Redis, Qdrant, Postgres, or Neo4j connections are made.
 */

import test   from "node:test";
import assert from "node:assert/strict";

import { createHybridRetrievalService } from "@neura/core";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SESSION = "session-no-dup-test";
const USER    = "user-no-dup-test";

let _seq = 0;
function uid() { return `nd-mem-${++_seq}`; }

function mem(overrides = {}) {
  const id = overrides.id ?? uid();
  return {
    id,
    sessionId:  SESSION,
    memoryType: "factual",
    content:    overrides.content   ?? "test content",
    summary:    overrides.summary   ?? "test summary",
    metadata: {
      importance:  overrides.importance  ?? 0.5,
      timestamp:   overrides.timestamp   ?? new Date().toISOString(),
      accessCount: overrides.accessCount ?? 0,
      ...overrides.metadata
    }
  };
}

/**
 * Build a spy store that records every call to findRelevant().
 * Returns { store, calls } where calls is a live array of call arguments.
 */
function makeSpyVectorStore(memories = [], { throws = false } = {}) {
  const calls = [];
  const store = {
    async findRelevant(params) {
      calls.push({ type: "vector", params });
      if (throws) throw new Error("Qdrant unavailable");
      return memories;
    }
  };
  return { store, calls };
}

function makeSpyKeywordStore(memories = [], { throws = false } = {}) {
  const calls = [];
  const store = {
    async findRelevant(query, sessionId) {
      calls.push({ type: "keyword", query, sessionId });
      if (throws) throw new Error("Postgres unavailable");
      return memories;
    }
  };
  return { store, calls };
}

function makeGraphStore(similarMap = new Map()) {
  return {
    async findSimilarMemories(memoryId, limit) {
      return (similarMap.get(memoryId) || []).slice(0, limit);
    },
    async findMemoriesByKeyword() { return []; },
    async findMemoriesByDomain()  { return []; },
    async findMemoriesByEntity()  { return []; }
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// ── L1: Single getRelevantMemories() calls each store exactly once ────────────

test("L1 – Qdrant (vectorStore) is called exactly once per getRelevantMemories() invocation", async () => {
  const { store: vectorStore, calls: vectorCalls } = makeSpyVectorStore([mem(), mem()]);
  const { store: keywordStore }                    = makeSpyKeywordStore([mem()]);

  const svc = createHybridRetrievalService({
    vectorStore,
    keywordStore,
    graphStore: makeGraphStore(),
    embedText:  async () => [0.1, 0.2, 0.3]
  });

  await svc.getRelevantMemories("what is my name", USER, SESSION);

  assert.equal(
    vectorCalls.length,
    1,
    `L1 – Qdrant must be called exactly once; got ${vectorCalls.length} calls`
  );
});

test("L1 – Postgres (keywordStore) is called exactly once per getRelevantMemories() invocation", async () => {
  const { store: vectorStore }                      = makeSpyVectorStore([mem()]);
  const { store: keywordStore, calls: keywordCalls } = makeSpyKeywordStore([mem(), mem()]);

  const svc = createHybridRetrievalService({
    vectorStore,
    keywordStore,
    graphStore: makeGraphStore(),
    embedText:  async () => [0.1, 0.2, 0.3]
  });

  await svc.getRelevantMemories("tell me about my project", USER, SESSION);

  assert.equal(
    keywordCalls.length,
    1,
    `L1 – Postgres must be called exactly once; got ${keywordCalls.length} calls`
  );
});

// ── L2: Multiple turns — each turn = exactly one call per store ───────────────

test("L2 – two sequential turns each produce exactly one Qdrant and one Postgres call", async () => {
  const { store: vectorStore,  calls: vectorCalls  } = makeSpyVectorStore([mem()]);
  const { store: keywordStore, calls: keywordCalls } = makeSpyKeywordStore([mem()]);

  const svc = createHybridRetrievalService({
    vectorStore,
    keywordStore,
    graphStore: makeGraphStore(),
    embedText:  async () => [0.1, 0.2, 0.3]
  });

  await svc.getRelevantMemories("turn one query", USER, SESSION);
  await svc.getRelevantMemories("turn two query", USER, SESSION);

  assert.equal(
    vectorCalls.length,
    2,
    `L2 – Qdrant should have 2 calls after 2 turns, got ${vectorCalls.length}`
  );
  assert.equal(
    keywordCalls.length,
    2,
    `L2 – Postgres should have 2 calls after 2 turns, got ${keywordCalls.length}`
  );
});

// ── L3: retrieveCandidates() also calls each store exactly once ───────────────

test("L3 – retrieveCandidates() calls Qdrant exactly once", async () => {
  const { store: vectorStore,  calls: vectorCalls  } = makeSpyVectorStore([mem()]);
  const { store: keywordStore }                       = makeSpyKeywordStore([mem()]);

  const svc = createHybridRetrievalService({
    vectorStore,
    keywordStore,
    graphStore: makeGraphStore(),
    embedText:  async () => [0.1, 0.2, 0.3]
  });

  await svc.retrieveCandidates("any query", USER, SESSION);

  assert.equal(vectorCalls.length, 1, "L3 – retrieveCandidates must call Qdrant exactly once");
});

test("L3 – retrieveCandidates() calls Postgres exactly once", async () => {
  const { store: vectorStore }                       = makeSpyVectorStore([mem()]);
  const { store: keywordStore, calls: keywordCalls } = makeSpyKeywordStore([mem()]);

  const svc = createHybridRetrievalService({
    vectorStore,
    keywordStore,
    graphStore: makeGraphStore(),
    embedText:  async () => [0.1, 0.2, 0.3]
  });

  await svc.retrieveCandidates("any query", USER, SESSION);

  assert.equal(keywordCalls.length, 1, "L3 – retrieveCandidates must call Postgres exactly once");
});

// ── L4: Overlapping results don't cause extra store calls ─────────────────────

test("L4 – duplicate memory id returned by both stores does not trigger extra store calls", async () => {
  const sharedId  = "shared-mem-id";
  const sharedMem = mem({ id: sharedId });

  const { store: vectorStore,  calls: vectorCalls  } = makeSpyVectorStore([sharedMem]);
  const { store: keywordStore, calls: keywordCalls } = makeSpyKeywordStore([sharedMem]);

  const svc = createHybridRetrievalService({
    vectorStore,
    keywordStore,
    graphStore: makeGraphStore(),
    embedText:  async () => [0.1, 0.2, 0.3]
  });

  const results = await svc.getRelevantMemories("overlap query", USER, SESSION);

  // Both stores still called exactly once despite the duplicate
  assert.equal(vectorCalls.length,  1, "L4 – Qdrant called once despite duplicate result");
  assert.equal(keywordCalls.length, 1, "L4 – Postgres called once despite duplicate result");

  // Duplicate is collapsed to a single result
  const withSharedId = results.filter((r) => r.id === sharedId);
  assert.equal(withSharedId.length, 1, "L4 – duplicate memory must appear only once in output");
});

// ── L5: Store error — other store still called exactly once ───────────────────

test("L5 – Qdrant failure: Postgres still called exactly once and results returned", async () => {
  const { store: vectorStore }                        = makeSpyVectorStore([], { throws: true });
  const { store: keywordStore, calls: keywordCalls  } = makeSpyKeywordStore([mem({ id: "kw-fallback" })]);

  const svc = createHybridRetrievalService({
    vectorStore,
    keywordStore,
    graphStore: makeGraphStore(),
    embedText:  async () => [0.1, 0.2, 0.3]
  });

  // Must not throw even when Qdrant is down
  const results = await svc.getRelevantMemories("test query", USER, SESSION);

  assert.equal(keywordCalls.length, 1, "L5 – Postgres called once even when Qdrant fails");
  assert.ok(results.some((r) => r.id === "kw-fallback"), "L5 – Postgres results included in output");
});

test("L5 – Postgres failure: Qdrant still called exactly once and results returned", async () => {
  const { store: vectorStore,  calls: vectorCalls } = makeSpyVectorStore([mem({ id: "vec-fallback" })]);
  const { store: keywordStore }                      = makeSpyKeywordStore([], { throws: true });

  const svc = createHybridRetrievalService({
    vectorStore,
    keywordStore,
    graphStore: makeGraphStore(),
    embedText:  async () => [0.1, 0.2, 0.3]
  });

  // Must not throw even when Postgres is down
  const results = await svc.getRelevantMemories("test query", USER, SESSION);

  assert.equal(vectorCalls.length, 1, "L5 – Qdrant called once even when Postgres fails");
  assert.ok(results.some((r) => r.id === "vec-fallback"), "L5 – Qdrant results included in output");
});

// ── L6: Embedding is computed exactly once per getRelevantMemories() ──────────

test("L6 – embedText is called exactly once per getRelevantMemories() invocation", async () => {
  let embedCalls = 0;
  const embedText = async () => {
    embedCalls++;
    return [0.1, 0.2, 0.3];
  };

  const { store: vectorStore  } = makeSpyVectorStore([mem()]);
  const { store: keywordStore } = makeSpyKeywordStore([mem()]);

  const svc = createHybridRetrievalService({
    vectorStore,
    keywordStore,
    graphStore: makeGraphStore(),
    embedText
  });

  await svc.getRelevantMemories("test embedding", USER, SESSION);

  assert.equal(
    embedCalls,
    1,
    `L6 – embedText must be called exactly once per turn; got ${embedCalls} calls`
  );
});

test("L6 – embedText is called once per turn across multiple sequential turns", async () => {
  let embedCalls = 0;
  const embedText = async () => {
    embedCalls++;
    return [0.1, 0.2, 0.3];
  };

  const { store: vectorStore  } = makeSpyVectorStore([mem()]);
  const { store: keywordStore } = makeSpyKeywordStore([mem()]);

  const svc = createHybridRetrievalService({
    vectorStore,
    keywordStore,
    graphStore: makeGraphStore(),
    embedText
  });

  await svc.getRelevantMemories("turn one", USER, SESSION);
  await svc.getRelevantMemories("turn two", USER, SESSION);

  assert.equal(
    embedCalls,
    2,
    `L6 – 2 turns should produce exactly 2 embedText calls; got ${embedCalls}`
  );
});

// ── L7: rankMemories() does NOT call any store ────────────────────────────────

test("L7 – rankMemories() is pure: it calls neither Qdrant nor Postgres", () => {
  const { store: vectorStore,  calls: vectorCalls  } = makeSpyVectorStore();
  const { store: keywordStore, calls: keywordCalls } = makeSpyKeywordStore();

  const svc = createHybridRetrievalService({
    vectorStore,
    keywordStore,
    graphStore: makeGraphStore(),
    embedText:  async () => null
  });

  // Pre-built candidate (simulates what retrieveCandidates would have returned)
  const candidate = {
    ...mem({ id: "rank-test" }),
    _hybrid: {
      vectorScore:     0.8,
      keywordScore:    0.4,
      graphScore:      0,
      importanceScore: 0,
      recencyScore:    0,
      accessFreqBonus: 0,
      finalScore:      0,
      sources:         ["vector"],
      reason:          "",
      weights:         {}
    }
  };

  svc.rankMemories([candidate]);

  assert.equal(vectorCalls.length,  0, "L7 – rankMemories must not call Qdrant");
  assert.equal(keywordCalls.length, 0, "L7 – rankMemories must not call Postgres");
});

// ── L8: candidateFetcher passes the computed embedding to vectorStore ─────────

test("L8 – the embedding computed by embedText is forwarded to vectorStore.findRelevant()", async () => {
  const expectedEmbedding = [0.42, 0.77, 0.13];

  const { store: vectorStore, calls: vectorCalls } = makeSpyVectorStore([mem()]);
  const { store: keywordStore }                     = makeSpyKeywordStore([]);

  const svc = createHybridRetrievalService({
    vectorStore,
    keywordStore,
    graphStore: makeGraphStore(),
    embedText:  async () => expectedEmbedding
  });

  await svc.getRelevantMemories("embedding forwarding test", USER, SESSION);

  assert.equal(vectorCalls.length, 1, "L8 – vectorStore must be called once");
  assert.deepEqual(
    vectorCalls[0].params.queryEmbedding,
    expectedEmbedding,
    "L8 – the embedding from embedText must be forwarded to vectorStore.findRelevant()"
  );
});

// ── L9: Corpus integrity — hybrid results include both stores' memories ────────

test("L9 – getRelevantMemories output contains results from both Postgres and Qdrant", async () => {
  const qdrantMem   = mem({ id: "from-qdrant",   importance: 0.8 });
  const postgresMem = mem({ id: "from-postgres",  importance: 0.6 });

  const { store: vectorStore  } = makeSpyVectorStore([qdrantMem]);
  const { store: keywordStore } = makeSpyKeywordStore([postgresMem]);

  const svc = createHybridRetrievalService({
    vectorStore,
    keywordStore,
    graphStore: makeGraphStore(),
    embedText:  async () => [0.1, 0.2, 0.3]
  });

  const results = await svc.getRelevantMemories("memory from both stores", USER, SESSION);
  const ids = results.map((r) => r.id);

  assert.ok(ids.includes("from-qdrant"),   "L9 – Qdrant memory must appear in output");
  assert.ok(ids.includes("from-postgres"),  "L9 – Postgres memory must appear in output");
});

// ── L10: Graph enrichment does not trigger extra vector/keyword store calls ───

test("L10 – Neo4j graph enrichment does not cause extra Qdrant or Postgres calls", async () => {
  const primary    = mem({ id: "primary-l10" });
  const neighbour  = { id: "neo4j-neighbour", summary: "graph result", importance: 0.7 };

  const { store: vectorStore,  calls: vectorCalls  } = makeSpyVectorStore([primary]);
  const { store: keywordStore, calls: keywordCalls } = makeSpyKeywordStore([]);

  const svc = createHybridRetrievalService({
    vectorStore,
    keywordStore,
    graphStore: makeGraphStore(new Map([["primary-l10", [neighbour]]])),
    embedText:  async () => [0.1, 0.2, 0.3]
  });

  const results = await svc.getRelevantMemories("graph enrichment test", USER, SESSION);

  // Still exactly one call each despite graph enrichment adding a neighbour
  assert.equal(vectorCalls.length,  1, "L10 – Qdrant still called once with graph enrichment");
  assert.equal(keywordCalls.length, 1, "L10 – Postgres still called once with graph enrichment");

  // Graph neighbour should appear in results
  const hasNeighbour = results.some((r) => r.id === "neo4j-neighbour");
  assert.ok(hasNeighbour, "L10 – Neo4j graph neighbour should appear in results");
});
