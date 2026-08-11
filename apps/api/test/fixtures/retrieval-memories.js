/**
 * apps/api/test/fixtures/retrieval-memories.js
 *
 * Deterministic fixture dataset for retrieval integration tests.
 *
 * 10 memories covering:
 *   - factual   (F)  – stable personal facts
 *   - episodic  (E)  – time-bound events
 *   - semantic  (S)  – general concept / summary
 *   - overlapping keywords / entities across memories
 *   - unrelated memories (noise)
 *
 * Domain spread: travel, work, food, fitness
 *
 * Timestamps are relative to "now" so recency decay is predictable:
 *   - RECENT  = 1 hour ago   → recency ≈ 1.0
 *   - MEDIUM  = 48 hours ago → recency ≈ 0.63  (half-life 72h)
 *   - OLD     = 200 hours ago → recency ≈ 0.14
 *
 * NOTE: Do NOT change ids – tests assert by id.
 */

// ─── Deterministic time helpers ───────────────────────────────────────────────

const NOW = Date.now();

/** Timestamp N hours before NOW (ISO string). */
function hoursAgo(n) {
  return new Date(NOW - n * 60 * 60 * 1000).toISOString();
}

// ─── Session namespacing ──────────────────────────────────────────────────────

export const SESSION_A = "session-test-A";
export const SESSION_B = "session-test-B";

// ─── Fixture memories ─────────────────────────────────────────────────────────

/**
 * @typedef {Object} FixtureMemory
 * @property {string} id
 * @property {string} sessionId
 * @property {string} content
 * @property {string} memoryType    – "factual" | "episodic" | "semantic"
 * @property {string} fingerprint
 * @property {object} metadata
 */

