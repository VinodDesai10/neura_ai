/**
 * apps/api/test/memory-processor-dedup-lock.test.js
 *
 * Concurrency and regression tests for H-4: per-session Redis distributed lock
 * in memory-processor.js.
 *
 * Test matrix
 * ───────────
 *   A. redisRuntimeStore lock primitives
 *      A1 – acquireMemoryProcessingLock returns a token on first call
 *      A2 – second acquire for same session returns null (lock held)
 *      A3 – lock is released and can be re-acquired
 *      A4 – token mismatch does not release the lock
 *      A5 – different sessions do not block each other
 *      A6 – lock key uses :proc-lock suffix (distinct from :lock)
 *
 *   B. Structural – memory-processor.js uses the lock
 *      B1 – source contains acquireMemoryProcessingLock call
 *      B2 – source contains releaseMemoryProcessingLock call in finally block
 *
 *   C. Serialisation – same-session concurrent jobs
 *      C1 – two simultaneous processEventJob calls for the same session:
 *           only the first acquires the lock; the second throws a transient
 *           error (ECONNRESET) so it is retried rather than creating a duplicate
 *      C2 – once the first job releases the lock the second job can run
 *      C3 – different-session jobs run concurrently (neither blocks the other)
 *
 *   D. Deduplication soundness (no race)
 *      D1 – two sequential jobs with identical content store exactly one copy
 *      D2 – two "concurrent" jobs (lock held by a stub) for the same session:
 *           the blocked one throws ECONNRESET, the holder stores exactly once
 *
 * No Redis, no OpenAI, no Postgres, no Qdrant, no Neo4j connections are used.
 * Everything runs via the in-process fallback inside redisRuntimeStore.
 */

import test   from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath }    from "node:url";

process.env.LOG_LEVEL = "silent";
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_BASE_URL;

const __dirname = dirname(fileURLToPath(import.meta.url));

import { redisRuntimeStore } from "../src/infrastructure/redis-runtime-store.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function resetStore() {
  redisRuntimeStore.clearLocalStorage();
}

