/**
 * apps/api/test/cross-conversation-memory.test.js
 *
 * End-to-end regression tests for cross-conversation factual memory retrieval.
 *
 * Scenario:
 *   Chat A (session-a) – user says "my name is Vinod"; memory is extracted and
 *                         stored in factualMemoryStore with userId.
 *   Chat B (session-b) – user asks "do you know my name?"; the retrieval
 *                         pipeline must surface the memory from session-a
 *                         because both sessions share the same userId.
 *
 * Test matrix
 * ───────────
 *   A. factualMemoryStore.upsert() + findRelevant() (in-memory fallback)
 *      A1 – memory stored in session-a is returned when queried from session-b
 *           using the same userId
 *      A2 – memory is NOT returned when queried from session-b with NO userId
 *      A3 – memory is NOT returned when queried with a DIFFERENT userId
 *      A4 – upsert with same userId+fingerprint deduplicates across sessions
 *      A5 – upsert without userId still uses session-level dedup (no regression)
 *
 *   B. createHybridRetrievalService (core) – keyword store receives userId
 *      B1 – keywordStore.findRelevant is called with the correct userId
 *      B2 – cross-session memory returned by keywordStore appears in
 *           getRelevantMemories() output
 *      B3 – session isolation preserved: different userId → memory absent
 *
 *   C. Prompt construction – retrieved cross-session memory reaches the LLM
 *      C1 – buildContextPrompt includes the cross-session factual memory in
 *           the generated prompt string
 *      C2 – memory content appears in the "working memory" section, not just
 *           the recentContext section
 *      C3 – memory from session-a marked as "factual" is labelled [factual] in
 *           the prompt block
 *
 *   D. Regression – existing session-scoped behaviour is preserved
 *      D1 – a session with no userId only sees its own memories
 *      D2 – two users with the same fingerprint (same name, different people)
 *           cannot access each other's memories
 *      D3 – small-talk queries return [] from findRelevant (no cross-session leak)
 *
 * No Redis, Qdrant, PostgreSQL, or Neo4j connections are made.
 * All store calls use the in-memory fallback path in factual-memory-store.js,
 * or the real createHybridRetrievalService wired with spy/stub stores.
 */

import test   from "node:test";
import assert from "node:assert/strict";

import { createHybridRetrievalService } from "@neura/core";
import { buildContextPrompt, buildContextPromptParts } from "@neura/core";

// ─── Import the real factualMemoryStore (uses in-memory fallback when
//     POSTGRES_URL is not set, which is the case in CI / local unit tests) ────
delete process.env.POSTGRES_URL;
import { factualMemoryStore } from "../src/infrastructure/postgres/factual-memory-store.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const USER_A        = "user-vinod-123";
const USER_B        = "user-other-456";
const SESSION_CHAT_A = "session-chat-a";
const SESSION_CHAT_B = "session-chat-b";
const SESSION_ANON   = "session-anon-no-user";

let _idSeq = 0;
function uid() { return `cross-mem-${++_idSeq}-${Date.now()}`; }

/**
 * Build a minimal factual memory object that mirrors what memory-processor.js
 * produces before calling factualMemoryStore.upsert().
 */
function factualMemory({
  id          = uid(),
  sessionId   = SESSION_CHAT_A,
  userId      = USER_A,
  content     = "User's name is Vinod",
  summary     = "User's name is Vinod",
  fingerprint = "fp-name-vinod",
  importance  = 0.9
} = {}) {
  return {
    id,
    sessionId,
    userId,
    memoryType:    "factual",
    content,
    summary,
    fingerprint,
    sourceEventId: uid(),
    embedding:     null,
    metadata: {
      importance,
      timestamp:    new Date().toISOString(),
      accessCount:  0
    }
  };
}

/**
 * Build a spy keyword store that records calls and delegates to a real
 * in-memory list for findRelevant().
 */
function makeSpyKeywordStore(memories = []) {
  const calls = [];
  const store = {
    async findRelevant(query, sessionId, userId = null) {
      calls.push({ query, sessionId, userId });
      // Simulate the fixed findRelevant logic: return memories matching
      // this session OR this user (when userId is provided)
      return memories.filter((m) =>
        m.sessionId === sessionId ||
        (userId && m.userId === userId)
      );
    }
  };
  return { store, calls };
}

function makeNullVectorStore() {
  return { async findRelevant() { return []; } };
}

function makeNullGraphStore() {
  return {
    async findSimilarMemories()   { return []; },
    async findMemoriesByKeyword() { return []; },
    async findMemoriesByDomain()  { return []; },
    async findMemoriesByEntity()  { return []; }
  };
}

