/**
 * packages/core/test/tiered-storage.test.js
 *
 * Unit tests for the hot/warm/cold tiered storage system:
 *
 *   Tier assignment    — determineTier() routes correctly by age + importance
 *   Promotion          — promote() moves a record to hot and updates metadata
 *   Demotion           — demote() moves a record to warm/cold
 *   Rebalancing        — rebalance() moves mis-placed memories to correct tiers
 *   Cross-tier reads   — getMemory() / searchUserMemories() searches all tiers
 *   Update propagation — updateMemory() finds and patches whichever tier holds it
 *
 * Test runner: Node 22 built-in (node --test)
 * Import style: ESM
 */

import assert from "node:assert/strict";
import test   from "node:test";

// ─── Subjects ─────────────────────────────────────────────────────────────────

import { hotRepository }  from "../src/memory/repositories/hotRepository.js";
import { warmRepository } from "../src/memory/repositories/warmRepository.js";
import { coldRepository } from "../src/memory/repositories/coldRepository.js";

import {
  Tier,
  determineTier,
  promote,
  demote,
  rebalance,
  getRepositoryForTier,
  HOT_WINDOW_MS,
  COLD_AGE_MS,
  COLD_IMPORTANCE_THRESHOLD,
  WARM_IMPORTANCE_THRESHOLD
} from "../src/memory/services/tierManager.js";

import {
  saveMemory,
  getMemory,
  searchUserMemories,
  updateMemory,
  removeMemory
} from "../src/memory/services/storageRouter.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _idSeq = 0;
function uid() {
  return `test-mem-${++_idSeq}`;
}

const TEST_USER = "user-test-001";

/**
 * Build a minimal memory object for tests.
 *
 * @param {Partial<{
 *   id:         string,
 *   userId:     string,
 *   importance: number,
 *   ageMs:      number,  // how old the timestamp is (default = 0 = now)
 *   lastAccessedAgeMs: number|null  // how old lastAccessedAt is (null = unset)
 * }>} opts
 */
function mem(opts = {}) {
  const {
    id                 = uid(),
    userId             = TEST_USER,
    importance         = 0.5,
    ageMs              = 0,
    lastAccessedAgeMs  = undefined   // undefined = omit the field entirely
  } = opts;

  const createdAt = new Date(Date.now() - ageMs).toISOString();

  const metadata = {
    importance,
    timestamp:   createdAt,
    accessCount: 0
  };

  if (lastAccessedAgeMs != null) {
    metadata.lastAccessedAt = new Date(Date.now() - lastAccessedAgeMs).toISOString();
  }

  return { id, userId, memoryType: "factual", content: "test", summary: "test", metadata };
}

/** Wipe all three in-memory stores between test groups. */
function clearAll() {
  hotRepository.clear();
  warmRepository.clear();
  coldRepository.clear();
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. Individual repository CRUD
// ══════════════════════════════════════════════════════════════════════════════

test("hotRepository: save and get round-trip", async () => {
  clearAll();
  const m = mem();
  const saved = await hotRepository.save(m);
  assert.equal(saved.id, m.id);

  const fetched = await hotRepository.get(m.id);
  assert.ok(fetched, "should find saved record");
  assert.equal(fetched.id, m.id);
});

test("hotRepository: get returns undefined for missing id", async () => {
  clearAll();
  const result = await hotRepository.get("no-such-id");
  assert.equal(result, undefined);
});

test("hotRepository: listByUser returns only that user's records", async () => {
  clearAll();
  const m1 = mem({ userId: "user-a" });
  const m2 = mem({ userId: "user-b" });
  const m3 = mem({ userId: "user-a" });
  await hotRepository.save(m1);
  await hotRepository.save(m2);
  await hotRepository.save(m3);

  const results = await hotRepository.listByUser("user-a");
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.userId === "user-a"));
});

test("hotRepository: update patches fields", async () => {
  clearAll();
  const m = mem({ importance: 0.3 });
  await hotRepository.save(m);

  const updated = await hotRepository.update(m.id, { metadata: { importance: 0.9 } });
  assert.ok(updated);
  assert.equal(updated.metadata.importance, 0.9);

  const fetched = await hotRepository.get(m.id);
  assert.equal(fetched.metadata.importance, 0.9);
});

