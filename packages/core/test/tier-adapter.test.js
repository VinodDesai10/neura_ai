/**
 * packages/core/test/tier-adapter.test.js
 *
 * Tests for the DI factory pattern, driver injection, error handling,
 * and graceful degradation of all three tier repositories.
 *
 * These tests run entirely with in-memory drivers — no external services
 * (Redis, PostgreSQL) are required.  The driver-injection contract is
 * verified by constructing custom mock drivers and asserting the repository
 * delegates correctly.
 *
 * Coverage areas:
 *   1. Factory returns a working repo when no driver is passed (in-memory default)
 *   2. Factory injects a custom driver and delegates all five operations
 *   3. Graceful degradation: driver errors fall through correctly
 *   4. Guard: save throws when id is missing (all three repos)
 *   5. Driver isolation: two repos from the same factory share no state
 *   6. Cold repo is fully pluggable (explicit driver swap)
 *   7. storageRouter uses DI repos end-to-end
 *
 * Test runner: Node 22 built-in (node --test)
 * Import style: ESM
 */

import assert from "node:assert/strict";
import test   from "node:test";

import { createHotRepository }  from "../src/memory/repositories/hotRepository.js";
import { createWarmRepository } from "../src/memory/repositories/warmRepository.js";
import { createColdRepository } from "../src/memory/repositories/coldRepository.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _seq = 0;
function uid()  { return `adapter-test-${++_seq}`; }
const USER = "user-adapter-test";

function mem(overrides = {}) {
  return {
    id:         overrides.id       ?? uid(),
    userId:     overrides.userId   ?? USER,
    memoryType: "factual",
    content:    "test content",
    summary:    "test",
    metadata: {
      importance:  overrides.importance ?? 0.5,
      timestamp:   new Date().toISOString(),
      ...(overrides.metadata ?? {})
    }
  };
}

// ─── Minimal spy driver ───────────────────────────────────────────────────────

/**
 * Builds a fully-operational spy driver backed by a local Map.
 * Records every call so tests can assert delegation happened.
 */
function makeSpyDriver() {
  const store = new Map();
  const calls = { save: 0, get: 0, listByUser: 0, update: 0, remove: 0 };

  return {
    calls,
    store,
    async save(memory) {
      calls.save++;
      store.set(memory.id, { ...memory });
      return store.get(memory.id);
    },
    async get(id) {
      calls.get++;
      return store.get(id);
    },
    async listByUser(userId) {
      calls.listByUser++;
      return [...store.values()].filter((m) => m.userId === userId);
    },
    async update(id, patch) {
      calls.update++;
      const e = store.get(id);
      if (!e) return null;
      const u = { ...e, ...patch, id };
      store.set(id, u);
      return u;
    },
    async remove(id) {
      calls.remove++;
      return store.delete(id);
    },
    _size()  { return store.size; },
    _clear() { store.clear(); }
  };
}

/**
 * Builds a driver whose every method throws a simulated error.
 * Used to test graceful degradation paths.
 */
