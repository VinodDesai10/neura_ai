/**
 * apps/api/test/memory-processor-embedding-cache.test.js
 *
 * Regression tests for H-2: the unbounded module-level `embeddingCache = new Map()`
 * must be absent from memory-processor.js.  Embedding caching must be
 * handled exclusively by openAIAdapter.embedText() via redisRuntimeStore
 * (TTL-backed, no unbounded in-process Map).
 *
 * Test matrix
 * ───────────
 *   A. Structural – memory-processor.js contains no module-level unbounded Map
 *   B. redisRuntimeStore  – cache miss stores the embedding; cache hit returns it
 *   C. redisRuntimeStore  – TTL-variant selection (short text / memory prefix / default)
 *   D. openAIAdapter.embedText – cache hit path: returns cached value, skips API
 *   E. openAIAdapter.embedText – cache miss path: caches result from API call
 *   F. openAIAdapter.embedText – null embedding from API is not cached
 *
 * No Redis, OpenAI, Postgres, Qdrant, or Neo4j connections are used.
 * All caching uses the in-process TTL fallback inside redisRuntimeStore.
 */

import test     from "node:test";
import assert   from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath }    from "node:url";

// Silence pino output
process.env.LOG_LEVEL = "silent";
// No OpenAI API key → embedText will use null (no network call)
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_BASE_URL;

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Modules under test ────────────────────────────────────────────────────────

import { redisRuntimeStore } from "../src/infrastructure/redis-runtime-store.js";

// openAIAdapter is imported AFTER env vars are set so it picks up the key state
import { openAIAdapter } from "../src/services/openai-adapter.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Fake embedding vector (1 536-d mimicking text-embedding-3-small). */
function fakeEmbedding(seed = 0) {
  return Array.from({ length: 8 }, (_, i) => (i + seed) * 0.01);
}

/**
 * Reset the redisRuntimeStore in-process fallback between tests so cache
 * entries from one test don't bleed into another.
 */
function resetStore() {
  redisRuntimeStore.clearLocalStorage();
}

// ─────────────────────────────────────────────────────────────────────────────
// A. Structural – no unbounded Map in memory-processor.js
// ─────────────────────────────────────────────────────────────────────────────

test("A1 – memory-processor.js contains no module-level `embeddingCache = new Map()`", () => {
  const filePath = resolve(__dirname, "../src/services/memory-processor.js");
  const source   = readFileSync(filePath, "utf8");

  // The exact declaration that was removed
  assert.ok(
    !source.includes("embeddingCache = new Map()"),
    "Found `embeddingCache = new Map()` — unbounded cache was not removed"
  );
});

test("A2 – memory-processor.js contains no reference to `embeddingCache`", () => {
  const filePath = resolve(__dirname, "../src/services/memory-processor.js");
  const source   = readFileSync(filePath, "utf8");

  assert.ok(
    !source.includes("embeddingCache"),
    "Found `embeddingCache` reference — unbounded cache was not fully removed"
  );
});