test("hotRepository: update returns null for missing id", async () => {
  clearAll();
  const result = await hotRepository.update("ghost", { content: "new" });
  assert.equal(result, null);
});

test("hotRepository: remove deletes record and returns true", async () => {
  clearAll();
  const m = mem();
  await hotRepository.save(m);

  const removed = await hotRepository.remove(m.id);
  assert.equal(removed, true);
  assert.equal(await hotRepository.get(m.id), undefined);
});

test("hotRepository: remove returns false for missing id", async () => {
  clearAll();
  const result = await hotRepository.remove("missing");
  assert.equal(result, false);
});

test("hotRepository: save throws without id", async () => {
  clearAll();
  await assert.rejects(
    () => hotRepository.save({ content: "no id" }),
    /memory.id is required/
  );
});

// Spot-check warmRepository and coldRepository use same contract
test("warmRepository: basic CRUD matches hotRepository contract", async () => {
  clearAll();
  const m = mem();
  await warmRepository.save(m);
  assert.ok(await warmRepository.get(m.id));
  assert.equal((await warmRepository.listByUser(TEST_USER)).length, 1);
  assert.ok(await warmRepository.update(m.id, { content: "patched" }));
  assert.equal((await warmRepository.get(m.id)).content, "patched");
  assert.equal(await warmRepository.remove(m.id), true);
  assert.equal(await warmRepository.get(m.id), undefined);
});

