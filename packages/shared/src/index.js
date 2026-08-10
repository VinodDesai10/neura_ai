/**
 * @neura/shared
 *
 * Cross-package constants, utilities, and error types shared across the
 * AiNeura monorepo. No other workspace packages may be imported here.
 *
 * Dependency rule: @neura/shared must NOT import from @neura/core or @neura/api.
 */

// ─── Text processing constants ────────────────────────────────────────────────

/**
 * Common English stop-words filtered out during tokenisation and
 * fingerprint computation.
 *
 * @type {Set<string>}
 */
export const STOP_TERMS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "do",
  "for",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "the",
  "this",
  "to",
  "we",
  "what",
  "you"
]);

/**
 * Short social phrases that carry no memory-worthy signal and should be
 * excluded from memory extraction entirely.
 *
 * @type {string[]}
 */
export const LOW_SIGNAL_PHRASES = [
  "hi",
  "hello",
  "thanks",
  "thank you",
  "okay",
  "ok",
  "cool",
  "great"
];

/**
 * Small-talk words used to detect single/two-word greeting turns that
 * should skip memory retrieval and expensive LLM calls.
 *
 * @type {string[]}
 */
export const SMALL_TALK_WORDS = [
  "hi",
  "hello",
  "hey",
  "ok",
  "okay",
  "thanks",
  "bye",
  "yes",
  "no",
  "sure",
  "great",
  "cool",
  "good",
  "nice",
  "how are you"
];

// ─── Memory domain rules ──────────────────────────────────────────────────────

/**
 * Ordered domain-classification rules.  Each rule maps a `domain` name to
 * a scoring `weight` and the keyword `terms` that trigger it.
 *
 * @type {Array<{domain: string, weight: number, terms: string[]}>}
 */
export const DOMAIN_RULES = [
  {
    domain: "identity",
    weight: 0.95,
    terms: ["my name is", "i am", "i'm", "we are", "identity", "profile"]
  },
  {
    domain: "memory_system",
    weight: 0.9,
    terms: [
      "memory",
      "metadata",
      "retrieval",
      "embedding",
      "working memory",
      "vector",
      "qdrant",
      "neo4j",
      "postgres",
      "redis",
      "mongo"
    ]
  },
  {
    domain: "architecture",
    weight: 0.85,
    terms: [
      "architecture",
      "pipeline",
      "system",
      "orchestrator",
      "processor",
      "storage",
      "database",
      "api",
      "backend"
    ]
  },
  {
    domain: "project",
    weight: 0.82,
    terms: ["project", "capstone", "mvp", "demo", "feature", "roadmap", "requirement"]
  },
  {
    domain: "preference",
    weight: 0.78,
    terms: ["i prefer", "i like", "i dislike", "i want", "we want", "preference", "style"]
  },
  {
    domain: "planning",
    weight: 0.74,
    terms: [
      "plan",
      "next step",
      "todo",
      "deadline",
      "schedule",
      "today",
      "tomorrow",
      "yesterday",
      "last time",
      "previously"
    ]
  },
  {
    domain: "engineering",
    weight: 0.72,
    terms: [
      "code",
      "bug",
      "test",
      "deploy",
      "server",
      "client",
      "frontend",
      "repository",
      "function",
      "class"
    ]
  },
  {
    domain: "business",
    weight: 0.66,
    terms: ["customer", "market", "pricing", "revenue", "business", "sales", "startup", "product"]
  },
  {
    domain: "education",
    weight: 0.64,
    terms: ["learn", "study", "course", "college", "exam", "assignment", "teacher", "student"]
  },
  {
    domain: "personal",
    weight: 0.62,
    terms: ["family", "friend", "home", "birthday", "hobby", "personal"]
  }
];

// ─── Entity extraction patterns ───────────────────────────────────────────────

/**
 * Regex patterns used to detect named entities inside memory content.
 *
 * @type {Array<{type: string, regex: RegExp}>}
 */
