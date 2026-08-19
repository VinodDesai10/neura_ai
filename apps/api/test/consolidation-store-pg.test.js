/**
 * apps/api/test/consolidation-store-pg.test.js
 *
 * Tests for the PostgreSQL-backed ConsolidationStore (C-2).
 *
 * ─── What is tested ───────────────────────────────────────────────────────────
 *
 *   The tests exercise two layers:
 *
 *   1. pgConsolidationDriver (in-memory fallback path)
 *      All tests run against the driver's in-memory Map fallback because no
 *      real Postgres connection is available in CI / local test runs.
 *      The fallback is activated by calling `driver._clear()` before each test
 *      which resets _tableReady so the driver re-checks Postgres — and because
 *      POSTGRES_URL is not set in the test environment it stays in fallback.
 *
 *   2. createConsolidationStore(pgConsolidationDriver)
 *      The factory wraps the driver, adding the API boundary (save throws on
 *      missing id, findByTopic / findByStatus delegate correctly).
 *
 * ─── Coverage ─────────────────────────────────────────────────────────────────
 *
 *  PG DRIVER — basic CRUD (11 tests)
 *   1.  driver.save — persists a record
 *   2.  driver.save — returns the saved record
 *   3.  driver.get  — retrieves by id
 *   4.  driver.get  — returns null for unknown id
 *   5.  driver.update — patches existing record
 *   6.  driver.update — returns null for unknown id
 *   7.  driver.remove — returns true when found
 *   8.  driver.remove — returns false when not found
 *   9.  driver.remove — record no longer retrievable after remove
 *  10.  driver.save (conflict / idempotent) — second save with same id overwrites
 *  11.  driver.save — preserves all ConsolidatedMemory fields exactly
 *
 *  PG DRIVER — lookup methods (8 tests)
 *  12.  driver.findByUserId — returns all records for the user
 *  13.  driver.findByUserId — excludes records for other users
 *  14.  driver.findByUserId — returns [] for unknown user
 *  15.  driver.findBySourceMemoryId — finds record containing the sourceId
 *  16.  driver.findBySourceMemoryId — excludes records not containing the id
 *  17.  driver.findBySourceMemoryId — returns [] when no match
 *  18.  driver.findByTopic — filters by topic for a user
 *  19.  driver.findByStatus — filters by status for a user
 *
 *  PG DRIVER — sourceMemoryIds / version preservation (4 tests)
 *  20.  sourceMemoryIds are stored and retrieved exactly
 *  21.  sourceMemoryIds order is preserved
 *  22.  version field is preserved through save/get round-trip
 *  23.  version field is preserved through update
 *
 *  PG DRIVER — conflictMeta preservation (2 tests)
 *  24.  conflictMeta is stored and retrieved when present
 *  25.  conflictMeta is null when not set
 *
 *  PG DRIVER — restart / reinitialization (3 tests)
 *  26.  records survive driver._clear() + re-save (simulates restart in fallback)
 *  27.  driver._clear() resets isolation (new instance starts empty)
 *  28.  two independent driver instances share no state
 *
 *  STORE FACTORY (API boundary) (8 tests)
 *  29.  createConsolidationStore(driver) — save and get round-trip
 *  30.  createConsolidationStore(driver) — update patches record
 *  31.  createConsolidationStore(driver) — remove returns true/false
 *  32.  createConsolidationStore(driver) — findByUserId correct isolation
 *  33.  createConsolidationStore(driver) — findBySourceMemoryId
 *  34.  createConsolidationStore(driver) — findByTopic
 *  35.  createConsolidationStore(driver) — findByStatus
 *  36.  createConsolidationStore(driver) — save throws on missing id
 *
 *  IN-MEMORY DRIVER FALLBACK BEHAVIOR (4 tests)
 *  37.  in-memory driver: save+get round-trip (createInMemoryDriver from core)
 *  38.  in-memory driver: update + remove
 *  39.  in-memory driver: two independent instances share no state
 *  40.  in-memory driver: empty store returns [] and null correctly
 *
 *  CONSOLIDATION-STORE SINGLETON (1 test)
 *  41.  API-layer consolidation-store.js exports a store with the correct API
 *
 * Test runner: Node 22 built-in (node --test)
 * Import style: ESM
 * No real Postgres connection needed — all tests use in-memory fallback.
 */

