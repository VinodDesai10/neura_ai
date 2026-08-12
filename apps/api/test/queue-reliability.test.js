/**
 * test/queue-reliability.test.js
 *
 * Integration test suite for the AiNeura memory-queue reliability stack.
 *
 * Test matrix:
 *   A. Job metadata & idempotency key stability
 *   B. Error classifier — transient / permanent / unknown
 *   C. Retry policy — shouldRetry, calculateBackoffMs, buildRetryPayload
 *   D. Backoff delay bounds and jitter
 *   E. Successful job processing (first attempt)
 *   F. Transient failure then success (retry → succeed)
 *   G. Permanent failure — no retry, immediate DLQ
 *   H. Retries exhausted → DLQ
 *   I. Duplicate job skipped (idempotency)
 *   J. DLQ — push / list / inspect / remove / size
 *   K. DLQ requeue resets attempt counter
 *   L. Metrics counters increment correctly
 *
 * No Redis, no OpenAI, no file-system I/O — all modules use their local
 * in-process fallback when Redis is unavailable.
 */

import test   from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// ── Silence pino output ───────────────────────────────────────────────────────
process.env.LOG_LEVEL = "silent";

// ── Modules under test ────────────────────────────────────────────────────────

import {
  buildIdempotencyKey,
  attachJobMetadata,
  getMaxAttempts,
  idempotencyRedisKey
} from "../src/queue/job-metadata.js";

import {
  classifyError,
  isRetryable,
  TRANSIENT,
  PERMANENT,
  UNKNOWN
} from "../src/queue/error-classifier.js";

import {
  shouldRetry,
  calculateBackoffMs,
  buildRetryPayload,
  serializeError,
  getBackoffBaseMs,
  getBackoffMaxMs
} from "../src/queue/retry-policy.js";

import { deadLetterQueue }   from "../src/queue/dead-letter-queue.js";
import {
  runWithReliability,
  checkDuplicate,
  markJobCompleted,
  _clearLocalIdempotency
} from "../src/queue/queue-reliability.js";
import { metrics }           from "../src/queue/metrics.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal valid job payload with a UNIQUE id every call.
 * This prevents idempotency key collisions between tests.
 */
function makeJob(overrides = {}) {
  const uid       = randomUUID();
  const eventId   = overrides.eventId   || uid;
  const sessionId = overrides.sessionId || `sess-${uid}`;
  const content   = overrides.content   || `content-${uid}`;

  const base = {
    type:      "process-event-into-memories",
    sessionId,
    userId:    "user-test",
    eventId,
    event: {
      id:        eventId,
      sessionId,
      role:      "user",
      content
    }
  };

  // Allow full override of any field
  const merged = { ...base, ...overrides };
  // If caller supplied event overrides merge them too
  if (overrides.event) merged.event = { ...base.event, ...overrides.event };

  return attachJobMetadata(merged);
}

/** No-op logger so pino child calls don't produce output. */
function silentLogger() {
  const noop = () => {};
  return { info: noop, debug: noop, warn: noop, error: noop, fatal: noop };
}

/** Fast backoff opts so retry tests complete in milliseconds. */
const FAST = { backoffBaseMs: 1, backoffMaxMs: 5 };

/** Reset all in-process mutable state before each async test. */
function resetState() {
  deadLetterQueue._clearLocal();
  _clearLocalIdempotency();
  metrics._reset();
}

// ─────────────────────────────────────────────────────────────────────────────
// A. Job metadata & idempotency key stability
// ─────────────────────────────────────────────────────────────────────────────

test("A1 – attachJobMetadata adds all required fields", () => {
  const job = makeJob();
  assert.ok(typeof job.jobId === "string" && job.jobId.length > 0, "jobId present");
  assert.equal(job.jobType, "process-event-into-memories");
  assert.ok(typeof job.sessionId === "string");
  assert.ok(typeof job.createdAt === "string");
  assert.equal(job.attempt, 1);
  assert.equal(job.maxAttempts, getMaxAttempts());
  assert.ok(typeof job.idempotencyKey === "string" && job.idempotencyKey.length > 0);
});