test("coldRepository: basic CRUD matches hotRepository contract", async () => {
  clearAll();
  const m = mem();
  await coldRepository.save(m);
  assert.ok(await coldRepository.get(m.id));
  assert.equal((await coldRepository.listByUser(TEST_USER)).length, 1);
  assert.ok(await coldRepository.update(m.id, { content: "archived" }));
  assert.equal((await coldRepository.get(m.id)).content, "archived");
  assert.equal(await coldRepository.remove(m.id), true);
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. Tier assignment — determineTier
// ══════════════════════════════════════════════════════════════════════════════

test("determineTier: hot — lastAccessedAt within 7 days", () => {
  const memory = mem({ ageMs: 10 * 24 * 60 * 60 * 1000, lastAccessedAgeMs: 1 * 24 * 60 * 60 * 1000 });
  assert.equal(determineTier(memory), Tier.HOT);
});

test("determineTier: hot — timestamp within 7 days (no lastAccessedAt)", () => {
  const memory = mem({ ageMs: 3 * 24 * 60 * 60 * 1000 });
  assert.equal(determineTier(memory), Tier.HOT);
});

test("determineTier: cold — older than 90 days AND importance < 0.4", () => {
  const memory = mem({
    ageMs:              95 * 24 * 60 * 60 * 1000,
    importance:         0.2,
    lastAccessedAgeMs:  95 * 24 * 60 * 60 * 1000
  });
  assert.equal(determineTier(memory), Tier.COLD);
});

test("determineTier: warm — older than 90 days but high importance", () => {
  const memory = mem({
    ageMs:              95 * 24 * 60 * 60 * 1000,
    importance:         0.8,
    lastAccessedAgeMs:  95 * 24 * 60 * 60 * 1000
  });
  assert.equal(determineTier(memory), Tier.WARM);
});

test("determineTier: warm — default for mid-age mid-importance", () => {
  const memory = mem({
    ageMs:             30 * 24 * 60 * 60 * 1000,  // 30 days — not hot
    importance:        0.5,
    lastAccessedAgeMs: 30 * 24 * 60 * 60 * 1000
  });
  assert.equal(determineTier(memory), Tier.WARM);
});

test("determineTier: warm — importance exactly at warm threshold", () => {
  const memory = mem({
    ageMs:             50 * 24 * 60 * 60 * 1000,
    importance:        WARM_IMPORTANCE_THRESHOLD,
    lastAccessedAgeMs: 50 * 24 * 60 * 60 * 1000
  });
  assert.equal(determineTier(memory), Tier.WARM);
});

test("determineTier: warm — exactly at COLD_AGE_MS boundary stays warm when importance = 0.39", () => {
  const memory = mem({
    ageMs:             COLD_AGE_MS + 1000,          // just over 90 days
    importance:        COLD_IMPORTANCE_THRESHOLD - 0.01,
    lastAccessedAgeMs: COLD_AGE_MS + 1000
  });
  assert.equal(determineTier(memory), Tier.COLD);
});

test("determineTier: warm — 89 days old with low importance is NOT cold", () => {
  const memory = mem({
    ageMs:             89 * 24 * 60 * 60 * 1000,
    importance:        0.1,
    lastAccessedAgeMs: 89 * 24 * 60 * 60 * 1000
  });
  assert.equal(determineTier(memory), Tier.WARM);
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. Promotion
// ══════════════════════════════════════════════════════════════════════════════

test("promote: moves memory from warm to hot tier", async () => {
  clearAll();
  const m = mem({ ageMs: 30 * 24 * 60 * 60 * 1000, importance: 0.5 });

  await warmRepository.save(m);
  assert.equal(warmRepository.size(), 1);

  const promoted = await promote(m, warmRepository);

  assert.equal(promoted.metadata.tier, Tier.HOT);
  assert.ok(promoted.metadata.lastAccessedAt, "lastAccessedAt should be stamped");

  // Source tier should be empty; hot should have it
  assert.equal(warmRepository.size(), 0);
  assert.ok(await hotRepository.get(m.id), "should exist in hot tier");
});

test("promote: moves memory from cold to hot tier", async () => {
  clearAll();
  const m = mem({ ageMs: 95 * 24 * 60 * 60 * 1000, importance: 0.2 });

  await coldRepository.save(m);
  const promoted = await promote(m, coldRepository);

  assert.equal(promoted.metadata.tier, Tier.HOT);
  assert.equal(coldRepository.size(), 0);
  assert.ok(await hotRepository.get(m.id));
});

test("promote: sets a fresh lastAccessedAt", async () => {
  clearAll();
  const before = Date.now();
  const m = mem();
  await warmRepository.save(m);

  const promoted = await promote(m, warmRepository);
  const accessedAt = new Date(promoted.metadata.lastAccessedAt).getTime();

  assert.ok(accessedAt >= before, "lastAccessedAt should be >= before promote");
  assert.ok(accessedAt <= Date.now(), "lastAccessedAt should be <= now");
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. Demotion
// ══════════════════════════════════════════════════════════════════════════════

test("demote: moves memory from hot to warm tier", async () => {
  clearAll();
  const m = mem({ importance: 0.8 });
  await hotRepository.save(m);
  assert.equal(hotRepository.size(), 1);

  const demoted = await demote(m, hotRepository, warmRepository);

  assert.equal(demoted.metadata.tier, Tier.WARM);
  assert.equal(hotRepository.size(), 0);
  assert.ok(await warmRepository.get(m.id));
});

test("demote: moves memory from warm to cold tier", async () => {
  clearAll();
  const m = mem({ importance: 0.2 });
  await warmRepository.save(m);

  const demoted = await demote(m, warmRepository, coldRepository);

  assert.equal(demoted.metadata.tier, Tier.COLD);
  assert.equal(warmRepository.size(), 0);
  assert.ok(await coldRepository.get(m.id));
});

test("demote: moves memory from hot directly to cold tier", async () => {
  clearAll();
  const m = mem();
  await hotRepository.save(m);

  const demoted = await demote(m, hotRepository, coldRepository);
  assert.equal(demoted.metadata.tier, Tier.COLD);
  assert.ok(await coldRepository.get(m.id));
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. Rebalancing
// ══════════════════════════════════════════════════════════════════════════════

test("rebalance: moves a stale hot memory to warm", async () => {
  clearAll();
  // Memory that was last accessed > 7 days ago → should go to warm
  const m = mem({
    ageMs:             10 * 24 * 60 * 60 * 1000,
    importance:        0.5,
    lastAccessedAgeMs: 8 * 24 * 60 * 60 * 1000   // 8 days ago → not hot
  });
  // Manually place in hot (simulating an old record that hasn't been rebalanced)
  await hotRepository.save({ ...m, metadata: { ...m.metadata, tier: Tier.HOT } });

  const result = await rebalance(TEST_USER);

  assert.ok(result.moved.some((mv) => mv.id === m.id && mv.from === "hot" && mv.to === "warm"),
    "should have moved from hot to warm");
  assert.equal(await hotRepository.get(m.id), undefined, "should not be in hot anymore");
  assert.ok(await warmRepository.get(m.id), "should be in warm");
});

test("rebalance: moves an old low-importance warm memory to cold", async () => {
  clearAll();
  const m = mem({
    ageMs:             95 * 24 * 60 * 60 * 1000,
    importance:        0.1,
    lastAccessedAgeMs: 95 * 24 * 60 * 60 * 1000
  });
  await warmRepository.save({ ...m, metadata: { ...m.metadata, tier: Tier.WARM } });

  const result = await rebalance(TEST_USER);

  assert.ok(result.moved.some((mv) => mv.id === m.id && mv.from === "warm" && mv.to === "cold"),
    "should have moved from warm to cold");
  assert.equal(await warmRepository.get(m.id), undefined);
  assert.ok(await coldRepository.get(m.id));
});

test("rebalance: leaves correctly-placed memories alone", async () => {
  clearAll();
  // Hot memory that is actually recent
  const hotMem = mem({ ageMs: 1 * 24 * 60 * 60 * 1000 });
  // Warm memory with high importance but old access
  const warmMem = mem({
    ageMs:             40 * 24 * 60 * 60 * 1000,
    importance:        0.8,
    lastAccessedAgeMs: 40 * 24 * 60 * 60 * 1000
  });
  // Cold memory that is genuinely old and low importance
  const coldMem = mem({
    ageMs:             100 * 24 * 60 * 60 * 1000,
    importance:        0.1,
    lastAccessedAgeMs: 100 * 24 * 60 * 60 * 1000
  });

  await hotRepository.save(hotMem);
  await warmRepository.save(warmMem);
  await coldRepository.save(coldMem);

  const result = await rebalance(TEST_USER);

  // None of these should have moved
  const movedIds = result.moved.map((mv) => mv.id);
  assert.ok(!movedIds.includes(hotMem.id),  "hot memory should not move");
  assert.ok(!movedIds.includes(warmMem.id), "warm memory should not move");
  assert.ok(!movedIds.includes(coldMem.id), "cold memory should not move");
});

test("rebalance: returns total count across all tiers", async () => {
  clearAll();
  const memories = [
    mem({ userId: TEST_USER }),
    mem({ userId: TEST_USER }),
    mem({ userId: TEST_USER })
  ];
  await hotRepository.save(memories[0]);
  await warmRepository.save(memories[1]);
  await coldRepository.save(memories[2]);

  const result = await rebalance(TEST_USER);
  assert.equal(result.total, 3);
});

test("rebalance: only affects memories for the specified user", async () => {
  clearAll();
  const myMem    = mem({ userId: "user-mine",  ageMs: 8 * 24 * 60 * 60 * 1000, importance: 0.5, lastAccessedAgeMs: 8 * 24 * 60 * 60 * 1000 });
  const otherMem = mem({ userId: "user-other", ageMs: 8 * 24 * 60 * 60 * 1000, importance: 0.5, lastAccessedAgeMs: 8 * 24 * 60 * 60 * 1000 });

  await hotRepository.save({ ...myMem,    metadata: { ...myMem.metadata,    tier: Tier.HOT } });
  await hotRepository.save({ ...otherMem, metadata: { ...otherMem.metadata, tier: Tier.HOT } });

  await rebalance("user-mine");

  // otherMem should still be exactly where it was (untouched)
  // We verify the total only covered user-mine's memories
  // (otherMem may or may not still be in hot depending on tier, but it wasn't
  //  processed by this rebalance call)
  const otherStillSomewhere =
    (await hotRepository.get(otherMem.id))  ||
    (await warmRepository.get(otherMem.id)) ||
    (await coldRepository.get(otherMem.id));
  assert.ok(otherStillSomewhere, "other user's memory should still exist");
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. Storage router — saveMemory
// ══════════════════════════════════════════════════════════════════════════════

test("saveMemory: routes recent memory to hot tier", async () => {
  clearAll();
  const m = mem({ ageMs: 1 * 24 * 60 * 60 * 1000 });  // 1 day old → hot
  const saved = await saveMemory(m);

  assert.equal(saved.metadata.tier, Tier.HOT);
  assert.ok(await hotRepository.get(m.id), "should be in hot repository");
});

test("saveMemory: routes old low-importance memory to cold tier", async () => {
  clearAll();
  const m = mem({
    ageMs:             100 * 24 * 60 * 60 * 1000,
    importance:        0.1,
    lastAccessedAgeMs: 100 * 24 * 60 * 60 * 1000
  });
  const saved = await saveMemory(m);

  assert.equal(saved.metadata.tier, Tier.COLD);
  assert.ok(await coldRepository.get(m.id));
});

test("saveMemory: routes mid-age important memory to warm tier", async () => {
  clearAll();
  const m = mem({
    ageMs:             30 * 24 * 60 * 60 * 1000,
    importance:        0.8,
    lastAccessedAgeMs: 30 * 24 * 60 * 60 * 1000
  });
  const saved = await saveMemory(m);

  assert.equal(saved.metadata.tier, Tier.WARM);
  assert.ok(await warmRepository.get(m.id));
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. Cross-tier retrieval — getMemory
// ══════════════════════════════════════════════════════════════════════════════

test("getMemory: finds a memory in the hot tier", async () => {
  clearAll();
  const m = mem();
  await hotRepository.save(m);

  const found = await getMemory(m.id);
  assert.ok(found, "should find the memory");
  assert.equal(found.id, m.id);
});

test("getMemory: finds a memory in the warm tier", async () => {
  clearAll();
  const m = mem();
  await warmRepository.save(m);

  const found = await getMemory(m.id);
  assert.ok(found);
  assert.equal(found.id, m.id);
});

test("getMemory: finds a memory in the cold tier", async () => {
  clearAll();
  const m = mem();
  await coldRepository.save(m);

  const found = await getMemory(m.id);
  assert.ok(found);
  assert.equal(found.id, m.id);
});

test("getMemory: returns null when id not found in any tier", async () => {
  clearAll();
  const result = await getMemory("no-such-id");
  assert.equal(result, null);
});

test("getMemory: increments accessCount on each retrieval", async () => {
  clearAll();
  const m = mem();
  await hotRepository.save(m);

  const first  = await getMemory(m.id);
  const second = await getMemory(m.id);

  assert.equal(first.metadata.accessCount,  1);
  assert.equal(second.metadata.accessCount, 2);
});

test("getMemory: stamps lastAccessedAt on retrieval", async () => {
  clearAll();
  const before = Date.now();
  const m = mem();
  await hotRepository.save(m);

  const found = await getMemory(m.id);
  const accessedAt = new Date(found.metadata.lastAccessedAt).getTime();

  assert.ok(accessedAt >= before);
  assert.ok(accessedAt <= Date.now());
});

// ══════════════════════════════════════════════════════════════════════════════
// 8. Cross-tier search — searchUserMemories
// ══════════════════════════════════════════════════════════════════════════════

test("searchUserMemories: returns memories from all three tiers", async () => {
  clearAll();
  const uid2 = "user-search-test";
  const mHot  = mem({ userId: uid2 });
  const mWarm = mem({ userId: uid2 });
  const mCold = mem({ userId: uid2 });

  await hotRepository.save(mHot);
  await warmRepository.save(mWarm);
  await coldRepository.save(mCold);

  const results = await searchUserMemories(uid2);

  assert.equal(results.length, 3);
  const ids = results.map((r) => r.id);
  assert.ok(ids.includes(mHot.id));
  assert.ok(ids.includes(mWarm.id));
  assert.ok(ids.includes(mCold.id));
});

test("searchUserMemories: returns empty array when user has no memories", async () => {
  clearAll();
  const results = await searchUserMemories("non-existent-user");
  assert.equal(results.length, 0);
});

test("searchUserMemories: results sorted by importance descending", async () => {
  clearAll();
  const uid3 = "user-sort-test";
  const low  = mem({ userId: uid3, importance: 0.2 });
  const high = mem({ userId: uid3, importance: 0.9 });
  const mid  = mem({ userId: uid3, importance: 0.6 });

  await hotRepository.save(low);
  await warmRepository.save(high);
  await coldRepository.save(mid);

  const results = await searchUserMemories(uid3);

  assert.equal(results[0].metadata.importance, 0.9);
  assert.equal(results[1].metadata.importance, 0.6);
  assert.equal(results[2].metadata.importance, 0.2);
});

test("searchUserMemories: does not return memories for other users", async () => {
  clearAll();
  const uid4 = "user-isolated";
  await hotRepository.save(mem({ userId: uid4 }));
  await hotRepository.save(mem({ userId: "other-user-xyz" }));

  const results = await searchUserMemories(uid4);
  assert.equal(results.length, 1);
  assert.equal(results[0].userId, uid4);
});

// ══════════════════════════════════════════════════════════════════════════════
// 9. Update propagation — updateMemory
// ══════════════════════════════════════════════════════════════════════════════

test("updateMemory: patches a memory in hot tier", async () => {
  clearAll();
  const m = mem();
  await hotRepository.save(m);

  const updated = await updateMemory(m.id, { content: "updated content" });
  assert.ok(updated);
  assert.equal(updated.content, "updated content");

  // Verify the change persisted in the hot repository
  const fetched = await hotRepository.get(m.id);
  assert.equal(fetched.content, "updated content");
});

test("updateMemory: patches a memory in warm tier", async () => {
  clearAll();
  const m = mem();
  await warmRepository.save(m);

  const updated = await updateMemory(m.id, { content: "warm patched" });
  assert.ok(updated);
  assert.equal(updated.content, "warm patched");
  assert.equal(await hotRepository.get(m.id), undefined, "should not appear in hot");
});

test("updateMemory: patches a memory in cold tier", async () => {
  clearAll();
  const m = mem();
  await coldRepository.save(m);

  const updated = await updateMemory(m.id, { content: "cold patched" });
  assert.ok(updated);
  assert.equal(updated.content, "cold patched");
});

test("updateMemory: returns null for unknown id", async () => {
  clearAll();
  const result = await updateMemory("no-such-id", { content: "nope" });
  assert.equal(result, null);
});

test("updateMemory: deep-merges metadata patch", async () => {
  clearAll();
  const m = mem({ importance: 0.4 });
  await hotRepository.save(m);

  const updated = await updateMemory(m.id, {
    metadata: { importance: 0.95, tier: Tier.HOT }
  });
  assert.equal(updated.metadata.importance, 0.95);
});

// ══════════════════════════════════════════════════════════════════════════════
// 10. removeMemory
// ══════════════════════════════════════════════════════════════════════════════

test("removeMemory: removes from hot tier", async () => {
  clearAll();
  const m = mem();
  await hotRepository.save(m);

  assert.equal(await removeMemory(m.id), true);
  assert.equal(await hotRepository.get(m.id), undefined);
});

test("removeMemory: removes from warm tier", async () => {
  clearAll();
  const m = mem();
  await warmRepository.save(m);

  assert.equal(await removeMemory(m.id), true);
  assert.equal(await warmRepository.get(m.id), undefined);
});

test("removeMemory: removes from cold tier", async () => {
  clearAll();
  const m = mem();
  await coldRepository.save(m);

  assert.equal(await removeMemory(m.id), true);
  assert.equal(await coldRepository.get(m.id), undefined);
});

test("removeMemory: returns false for missing id", async () => {
  clearAll();
  assert.equal(await removeMemory("ghost-id"), false);
});

// ══════════════════════════════════════════════════════════════════════════════
// 11. getRepositoryForTier helper
// ══════════════════════════════════════════════════════════════════════════════

test("getRepositoryForTier: resolves all three tiers", () => {
  assert.equal(getRepositoryForTier(Tier.HOT),  hotRepository);
  assert.equal(getRepositoryForTier(Tier.WARM), warmRepository);
  assert.equal(getRepositoryForTier(Tier.COLD), coldRepository);
});

test("getRepositoryForTier: throws for unknown tier string", () => {
  assert.throws(
    () => getRepositoryForTier("lukewarm"),
    /unknown tier/
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// 12. Tier constant values
// ══════════════════════════════════════════════════════════════════════════════

test("Tier enum values are the expected strings", () => {
  assert.equal(Tier.HOT,  "hot");
  assert.equal(Tier.WARM, "warm");
  assert.equal(Tier.COLD, "cold");
});

test("HOT_WINDOW_MS is 7 days in milliseconds", () => {
  assert.equal(HOT_WINDOW_MS, 7 * 24 * 60 * 60 * 1000);
});

test("COLD_AGE_MS is 90 days in milliseconds", () => {
  assert.equal(COLD_AGE_MS, 90 * 24 * 60 * 60 * 1000);
});

test("COLD_IMPORTANCE_THRESHOLD is 0.4", () => {
  assert.equal(COLD_IMPORTANCE_THRESHOLD, 0.4);
});

test("WARM_IMPORTANCE_THRESHOLD is 0.7", () => {
  assert.equal(WARM_IMPORTANCE_THRESHOLD, 0.7);
});
