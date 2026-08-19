/**
 * packages/core/test/lifecycle-sync.test.js
 *
 * Tests for C-1: Lifecycle State Synchronization.
 *
 * Covers the new LifecycleSyncService and the wiring in lifecycleManager
 * that fans out state changes to PostgreSQL, Qdrant, and Neo4j.
 *
 * ─── Coverage ─────────────────────────────────────────────────────────────────
 *
 *  LIFECYCLE SYNC SERVICE (24 tests)
 *    createLifecycleSyncService
 *     1.  returns an object with syncLifecycleState function
 *     2.  all adapters omitted → all results are "skipped", success=true
 *     3.  NOOP_SYNC_SERVICE skips all backends
 *
 *    syncLifecycleState — happy paths
 *     4.  postgres-only: calls updateLifecycleState with correct args
 *     5.  qdrant-only: calls updatePayloadMetadata with correct args
 *     6.  neo4j-only: calls updateMemoryLifecycleState with correct args
 *     7.  all three adapters: all results are "ok", success=true
 *     8.  passes memory.metadata.lifecycleState to each backend
 *     9.  passes full metadata object to each backend
 *
 *    syncLifecycleState — ACTIVE/STALE/CONFLICTED/ARCHIVED transitions
 *    10.  ACTIVE → STALE: state propagated to all backends
 *    11.  ACTIVE → CONFLICTED: state propagated to all backends
 *    12.  ACTIVE → ARCHIVED: state propagated to all backends
 *    13.  STALE → ACTIVE: state propagated to all backends
 *    14.  CONFLICTED → ACTIVE: state propagated to all backends
 *
 *    syncLifecycleState — partial failure safety
 *    15.  postgres failure: qdrant and neo4j still receive update; failures captured
 *    16.  qdrant failure: postgres and neo4j still receive update; failures captured
 *    17.  neo4j failure: postgres and qdrant still receive update; failures captured
 *    18.  all three fail: success=false, failures array has all three entries
 *    19.  adapter returning false counts as "ok" (not-found/skipped, not a crash)
 *    20.  adapter throwing does not propagate the throw
 *    21.  multiple backend failures: all captured in failures array
 *    22.  error message preserved in failures entry
 *
 *  PROCESSUSERMEMORIES WITH SYNC (8 tests)
 *    23.  syncService called for each transitioned memory
 *    24.  syncFailures returned in result object
 *    25.  tier repository updated even when sync backend fails
 *    26.  sync backend failure does not abort sweep of remaining memories
 *    27.  result includes syncFailures array (empty when no failures)
 *    28.  no syncService param → NOOP used, result.syncFailures is empty array
 *    29.  sync not called for memories with no state change
 *    30.  sync receives fully stamped updated memory (correct metadata)
 *
 * Test runner: Node 22 built-in (node --test)
 * Import style: ESM
 */

import assert from "node:assert/strict";
import test   from "node:test";

import {
  createLifecycleSyncService,
  NOOP_SYNC_SERVICE
} from "../src/memory/lifecycle/lifecycleSyncService.js";

import {
  processUserMemories,
  LifecycleState,
  LIFECYCLE_DEFAULTS,
  markStale,
  markConflicted,
  archiveMemory
} from "../src/memory/lifecycle/index.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _idSeq = 0;
function uid() { return `sync-mem-${++_idSeq}`; }

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Build a minimal memory for testing.
 */
function mem(opts = {}) {
  const {
    id             = uid(),
    content        = "I live in Mumbai.",
    memoryType     = "factual",
    importance     = 0.5,
    confidence     = 0.7,
    ageMs          = 0,
    lifecycleState = undefined
  } = opts;

  const timestamp = new Date(Date.now() - ageMs).toISOString();

  return {
    id,
    content,
    memoryType,
    metadata: {
      importance,
      confidence,
      timestamp,
      ...(lifecycleState ? { lifecycleState } : {})
    }
  };
}

/**
 * Build a fully-stamped stale memory (already transitioned).
 */
function staleMemory(id = uid()) {
  return markStale(mem({ id, ageMs: 60 * DAY_MS, importance: 0.2 }));
}