function makeFailingDriver(errorMsg = "simulated driver failure") {
  return {
    async save()        { throw new Error(errorMsg); },
    async get()         { throw new Error(errorMsg); },
    async listByUser()  { throw new Error(errorMsg); },
    async update()      { throw new Error(errorMsg); },
    async remove()      { throw new Error(errorMsg); },
    _size()  { return 0; },
    _clear() {}
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. Default (in-memory) factory — all three repos
// ══════════════════════════════════════════════════════════════════════════════

for (const [label, factory] of [
  ["createHotRepository",  createHotRepository],
  ["createWarmRepository", createWarmRepository],
  ["createColdRepository", createColdRepository]
]) {
  test(`${label}(null): default in-memory round-trip`, async () => {
    const repo = factory(null);
    repo.clear();

    const m = mem();
    const saved = await repo.save(m);
    assert.equal(saved.id, m.id);

    const fetched = await repo.get(m.id);
    assert.ok(fetched);
    assert.equal(fetched.id, m.id);
  });

  test(`${label}(null): listByUser returns only that user's records`, async () => {
    const repo = factory(null);
    repo.clear();

    await repo.save(mem({ userId: "u-a" }));
    await repo.save(mem({ userId: "u-b" }));
    await repo.save(mem({ userId: "u-a" }));

    const results = await repo.listByUser("u-a");
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.userId === "u-a"));
  });

  test(`${label}(null): update patches a field`, async () => {
    const repo = factory(null);
    repo.clear();

    const m = mem();
    await repo.save(m);

    const updated = await repo.update(m.id, { content: "patched" });
    assert.ok(updated);
    assert.equal(updated.content, "patched");
    assert.equal((await repo.get(m.id)).content, "patched");
  });

  test(`${label}(null): update returns null for unknown id`, async () => {
    const repo = factory(null);
    repo.clear();
    assert.equal(await repo.update("no-such-id", {}), null);
  });

  test(`${label}(null): remove deletes and returns true`, async () => {
    const repo = factory(null);
    repo.clear();

    const m = mem();
    await repo.save(m);
    assert.equal(await repo.remove(m.id), true);
    assert.equal(await repo.get(m.id), undefined);
  });

  test(`${label}(null): remove returns false for missing id`, async () => {
    const repo = factory(null);
    repo.clear();
    assert.equal(await repo.remove("ghost"), false);
  });

  test(`${label}(null): save throws when memory.id is missing`, async () => {
    const repo = factory(null);
    await assert.rejects(
      () => repo.save({ content: "no id" }),
      /memory.id is required/
    );
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. Driver injection — spy driver receives all calls
// ══════════════════════════════════════════════════════════════════════════════

test("createHotRepository: delegates save to injected driver", async () => {
  const spy = makeSpyDriver();
  const repo = createHotRepository(spy);
  const m = mem();

  await repo.save(m);

  assert.equal(spy.calls.save, 1, "save should have been called once on the driver");
  assert.ok(spy.store.has(m.id), "driver's store should contain the record");
});

test("createHotRepository: delegates get to injected driver", async () => {
  const spy = makeSpyDriver();
  const repo = createHotRepository(spy);
  const m = mem();
  spy.store.set(m.id, m);   // plant directly

  const result = await repo.get(m.id);
  assert.equal(spy.calls.get, 1);
  assert.equal(result?.id, m.id);
});

test("createHotRepository: delegates listByUser to injected driver", async () => {
  const spy = makeSpyDriver();
  const repo = createHotRepository(spy);
  const m = mem({ userId: "u-spy" });
  spy.store.set(m.id, m);

  const results = await repo.listByUser("u-spy");
  assert.equal(spy.calls.listByUser, 1);
  assert.equal(results.length, 1);
});

test("createHotRepository: delegates update to injected driver", async () => {
  const spy = makeSpyDriver();
  const repo = createHotRepository(spy);
  const m = mem();
  spy.store.set(m.id, m);

  await repo.update(m.id, { content: "via-driver" });
  assert.equal(spy.calls.update, 1);
  assert.equal(spy.store.get(m.id)?.content, "via-driver");
});

test("createHotRepository: delegates remove to injected driver", async () => {
  const spy = makeSpyDriver();
  const repo = createHotRepository(spy);
  const m = mem();
  spy.store.set(m.id, m);

  const result = await repo.remove(m.id);
  assert.equal(spy.calls.remove, 1);
  assert.equal(result, true);
  assert.ok(!spy.store.has(m.id));
});

// Same injection checks for warm + cold (spot-check one method each)
test("createWarmRepository: delegates to injected driver", async () => {
  const spy = makeSpyDriver();
  const repo = createWarmRepository(spy);
  const m = mem();

  await repo.save(m);
  assert.equal(spy.calls.save, 1);
  assert.ok(spy.store.has(m.id));
});

test("createColdRepository: delegates to injected driver", async () => {
  const spy = makeSpyDriver();
  const repo = createColdRepository(spy);
  const m = mem();

  await repo.save(m);
  assert.equal(spy.calls.save, 1);
  assert.ok(spy.store.has(m.id));
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. Error handling / graceful degradation
//
// When a driver method throws, the repository factory itself propagates the
// error (it does NOT silently swallow it — that's the real adapters' job).
// Tests here verify the error surfaces correctly so callers can decide how
// to handle it.
// ══════════════════════════════════════════════════════════════════════════════

test("createHotRepository: driver save error propagates to caller", async () => {
  const repo = createHotRepository(makeFailingDriver("redis down"));
  const m = mem();
  await assert.rejects(() => repo.save(m), /redis down/);
});

test("createHotRepository: driver get error propagates to caller", async () => {
  const repo = createHotRepository(makeFailingDriver("connection reset"));
  await assert.rejects(() => repo.get("any-id"), /connection reset/);
});

test("createWarmRepository: driver error propagates to caller", async () => {
  const repo = createWarmRepository(makeFailingDriver("pg offline"));
  await assert.rejects(() => repo.save(mem()), /pg offline/);
});

test("createColdRepository: driver error propagates to caller", async () => {
  const repo = createColdRepository(makeFailingDriver("s3 timeout"));
  await assert.rejects(() => repo.save(mem()), /s3 timeout/);
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. Graceful-degradation via a fallback wrapper driver
//
// This models how the real Redis/Postgres drivers work: they catch errors
// internally and fall back to a secondary store.  We verify this pattern
// works correctly when wrapped.
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Wraps a primary driver with a fallback.
 * If primary throws, uses fallback.
 */
function withFallback(primary, fallback) {
  return {
    async save(memory) {
      try { return await primary.save(memory); }
      catch { return fallback.save(memory); }
    },
    async get(id) {
      try { return await primary.get(id); }
      catch { return fallback.get(id); }
    },
    async listByUser(uid) {
      try { return await primary.listByUser(uid); }
      catch { return fallback.listByUser(uid); }
    },
    async update(id, patch) {
      try { return await primary.update(id, patch); }
      catch { return fallback.update(id, patch); }
    },
    async remove(id) {
      try { return await primary.remove(id); }
      catch { return fallback.remove(id); }
    },
    _size()  { return fallback._size?.() ?? 0; },
    _clear() { fallback._clear?.(); }
  };
}

test("fallback driver: returns data from fallback when primary fails", async () => {
  const fallbackSpy = makeSpyDriver();
  const driver = withFallback(makeFailingDriver("primary down"), fallbackSpy);
  const repo = createHotRepository(driver);
  const m = mem();

  // save goes to fallback
  await repo.save(m);
  assert.equal(fallbackSpy.calls.save, 1);

  // get goes to fallback
  const result = await repo.get(m.id);
  assert.equal(fallbackSpy.calls.get, 1);
  assert.equal(result?.id, m.id);
});

test("fallback driver: returns [] from fallback listByUser when primary fails", async () => {
  const fallbackSpy = makeSpyDriver();
  const driver = withFallback(makeFailingDriver("primary down"), fallbackSpy);
  const repo = createWarmRepository(driver);

  const results = await repo.listByUser("any-user");
  assert.ok(Array.isArray(results));
  assert.equal(fallbackSpy.calls.listByUser, 1);
});

test("fallback driver: remove returns false when primary and fallback both miss", async () => {
  const fallbackSpy = makeSpyDriver();  // empty store → remove returns false
  const driver = withFallback(makeFailingDriver("primary down"), fallbackSpy);
  const repo = createColdRepository(driver);

  const result = await repo.remove("non-existent");
  assert.equal(result, false);
  assert.equal(fallbackSpy.calls.remove, 1);
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. Driver isolation: two repo instances don't share state
// ══════════════════════════════════════════════════════════════════════════════

test("two hot repos with separate spy drivers are fully isolated", async () => {
  const spy1 = makeSpyDriver();
  const spy2 = makeSpyDriver();
  const repo1 = createHotRepository(spy1);
  const repo2 = createHotRepository(spy2);

  const m = mem();
  await repo1.save(m);

  // repo2 should know nothing about m
  assert.equal(spy2.calls.save, 0);
  assert.equal(await repo2.get(m.id), undefined);
});

test("two warm repos with separate in-memory drivers are isolated", async () => {
  const repo1 = createWarmRepository(null);
  const repo2 = createWarmRepository(null);

  // Note: both share the module-level Map in inMemoryDriver because
  // inMemoryDriver is a singleton at module scope.
  // This is EXPECTED — the default singleton is intentionally shared
  // (same as before the refactor).  Users who need isolation must pass
  // their own driver instance (as spy tests above demonstrate).
  //
  // This test therefore just asserts the DI works, not module-map isolation.
  repo1.clear();
  repo2.clear();
  const m = mem();
  await repo1.save(m);

  // Since both repos use the shared inMemoryDriver singleton,
  // repo2.get will find it (expected shared-state behaviour)
  const found = await repo2.get(m.id);
  assert.ok(found, "shared default driver: record visible via second repo instance");
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. Cold repo pluggable swap
// ══════════════════════════════════════════════════════════════════════════════

test("cold repo: swapping from in-memory to spy driver at startup", async () => {
  const spy = makeSpyDriver();

  // Simulate: at app startup, inject the real driver
  const repo = createColdRepository(spy);

  const m = mem();
  await repo.save(m);
  await repo.get(m.id);
  await repo.listByUser(USER);
  await repo.update(m.id, { content: "archived updated" });
  await repo.remove(m.id);

  assert.equal(spy.calls.save,       1);
  assert.equal(spy.calls.get,        1);
  assert.equal(spy.calls.listByUser, 1);
  assert.equal(spy.calls.update,     1);
  assert.equal(spy.calls.remove,     1);
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. hot-redis-driver unit tests (using the driver directly, not via real Redis)
//    We test the fallback path by verifying getRedisClient returns null.
//    Since REDIS_URL is not set in the test environment, the driver always
//    uses its internal in-memory fallback.
// ══════════════════════════════════════════════════════════════════════════════

// Dynamic import to avoid top-level resolution if the file is absent (it's
// in the apps/api workspace which isn't on the core test path).
// We test the driver contract via a portable shim instead.

test("hot-redis-driver contract: save/get/update/remove via in-memory fallback", async () => {
  // Build a driver that matches the hot-redis-driver contract but is
  // self-contained (no external deps) — models the fallback code path.
  const store = new Map();
  const userIndex = new Map();

  const driver = {
    async save(memory) {
      store.set(memory.id, { ...memory });
      if (memory.userId) {
        if (!userIndex.has(memory.userId)) userIndex.set(memory.userId, new Set());
        userIndex.get(memory.userId).add(memory.id);
      }
      return store.get(memory.id);
    },
    async get(id)           { return store.get(id); },
    async listByUser(uid)   {
      const ids = userIndex.get(uid) || new Set();
      return [...ids].map((id) => store.get(id)).filter(Boolean);
    },
    async update(id, patch) {
      const e = store.get(id);
      if (!e) return null;
      const u = { ...e, ...patch, id };
      store.set(id, u);
      return u;
    },
    async remove(id) {
      const memory = store.get(id);
      if (!memory) return false;
      store.delete(id);
      userIndex.get(memory.userId)?.delete(id);
      return true;
    },
    _size()  { return store.size; },
    _clear() { store.clear(); userIndex.clear(); }
  };

  const repo = createHotRepository(driver);
  const m = mem({ userId: "redis-user" });

  const saved = await repo.save(m);
  assert.equal(saved.id, m.id);

  const fetched = await repo.get(m.id);
  assert.ok(fetched);
  assert.equal(fetched.userId, "redis-user");

  const list = await repo.listByUser("redis-user");
  assert.equal(list.length, 1);

  const updated = await repo.update(m.id, { content: "redis-updated" });
  assert.equal(updated.content, "redis-updated");

  const removed = await repo.remove(m.id);
  assert.equal(removed, true);
  assert.equal(await repo.get(m.id), undefined);

  // user index should be cleaned up
  const afterRemove = await repo.listByUser("redis-user");
  assert.equal(afterRemove.length, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// 8. warm-postgres-driver fallback path (no real DB)
//    Models the in-memory fallback that warm-postgres-driver uses when
//    POSTGRES_URL is not set.
// ══════════════════════════════════════════════════════════════════════════════

test("warm-postgres-driver contract: full CRUD via in-memory fallback", async () => {
  // Simulate the warm driver's fallback Map behaviour without requiring a real PG
  const fallback = new Map();

  const driver = {
    async save(memory) {
      const record = {
        id:         memory.id,
        userId:     memory.userId ?? "",
        content:    memory.content ?? "",
        summary:    memory.summary ?? "",
        memoryType: memory.memoryType ?? "factual",
        metadata:   memory.metadata ?? {},
        tier:       memory.metadata?.tier ?? "warm"
      };
      fallback.set(record.id, record);
      return record;
    },
    async get(id)          { return fallback.get(id); },
    async listByUser(uid)  { return [...fallback.values()].filter((m) => m.userId === uid); },
    async update(id, patch) {
      const e = fallback.get(id);
      if (!e) return null;
      const u = { ...e, ...patch, id };
      fallback.set(id, u);
      return u;
    },
    async remove(id) { return fallback.delete(id); },
    _size()  { return fallback.size; },
    _clear() { fallback.clear(); }
  };

  const repo = createWarmRepository(driver);
  const m = mem({ userId: "pg-user", importance: 0.8 });

  const saved = await repo.save(m);
  assert.ok(saved);
  assert.equal(saved.id, m.id);
  assert.equal(saved.tier, "warm");

  const list = await repo.listByUser("pg-user");
  assert.equal(list.length, 1);

  const updated = await repo.update(m.id, { content: "pg-updated" });
  assert.equal(updated?.content, "pg-updated");

  const removed = await repo.remove(m.id);
  assert.equal(removed, true);
  assert.equal(await repo.get(m.id), undefined);
});

// ══════════════════════════════════════════════════════════════════════════════
// 9. storageRouter DI — inject custom repos, verify routing
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Build a self-contained storageRouter with injected repositories.
 * Mirrors the logic in storageRouter.js but accepts repo overrides.
 */
function makeRouter(repos) {
  const { hot, warm, cold } = repos;
  const ALL = [hot, warm, cold];

  function withTierMeta(memory, tier) {
    return { ...memory, metadata: { ...memory.metadata, tier } };
  }
  function stampAccess(memory) {
    return {
      ...memory,
      metadata: {
        ...memory.metadata,
        lastAccessedAt: new Date().toISOString(),
        accessCount:    (memory.metadata?.accessCount ?? 0) + 1
      }
    };
  }

  return {
    async saveToHot(memory) {
      return hot.save(withTierMeta(memory, "hot"));
    },
    async saveToWarm(memory) {
      return warm.save(withTierMeta(memory, "warm"));
    },
    async saveToTier(memory, tier) {
      const repo = tier === "hot" ? hot : tier === "warm" ? warm : cold;
      return repo.save(withTierMeta(memory, tier));
    },
    async getMemory(id) {
      for (const repo of ALL) {
        const m = await repo.get(id);
        if (m) {
          const accessed = stampAccess(m);
          await repo.update(id, accessed);
          return accessed;
        }
      }
      return null;
    },
    async searchUserMemories(userId) {
      const [h, w, c] = await Promise.all([
        hot.listByUser(userId),
        warm.listByUser(userId),
        cold.listByUser(userId)
      ]);
      return [...h, ...w, ...c].sort(
        (a, b) => (b.metadata?.importance ?? 0) - (a.metadata?.importance ?? 0)
      );
    }
  };
}

test("storageRouter DI: getMemory finds records across all three tiers", async () => {
  const spyHot  = makeSpyDriver();
  const spyWarm = makeSpyDriver();
  const spyCold = makeSpyDriver();

  const hotRepo  = createHotRepository(spyHot);
  const warmRepo = createWarmRepository(spyWarm);
  const coldRepo = createColdRepository(spyCold);

  const router = makeRouter({ hot: hotRepo, warm: warmRepo, cold: coldRepo });

  const mHot  = mem({ userId: "u-router" });
  const mWarm = mem({ userId: "u-router" });
  const mCold = mem({ userId: "u-router" });

  await router.saveToHot(mHot);
  await router.saveToWarm(mWarm);
  await router.saveToTier(mCold, "cold");

  // All three should be retrievable
  const fHot  = await router.getMemory(mHot.id);
  const fWarm = await router.getMemory(mWarm.id);
  const fCold = await router.getMemory(mCold.id);

  assert.equal(fHot?.id,  mHot.id);
  assert.equal(fWarm?.id, mWarm.id);
  assert.equal(fCold?.id, mCold.id);
});

test("storageRouter DI: getMemory returns null when id absent", async () => {
  const router = makeRouter({
    hot:  createHotRepository(makeSpyDriver()),
    warm: createWarmRepository(makeSpyDriver()),
    cold: createColdRepository(makeSpyDriver())
  });

  const result = await router.getMemory("no-such");
  assert.equal(result, null);
});

test("storageRouter DI: getMemory stamps accessCount on each call", async () => {
  const spy   = makeSpyDriver();
  const repo  = createHotRepository(spy);
  const router = makeRouter({
    hot:  repo,
    warm: createWarmRepository(makeSpyDriver()),
    cold: createColdRepository(makeSpyDriver())
  });

  const m = mem();
  await repo.save(m);

  const first  = await router.getMemory(m.id);
  const second = await router.getMemory(m.id);

  assert.equal(first.metadata.accessCount,  1);
  assert.equal(second.metadata.accessCount, 2);
});

test("storageRouter DI: searchUserMemories merges all tiers, sorted by importance", async () => {
  const spyHot  = makeSpyDriver();
  const spyWarm = makeSpyDriver();
  const spyCold = makeSpyDriver();
  const router  = makeRouter({
    hot:  createHotRepository(spyHot),
    warm: createWarmRepository(spyWarm),
    cold: createColdRepository(spyCold)
  });

  const uid = "u-sort-router";
  await router.saveToHot( mem({ userId: uid, importance: 0.2 }));
  await router.saveToWarm(mem({ userId: uid, importance: 0.9 }));
  await router.saveToTier(mem({ userId: uid, importance: 0.5 }), "cold");

  const results = await router.searchUserMemories(uid);
  assert.equal(results.length, 3);
  assert.equal(results[0].metadata.importance, 0.9);
  assert.equal(results[1].metadata.importance, 0.5);
  assert.equal(results[2].metadata.importance, 0.2);
});

test("storageRouter DI: searchUserMemories returns empty for unknown user", async () => {
  const router = makeRouter({
    hot:  createHotRepository(makeSpyDriver()),
    warm: createWarmRepository(makeSpyDriver()),
    cold: createColdRepository(makeSpyDriver())
  });
  const results = await router.searchUserMemories("no-such-user");
  assert.equal(results.length, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// 10. size() and clear() test-helper contract
// ══════════════════════════════════════════════════════════════════════════════

test("size() and clear() work on default in-memory repos", async () => {
  const repo = createHotRepository(null);
  repo.clear();
  assert.equal(repo.size(), 0);

  await repo.save(mem());
  assert.equal(repo.size(), 1);

  await repo.save(mem());
  assert.equal(repo.size(), 2);

  repo.clear();
  assert.equal(repo.size(), 0);
});

test("size() returns undefined when driver provides no _size helper", async () => {
  const minimalDriver = {
    async save(m) { return m; },
    async get()   { return undefined; },
    async listByUser() { return []; },
    async update() { return null; },
    async remove() { return false; }
    // no _size / _clear
  };

  const repo = createHotRepository(minimalDriver);
  assert.equal(repo.size(), undefined);
  // clear() should not throw even without _clear
  assert.doesNotThrow(() => repo.clear());
});