test("A3 – memory-processor.js delegates embedding to openAIAdapter.embedText", () => {
  const filePath = resolve(__dirname, "../src/services/memory-processor.js");
  const source   = readFileSync(filePath, "utf8");

  assert.ok(
    source.includes("openAIAdapter.embedText"),
    "Expected `openAIAdapter.embedText` call in memory-processor.js"
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// B. redisRuntimeStore – cache miss / cache hit round-trip
// ─────────────────────────────────────────────────────────────────────────────

test("B1 – getCachedEmbedding returns null on cache miss", async () => {
  resetStore();
  const result = await redisRuntimeStore.getCachedEmbedding({
    model: "text-embedding-3-small",
    text:  "episodic: user went to the gym"
  });
  assert.equal(result, null, "Expected null on miss");
});

test("B2 – setCachedEmbedding stores and getCachedEmbedding retrieves the embedding", async () => {
  resetStore();
  const model     = "text-embedding-3-small";
  const text      = "episodic: user went to the gym";
  const embedding = fakeEmbedding(1);

  await redisRuntimeStore.setCachedEmbedding({ model, text, embedding });

  const cached = await redisRuntimeStore.getCachedEmbedding({ model, text });
  assert.ok(cached !== null, "Expected a cache hit");
  assert.deepEqual(cached.embedding, embedding, "Cached embedding should match stored value");
});

test("B3 – different texts produce independent cache entries", async () => {
  resetStore();
  const model  = "text-embedding-3-small";
  const text1  = "episodic: visited Paris";
  const text2  = "semantic: concept of travel";
  const emb1   = fakeEmbedding(10);
  const emb2   = fakeEmbedding(20);

  await redisRuntimeStore.setCachedEmbedding({ model, text: text1, embedding: emb1 });
  await redisRuntimeStore.setCachedEmbedding({ model, text: text2, embedding: emb2 });

  const cached1 = await redisRuntimeStore.getCachedEmbedding({ model, text: text1 });
  const cached2 = await redisRuntimeStore.getCachedEmbedding({ model, text: text2 });

  assert.deepEqual(cached1.embedding, emb1);
  assert.deepEqual(cached2.embedding, emb2);
  assert.notDeepEqual(cached1.embedding, cached2.embedding);
});

test("B4 – setCachedEmbedding does not cache a non-array value (null guard)", async () => {
  resetStore();
  const model = "text-embedding-3-small";
  const text  = "factual: user name is Alice";

  // null is not an Array — the store should silently reject it
  await redisRuntimeStore.setCachedEmbedding({ model, text, embedding: null });

  const cached = await redisRuntimeStore.getCachedEmbedding({ model, text });
  assert.equal(cached, null, "null embedding must not be stored");
});

test("B5 – cached entry includes model and textHash metadata", async () => {
  resetStore();
  const model     = "text-embedding-3-small";
  const text      = "semantic: machine learning fundamentals";
  const embedding = fakeEmbedding(5);

  await redisRuntimeStore.setCachedEmbedding({ model, text, embedding });

  const cached = await redisRuntimeStore.getCachedEmbedding({ model, text });
  assert.equal(cached.model, model, "model should be stored in cache entry");
  assert.ok(typeof cached.textHash === "string" && cached.textHash.length > 0, "textHash should be stored");
  assert.ok(typeof cached.createdAt === "string", "createdAt should be stored");
});

// ─────────────────────────────────────────────────────────────────────────────
// C. redisRuntimeStore – TTL variant selection
// ─────────────────────────────────────────────────────────────────────────────

test("C1 – store accepts and retrieves a short text embedding (short-TTL path)", async () => {
  resetStore();
  // A very short text triggers the short-TTL branch in getEmbeddingTtlSeconds()
  const text      = "hi";
  const model     = "text-embedding-3-small";
  const embedding = fakeEmbedding(3);

  await redisRuntimeStore.setCachedEmbedding({ model, text, embedding });
  const cached = await redisRuntimeStore.getCachedEmbedding({ model, text });

  assert.ok(cached !== null);
  assert.deepEqual(cached.embedding, embedding);
});

test("C2 – store accepts and retrieves a memory-type embedding (memory-TTL path)", async () => {
  resetStore();
  // Text containing a memory-type prefix triggers the memory-TTL branch
  const text      = "factual: user's name is Bob";
  const model     = "text-embedding-3-small";
  const embedding = fakeEmbedding(7);

  await redisRuntimeStore.setCachedEmbedding({ model, text, embedding });
  const cached = await redisRuntimeStore.getCachedEmbedding({ model, text });

  assert.ok(cached !== null);
  assert.deepEqual(cached.embedding, embedding);
});

// ─────────────────────────────────────────────────────────────────────────────
// D. openAIAdapter.embedText – cache hit path
// ─────────────────────────────────────────────────────────────────────────────

test("D1 – embedText returns cached embedding without calling the OpenAI API", async () => {
  resetStore();
  const model     = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
  const text      = "episodic: user solved a difficult puzzle";
  const embedding = fakeEmbedding(99);

  // Pre-populate the cache directly via the store
  await redisRuntimeStore.setCachedEmbedding({ model, text, embedding });

  // embedText should return the cached value — no network call can succeed
  // in this environment (no OPENAI_API_KEY / OPENAI_BASE_URL set)
  const result = await openAIAdapter.embedText(text);

  assert.deepEqual(result, embedding, "embedText should return the pre-cached embedding");
});

test("D2 – embedText returns cached embedding on a second call (same text)", async () => {
  resetStore();
  const model     = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
  const text      = "semantic: concept of distributed systems";
  const embedding = fakeEmbedding(42);

  // Seed the cache
  await redisRuntimeStore.setCachedEmbedding({ model, text, embedding });

  const r1 = await openAIAdapter.embedText(text);
  const r2 = await openAIAdapter.embedText(text);

  assert.deepEqual(r1, embedding, "first call should hit cache");
  assert.deepEqual(r2, embedding, "second call should also hit cache");
  assert.deepEqual(r1, r2, "both calls must return identical result");
});

// ─────────────────────────────────────────────────────────────────────────────
// E. openAIAdapter.embedText – cache miss path
// ─────────────────────────────────────────────────────────────────────────────

test("E1 – embedText on cache miss returns null when no API is configured", async () => {
  resetStore();
  // No OPENAI_API_KEY and no OPENAI_BASE_URL → adapter returns null (no fallback reply)
  const result = await openAIAdapter.embedText("episodic: user attended a conference");
  assert.equal(result, null, "embedText should return null when no API is configured");
});

test("E2 – null returned by embedText is NOT stored in cache (no poisoned entry)", async () => {
  resetStore();
  const model = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
  const text  = "episodic: user attended a conference";

  await openAIAdapter.embedText(text);

  // The cache should still be empty for this text
  const cached = await redisRuntimeStore.getCachedEmbedding({ model, text });
  assert.equal(cached, null, "null embedding must not poison the cache");
});

// ─────────────────────────────────────────────────────────────────────────────
// F. openAIAdapter.embedText – model key isolation
// ─────────────────────────────────────────────────────────────────────────────

test("F1 – different embedding models produce independent cache keys", async () => {
  resetStore();
  const text  = "factual: user prefers dark mode";
  const emb1  = fakeEmbedding(11);
  const emb2  = fakeEmbedding(22);

  await redisRuntimeStore.setCachedEmbedding({ model: "model-A", text, embedding: emb1 });
  await redisRuntimeStore.setCachedEmbedding({ model: "model-B", text, embedding: emb2 });

  const c1 = await redisRuntimeStore.getCachedEmbedding({ model: "model-A", text });
  const c2 = await redisRuntimeStore.getCachedEmbedding({ model: "model-B", text });

  assert.deepEqual(c1.embedding, emb1, "model-A entry should be independent");
  assert.deepEqual(c2.embedding, emb2, "model-B entry should be independent");
  assert.notDeepEqual(c1.embedding, c2.embedding, "different models must not share cache entries");
});

test("F2 – clearLocalStorage wipes all cached entries (store reset works)", async () => {
  resetStore();
  const model     = "text-embedding-3-small";
  const text      = "factual: user's timezone is IST";
  const embedding = fakeEmbedding(33);

  await redisRuntimeStore.setCachedEmbedding({ model, text, embedding });
  assert.ok((await redisRuntimeStore.getCachedEmbedding({ model, text })) !== null, "Should be cached");

  redisRuntimeStore.clearLocalStorage();

  const afterClear = await redisRuntimeStore.getCachedEmbedding({ model, text });
  assert.equal(afterClear, null, "Cache should be empty after clearLocalStorage");
});