// ─── A. factualMemoryStore.upsert + findRelevant (in-memory fallback) ─────────

test("A1 – memory stored in session-a is returned when queried from session-b with same userId", async () => {
  // Store in Chat A
  const memory = factualMemory({ sessionId: SESSION_CHAT_A, userId: USER_A });
  await factualMemoryStore.upsert(memory);

  // Retrieve from Chat B using same userId
  const results = await factualMemoryStore.findRelevant(
    "what is my name",
    SESSION_CHAT_B,   // ← different session
    USER_A            // ← same user
  );

  const found = results.find((m) => m.fingerprint === "fp-name-vinod");
  assert.ok(
    found,
    "A1 – cross-session factual memory must be returned when userId matches"
  );
  assert.equal(found.summary, "User's name is Vinod", "A1 – correct memory content");
});

test("A2 – memory is NOT returned when queried from session-b with no userId", async () => {
  const fp = `fp-a2-${uid()}`;
  const memory = factualMemory({ sessionId: SESSION_CHAT_A, userId: USER_A, fingerprint: fp });
  await factualMemoryStore.upsert(memory);

  // Query from a different session with NO userId
  const results = await factualMemoryStore.findRelevant(
    "what is my name",
    SESSION_CHAT_B,
    null             // ← no userId → strict session filter
  );

  const found = results.find((m) => m.fingerprint === fp);
  assert.ok(!found, "A2 – memory from another session must NOT appear when userId is absent");
});

test("A3 – memory is NOT returned when queried with a different userId", async () => {
  const fp = `fp-a3-${uid()}`;
  const memory = factualMemory({ sessionId: SESSION_CHAT_A, userId: USER_A, fingerprint: fp });
  await factualMemoryStore.upsert(memory);

  // Query from a different session with a DIFFERENT userId
  const results = await factualMemoryStore.findRelevant(
    "what is my name",
    SESSION_CHAT_B,
    USER_B           // ← different user
  );

  const found = results.find((m) => m.fingerprint === fp);
  assert.ok(!found, "A3 – memory must NOT appear for a different user");
});

test("A4 – upsert with same userId+fingerprint deduplicates across sessions", async () => {
  const fp = `fp-a4-${uid()}`;
  const base = {
    sessionId:   SESSION_CHAT_A,
    userId:      USER_A,
    fingerprint: fp,
    content:     "User's favourite colour is blue",
    summary:     "User's favourite colour is blue",
    importance:  0.7
  };

  await factualMemoryStore.upsert(factualMemory(base));
  // Second upsert from a NEW session — same user, same fingerprint
  await factualMemoryStore.upsert(factualMemory({
    ...base,
    id:        uid(),
    sessionId: SESSION_CHAT_B,  // different session
    importance: 0.8             // higher importance — should be kept
  }));

  // Retrieve for the user and count how many have this fingerprint
  const results = await factualMemoryStore.findRelevant(
    "favourite colour",
    SESSION_CHAT_B,
    USER_A
  );

  const withFp = results.filter((m) => m.fingerprint === fp);
  assert.equal(
    withFp.length,
    1,
    "A4 – same (userId, fingerprint) must not produce duplicate entries"
  );
  assert.ok(
    Number(withFp[0].metadata?.importance ?? 0) >= 0.8,
    "A4 – importance must be updated to the higher value on conflict"
  );
});

test("A5 – upsert without userId still uses session-level dedup (no regression)", async () => {
  const fp = `fp-a5-${uid()}`;
  const base = {
    sessionId:   SESSION_ANON,
    userId:      null,
    fingerprint: fp,
    content:     "User likes jazz music",
    summary:     "User likes jazz music",
    importance:  0.5
  };

  await factualMemoryStore.upsert(factualMemory(base));
  await factualMemoryStore.upsert(factualMemory({ ...base, id: uid() }));

  const all = await factualMemoryStore.all();
  const withFp = all.filter((m) => m.fingerprint === fp);
  assert.equal(withFp.length, 1, "A5 – session-level dedup still works when userId is null");
});

// ─── B. createHybridRetrievalService – keywordStore receives userId ───────────