/**
 * Build a mock store adapter that records calls.
 *
 * @param {{ fail?: boolean, returnValue?: boolean }} opts
 */
function mockPostgresStore(opts = {}) {
  const calls = [];
  return {
    calls,
    async updateLifecycleState(id, lifecycleState, metadata) {
      calls.push({ id, lifecycleState, metadata });
      if (opts.fail) throw new Error("postgres error");
      return opts.returnValue ?? true;
    }
  };
}

function mockVectorStore(opts = {}) {
  const calls = [];
  return {
    calls,
    async updatePayloadMetadata(id, metadata) {
      calls.push({ id, metadata });
      if (opts.fail) throw new Error("qdrant error");
      return opts.returnValue ?? true;
    }
  };
}

function mockGraphStore(opts = {}) {
  const calls = [];
  return {
    calls,
    async updateMemoryLifecycleState(id, lifecycleState, metadata) {
      calls.push({ id, lifecycleState, metadata });
      if (opts.fail) throw new Error("neo4j error");
      return opts.returnValue ?? true;
    }
  };
}

/**
 * Tight test config — stale after 1 day, archive after 7 days.
 */
const TEST_CONFIG = {
  ...LIFECYCLE_DEFAULTS,
  staleAccessDays:       1,
  staleImportanceMin:    0.4,
  archiveAccessDays:     7,
  archiveImportanceMax:  0.4,
  conflictSimilarity:    0.25,
  conflictConfidenceMin: 0.20
};

// ═══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE SYNC SERVICE — basics
// ═══════════════════════════════════════════════════════════════════════════════

test("createLifecycleSyncService returns object with syncLifecycleState function", () => {
  const svc = createLifecycleSyncService({});
  assert.equal(typeof svc.syncLifecycleState, "function");
});

test("all adapters omitted → all results are 'skipped', success=true", async () => {
  const svc    = createLifecycleSyncService({});
  const memory = staleMemory();
  const result = await svc.syncLifecycleState(memory);

  assert.equal(result.success, true);
  assert.equal(result.results.postgres, "skipped");
  assert.equal(result.results.qdrant,   "skipped");
  assert.equal(result.results.neo4j,    "skipped");
  assert.equal(result.failures.length,  0);
});

test("NOOP_SYNC_SERVICE skips all backends", async () => {
  const memory = staleMemory();
  const result = await NOOP_SYNC_SERVICE.syncLifecycleState(memory);

  assert.equal(result.success, true);
  assert.equal(result.results.postgres, "skipped");
  assert.equal(result.results.qdrant,   "skipped");
  assert.equal(result.results.neo4j,    "skipped");
});

// ═══════════════════════════════════════════════════════════════════════════════
// SYNC SERVICE — happy paths per adapter
// ═══════════════════════════════════════════════════════════════════════════════

test("postgres-only: calls updateLifecycleState with correct args", async () => {
  const pg     = mockPostgresStore();
  const svc    = createLifecycleSyncService({ postgresStore: pg });
  const memory = staleMemory("pg-test-1");

  const result = await svc.syncLifecycleState(memory);

  assert.equal(result.results.postgres, "ok");
  assert.equal(result.results.qdrant,   "skipped");
  assert.equal(result.results.neo4j,    "skipped");
  assert.equal(pg.calls.length, 1);
  assert.equal(pg.calls[0].id,             memory.id);
  assert.equal(pg.calls[0].lifecycleState, LifecycleState.STALE);
  assert.equal(pg.calls[0].metadata,       memory.metadata);
});

test("qdrant-only: calls updatePayloadMetadata with correct args", async () => {
  const qdrant = mockVectorStore();
  const svc    = createLifecycleSyncService({ vectorStore: qdrant });
  const memory = staleMemory("qdrant-test-1");

  const result = await svc.syncLifecycleState(memory);

  assert.equal(result.results.postgres, "skipped");
  assert.equal(result.results.qdrant,   "ok");
  assert.equal(result.results.neo4j,    "skipped");
  assert.equal(qdrant.calls.length, 1);
  assert.equal(qdrant.calls[0].id,       memory.id);
  assert.equal(qdrant.calls[0].metadata, memory.metadata);
});