test("A2 – idempotency key is deterministic (same inputs → same key)", () => {
  const p = { jobType: "process-event-into-memories", sessionId: "s1", eventId: "e1", content: "hello" };
  assert.equal(buildIdempotencyKey(p), buildIdempotencyKey(p));
});

test("A3 – idempotency key differs when any input differs", () => {
  const b = { jobType: "t", sessionId: "s", eventId: "e", content: "a" };
  assert.notEqual(buildIdempotencyKey(b), buildIdempotencyKey({ ...b, eventId: "e2" }));
  assert.notEqual(buildIdempotencyKey(b), buildIdempotencyKey({ ...b, sessionId: "s2" }));
  assert.notEqual(buildIdempotencyKey(b), buildIdempotencyKey({ ...b, content: "b" }));
});

test("A4 – attachJobMetadata preserves existing jobId and createdAt on retry", () => {
  const original = makeJob();
  const retry    = attachJobMetadata({ ...original, attempt: 2 });
  assert.equal(retry.jobId, original.jobId);
  assert.equal(retry.createdAt, original.createdAt);
  assert.equal(retry.idempotencyKey, original.idempotencyKey);
});

test("A5 – idempotencyRedisKey uses prefix", () => {
  const key = idempotencyRedisKey("abc123", "neura");
  assert.ok(key.startsWith("neura:idempotency:"));
  assert.ok(key.includes("abc123"));
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Error classifier
// ─────────────────────────────────────────────────────────────────────────────

test("B1  – ECONNRESET → transient", () =>
  assert.equal(classifyError(Object.assign(new Error("x"), { code: "ECONNRESET" })).category, TRANSIENT));

test("B2  – ETIMEDOUT → transient", () =>
  assert.equal(classifyError(Object.assign(new Error("x"), { code: "ETIMEDOUT" })).category, TRANSIENT));

test("B3  – HTTP 429 → transient", () =>
  assert.equal(classifyError(Object.assign(new Error("x"), { status: 429 })).category, TRANSIENT));

test("B4  – HTTP 500 → transient", () =>
  assert.equal(classifyError(Object.assign(new Error("x"), { status: 500 })).category, TRANSIENT));

test("B5  – HTTP 503 → transient", () =>
  assert.equal(classifyError(Object.assign(new Error("x"), { status: 503 })).category, TRANSIENT));

test("B6  – message 'timeout' → transient", () =>
  assert.equal(classifyError(new Error("Request timeout after 5000ms")).category, TRANSIENT));

test("B7  – message 'rate limit' → transient", () =>
  assert.equal(classifyError(new Error("OpenAI rate limit exceeded")).category, TRANSIENT));

test("B8  – TypeError → permanent", () =>
  assert.equal(classifyError(new TypeError("Cannot read properties of undefined")).category, PERMANENT));

test("B9  – SyntaxError → permanent", () =>
  assert.equal(classifyError(new SyntaxError("Unexpected token")).category, PERMANENT));

test("B10 – HTTP 400 → permanent", () =>
  assert.equal(classifyError(Object.assign(new Error("x"), { status: 400 })).category, PERMANENT));

test("B11 – HTTP 422 → permanent", () =>
  assert.equal(classifyError(Object.assign(new Error("x"), { status: 422 })).category, PERMANENT));

test("B12 – message 'invalid payload' → permanent", () =>
  assert.equal(classifyError(new Error("invalid payload schema")).category, PERMANENT));

test("B13 – message 'missing required' → permanent", () =>
  assert.equal(classifyError(new Error("missing required field: sessionId")).category, PERMANENT));

test("B14 – unrecognised error → unknown", () =>
  assert.equal(classifyError(new Error("something nobody has ever seen")).category, UNKNOWN));

test("B15 – explicit permanent flag → permanent", () =>
  assert.equal(classifyError(Object.assign(new Error("x"), { permanent: true })).category, PERMANENT));

test("B16 – isRetryable: transient → true", () =>
  assert.ok(isRetryable(Object.assign(new Error("x"), { code: "ECONNRESET" }))));

test("B17 – isRetryable: permanent → false", () =>
  assert.equal(isRetryable(new TypeError("bad")), false));

test("B18 – isRetryable: unknown → true (conservative)", () =>
  assert.ok(isRetryable(new Error("mystery error nobody recognises"))));

// ─────────────────────────────────────────────────────────────────────────────
// C. Retry policy
// ─────────────────────────────────────────────────────────────────────────────

test("C1 – shouldRetry: transient with attempts remaining → true", () =>
  assert.ok(shouldRetry({ attempt: 1, maxAttempts: 5 }, TRANSIENT)));

test("C2 – shouldRetry: transient at maxAttempts → false", () =>
  assert.equal(shouldRetry({ attempt: 5, maxAttempts: 5 }, TRANSIENT), false));

test("C3 – shouldRetry: permanent always false", () => {
  assert.equal(shouldRetry({ attempt: 1, maxAttempts: 5 }, PERMANENT), false);
  assert.equal(shouldRetry({ attempt: 3, maxAttempts: 5 }, PERMANENT), false);
});

test("C4 – shouldRetry: unknown with attempts remaining → true", () =>
  assert.ok(shouldRetry({ attempt: 2, maxAttempts: 5 }, UNKNOWN)));

test("C5 – buildRetryPayload increments attempt and records error", () => {
  const job  = makeJob();
  const next = buildRetryPayload(job, new Error("fail"), TRANSIENT);
  assert.equal(next.attempt, 2);
  assert.equal(next.lastErrorCategory, TRANSIENT);
  assert.ok(next.lastError);
  assert.equal(next.lastError.message, "fail");
  assert.ok(next.retriedAt);
});

test("C6 – serializeError produces safe object", () => {
  const s = serializeError(Object.assign(new Error("oops"), { code: "ECONNRESET", status: 503 }));
  assert.equal(s.message, "oops");
  assert.equal(s.name, "Error");
  assert.equal(s.code, "ECONNRESET");
  assert.equal(s.status, 503);
  assert.ok(typeof s.stack === "string");
});

test("C7 – serializeError handles non-Error", () => {
  const s = serializeError("plain string");
  assert.equal(s.message, "plain string");
  assert.equal(s.name, "UnknownError");
});

// ─────────────────────────────────────────────────────────────────────────────
// D. Backoff delay bounds and jitter
// ─────────────────────────────────────────────────────────────────────────────

test("D1 – backoff sequence is exponential (no jitter)", () => {
  assert.equal(calculateBackoffMs(1, { baseMs: 1000, maxMs: 30_000, jitter: 0 }), 1000);
  assert.equal(calculateBackoffMs(2, { baseMs: 1000, maxMs: 30_000, jitter: 0 }), 2000);
  assert.equal(calculateBackoffMs(3, { baseMs: 1000, maxMs: 30_000, jitter: 0 }), 4000);
  assert.equal(calculateBackoffMs(4, { baseMs: 1000, maxMs: 30_000, jitter: 0 }), 8000);
  assert.equal(calculateBackoffMs(5, { baseMs: 1000, maxMs: 30_000, jitter: 0 }), 16000);
});

test("D2 – backoff never exceeds maxMs", () => {
  for (let i = 1; i <= 20; i++) {
    const d = calculateBackoffMs(i, { baseMs: 1000, maxMs: 5000, jitter: 0 });
    assert.ok(d <= 5000, `attempt ${i} delay ${d} exceeded maxMs`);
  }
});

test("D3 – jitter stays within ±20% bounds (100 samples)", () => {
  for (let i = 0; i < 100; i++) {
    const d = calculateBackoffMs(1, { baseMs: 1000, maxMs: 30_000, jitter: 0.2 });
    assert.ok(d >= 800 && d <= 1200, `jitter out of range: ${d}`);
  }
});

test("D4 – default config reads from env (returns positive number)", () => {
  const d = calculateBackoffMs(1);
  assert.ok(d > 0);
  assert.ok(d <= getBackoffMaxMs() * 1.25);
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Successful job processing
// ─────────────────────────────────────────────────────────────────────────────

test("E1 – success on first attempt: outcome=completed, metrics incremented", async () => {
  resetState();
  const job    = makeJob();
  const result = await runWithReliability(job, async () => ({ stored: 2, skipped: false }), silentLogger());

  assert.equal(result.outcome, "completed");
  assert.equal(result.stored, 2);
  assert.equal(result.skipped, false);
  assert.ok(result.durationMs >= 0);

  const snap = metrics.snapshot();
  assert.equal(snap.jobs_processed_total, 1);
  assert.equal(snap.jobs_failed_total, 0);
  assert.equal(snap.jobs_retried_total, 0);
  assert.equal(snap.jobs_dead_lettered_total, 0);
});

test("E2 – completed job writes idempotency marker", async () => {
  resetState();
  const job = makeJob();
  await runWithReliability(job, async () => ({ stored: 1, skipped: false }), silentLogger());
  assert.ok(await checkDuplicate(job));
});

// ─────────────────────────────────────────────────────────────────────────────
// F. Transient failure then success
// ─────────────────────────────────────────────────────────────────────────────

test("F1 – transient failure on attempt 1, success on attempt 2", async () => {
  resetState();
  let calls = 0;
  const result = await runWithReliability(
    makeJob({ maxAttempts: 5 }),
    async () => {
      if (++calls === 1) throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
      return { stored: 1, skipped: false };
    },
    silentLogger(),
    FAST
  );

  assert.equal(calls, 2);
  assert.equal(result.outcome, "completed");

  const snap = metrics.snapshot();
  assert.equal(snap.jobs_processed_total, 1);
  assert.equal(snap.jobs_failed_total, 1);
  assert.equal(snap.jobs_retried_total, 1);
  assert.equal(snap.jobs_dead_lettered_total, 0);
});

test("F2 – two transient failures then success: 3 handler calls", async () => {
  resetState();
  let calls = 0;
  const result = await runWithReliability(
    makeJob({ maxAttempts: 5 }),
    async () => {
      if (++calls < 3) throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
      return { stored: 3, skipped: false };
    },
    silentLogger(),
    FAST
  );

  assert.equal(calls, 3);
  assert.equal(result.outcome, "completed");
  assert.equal(result.stored, 3);
  assert.equal(metrics.snapshot().jobs_retried_total, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// G. Permanent failure — no retry, immediate DLQ
// ─────────────────────────────────────────────────────────────────────────────

test("G1 – permanent TypeError: single attempt, immediate DLQ", async () => {
  resetState();
  let calls = 0;
  const result = await runWithReliability(
    makeJob({ maxAttempts: 5 }),
    async () => { calls++; throw new TypeError("cannot read properties of undefined"); },
    silentLogger()
  );

  assert.equal(calls, 1, "only one attempt");
  assert.equal(result.outcome, "dead_lettered");
  assert.equal(await deadLetterQueue.size(), 1);

  const [rec] = await deadLetterQueue.list(1);
  assert.equal(rec.errorCategory, PERMANENT);
  assert.equal(rec.attempts, 1);
  assert.ok(rec.error.message.includes("cannot read properties"));
  assert.ok(rec.failedAt);

  const snap = metrics.snapshot();
  assert.equal(snap.jobs_failed_total, 1);
  assert.equal(snap.jobs_retried_total, 0);
  assert.equal(snap.jobs_dead_lettered_total, 1);
  assert.equal(snap.jobs_processed_total, 0);
});

test("G2 – explicit permanent flag stops immediately", async () => {
  resetState();
  const result = await runWithReliability(
    makeJob({ maxAttempts: 5 }),
    async () => { const e = new Error("invalid payload"); e.permanent = true; throw e; },
    silentLogger()
  );

  assert.equal(result.outcome, "dead_lettered");
  const [rec] = await deadLetterQueue.list(1);
  assert.equal(rec.errorCategory, PERMANENT);
});

// ─────────────────────────────────────────────────────────────────────────────
// H. Retries exhausted → DLQ
// ─────────────────────────────────────────────────────────────────────────────

test("H1 – transient failures exhausting maxAttempts=3 → DLQ", async () => {
  resetState();
  let calls = 0;
  const result = await runWithReliability(
    makeJob({ maxAttempts: 3 }),
    async () => { calls++; throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" }); },
    silentLogger(),
    FAST
  );

  assert.equal(calls, 3, "all 3 attempts exhausted");
  assert.equal(result.outcome, "dead_lettered");

  const [rec] = await deadLetterQueue.list(1);
  assert.equal(rec.attempts, 3);
  assert.equal(rec.errorCategory, TRANSIENT);
  assert.ok(rec.error.stack, "stack preserved in DLQ record");

  const snap = metrics.snapshot();
  assert.equal(snap.jobs_retried_total, 2);
  assert.equal(snap.jobs_dead_lettered_total, 1);
});

test("H2 – unknown error exhausting maxAttempts=2 → DLQ", async () => {
  resetState();
  const result = await runWithReliability(
    makeJob({ maxAttempts: 2 }),
    async () => { throw new Error("strange unclassified failure nobody expected"); },
    silentLogger(),
    FAST
  );

  assert.equal(result.outcome, "dead_lettered");
  const [rec] = await deadLetterQueue.list(1);
  assert.equal(rec.errorCategory, UNKNOWN);
});

// ─────────────────────────────────────────────────────────────────────────────
// I. Duplicate job skipped (idempotency)
// ─────────────────────────────────────────────────────────────────────────────

test("I1 – second identical job is skipped without calling handler", async () => {
  resetState();
  let calls = 0;
  const job = makeJob();
  const h   = async () => { calls++; return { stored: 1, skipped: false }; };

  const r1 = await runWithReliability(job, h, silentLogger());
  const r2 = await runWithReliability(job, h, silentLogger());

  assert.equal(r1.outcome, "completed");
  assert.equal(r2.outcome, "skipped_duplicate");
  assert.equal(r2.skipped, true);
  assert.equal(calls, 1, "handler NOT called on duplicate");
  assert.equal(metrics.snapshot().jobs_duplicate_skipped_total, 1);
});

test("I2 – different eventIds produce different keys and both process", async () => {
  resetState();
  let calls = 0;
  const h = async () => { calls++; return { stored: 1, skipped: false }; };

  const jA = makeJob();
  const jB = makeJob();  // different UUID → different idempotency key
  assert.notEqual(jA.idempotencyKey, jB.idempotencyKey);

  await runWithReliability(jA, h, silentLogger());
  const r2 = await runWithReliability(jB, h, silentLogger());

  assert.equal(r2.outcome, "completed");
  assert.equal(calls, 2);
});

test("I3 – checkDuplicate false before, true after markJobCompleted", async () => {
  resetState();
  const job = makeJob();
  assert.equal(await checkDuplicate(job), false);
  await markJobCompleted(job);
  assert.equal(await checkDuplicate(job), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// J. DLQ operations
// ─────────────────────────────────────────────────────────────────────────────

test("J1 – push stores record retrievable by inspect", async () => {
  resetState();
  const job = makeJob();
  const rec = await deadLetterQueue.push(job, new Error("fatal"), PERMANENT);

  assert.equal(rec.jobId, job.jobId);
  assert.equal(rec.errorCategory, PERMANENT);
  assert.equal(rec.attempts, 1);
  assert.ok(rec.failedAt);
  assert.deepEqual(rec.originalJob, job);

  const fetched = await deadLetterQueue.inspect(job.jobId);
  assert.ok(fetched);
  assert.equal(fetched.jobId, job.jobId);
});

test("J2 – list returns records most-recently-added first", async () => {
  resetState();
  const jobs = [makeJob(), makeJob(), makeJob()];
  for (const j of jobs) await deadLetterQueue.push(j, new Error("e"), TRANSIENT);

  const records = await deadLetterQueue.list(10);
  assert.equal(records.length, 3);
  assert.equal(records[0].jobId, jobs[2].jobId);
  assert.equal(records[1].jobId, jobs[1].jobId);
  assert.equal(records[2].jobId, jobs[0].jobId);
});

test("J3 – size returns correct count", async () => {
  resetState();
  assert.equal(await deadLetterQueue.size(), 0);
  await deadLetterQueue.push(makeJob(), new Error("a"), TRANSIENT);
  assert.equal(await deadLetterQueue.size(), 1);
  await deadLetterQueue.push(makeJob(), new Error("b"), PERMANENT);
  assert.equal(await deadLetterQueue.size(), 2);
});

test("J4 – remove deletes record and decrements size", async () => {
  resetState();
  const job = makeJob();
  await deadLetterQueue.push(job, new Error("x"), UNKNOWN);
  assert.equal(await deadLetterQueue.size(), 1);

  const removed = await deadLetterQueue.remove(job.jobId);
  assert.ok(removed);
  assert.equal(await deadLetterQueue.size(), 0);
  assert.equal(await deadLetterQueue.inspect(job.jobId), null);
});

test("J5 – inspect returns null for unknown jobId", async () => {
  resetState();
  assert.equal(await deadLetterQueue.inspect("nonexistent-id"), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// K. DLQ requeue
// ─────────────────────────────────────────────────────────────────────────────

test("K1 – requeue returns original job with attempt reset to 1", async () => {
  resetState();
  const job = makeJob({ maxAttempts: 3 });
  await deadLetterQueue.push({ ...job, attempt: 3 }, new Error("exhausted"), TRANSIENT);

  const requeued = await deadLetterQueue.requeue(job.jobId);
  assert.ok(requeued);
  assert.equal(requeued.attempt, 1);
  assert.ok(requeued.requeuedFromDlq);
  assert.equal(requeued.jobType, job.jobType);
  assert.equal(requeued.sessionId, job.sessionId);
});

test("K2 – requeue does NOT remove the DLQ record (caller removes it)", async () => {
  resetState();
  const job = makeJob();
  await deadLetterQueue.push(job, new Error("e"), PERMANENT);
  await deadLetterQueue.requeue(job.jobId);
  assert.ok(await deadLetterQueue.inspect(job.jobId), "record still present");
});

// ─────────────────────────────────────────────────────────────────────────────
// L. Metrics counters
// ─────────────────────────────────────────────────────────────────────────────

test("L1 – snapshot returns zero counters initially", () => {
  metrics._reset();
  const snap = metrics.snapshot();
  assert.equal(snap.jobs_processed_total, 0);
  assert.equal(snap.jobs_failed_total, 0);
  assert.equal(snap.jobs_retried_total, 0);
  assert.equal(snap.jobs_dead_lettered_total, 0);
  assert.equal(snap.jobs_duplicate_skipped_total, 0);
});

test("L2 – each counter increments independently", () => {
  metrics._reset();
  metrics.jobProcessed({ jobId: "a", jobType: "t", sessionId: "s", durationMs: 10 });
  metrics.jobProcessed({ jobId: "b", jobType: "t", sessionId: "s", durationMs: 10 });
  metrics.jobFailed({ jobId: "c", jobType: "t", sessionId: "s", attempt: 1, errorCategory: TRANSIENT });
  metrics.jobRetried({ jobId: "c", jobType: "t", sessionId: "s", attempt: 1, delayMs: 1 });
  metrics.jobDeadLettered({ jobId: "d", jobType: "t", sessionId: "s", attempts: 5 });
  metrics.jobDuplicateSkipped({ jobId: "e", jobType: "t", sessionId: "s", idempotencyKey: "k" });

  const snap = metrics.snapshot();
  assert.equal(snap.jobs_processed_total, 2);
  assert.equal(snap.jobs_failed_total, 1);
  assert.equal(snap.jobs_retried_total, 1);
  assert.equal(snap.jobs_dead_lettered_total, 1);
  assert.equal(snap.jobs_duplicate_skipped_total, 1);
});

test("L3 – full transient-retry-success scenario: correct metric counts", async () => {
  resetState();
  let calls = 0;
  await runWithReliability(
    makeJob({ maxAttempts: 5 }),
    async () => {
      if (++calls < 4) throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
      return { stored: 1, skipped: false };
    },
    silentLogger(),
    FAST
  );

  const snap = metrics.snapshot();
  assert.equal(snap.jobs_failed_total, 3);
  assert.equal(snap.jobs_retried_total, 3);
  assert.equal(snap.jobs_processed_total, 1);
  assert.equal(snap.jobs_dead_lettered_total, 0);
});