export const ENTITY_PATTERNS = [
  { type: "email",      regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { type: "url",        regex: /\bhttps?:\/\/[^\s]+/gi },
  {
    type: "date",
    regex: /\b(?:today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\b/gi
  },
  { type: "version",    regex: /\bv?\d+\.\d+(?:\.\d+)?\b/gi },
  {
    type: "phone",
    regex: /\b(?:\+1|1)?[-.\s]?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b/gi
  },
  { type: "mentions",   regex: /\B@[a-zA-Z0-9_]+\b/g },
  { type: "hashtag",    regex: /\B#[a-zA-Z0-9_]+\b/g },
  { type: "code_block", regex: /`[^`]+`/g },
  { type: "file_path",  regex: /(?:\/[\w.-]+)+|C:\\(?:[\\w.-]+\\)+[\w.-]+/g }
];

// ─── Shared pure utilities ────────────────────────────────────────────────────

/**
 * Returns `n` clamped to the nearest env integer, falling back to `fallback`
 * when the env value is absent or not a positive finite number.
 *
 * @param {string} name     - process.env key
 * @param {number} fallback - default value
 * @returns {number}
 */
export function readPositiveNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Clamp a 0–1 score to two decimal places.
 *
 * @param {number} score
 * @returns {number}
 */
export function clampScore(score) {
  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

/**
 * Deduplicate an array, removing falsy values.
 *
 * @template T
 * @param {T[]} values
 * @returns {T[]}
 */
export function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

/**
 * Tokenise content into lower-case terms, stripping stop-words and
 * non-alphanumeric characters.
 *
 * @param {string} content
 * @returns {string[]}
 */
export function tokenize(content) {
  return content
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((term) => term && !STOP_TERMS.has(term));
}

/**
 * Returns `true` when the content is a trivial phrase or too short to carry
 * any memory-worthy signal.
 *
 * @param {string} content
 * @returns {boolean}
 */
export function hasLowSignalContent(content) {
  const lower = content.toLowerCase().trim();
  return LOW_SIGNAL_PHRASES.includes(lower) || lower.length < 8;
}

/**
 * Returns `true` when the message looks like a short small-talk greeting
 * (≤ 2 words, matching a known small-talk term).
 *
 * @param {string} message
 * @returns {boolean}
 */
export function isSmallTalk(message) {
  const trimmed = message.trim().toLowerCase().replace(/[^a-z0-9\s]/g, "");
  return (
    trimmed.split(/\s+/).length <= 2 &&
    SMALL_TALK_WORDS.some((word) => trimmed.includes(word))
  );
}

// ─── Error types ──────────────────────────────────────────────────────────────

/**
 * Base error class for AiNeura domain errors.  Carries an optional HTTP
 * `statusCode` so that route handlers can surface it directly.
 */
export class NeuraError extends Error {
  /**
   * @param {string} message
   * @param {number} [statusCode=500]
   */
  constructor(message, statusCode = 500) {
    super(message);
    this.name = "NeuraError";
    this.statusCode = statusCode;
  }
}

/**
 * Thrown when a resource cannot be found.
 */
export class NotFoundError extends NeuraError {
  /** @param {string} message */
  constructor(message = "Not found") {
    super(message, 404);
    this.name = "NotFoundError";
  }
}

/**
 * Thrown when a concurrent operation cannot proceed because a session lock
 * is already held.
 */
export class SessionConflictError extends NeuraError {
  /** @param {string} message */
  constructor(message = "Session is already processing a chat turn") {
    super(message, 409);
    this.name = "SessionConflictError";
  }
}

/**
 * Thrown when a client exceeds the rate limit.
 */
export class RateLimitError extends NeuraError {
  /** @param {string} message */
  constructor(message = "Rate limit exceeded") {
    super(message, 429);
    this.name = "RateLimitError";
  }
}

// ─── Retrieval configuration ──────────────────────────────────────────────────

/**
 * Default values for the hybrid retrieval pipeline.
 * Every value can be overridden via environment variables.
 *
 * @type {{
 *   topK: number,
 *   vectorWeight: number,
 *   lexicalWeight: number,
 *   importanceWeight: number,
 *   recencyWeight: number,
 *   recencyHalfLifeHours: number,
 *   dedupThreshold: number,
 *   summaryEveryNTurns: number
 * }}
 */
export const RETRIEVAL_DEFAULTS = {
  /** Maximum memories returned by findRelevant calls. */
  topK: 8,
  /** Weight applied to the Qdrant cosine-similarity score. */
  vectorWeight: 0.5,
  /** Weight applied to the lexical / BM25 overlap score. */
  lexicalWeight: 0.2,
  /** Weight applied to the stored importance score. */
  importanceWeight: 0.2,
  /** Weight applied to the recency-decay factor. */
  recencyWeight: 0.1,
  /** Hours for the recency half-life (score halves every N hours). */
  recencyHalfLifeHours: 72,
  /** Cosine similarity threshold above which two memories are near-duplicates. */
  dedupThreshold: 0.92,
  /** Generate a session-summary memory after every N assistant turns. */
  summaryEveryNTurns: 20
};

/**
 * Read the active retrieval config from environment variables, falling back
 * to RETRIEVAL_DEFAULTS for any missing value.
 *
 * @returns {typeof RETRIEVAL_DEFAULTS}
 */
export function readRetrievalConfig() {
  const env = process.env;

  function num(key, fallback) {
    const v = Number(env[key]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  }

  return {
    topK:                  num("RETRIEVAL_TOP_K",                   RETRIEVAL_DEFAULTS.topK),
    vectorWeight:          num("RETRIEVAL_VECTOR_WEIGHT",           RETRIEVAL_DEFAULTS.vectorWeight),
    lexicalWeight:         num("RETRIEVAL_LEXICAL_WEIGHT",          RETRIEVAL_DEFAULTS.lexicalWeight),
    importanceWeight:      num("RETRIEVAL_IMPORTANCE_WEIGHT",       RETRIEVAL_DEFAULTS.importanceWeight),
    recencyWeight:         num("RETRIEVAL_RECENCY_WEIGHT",          RETRIEVAL_DEFAULTS.recencyWeight),
    recencyHalfLifeHours:  num("RETRIEVAL_RECENCY_HALF_LIFE_HOURS", RETRIEVAL_DEFAULTS.recencyHalfLifeHours),
    dedupThreshold:        num("RETRIEVAL_DEDUP_THRESHOLD",         RETRIEVAL_DEFAULTS.dedupThreshold),
    summaryEveryNTurns:    num("MEMORY_SUMMARY_EVERY_N_TURNS",      RETRIEVAL_DEFAULTS.summaryEveryNTurns)
  };
}