test("neo4j-only: calls updateMemoryLifecycleState with correct args", async () => {
  const neo4j  = mockGraphStore();
  const svc    = createLifecycleSyncService({ graphStore: neo4j });
  const memory = staleMemory("neo4j-test-1");

  const result = await svc.syncLifecycleState(memory);

  assert.equal(result.results.postgres, "skipped");
  assert.equal(result.results.qdrant,   "skipped");
  assert.equal(result.results.neo4j,    "ok");
  assert.equal(neo4j.calls.length, 1);
  assert.equal(neo4j.calls[0].id,             memory.id);
  assert.equal(neo4j.calls[0].lifecycleState, LifecycleState.STALE);
  assert.equal(neo4j.calls[0].metadata,       memory.metadata);
});

test("all three adapters: all results are 'ok', success=true", async () => {
  const pg     = mockPostgresStore();
  const qdrant = mockVectorStore();
  const neo4j  = mockGraphStore();
  const svc    = createLifecycleSyncService({ postgresStore: pg, vectorStore: qdrant, graphStore: neo4j });
  const memory = staleMemory();

  const result = await svc.syncLifecycleState(memory);

  assert.equal(result.success, true);
  assert.equal(result.results.postgres, "ok");
  assert.equal(result.results.qdrant,   "ok");
  assert.equal(result.results.neo4j,    "ok");
  assert.equal(result.failures.length,  0);
});

test("passes memory.metadata.lifecycleState to each backend", async () => {
  const pg     = mockPostgresStore();
  const qdrant = mockVectorStore();
  const neo4j  = mockGraphStore();
  const svc    = createLifecycleSyncService({ postgresStore: pg, vectorStore: qdrant, graphStore: neo4j });

  const archived = archiveMemory(mem());
  await svc.syncLifecycleState(archived);

  assert.equal(pg.calls[0].lifecycleState,    LifecycleState.ARCHIVED);
  assert.equal(neo4j.calls[0].lifecycleState, LifecycleState.ARCHIVED);
});

test("passes full metadata object to each backend", async () => {
  const pg     = mockPostgresStore();
  const qdrant = mockVectorStore();
  const neo4j  = mockGraphStore();
  const svc    = createLifecycleSyncService({ postgresStore: pg, vectorStore: qdrant, graphStore: neo4j });

  const memory = staleMemory();
  await svc.syncLifecycleState(memory);

  assert.deepEqual(pg.calls[0].metadata,     memory.metadata);
  assert.deepEqual(qdrant.calls[0].metadata, memory.metadata);
  assert.deepEqual(neo4j.calls[0].metadata,  memory.metadata);
});

// ═══════════════════════════════════════════════════════════════════════════════
// SYNC SERVICE — ACTIVE/STALE/CONFLICTED/ARCHIVED transitions
// ═══════════════════════════════════════════════════════════════════════════════

test("ACTIVE → STALE: state propagated to all backends", async () => {
  const pg     = mockPostgresStore();
  const qdrant = mockVectorStore();
  const neo4j  = mockGraphStore();
  const svc    = createLifecycleSyncService({ postgresStore: pg, vectorStore: qdrant, graphStore: neo4j });

  const staled = markStale(mem());
  const result = await svc.syncLifecycleState(staled);

  assert.equal(result.success, true);
  assert.equal(pg.calls[0].lifecycleState,    LifecycleState.STALE);
  assert.equal(neo4j.calls[0].lifecycleState, LifecycleState.STALE);
  assert.equal(qdrant.calls[0].metadata.lifecycleState, LifecycleState.STALE);
});