test("B1 – keywordStore.findRelevant is called with the correct userId", async () => {
  const { store: keywordStore, calls } = makeSpyKeywordStore([]);

  const svc = createHybridRetrievalService({
    vectorStore:  makeNullVectorStore(),
    keywordStore,
    graphStore:   makeNullGraphStore(),
    embedText:    async () => null
  });

  await svc.getRelevantMemories("do you know my name", USER_A, SESSION_CHAT_B);

  assert.equal(calls.length, 1, "B1 – keywordStore called exactly once");
  assert.equal(calls[0].userId, USER_A, "B1 – userId must be forwarded to keywordStore");
  assert.equal(calls[0].sessionId, SESSION_CHAT_B, "B1 – sessionId must also be forwarded");
});

test("B2 – cross-session memory returned by keywordStore appears in getRelevantMemories() output", async () => {
  // Memory was stored in session-a but keywordStore will return it because userId matches
  const crossSessionMemory = {
    ...factualMemory({
      id:          uid(),
      sessionId:   SESSION_CHAT_A,   // stored in Chat A
      userId:      USER_A,
      content:     "User's name is Vinod",
      summary:     "User's name is Vinod",
      fingerprint: `fp-b2-${uid()}`
    }),
    // Provide the _retrieval envelope expected by the ranking pipeline
    _retrieval: {
      vectorScore:     0,
      lexicalScore:    3.5,
      importanceScore: 0.9,
      recencyScore:    1.0,
      score:           0.7,
      source:          "local"
    }
  };

  const { store: keywordStore } = makeSpyKeywordStore([crossSessionMemory]);

  const svc = createHybridRetrievalService({
    vectorStore:  makeNullVectorStore(),
    keywordStore,
    graphStore:   makeNullGraphStore(),
    embedText:    async () => null
  });

  // Query from Chat B
  const results = await svc.getRelevantMemories(
    "do you know my name",
    USER_A,
    SESSION_CHAT_B
  );

  const found = results.find((r) => r.content === "User's name is Vinod");
  assert.ok(
    found,
    "B2 – cross-session factual memory must appear in getRelevantMemories() output"
  );
});

test("B3 – session isolation preserved: different userId → cross-session memory absent", async () => {
  const crossSessionMemory = {
    ...factualMemory({
      id:          uid(),
      sessionId:   SESSION_CHAT_A,
      userId:      USER_A,           // owned by USER_A
      content:     "User's name is Vinod",
      summary:     "User's name is Vinod",
      fingerprint: `fp-b3-${uid()}`
    }),
    _retrieval: {
      vectorScore: 0, lexicalScore: 3.5, importanceScore: 0.9,
      recencyScore: 1.0, score: 0.7, source: "local"
    }
  };

  // Spy store that respects userId filtering (simulates the fixed findRelevant)
  const { store: keywordStore } = makeSpyKeywordStore([crossSessionMemory]);

  const svc = createHybridRetrievalService({
    vectorStore:  makeNullVectorStore(),
    keywordStore,
    graphStore:   makeNullGraphStore(),
    embedText:    async () => null
  });

  // Query as USER_B — should NOT see USER_A's memory
  const results = await svc.getRelevantMemories(
    "do you know my name",
    USER_B,           // ← different user
    SESSION_CHAT_B
  );

  const found = results.find((r) => r.content === "User's name is Vinod");
  assert.ok(!found, "B3 – cross-session memory must NOT appear for a different user");
});

// ─── C. Prompt construction – memory reaches the LLM ─────────────────────────

test("C1 – buildContextPrompt includes the cross-session factual memory text", () => {
  const activeMemories = [
    {
      id:         uid(),
      sessionId:  SESSION_CHAT_A,
      userId:     USER_A,
      memoryType: "factual",
      content:    "User's name is Vinod",
      summary:    "User's name is Vinod",
      metadata:   { importance: 0.9 }
    }
  ];

  const prompt = buildContextPrompt({
    userMessage:    "do you know my name",
    activeMemories,
    recentContext:  []
  });

  assert.ok(
    prompt.includes("Vinod"),
    "C1 – the user's name must appear in the final LLM prompt"
  );
  assert.ok(
    prompt.includes("factual"),
    "C1 – the memory type label must appear in the prompt"
  );
});

test("C2 – cross-session memory appears in the workingMemory section, not just recentContext", () => {
  const activeMemories = [
    {
      id:         uid(),
      sessionId:  SESSION_CHAT_A,
      userId:     USER_A,
      memoryType: "factual",
      content:    "User's name is Vinod",
      summary:    "User's name is Vinod",
      metadata:   { importance: 0.9 }
    }
  ];

  const parts = buildContextPromptParts({
    userMessage:    "do you know my name",
    activeMemories,
    recentContext:  []
  });

  assert.ok(
    parts.workingMemory.includes("Vinod"),
    "C2 – Vinod must be in the workingMemory prompt section"
  );
  // The recentContext section should NOT contain the memory (it's not a recent turn)
  assert.ok(
    !parts.recentContext.includes("Vinod") || parts.recentContext === "Recent conversation:\nNone",
    "C2 – Vinod should not appear in recentContext (it is a working memory, not a recent turn)"
  );
});