/** @type {FixtureMemory[]} */
export const FIXTURE_MEMORIES = [
  // ── F1: Factual – travel preference ────────────────────────────────────────
  {
    id:          "mem-f1",
    sessionId:   SESSION_A,
    content:     "I always book window seats on flights because I love watching clouds during travel.",
    memoryType:  "factual",
    fingerprint: "fp-f1",
    metadata: {
      importance: 0.75,
      domain:     "preference",
      keywords:   ["window", "seats", "flights", "travel", "clouds"],
      timestamp:  hoursAgo(1),       // RECENT
    }
  },

  // ── F2: Factual – work role ─────────────────────────────────────────────────
  {
    id:          "mem-f2",
    sessionId:   SESSION_A,
    content:     "I am a senior software engineer working on distributed systems and backend APIs.",
    memoryType:  "factual",
    fingerprint: "fp-f2",
    metadata: {
      importance: 0.85,
      domain:     "identity",
      keywords:   ["software", "engineer", "distributed", "systems", "backend"],
      timestamp:  hoursAgo(48),      // MEDIUM
    }
  },

  // ── E1: Episodic – travel event ─────────────────────────────────────────────
  {
    id:          "mem-e1",
    sessionId:   SESSION_A,
    content:     "Last month I travelled to Tokyo for a tech conference and visited the Akihabara district.",
    memoryType:  "episodic",
    fingerprint: "fp-e1",
    metadata: {
      importance: 0.70,
      domain:     "personal",
      keywords:   ["tokyo", "travel", "conference", "akihabara"],
      timestamp:  hoursAgo(2),       // RECENT
    }
  },

  // ── E2: Episodic – work sprint ──────────────────────────────────────────────
  {
    id:          "mem-e2",
    sessionId:   SESSION_A,
    content:     "Yesterday I finished the sprint review and deployed the new API endpoint to production.",
    memoryType:  "episodic",
    fingerprint: "fp-e2",
    metadata: {
      importance: 0.80,
      domain:     "engineering",
      keywords:   ["sprint", "review", "deployed", "api", "production"],
      timestamp:  hoursAgo(24),      // MEDIUM
    }
  },

  // ── E3: Episodic – fitness event ────────────────────────────────────────────
  {
    id:          "mem-e3",
    sessionId:   SESSION_B,
    content:     "This morning I ran 10 kilometres in the park before my stand-up meeting.",
    memoryType:  "episodic",
    fingerprint: "fp-e3",
    metadata: {
      importance: 0.60,
      domain:     "personal",
      keywords:   ["ran", "kilometres", "park", "morning", "meeting"],
      timestamp:  hoursAgo(8),       // RECENT
    }
  },

  // ── S1: Semantic – travel concept ───────────────────────────────────────────
  {
    id:          "mem-s1",
    sessionId:   SESSION_A,
    content:     "Long-haul international travel requires careful planning for time zones, jet lag and local currency.",
    memoryType:  "semantic",
    fingerprint: "fp-s1",
    metadata: {
      importance: 0.55,
      domain:     "personal",
      keywords:   ["travel", "international", "time-zones", "jet-lag", "currency"],
      timestamp:  hoursAgo(200),     // OLD
    }
  },

  // ── S2: Semantic – food concept ─────────────────────────────────────────────
  {
    id:          "mem-s2",
    sessionId:   SESSION_B,
    content:     "Japanese cuisine emphasises umami flavour through fermented ingredients like miso and soy sauce.",
    memoryType:  "semantic",
    fingerprint: "fp-s2",
    metadata: {
      importance: 0.50,
      domain:     "personal",
      keywords:   ["japanese", "cuisine", "umami", "miso", "soy"],
      timestamp:  hoursAgo(120),     // MEDIUM-OLD
    }
  },

  // ── S3: Semantic – fitness concept ──────────────────────────────────────────
  {
    id:          "mem-s3",
    sessionId:   SESSION_A,
    content:     "Regular aerobic exercise improves cardiovascular health and reduces cortisol levels significantly.",
    memoryType:  "semantic",
    fingerprint: "fp-s3",
    metadata: {
      importance: 0.65,
      domain:     "personal",
      keywords:   ["aerobic", "exercise", "cardiovascular", "cortisol"],
      timestamp:  hoursAgo(96),      // MEDIUM-OLD
    }
  },

  // ── NOISE1: Unrelated – food preference ─────────────────────────────────────
  {
    id:          "mem-noise1",
    sessionId:   SESSION_B,
    content:     "I prefer spicy Thai food especially pad thai noodles with extra chilli.",
    memoryType:  "factual",
    fingerprint: "fp-noise1",
    metadata: {
      importance: 0.45,
      domain:     "preference",
      keywords:   ["spicy", "thai", "food", "noodles", "chilli"],
      timestamp:  hoursAgo(72),      // MEDIUM
    }
  },

  // ── NOISE2: Unrelated – completely off-topic ────────────────────────────────
  {
    id:          "mem-noise2",
    sessionId:   SESSION_B,
    content:     "The annual subscription for the cloud storage service renews in December.",
    memoryType:  "factual",
    fingerprint: "fp-noise2",
    metadata: {
      importance: 0.30,
      domain:     "planning",
      keywords:   ["subscription", "cloud", "storage", "december", "renews"],
      timestamp:  hoursAgo(300),     // OLD
    }
  }
];

// ─── Convenience lookup ───────────────────────────────────────────────────────

/** Fast id → memory lookup. */
export const MEMORY_BY_ID = Object.fromEntries(
  FIXTURE_MEMORIES.map((m) => [m.id, m])
);

/**
 * Build a scoredEntries array with explicit vector and lexical scores.
 * Tests use this to inject deterministic scores into deduplicateAndRerank.
 *
 * @param {Array<{id: string, vectorScore: number, lexicalScore: number}>} overrides
 * @returns {Array<{memory: FixtureMemory, vectorScore: number, lexicalScore: number}>}
 */
export function buildScoredEntries(overrides) {
  return overrides.map(({ id, vectorScore, lexicalScore }) => ({
    memory:       MEMORY_BY_ID[id],
    vectorScore,
    lexicalScore
  }));
}