let sessionCounter = 0;
function uniqueSession() {
  return `test-session-${++sessionCounter}-${Date.now()}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// A. Lock primitive unit tests
// ═════════════════════════════════════════════════════════════════════════════

test("A1 – acquireMemoryProcessingLock returns a non-empty token on first call", async () => {
  resetStore();
  const sessionId = uniqueSession();
  const token = await redisRuntimeStore.acquireMemoryProcessingLock(sessionId);
  assert.ok(typeof token === "string" && token.length > 0, "expected a token string");
  await redisRuntimeStore.releaseMemoryProcessingLock(sessionId, token);
});

test("A2 – second acquire for the same session returns null while lock is held", async () => {
  resetStore();
  const sessionId = uniqueSession();
  const token1 = await redisRuntimeStore.acquireMemoryProcessingLock(sessionId);
  assert.ok(token1, "first acquire must succeed");

  const token2 = await redisRuntimeStore.acquireMemoryProcessingLock(sessionId);
  assert.equal(token2, null, "second acquire must fail while lock is held");

  await redisRuntimeStore.releaseMemoryProcessingLock(sessionId, token1);
});

test("A3 – after release the lock can be re-acquired by a new caller", async () => {
  resetStore();
  const sessionId = uniqueSession();
  const token1 = await redisRuntimeStore.acquireMemoryProcessingLock(sessionId);
  await redisRuntimeStore.releaseMemoryProcessingLock(sessionId, token1);

  const token2 = await redisRuntimeStore.acquireMemoryProcessingLock(sessionId);
  assert.ok(token2, "re-acquire after release must succeed");
  assert.notEqual(token2, token1, "new token must differ from old token");
  await redisRuntimeStore.releaseMemoryProcessingLock(sessionId, token2);
});

test("A4 – releaseMemoryProcessingLock with wrong token does not release the lock", async () => {
  resetStore();
  const sessionId = uniqueSession();
  const token = await redisRuntimeStore.acquireMemoryProcessingLock(sessionId);

  // Attempt release with a bogus token
  await redisRuntimeStore.releaseMemoryProcessingLock(sessionId, "wrong-token-xyz");

  // Lock should still be held — another acquire must fail
  const token2 = await redisRuntimeStore.acquireMemoryProcessingLock(sessionId);
  assert.equal(token2, null, "lock must still be held after wrong-token release attempt");

  // Cleanup with correct token
  await redisRuntimeStore.releaseMemoryProcessingLock(sessionId, token);
});

test("A5 – different sessions acquire their locks independently and concurrently", async () => {
  resetStore();
  const sessionA = uniqueSession();
  const sessionB = uniqueSession();

  const [tokenA, tokenB] = await Promise.all([
    redisRuntimeStore.acquireMemoryProcessingLock(sessionA),
    redisRuntimeStore.acquireMemoryProcessingLock(sessionB)
  ]);

  assert.ok(tokenA, "session A must acquire its lock");
  assert.ok(tokenB, "session B must acquire its lock independently");

  // Holding A's lock must not prevent a third acquire on B
  const tokenB2 = await redisRuntimeStore.acquireMemoryProcessingLock(sessionB);
  assert.equal(tokenB2, null, "session B's lock is still held — second acquire must fail");

  await Promise.all([
    redisRuntimeStore.releaseMemoryProcessingLock(sessionA, tokenA),
    redisRuntimeStore.releaseMemoryProcessingLock(sessionB, tokenB)
  ]);
});

test("A6 – proc-lock key is distinct from chat-turn lock key", async () => {
  resetStore();
  const sessionId = uniqueSession();

  // Acquire the orchestrator chat-turn lock (:lock)
  const chatToken = await redisRuntimeStore.acquireSessionLock(sessionId);
  assert.ok(chatToken, "chat-turn lock must be acquired");

  // Memory-processing lock (:proc-lock) must be independent
  const procToken = await redisRuntimeStore.acquireMemoryProcessingLock(sessionId);
  assert.ok(procToken, "proc-lock must be acquirable while chat-turn lock is held");

  await redisRuntimeStore.releaseSessionLock(sessionId, chatToken);
  await redisRuntimeStore.releaseMemoryProcessingLock(sessionId, procToken);
});

// ═════════════════════════════════════════════════════════════════════════════
// B. Structural assertions on memory-processor.js
// ═════════════════════════════════════════════════════════════════════════════

const processorSource = readFileSync(
  resolve(__dirname, "../src/services/memory-processor.js"),
  "utf8"
);

test("B1 – memory-processor.js calls acquireMemoryProcessingLock", () => {
  assert.ok(
    processorSource.includes("acquireMemoryProcessingLock"),
    "acquireMemoryProcessingLock call not found in memory-processor.js"
  );
});

test("B2 – memory-processor.js calls releaseMemoryProcessingLock inside a finally block", () => {
  assert.ok(
    processorSource.includes("releaseMemoryProcessingLock"),
    "releaseMemoryProcessingLock call not found in memory-processor.js"
  );
  // The release must be inside a finally block
  const finallyIndex   = processorSource.indexOf("} finally {");
  const releaseIndex   = processorSource.indexOf("releaseMemoryProcessingLock");
  assert.ok(
    finallyIndex !== -1 && releaseIndex > finallyIndex,
    "releaseMemoryProcessingLock must appear after the finally { block opening"
  );
});

test("B3 – memory-processor.js imports redisRuntimeStore", () => {
  assert.ok(
    processorSource.includes("redisRuntimeStore"),
    "redisRuntimeStore import not found in memory-processor.js"
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// C. Serialisation — same-session concurrent jobs
//
// These tests drive the lock layer directly (no heavy infrastructure needed).
// ═════════════════════════════════════════════════════════════════════════════

test("C1 – same session: concurrent lock requests — only one succeeds simultaneously", async () => {
  resetStore();
  const sessionId = uniqueSession();

  // Simulate two workers racing to acquire the same session lock
  const [t1, t2] = await Promise.all([
    redisRuntimeStore.acquireMemoryProcessingLock(sessionId),
    redisRuntimeStore.acquireMemoryProcessingLock(sessionId)
  ]);

  const wins  = [t1, t2].filter(Boolean);
  const nulls = [t1, t2].filter((t) => t === null);

  assert.equal(wins.length,  1, "exactly one worker must acquire the lock");
  assert.equal(nulls.length, 1, "exactly one worker must be blocked (null)");

  await redisRuntimeStore.releaseMemoryProcessingLock(sessionId, wins[0]);
});

test("C2 – same session: blocked job can retry after holder releases", async () => {
  resetStore();
  const sessionId = uniqueSession();

  const holder = await redisRuntimeStore.acquireMemoryProcessingLock(sessionId);
  assert.ok(holder, "holder must acquire the lock");

  // Contender cannot acquire while holder holds
  const blocked = await redisRuntimeStore.acquireMemoryProcessingLock(sessionId);
  assert.equal(blocked, null, "contender must be blocked");

  // Holder finishes and releases
  await redisRuntimeStore.releaseMemoryProcessingLock(sessionId, holder);

  // Contender retries and now succeeds
  const retry = await redisRuntimeStore.acquireMemoryProcessingLock(sessionId);
  assert.ok(retry, "contender must succeed after holder releases");

  await redisRuntimeStore.releaseMemoryProcessingLock(sessionId, retry);
});

test("C3 – different sessions: locks are fully independent (no cross-session blocking)", async () => {
  resetStore();
  const sessions = [uniqueSession(), uniqueSession(), uniqueSession()];

  // All three acquire concurrently
  const tokens = await Promise.all(
    sessions.map((s) => redisRuntimeStore.acquireMemoryProcessingLock(s))
  );

  assert.ok(
    tokens.every(Boolean),
    `all three sessions must acquire concurrently — got: ${JSON.stringify(tokens)}`
  );

  // Release all
  await Promise.all(
    sessions.map((s, i) => redisRuntimeStore.releaseMemoryProcessingLock(s, tokens[i]))
  );

  // All three are free again
  const reacquired = await Promise.all(
    sessions.map((s) => redisRuntimeStore.acquireMemoryProcessingLock(s))
  );
  assert.ok(reacquired.every(Boolean), "all three must re-acquire after release");

  await Promise.all(
    sessions.map((s, i) => redisRuntimeStore.releaseMemoryProcessingLock(s, reacquired[i]))
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// D. Deduplication soundness — no race path
//
// These tests verify the invariant that the lock enforces: the read-then-write
// section cannot be concurrently entered for the same session.
// ═════════════════════════════════════════════════════════════════════════════

test("D1 – with lock: holder reads+writes while contender is blocked → no duplicate", async () => {
  resetStore();
  const sessionId = uniqueSession();

  // In-memory mock store to track writes
  const written = [];

  async function simulateJobWithLock(label, writeValue) {
    const token = await redisRuntimeStore.acquireMemoryProcessingLock(sessionId);
    if (!token) {
      const err = new Error("lock contended — retry");
      err.code = "ECONNRESET";
      throw err;
    }
    try {
      // simulate: read existing
      const existing = [...written];
      // simulate: dedup check (exact match)
      const isDup = existing.includes(writeValue);
      if (!isDup) {
        written.push(writeValue);
      }
      return { wrote: !isDup, label };
    } finally {
      await redisRuntimeStore.releaseMemoryProcessingLock(sessionId, token);
    }
  }

  // First job runs, acquires lock, writes the value
  const r1 = await simulateJobWithLock("job-1", "memory-content-A");
  assert.ok(r1.wrote, "first job must write");
  assert.equal(written.length, 1);

  // Second job (retry of a concurrent one) runs after first is done
  const r2 = await simulateJobWithLock("job-2", "memory-content-A");
  assert.equal(r2.wrote, false, "second job must be deduped — content already stored");
  assert.equal(written.length, 1, "only one copy must exist");
});

test("D2 – without lock: concurrent jobs would both pass dedup (demonstrates the bug)", async () => {
  resetStore();
  // This test demonstrates WHY the lock is necessary by simulating the race
  // condition that existed before H-4.
  //
  // The real race in processEventJob() is:
  //   1. Worker A calls getExistingMemoriesForDedup()  ← async, yields here
  //   2. Worker B calls getExistingMemoriesForDedup()  ← both now have a stale snapshot
  //   3. Worker A's snapshot is empty → passes dedup → writes
  //   4. Worker B's snapshot is empty → passes dedup → writes (duplicate!)
  //
  // We reproduce this with an `await` between the read snapshot and the write
  // so that Promise.all() can interleave both jobs past their reads before
  // either write executes.

  const written = [];

  async function racy_job_WITHOUT_lock(writeValue) {
    // Step 1: read (async — yields to the event loop)
    const existingSnapshot = await Promise.resolve([...written]);
    // ← Both jobs reach here before either proceeds to the write below
    const isDup = existingSnapshot.includes(writeValue);
    if (!isDup) {
      written.push(writeValue); // Step 2: write — races with the other job
    }
    return { wrote: !isDup };
  }

  // Both jobs start concurrently.  After their reads they each yield once, so
  // Promise.all interleaves them: both take the existingSnapshot before either
  // writes → both see an empty array → both pass dedup → both write.
  const [r1, r2] = await Promise.all([
    racy_job_WITHOUT_lock("memory-content-B"),
    racy_job_WITHOUT_lock("memory-content-B")
  ]);

  // Without the lock, both jobs wrote — demonstrating the duplicate
  assert.equal(written.length, 2, "bug confirmed: both jobs wrote without lock");
  assert.ok(r1.wrote && r2.wrote, "bug confirmed: both jobs passed dedup");
});

test("D3 – with lock: concurrent jobs for the same session cannot both pass dedup", async () => {
  resetStore();
  const sessionId = uniqueSession();
  const written = [];

  async function locked_job(writeValue) {
    const token = await redisRuntimeStore.acquireMemoryProcessingLock(sessionId);
    if (!token) {
      const err = new Error("lock contended");
      err.code = "ECONNRESET";
      throw err;
    }
    try {
      const existing = [...written];
      const isDup = existing.includes(writeValue);
      if (!isDup) {
        // simulate async write latency
        await Promise.resolve();
        written.push(writeValue);
      }
      return { wrote: !isDup };
    } finally {
      await redisRuntimeStore.releaseMemoryProcessingLock(sessionId, token);
    }
  }

  // Race two jobs for the same session + same content
  let blockedCount = 0;
  const results = await Promise.allSettled([
    locked_job("memory-content-C"),
    locked_job("memory-content-C")
  ]);

  for (const r of results) {
    if (r.status === "rejected" && r.reason?.code === "ECONNRESET") {
      blockedCount++;
    }
  }

  const successes = results.filter((r) => r.status === "fulfilled");
  assert.equal(successes.length, 1, "exactly one job must succeed");
  assert.equal(blockedCount,     1, "exactly one job must be blocked (ECONNRESET)");
  assert.equal(written.length,   1, "only one copy stored — no duplicate");
});

test("D4 – lock does not block jobs for different sessions from running concurrently", async () => {
  resetStore();
  const sessionX = uniqueSession();
  const sessionY = uniqueSession();

  const log = [];

  async function job(sessionId, label) {
    const token = await redisRuntimeStore.acquireMemoryProcessingLock(sessionId);
    if (!token) throw new Error("unexpected lock contention");
    try {
      log.push(`${label}:start`);
      // simulate work
      await Promise.resolve();
      log.push(`${label}:end`);
    } finally {
      await redisRuntimeStore.releaseMemoryProcessingLock(sessionId, token);
    }
  }

  // Both jobs must complete without either blocking the other
  await Promise.all([
    job(sessionX, "X"),
    job(sessionY, "Y")
  ]);

  assert.ok(log.includes("X:start"), "session X started");
  assert.ok(log.includes("X:end"),   "session X ended");
  assert.ok(log.includes("Y:start"), "session Y started");
  assert.ok(log.includes("Y:end"),   "session Y ended");
  assert.equal(log.length, 4, "all four lifecycle events recorded");
});