test("C3 – factual memory from session-a is labelled [factual] in the prompt block", () => {
  const activeMemories = [
    {
      id:         uid(),
      sessionId:  SESSION_CHAT_A,
      userId:     USER_A,
      memoryType: "factual",
      content:    "User's name is Vinod",
      summary:    "User's name is Vinod",
      metadata:   { importance: 0.9 }
    }
  ];

  const parts = buildContextPromptParts({
    userMessage:    "do you know my name",
    activeMemories,
    recentContext:  []
  });

  assert.ok(
    parts.workingMemory.includes("[factual]"),
    "C3 – memory type label [factual] must appear in the workingMemory section"
  );
});

// ─── D. Regression – existing behaviour unchanged ─────────────────────────────

test("D1 – session with no userId only sees its own memories (no cross-session leak)", async () => {
  const fpOwned  = `fp-d1-owned-${uid()}`;
  const fpForeign = `fp-d1-foreign-${uid()}`;

  // Store a memory in the anon session
  await factualMemoryStore.upsert(factualMemory({
    sessionId:   SESSION_ANON,
    userId:      null,
    fingerprint: fpOwned,
    content:     "Anon user preference",
    summary:     "Anon user preference"
  }));

  // Store a different user's memory in a separate session
  await factualMemoryStore.upsert(factualMemory({
    sessionId:   SESSION_CHAT_A,
    userId:      USER_A,
    fingerprint: fpForeign,
    content:     "Some other user fact",
    summary:     "Some other user fact"
  }));

  // Anon session queries with no userId — must only see its own memory
  const results = await factualMemoryStore.findRelevant(
    "user preference",
    SESSION_ANON,
    null  // no userId
  );

  const ownedFound  = results.find((m) => m.fingerprint === fpOwned);
  const foreignFound = results.find((m) => m.fingerprint === fpForeign);

  assert.ok(ownedFound,  "D1 – anon session must see its own memory");
  assert.ok(!foreignFound, "D1 – anon session must NOT see another user's memory");
});

test("D2 – two users with same fingerprint (same name, different people) cannot see each other's memories", async () => {
  const sharedFp = `fp-d2-shared-name-${uid()}`;

  await factualMemoryStore.upsert(factualMemory({
    id:          uid(),
    sessionId:   "d2-session-a",
    userId:      USER_A,
    fingerprint: sharedFp,
    content:     "User's name is Alex",
    summary:     "User's name is Alex"
  }));

  await factualMemoryStore.upsert(factualMemory({
    id:          uid(),
    sessionId:   "d2-session-b",
    userId:      USER_B,
    fingerprint: sharedFp,
    content:     "User's name is Alex",
    summary:     "User's name is Alex"
  }));

  // USER_A queries from a new session — should only see USER_A's copy
  const resultsA = await factualMemoryStore.findRelevant("name", "d2-session-c", USER_A);
  const forA = resultsA.filter((m) => m.fingerprint === sharedFp);

  // USER_B queries from a new session — should only see USER_B's copy
  const resultsB = await factualMemoryStore.findRelevant("name", "d2-session-d", USER_B);
  const forB = resultsB.filter((m) => m.fingerprint === sharedFp);

  // Each user must find exactly their own memory (or both due to same-fp dedup)
  // The key constraint: USER_A's query must not return USER_B's row and vice-versa
  for (const m of forA) {
    assert.equal(m.userId, USER_A, "D2 – USER_A must only see memories owned by USER_A");
  }
  for (const m of forB) {
    assert.equal(m.userId, USER_B, "D2 – USER_B must only see memories owned by USER_B");
  }
});

test("D3 – small-talk queries return [] from findRelevant (no cross-session leak on greetings)", async () => {
  await factualMemoryStore.upsert(factualMemory({
    sessionId:   SESSION_CHAT_A,
    userId:      USER_A,
    fingerprint: `fp-d3-${uid()}`,
    content:     "User's name is Vinod",
    summary:     "User's name is Vinod"
  }));

  // Small-talk queries must return empty regardless of cross-session state
  const results = await factualMemoryStore.findRelevant("hi", SESSION_CHAT_B, USER_A);
  assert.deepEqual(results, [], "D3 – small-talk query must return [] (no retrieval)");
});