test("ACTIVE → CONFLICTED: state propagated to all backends", async () => {
  const pg     = mockPostgresStore();
  const qdrant = mockVectorStore();
  const neo4j  = mockGraphStore();
  const svc    = createLifecycleSyncService({ postgresStore: pg, vectorStore: qdrant, graphStore: neo4j });

  const conflicts = [{
    conflictingId: "other-id", similarity: 0.55, confidence: 0.7,
    reason: "location", detectedAt: new Date().toISOString(), preferOther: true
  }];
  const conflicted = markConflicted(mem(), conflicts);
  const result     = await svc.syncLifecycleState(conflicted);

  assert.equal(result.success, true);
  assert.equal(pg.calls[0].lifecycleState,    LifecycleState.CONFLICTED);
  assert.equal(neo4j.calls[0].lifecycleState, LifecycleState.CONFLICTED);
  assert.equal(qdrant.calls[0].metadata.lifecycleState, LifecycleState.CONFLICTED);
});

test("ACTIVE → ARCHIVED: state propagated to all backends", async () => {
  const pg     = mockPostgresStore();
  const qdrant = mockVectorStore();
  const neo4j  = mockGraphStore();
  const svc    = createLifecycleSyncService({ postgresStore: pg, vectorStore: qdrant, graphStore: neo4j });

  const archived = archiveMemory(mem());
  const result   = await svc.syncLifecycleState(archived);

  assert.equal(result.success, true);
  assert.equal(pg.calls[0].lifecycleState,    LifecycleState.ARCHIVED);
  assert.equal(neo4j.calls[0].lifecycleState, LifecycleState.ARCHIVED);
  assert.equal(qdrant.calls[0].metadata.lifecycleState, LifecycleState.ARCHIVED);
});

test("STALE → ACTIVE: state propagated to all backends", async () => {
  const pg     = mockPostgresStore();
  const qdrant = mockVectorStore();
  const neo4j  = mockGraphStore();
  const svc    = createLifecycleSyncService({ postgresStore: pg, vectorStore: qdrant, graphStore: neo4j });

  // Build a memory that looks like it was revived to ACTIVE
  const revived = { ...mem(), metadata: { ...mem().metadata, lifecycleState: LifecycleState.ACTIVE } };
  const result  = await svc.syncLifecycleState(revived);

  assert.equal(result.success, true);
  assert.equal(pg.calls[0].lifecycleState,    LifecycleState.ACTIVE);
  assert.equal(neo4j.calls[0].lifecycleState, LifecycleState.ACTIVE);
});

test("CONFLICTED → ACTIVE: state propagated to all backends", async () => {
  const pg     = mockPostgresStore();
  const qdrant = mockVectorStore();
  const neo4j  = mockGraphStore();
  const svc    = createLifecycleSyncService({ postgresStore: pg, vectorStore: qdrant, graphStore: neo4j });

  const revived = {
    ...mem(),
    metadata: { ...mem().metadata, lifecycleState: LifecycleState.ACTIVE, conflicts: [] }
  };
  const result = await svc.syncLifecycleState(revived);

  assert.equal(result.success, true);
  assert.equal(pg.calls[0].lifecycleState,    LifecycleState.ACTIVE);
  assert.equal(neo4j.calls[0].lifecycleState, LifecycleState.ACTIVE);
});

// ═══════════════════════════════════════════════════════════════════════════════
// SYNC SERVICE — partial failure safety
// ═══════════════════════════════════════════════════════════════════════════════

test("postgres failure: qdrant and neo4j still receive update; failures captured", async () => {
  const pg     = mockPostgresStore({ fail: true });
  const qdrant = mockVectorStore();
  const neo4j  = mockGraphStore();
  const svc    = createLifecycleSyncService({ postgresStore: pg, vectorStore: qdrant, graphStore: neo4j });

  const result = await svc.syncLifecycleState(staleMemory());

  assert.equal(result.success, false);
  assert.equal(result.results.postgres, "failed");
  assert.equal(result.results.qdrant,   "ok");
  assert.equal(result.results.neo4j,    "ok");
  assert.equal(result.failures.length,  1);
  assert.equal(result.failures[0].backend, "postgres");
  assert.ok(result.failures[0].error.includes("postgres error"));
  // The other backends received the call
  assert.equal(qdrant.calls.length, 1);
  assert.equal(neo4j.calls.length,  1);
});