import assert from "node:assert/strict";
import test   from "node:test";

// ─── Subjects ─────────────────────────────────────────────────────────────────

// The PG driver itself (we test its in-memory fallback path)
import { pgConsolidationDriver } from "../src/infrastructure/postgres/pg-consolidation-driver.js";

// Core factory + in-memory driver for comparison / isolation tests
import {
  createConsolidationStore,
  createInMemoryDriver
} from "@neura/core";

// The API-layer singleton (just check its shape)
import { consolidationStore as apiConsolidationStore } from "../src/infrastructure/consolidation-store.js";

// Postgres client — used for per-test table truncation when PG is available
import {
  ensurePostgresReady,
  getPostgresClient
} from "../src/infrastructure/postgres/postgres-client.js";

// ─── Per-test cleanup helper ──────────────────────────────────────────────────

/**
 * Reset the store before each test.
 *
 * - Always clears the in-memory fallback Map and bootstrap flags.
 * - When POSTGRES_URL is configured, truncates the consolidated_memories table
 *   so records from previous tests do not leak into the current one.
 *
 * Called explicitly at the top of every test that needs isolation because
 * Node's built-in test runner has no beforeEach lifecycle hook.
 */
async function resetStore() {
  pgConsolidationDriver._clear();

  const pgReady = await ensurePostgresReady();
  if (pgReady) {
    const sql = getPostgresClient();
    try {
      await sql`truncate table consolidated_memories`;
    } catch {
      // Table may not exist on the very first run — ensureConsolidationTableReady
      // will create it; subsequent truncates will succeed.
    }
  }
}