test("qdrant failure: postgres and neo4j still receive update; failures captured", async () => {
  const pg     = mockPostgresStore();
  const qdrant = mockVectorStore({ fail: true });
  const neo4j  = mockGraphStore();
  const svc    = createLifecycleSyncService({ postgresStore: pg, vectorStore: qdrant, graphStore: neo4j });

  const result = await svc.syncLifecycleState(staleMemory());

  assert.equal(result.success, false);
  assert.equal(result.results.postgres, "ok");
  assert.equal(result.results.qdrant,   "failed");
  assert.equal(result.results.neo4j,    "ok");
  assert.equal(result.failures.length,  1);
  assert.equal(result.failures[0].backend, "qdrant");
  assert.ok(result.failures[0].error.includes("qdrant error"));
  // Postgres and Neo4j were still called
  assert.equal(pg.calls.length,    1);
  assert.equal(neo4j.calls.length, 1);
});

test("neo4j failure: postgres and qdrant still receive update; failures captured", async () => {
  const pg     = mockPostgresStore();
  const qdrant = mockVectorStore();
  const neo4j  = mockGraphStore({ fail: true });
  const svc    = createLifecycleSyncService({ postgresStore: pg, vectorStore: qdrant, graphStore: neo4j });

  const result = await svc.syncLifecycleState(staleMemory());

  assert.equal(result.success, false);
  assert.equal(result.results.postgres, "ok");
  assert.equal(result.results.qdrant,   "ok");
  assert.equal(result.results.neo4j,    "failed");
  assert.equal(result.failures.length,  1);
  assert.equal(result.failures[0].backend, "neo4j");
  assert.ok(result.failures[0].error.includes("neo4j error"));
  // Postgres and Qdrant were still called
  assert.equal(pg.calls.length,    1);
  assert.equal(qdrant.calls.length, 1);
});

test("all three fail: success=false, failures array has three entries", async () => {
  const svc = createLifecycleSyncService({
    postgresStore: mockPostgresStore({ fail: true }),
    vectorStore:   mockVectorStore({ fail: true }),
    graphStore:    mockGraphStore({ fail: true })
  });

  const result = await svc.syncLifecycleState(staleMemory());

  assert.equal(result.success, false);
  assert.equal(result.results.postgres, "failed");
  assert.equal(result.results.qdrant,   "failed");
  assert.equal(result.results.neo4j,    "failed");
  assert.equal(result.failures.length,  3);

  const backends = result.failures.map((f) => f.backend).sort();
  assert.deepEqual(backends, ["neo4j", "postgres", "qdrant"]);
});

test("adapter returning false counts as ok (not-found/skipped, not a crash)", async () => {
  // Some adapters return false when the row doesn't exist yet in Postgres/Neo4j.
  // This should NOT be recorded as a failure.
  const pg     = mockPostgresStore({ returnValue: false });
  const qdrant = mockVectorStore({ returnValue: false });
  const neo4j  = mockGraphStore({ returnValue: false });
  const svc    = createLifecycleSyncService({ postgresStore: pg, vectorStore: qdrant, graphStore: neo4j });

  const result = await svc.syncLifecycleState(staleMemory());

  // false return means "not found" — treated as ok (the sync attempt was made)
  assert.equal(result.success, true);
  assert.equal(result.failures.length, 0);
});

test("adapter throwing does not propagate the throw", async () => {
  const pg = mockPostgresStore({ fail: true });
  const svc = createLifecycleSyncService({ postgresStore: pg });

  // Must not throw
  let result;
  await assert.doesNotReject(async () => {
    result = await svc.syncLifecycleState(staleMemory());
  });
  assert.equal(result.success, false);
});

test("multiple backend failures: all captured in failures array", async () => {
  const svc = createLifecycleSyncService({
    postgresStore: mockPostgresStore({ fail: true }),
    vectorStore:   mockVectorStore({ fail: true }),
    graphStore:    mockGraphStore()  // neo4j succeeds
  });

  const result = await svc.syncLifecycleState(staleMemory());

  assert.equal(result.success, false);
  assert.equal(result.failures.length, 2);
  const failedBackends = result.failures.map((f) => f.backend).sort();
  assert.deepEqual(failedBackends, ["postgres", "qdrant"]);
});