function makeRecord(overrides = {}) {
  const now = new Date().toISOString();
  const id  = overrides.id ?? `con-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    userId:          overrides.userId          ?? "user-test-1",
    topic:           overrides.topic           ?? "location",
    summary:         overrides.summary         ?? "User lives in Mumbai, India",
    sourceMemoryIds: overrides.sourceMemoryIds ?? ["mem-1", "mem-2"],
    confidence:      overrides.confidence      ?? 0.82,
    importanceScore: overrides.importanceScore ?? 0.75,
    createdAt:       overrides.createdAt       ?? now,
    updatedAt:       overrides.updatedAt       ?? now,
    version:         overrides.version         ?? 1,
    status:          overrides.status          ?? "active",
    conflictMeta:    overrides.conflictMeta    ?? null,
    memoryType:      overrides.memoryType      ?? "factual",
    tags:            overrides.tags            ?? ["location", "identity"],
    domain:          overrides.domain          ?? "identity",
    ...overrides
  };
}

// ─── Shared beforeEach-equivalent: clear the driver before each test ──────────
//
// Node's built-in test runner doesn't have beforeEach, so each test that needs
// isolation calls driver._clear() itself.

// ═══════════════════════════════════════════════════════════════════════════════
// PG DRIVER — basic CRUD
// ═══════════════════════════════════════════════════════════════════════════════

test("1. driver.save — persists a record", async () => {
  await resetStore();
  const rec = makeRecord({ id: "d-save-1" });
  await pgConsolidationDriver.save(rec);
  const fetched = await pgConsolidationDriver.get("d-save-1");
  assert.ok(fetched, "record should be retrievable after save");
  assert.equal(fetched.id, "d-save-1");
});

test("2. driver.save — returns the saved record", async () => {
  await resetStore();
  const rec    = makeRecord({ id: "d-save-2", summary: "Test summary" });
  const result = await pgConsolidationDriver.save(rec);
  assert.ok(result, "save should return the saved record");
  assert.equal(result.id, "d-save-2");
  assert.equal(result.summary, "Test summary");
});

test("3. driver.get — retrieves by id", async () => {
  await resetStore();
  const rec = makeRecord({ id: "d-get-1", topic: "employment" });
  await pgConsolidationDriver.save(rec);
  const fetched = await pgConsolidationDriver.get("d-get-1");
  assert.equal(fetched.topic, "employment");
});

test("4. driver.get — returns null for unknown id", async () => {
  await resetStore();
  const result = await pgConsolidationDriver.get("does-not-exist");
  assert.equal(result, null);
});

test("5. driver.update — patches existing record", async () => {
  await resetStore();
  const rec = makeRecord({ id: "d-upd-1", summary: "original" });
  await pgConsolidationDriver.save(rec);
  await pgConsolidationDriver.update("d-upd-1", { summary: "patched" });
  const fetched = await pgConsolidationDriver.get("d-upd-1");
  assert.equal(fetched.summary, "patched");
  assert.equal(fetched.id, "d-upd-1");
});

test("6. driver.update — returns null for unknown id", async () => {
  await resetStore();
  const result = await pgConsolidationDriver.update("unknown-id", { summary: "x" });
  assert.equal(result, null);
});

test("7. driver.remove — returns true when found", async () => {
  await resetStore();
  const rec = makeRecord({ id: "d-rm-1" });
  await pgConsolidationDriver.save(rec);
  const removed = await pgConsolidationDriver.remove("d-rm-1");
  assert.ok(removed, "remove should return true for existing record");
});

test("8. driver.remove — returns false when not found", async () => {
  await resetStore();
  const removed = await pgConsolidationDriver.remove("no-such-id");
  assert.equal(removed, false);
});

test("9. driver.remove — record no longer retrievable after remove", async () => {
  await resetStore();
  const rec = makeRecord({ id: "d-rm-2" });
  await pgConsolidationDriver.save(rec);
  await pgConsolidationDriver.remove("d-rm-2");
  const fetched = await pgConsolidationDriver.get("d-rm-2");
  assert.equal(fetched, null);
});

test("10. driver.save (idempotent) — second save with same id overwrites", async () => {
  await resetStore();
  const rec1 = makeRecord({ id: "d-idem-1", summary: "first", version: 1 });
  const rec2 = makeRecord({ id: "d-idem-1", summary: "second", version: 2 });
  await pgConsolidationDriver.save(rec1);
  await pgConsolidationDriver.save(rec2);
  const fetched = await pgConsolidationDriver.get("d-idem-1");
  assert.equal(fetched.summary, "second", "second save should overwrite");
  assert.equal(fetched.version, 2);
});

test("11. driver.save — preserves all ConsolidatedMemory fields exactly", async () => {
  await resetStore();
  const rec = makeRecord({
    id:              "d-fields-1",
    userId:          "user-fields",
    topic:           "employment",
    summary:         "User is a software engineer",
    sourceMemoryIds: ["src-A", "src-B", "src-C"],
    confidence:      0.91,
    importanceScore: 0.88,
    createdAt:       "2024-03-01T12:00:00.000Z",
    updatedAt:       "2024-03-02T08:30:00.000Z",
    version:         3,
    status:          "active",
    conflictMeta:    null,
    memoryType:      "factual",
    tags:            ["work", "career"],
    domain:          "employment"
  });

  const saved   = await pgConsolidationDriver.save(rec);
  const fetched = await pgConsolidationDriver.get("d-fields-1");

  assert.equal(fetched.id,              "d-fields-1");
  assert.equal(fetched.userId,          "user-fields");
  assert.equal(fetched.topic,           "employment");
  assert.equal(fetched.summary,         "User is a software engineer");
  assert.deepEqual(fetched.sourceMemoryIds, ["src-A", "src-B", "src-C"]);
  assert.ok(Math.abs(fetched.confidence - 0.91) < 1e-9, "confidence should be preserved");
  assert.ok(Math.abs(fetched.importanceScore - 0.88) < 1e-9, "importanceScore should be preserved");
  assert.equal(fetched.version,         3);
  assert.equal(fetched.status,          "active");
  assert.equal(fetched.conflictMeta,    null);
  assert.equal(fetched.memoryType,      "factual");
  assert.deepEqual(fetched.tags,        ["work", "career"]);
  assert.equal(fetched.domain,          "employment");
  // Return value from save() should also carry all fields
  assert.equal(saved.id, "d-fields-1");
  assert.equal(saved.version, 3);
});

// ═══════════════════════════════════════════════════════════════════════════════
// PG DRIVER — lookup methods
// ═══════════════════════════════════════════════════════════════════════════════

test("12. driver.findByUserId — returns all records for the user", async () => {
  await resetStore();
  await pgConsolidationDriver.save(makeRecord({ id: "u-1a", userId: "user-A" }));
  await pgConsolidationDriver.save(makeRecord({ id: "u-1b", userId: "user-A" }));
  await pgConsolidationDriver.save(makeRecord({ id: "u-1c", userId: "user-B" }));

  const results = await pgConsolidationDriver.findByUserId("user-A");
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.userId === "user-A"), "all results should belong to user-A");
});

test("13. driver.findByUserId — excludes records for other users", async () => {
  await resetStore();
  await pgConsolidationDriver.save(makeRecord({ id: "u-2a", userId: "user-X" }));
  await pgConsolidationDriver.save(makeRecord({ id: "u-2b", userId: "user-Y" }));

  const results = await pgConsolidationDriver.findByUserId("user-X");
  assert.equal(results.length, 1);
  assert.equal(results[0].userId, "user-X");
});

test("14. driver.findByUserId — returns [] for unknown user", async () => {
  await resetStore();
  const results = await pgConsolidationDriver.findByUserId("ghost-user");
  assert.equal(results.length, 0);
});

test("15. driver.findBySourceMemoryId — finds record containing the sourceId", async () => {
  await resetStore();
  const rec = makeRecord({ id: "src-1", sourceMemoryIds: ["mem-alpha", "mem-beta"] });
  await pgConsolidationDriver.save(rec);

  const results = await pgConsolidationDriver.findBySourceMemoryId("mem-alpha");
  assert.equal(results.length, 1);
  assert.equal(results[0].id, "src-1");
});

test("16. driver.findBySourceMemoryId — excludes records not containing the id", async () => {
  await resetStore();
  await pgConsolidationDriver.save(makeRecord({ id: "src-2a", sourceMemoryIds: ["mem-X"] }));
  await pgConsolidationDriver.save(makeRecord({ id: "src-2b", sourceMemoryIds: ["mem-Y"] }));

  const results = await pgConsolidationDriver.findBySourceMemoryId("mem-X");
  assert.equal(results.length, 1);
  assert.equal(results[0].id, "src-2a");
});

test("17. driver.findBySourceMemoryId — returns [] when no match", async () => {
  await resetStore();
  await pgConsolidationDriver.save(makeRecord({ id: "src-3", sourceMemoryIds: ["mem-A"] }));

  const results = await pgConsolidationDriver.findBySourceMemoryId("mem-nobody");
  assert.equal(results.length, 0);
});

test("18. driver.findByTopic — filters by topic for a user", async () => {
  await resetStore();
  await pgConsolidationDriver.save(makeRecord({ id: "tp-1", userId: "u1", topic: "location" }));
  await pgConsolidationDriver.save(makeRecord({ id: "tp-2", userId: "u1", topic: "employment" }));
  await pgConsolidationDriver.save(makeRecord({ id: "tp-3", userId: "u2", topic: "location" }));

  const results = await pgConsolidationDriver.findByTopic("u1", "location");
  assert.equal(results.length, 1);
  assert.equal(results[0].id, "tp-1");
  assert.equal(results[0].topic, "location");
});

test("19. driver.findByStatus — filters by status for a user", async () => {
  await resetStore();
  await pgConsolidationDriver.save(makeRecord({ id: "st-1", userId: "u1", status: "active" }));
  await pgConsolidationDriver.save(makeRecord({ id: "st-2", userId: "u1", status: "conflicted" }));
  await pgConsolidationDriver.save(makeRecord({ id: "st-3", userId: "u2", status: "active" }));

  const active = await pgConsolidationDriver.findByStatus("u1", "active");
  assert.equal(active.length, 1);
  assert.equal(active[0].id, "st-1");
  assert.equal(active[0].status, "active");
});

// ═══════════════════════════════════════════════════════════════════════════════
// PG DRIVER — sourceMemoryIds / version preservation
// ═══════════════════════════════════════════════════════════════════════════════

test("20. sourceMemoryIds are stored and retrieved exactly", async () => {
  await resetStore();
  const ids = ["mem-provenance-A", "mem-provenance-B", "mem-provenance-C"];
  const rec = makeRecord({ id: "prov-1", sourceMemoryIds: ids });
  await pgConsolidationDriver.save(rec);
  const fetched = await pgConsolidationDriver.get("prov-1");
  assert.deepEqual(fetched.sourceMemoryIds, ids);
});

test("21. sourceMemoryIds order is preserved", async () => {
  await resetStore();
  // Intentionally non-alphabetical to verify no silent sorting
  const ids = ["zzz-last", "aaa-first", "mmm-middle"];
  const rec = makeRecord({ id: "prov-order-1", sourceMemoryIds: ids });
  await pgConsolidationDriver.save(rec);
  const fetched = await pgConsolidationDriver.get("prov-order-1");
  assert.deepEqual(fetched.sourceMemoryIds, ids,
    "sourceMemoryIds order must be preserved exactly");
});

test("22. version field is preserved through save/get round-trip", async () => {
  await resetStore();
  const rec = makeRecord({ id: "ver-1", version: 7 });
  await pgConsolidationDriver.save(rec);
  const fetched = await pgConsolidationDriver.get("ver-1");
  assert.equal(fetched.version, 7);
});

test("23. version field is preserved through update", async () => {
  await resetStore();
  const rec = makeRecord({ id: "ver-upd-1", version: 2 });
  await pgConsolidationDriver.save(rec);
  // Update increments version as part of the patch
  await pgConsolidationDriver.update("ver-upd-1", { version: 3, summary: "updated v3" });
  const fetched = await pgConsolidationDriver.get("ver-upd-1");
  assert.equal(fetched.version, 3, "updated version should be 3");
  assert.equal(fetched.summary, "updated v3");
  // Original sourceMemoryIds must not be lost
  assert.ok(Array.isArray(fetched.sourceMemoryIds), "sourceMemoryIds should still be present");
});

// ═══════════════════════════════════════════════════════════════════════════════
// PG DRIVER — conflictMeta preservation
// ═══════════════════════════════════════════════════════════════════════════════

test("24. conflictMeta is stored and retrieved when present", async () => {
  await resetStore();
  const conflictMeta = {
    conflicts: [
      {
        memoryIdA:  "mem-A",
        memoryIdB:  "mem-B",
        similarity: 0.55,
        severity:   "medium",
        reason:     "Contradictory location claims"
      }
    ],
    conflictingIds: ["mem-A", "mem-B"],
    severity:       "medium",
    resolvedWith:   "mem-A",
    detectedAt:     new Date().toISOString(),
    reason:         "Contradictory claims about user location"
  };

  const rec = makeRecord({ id: "cf-1", conflictMeta, status: "conflicted" });
  await pgConsolidationDriver.save(rec);
  const fetched = await pgConsolidationDriver.get("cf-1");

  assert.ok(fetched.conflictMeta, "conflictMeta should be present");
  assert.equal(fetched.conflictMeta.severity, "medium");
  assert.equal(fetched.conflictMeta.resolvedWith, "mem-A");
  assert.equal(fetched.conflictMeta.conflicts.length, 1);
  assert.equal(fetched.conflictMeta.conflicts[0].severity, "medium");
});

test("25. conflictMeta is null when not set", async () => {
  await resetStore();
  const rec = makeRecord({ id: "cf-null-1", conflictMeta: null, status: "active" });
  await pgConsolidationDriver.save(rec);
  const fetched = await pgConsolidationDriver.get("cf-null-1");
  assert.equal(fetched.conflictMeta, null);
});

// ═══════════════════════════════════════════════════════════════════════════════
// PG DRIVER — restart / reinitialization
// ═══════════════════════════════════════════════════════════════════════════════

test("26. records survive driver._clear() + re-save (restart simulation)", async () => {
  // This simulates what happens on a real restart: the driver's fallback Map
  // is reset (_clear), and the data must be re-persisted (in real Postgres it
  // would still exist; the fallback re-populates on re-save as expected).
  await resetStore();

  const rec = makeRecord({
    id:              "restart-1",
    userId:          "user-restart",
    sourceMemoryIds: ["src-persist-1", "src-persist-2"],
    version:         5,
    status:          "active"
  });
  await pgConsolidationDriver.save(rec);

  // Simulate restart by clearing the driver's state
  await resetStore();

  // Re-save with identical data (as Postgres would hydrate on startup)
  await pgConsolidationDriver.save(rec);

  const fetched = await pgConsolidationDriver.get("restart-1");
  assert.ok(fetched, "record should be retrievable after re-init");
  assert.deepEqual(fetched.sourceMemoryIds, ["src-persist-1", "src-persist-2"],
    "sourceMemoryIds must be identical after restart");
  assert.equal(fetched.version, 5, "version must be preserved after restart");
});

test("27. driver._clear() resets isolation (new instance starts empty)", async () => {
  await resetStore();
  await pgConsolidationDriver.save(makeRecord({ id: "isolation-pre-clear" }));
  await resetStore();
  const result = await pgConsolidationDriver.get("isolation-pre-clear");
  assert.equal(result, null, "cleared driver should not return previously saved records");
});

test("28. two independent createInMemoryDriver instances share no state", async () => {
  // Tests that the pattern of creating isolated stores works as expected
  const d1 = createInMemoryDriver();
  const d2 = createInMemoryDriver();

  await d1.save(makeRecord({ id: "iso-d1-1" }));
  const fromD2 = await d2.get("iso-d1-1");
  assert.equal(fromD2, null, "d2 must not see d1's records");
});

// ═══════════════════════════════════════════════════════════════════════════════
// STORE FACTORY (API boundary)
// ═══════════════════════════════════════════════════════════════════════════════

test("29. createConsolidationStore(driver) — save and get round-trip", async () => {
  await resetStore();
  const store = createConsolidationStore(pgConsolidationDriver);
  const rec = makeRecord({ id: "store-rt-1", userId: "u-store-1" });
  await store.save(rec);
  const fetched = await store.get("store-rt-1");
  assert.equal(fetched.id, "store-rt-1");
  assert.equal(fetched.userId, "u-store-1");
});

test("30. createConsolidationStore(driver) — update patches record", async () => {
  await resetStore();
  const store = createConsolidationStore(pgConsolidationDriver);
  const rec = makeRecord({ id: "store-upd-1", summary: "before" });
  await store.save(rec);
  await store.update("store-upd-1", { summary: "after" });
  const fetched = await store.get("store-upd-1");
  assert.equal(fetched.summary, "after");
  assert.equal(fetched.id, "store-upd-1");
});

test("31. createConsolidationStore(driver) — remove returns true/false", async () => {
  await resetStore();
  const store = createConsolidationStore(pgConsolidationDriver);
  const rec = makeRecord({ id: "store-rm-1" });
  await store.save(rec);

  const removed = await store.remove("store-rm-1");
  assert.ok(removed, "remove should return true for existing record");

  const missing = await store.remove("store-rm-1");
  assert.equal(missing, false, "second remove should return false");

  const fetched = await store.get("store-rm-1");
  assert.equal(fetched, null, "removed record should not be retrievable");
});

test("32. createConsolidationStore(driver) — findByUserId correct isolation", async () => {
  await resetStore();
  const store = createConsolidationStore(pgConsolidationDriver);

  await store.save(makeRecord({ id: "fu-1", userId: "user-A" }));
  await store.save(makeRecord({ id: "fu-2", userId: "user-A" }));
  await store.save(makeRecord({ id: "fu-3", userId: "user-B" }));

  const forA = await store.findByUserId("user-A");
  assert.equal(forA.length, 2);
  assert.ok(forA.every((r) => r.userId === "user-A"));

  const forB = await store.findByUserId("user-B");
  assert.equal(forB.length, 1);
  assert.equal(forB[0].userId, "user-B");
});

test("33. createConsolidationStore(driver) — findBySourceMemoryId", async () => {
  await resetStore();
  const store = createConsolidationStore(pgConsolidationDriver);

  await store.save(makeRecord({ id: "fsm-1", sourceMemoryIds: ["src-X", "src-Y"] }));
  await store.save(makeRecord({ id: "fsm-2", sourceMemoryIds: ["src-Z"] }));

  const results = await store.findBySourceMemoryId("src-X");
  assert.equal(results.length, 1);
  assert.equal(results[0].id, "fsm-1");

  const empty = await store.findBySourceMemoryId("src-nobody");
  assert.equal(empty.length, 0);
});

test("34. createConsolidationStore(driver) — findByTopic", async () => {
  await resetStore();
  const store = createConsolidationStore(pgConsolidationDriver);

  await store.save(makeRecord({ id: "ftp-1", userId: "u1", topic: "location" }));
  await store.save(makeRecord({ id: "ftp-2", userId: "u1", topic: "employment" }));

  const loc = await store.findByTopic("u1", "location");
  assert.equal(loc.length, 1);
  assert.equal(loc[0].topic, "location");

  const emp = await store.findByTopic("u1", "employment");
  assert.equal(emp.length, 1);
  assert.equal(emp[0].topic, "employment");

  const none = await store.findByTopic("u1", "nonexistent-topic");
  assert.equal(none.length, 0);
});

test("35. createConsolidationStore(driver) — findByStatus", async () => {
  await resetStore();
  const store = createConsolidationStore(pgConsolidationDriver);

  await store.save(makeRecord({ id: "fst-1", userId: "u1", status: "active" }));
  await store.save(makeRecord({ id: "fst-2", userId: "u1", status: "stale" }));
  await store.save(makeRecord({ id: "fst-3", userId: "u1", status: "conflicted" }));

  const active = await store.findByStatus("u1", "active");
  assert.equal(active.length, 1);
  assert.equal(active[0].status, "active");

  const stale = await store.findByStatus("u1", "stale");
  assert.equal(stale.length, 1);
  assert.equal(stale[0].status, "stale");
});

test("36. createConsolidationStore(driver) — save throws on missing id", async () => {
  await resetStore();
  const store = createConsolidationStore(pgConsolidationDriver);

  await assert.rejects(
    () => store.save({ userId: "u1", topic: "location" }),
    /id is required/i
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// IN-MEMORY DRIVER FALLBACK BEHAVIOR
// (verifies the fallback the PG driver delegates to when Postgres is absent)
// ═══════════════════════════════════════════════════════════════════════════════

test("37. in-memory driver: save+get round-trip (createInMemoryDriver from core)", async () => {
  const d = createInMemoryDriver();
  const rec = makeRecord({ id: "im-1", summary: "in-memory test" });
  await d.save(rec);
  const fetched = await d.get("im-1");
  assert.equal(fetched.id, "im-1");
  assert.equal(fetched.summary, "in-memory test");
});

test("38. in-memory driver: update + remove", async () => {
  const d = createInMemoryDriver();
  const rec = makeRecord({ id: "im-upd-1", summary: "before" });
  await d.save(rec);

  await d.update("im-upd-1", { summary: "after" });
  const fetched = await d.get("im-upd-1");
  assert.equal(fetched.summary, "after");

  const removed = await d.remove("im-upd-1");
  assert.ok(removed);

  const gone = await d.get("im-upd-1");
  assert.equal(gone, null);
});

test("39. in-memory driver: two independent instances share no state", async () => {
  const d1 = createInMemoryDriver();
  const d2 = createInMemoryDriver();

  await d1.save(makeRecord({ id: "im-iso-1" }));

  // d2 was created before d1 had any data — it must be empty
  const fromD2 = await d2.get("im-iso-1");
  assert.equal(fromD2, null, "d2 must not see d1's records");

  assert.equal(d2._size(), 0, "d2 size must be 0");
  assert.equal(d1._size(), 1, "d1 size must be 1");
});

test("40. in-memory driver: empty store returns [] and null correctly", async () => {
  const d = createInMemoryDriver();

  const noRecord    = await d.get("does-not-exist");
  const emptyUser   = await d.findByUserId("ghost");
  const emptySource = await d.findBySourceMemoryId("no-src");
  const emptyTopic  = await d.findByTopic("ghost", "location");
  const emptyStatus = await d.findByStatus("ghost", "active");

  assert.equal(noRecord,    null);
  assert.deepEqual(emptyUser,   []);
  assert.deepEqual(emptySource, []);
  assert.deepEqual(emptyTopic,  []);
  assert.deepEqual(emptyStatus, []);
});

// ═══════════════════════════════════════════════════════════════════════════════
// CONSOLIDATION-STORE SINGLETON
// ═══════════════════════════════════════════════════════════════════════════════

test("41. API-layer consolidation-store.js exports a store with the correct API", () => {
  // Verify the singleton has all the required store methods
  const requiredMethods = [
    "save", "get", "update", "remove",
    "findByUserId", "findBySourceMemoryId", "findByTopic", "findByStatus"
  ];

  for (const method of requiredMethods) {
    assert.equal(
      typeof apiConsolidationStore[method],
      "function",
      `consolidationStore.${method} should be a function`
    );
  }
});