test("error message preserved in failures entry", async () => {
  const pg = {
    async updateLifecycleState() {
      throw new Error("connection timeout after 5000ms");
    }
  };
  const svc    = createLifecycleSyncService({ postgresStore: pg });
  const result = await svc.syncLifecycleState(staleMemory());

  assert.equal(result.failures[0].error, "connection timeout after 5000ms");
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROCESSUSERMEMORIES WITH SYNC
// ═══════════════════════════════════════════════════════════════════════════════

test("syncService called for each transitioned memory", async () => {
  const syncCalls = [];
  const syncService = {
    async syncLifecycleState(memory) {
      syncCalls.push(memory.id);
      return { success: true, results: { postgres: "ok", qdrant: "ok", neo4j: "ok" }, failures: [] };
    }
  };

  // Two stale memories that should both transition
  const m1 = mem({ id: "proc-s1", ageMs: 60 * DAY_MS, importance: 0.2 });
  const m2 = mem({ id: "proc-s2", ageMs: 60 * DAY_MS, importance: 0.2 });
  const mockRouter = {
    async searchUserMemories() { return [m1, m2]; },
    async updateMemory(id, patch) { return patch; }
  };

  const result = await processUserMemories("user-sync-1", mockRouter, TEST_CONFIG, syncService);

  assert.ok(result.transitions.length >= 2, "Both memories should transition");
  assert.equal(syncCalls.length, result.transitions.length,
    "syncService called once per transition");
});

test("syncFailures returned in result object when a backend fails", async () => {
  const syncService = {
    async syncLifecycleState(memory) {
      return {
        success: false,
        results: { postgres: "failed", qdrant: "ok", neo4j: "ok" },
        failures: [{ backend: "postgres", error: "timeout" }]
      };
    }
  };

  const m = mem({ id: "proc-sf1", ageMs: 60 * DAY_MS, importance: 0.2 });
  const mockRouter = {
    async searchUserMemories() { return [m]; },
    async updateMemory(id, patch) { return patch; }
  };

  const result = await processUserMemories("user-sync-2", mockRouter, TEST_CONFIG, syncService);

  assert.ok(result.syncFailures.length >= 1, "syncFailures should be populated");
  assert.equal(result.syncFailures[0].backend, "postgres");
  assert.equal(result.syncFailures[0].error,   "timeout");
  assert.equal(result.syncFailures[0].id,       m.id);
});

test("tier repository updated even when sync backend fails", async () => {
  const tierUpdates = [];
  const syncService = {
    async syncLifecycleState() {
      return {
        success:  false,
        results:  { postgres: "failed", qdrant: "ok", neo4j: "ok" },
        failures: [{ backend: "postgres", error: "down" }]
      };
    }
  };

  const m = mem({ id: "proc-tier1", ageMs: 60 * DAY_MS, importance: 0.2 });
  const mockRouter = {
    async searchUserMemories() { return [m]; },
    async updateMemory(id, patch) { tierUpdates.push({ id, patch }); return patch; }
  };

  const result = await processUserMemories("user-sync-3", mockRouter, TEST_CONFIG, syncService);

  // Tier store was updated despite sync failure
  assert.ok(tierUpdates.length >= 1, "Tier repository must still be updated");
  assert.ok(result.transitions.length >= 1, "Transition must still be recorded");
});

test("sync backend failure does not abort sweep of remaining memories", async () => {
  let callCount = 0;
  const syncService = {
    async syncLifecycleState() {
      callCount++;
      // Always fail the sync
      return {
        success:  false,
        results:  { postgres: "failed", qdrant: "failed", neo4j: "failed" },
        failures: [
          { backend: "postgres", error: "down" },
          { backend: "qdrant", error: "down" },
          { backend: "neo4j", error: "down" }
        ]
      };
    }
  };

  // Three memories that should all transition
  const memories = [
    mem({ id: "abort-1", ageMs: 60 * DAY_MS, importance: 0.2 }),
    mem({ id: "abort-2", ageMs: 60 * DAY_MS, importance: 0.2 }),
    mem({ id: "abort-3", ageMs: 60 * DAY_MS, importance: 0.2 })
  ];

  const mockRouter = {
    async searchUserMemories() { return memories; },
    async updateMemory(id, patch) { return patch; }
  };

  const result = await processUserMemories("user-sync-4", mockRouter, TEST_CONFIG, syncService);

  // All three should have been processed, not aborted after first failure
  assert.equal(result.evaluated, 3);
  assert.equal(result.errors.length, 0, "sync failures should not populate errors array");
  assert.ok(result.transitions.length === 3, "all three memories transitioned");
  assert.equal(callCount, 3, "sync called for each transition");
});

test("result includes syncFailures array (empty when no failures)", async () => {
  const syncService = {
    async syncLifecycleState() {
      return { success: true, results: { postgres: "ok", qdrant: "ok", neo4j: "ok" }, failures: [] };
    }
  };

  const m = mem({ id: "empty-sf", ageMs: 60 * DAY_MS, importance: 0.2 });
  const mockRouter = {
    async searchUserMemories() { return [m]; },
    async updateMemory(id, patch) { return patch; }
  };

  const result = await processUserMemories("user-sync-5", mockRouter, TEST_CONFIG, syncService);

  assert.ok(Array.isArray(result.syncFailures), "syncFailures must be an array");
  assert.equal(result.syncFailures.length, 0, "no sync failures expected");
});

test("no syncService param → NOOP used, result.syncFailures is empty array", async () => {
  const m = mem({ id: "noop-1", ageMs: 60 * DAY_MS, importance: 0.2 });
  const mockRouter = {
    async searchUserMemories() { return [m]; },
    async updateMemory(id, patch) { return patch; }
  };

  // No syncService passed → should default to NOOP
  const result = await processUserMemories("user-sync-6", mockRouter, TEST_CONFIG);

  assert.ok(Array.isArray(result.syncFailures), "syncFailures must be present");
  assert.equal(result.syncFailures.length, 0);
});

test("sync not called for memories with no state change", async () => {
  const syncCalls = [];
  const syncService = {
    async syncLifecycleState(memory) {
      syncCalls.push(memory.id);
      return { success: true, results: { postgres: "ok", qdrant: "ok", neo4j: "ok" }, failures: [] };
    }
  };

  // A fresh, important memory that should NOT transition
  const fresh = mem({ id: "no-change-1", ageMs: 0, importance: 0.9 });
  const mockRouter = {
    async searchUserMemories() { return [fresh]; },
    async updateMemory(id, patch) { return patch; }
  };

  const result = await processUserMemories("user-sync-7", mockRouter, TEST_CONFIG, syncService);

  assert.equal(result.transitions.length, 0, "No transitions expected");
  assert.equal(syncCalls.length, 0, "syncService should not be called when nothing changed");
});

test("sync receives fully stamped updated memory with correct metadata", async () => {
  let capturedMemory = null;
  const syncService = {
    async syncLifecycleState(memory) {
      capturedMemory = memory;
      return { success: true, results: { postgres: "ok", qdrant: "ok", neo4j: "ok" }, failures: [] };
    }
  };

  const original = mem({ id: "stamp-1", ageMs: 60 * DAY_MS, importance: 0.2 });
  const mockRouter = {
    async searchUserMemories() { return [original]; },
    async updateMemory(id, patch) { return patch; }
  };

  await processUserMemories("user-sync-8", mockRouter, TEST_CONFIG, syncService);

  assert.ok(capturedMemory !== null, "sync should have been called");
  // The memory passed to sync must have the new lifecycleState stamped in
  assert.ok(
    capturedMemory.metadata.lifecycleState === LifecycleState.STALE ||
    capturedMemory.metadata.lifecycleState === LifecycleState.CONFLICTED ||
    capturedMemory.metadata.lifecycleState === LifecycleState.ARCHIVED,
    `Memory should be in a non-ACTIVE state, got: ${capturedMemory.metadata.lifecycleState}`
  );
  // updatedAt must be present (stamped by withLifecycleState)
  assert.ok(capturedMemory.metadata.updatedAt, "updatedAt must be stamped");
});
