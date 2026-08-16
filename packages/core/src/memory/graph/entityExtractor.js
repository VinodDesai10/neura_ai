/**
 * packages/core/src/memory/graph/entityExtractor.js
 *
 * Deterministic, lightweight entity extraction from memory objects.
 *
 * No LLM dependency — all extraction uses regex heuristics and the
 * memory's structured metadata (domain, keywords, tags).  The output is
 * a list of `GraphEntity` objects suitable for upsert into Neo4j via
 * `graphService.upsertEntity()`.
 *
 * ─── Extraction strategy ─────────────────────────────────────────────────
 *
 *   1. Proper-noun scan — capitalized word sequences likely to be names or
 *      project/org titles.
 *   2. Keyword list — metadata.keywords from the memory processor.
 *   3. Domain label — metadata.domain becomes a :topic entity.
 *   4. Task signals — imperative verb phrases ("implement X", "fix Y").
 *   5. Preference signals — "I prefer/like/want X" → :preference entity.
 *   6. Decision signals — "decided to X" → :decision entity.
 *
 * ─── Stability guarantee ─────────────────────────────────────────────────
 *
 *   Entity ids are derived deterministically from (type, normalized name),
 *   so the same conceptual entity always yields the same id and can be
 *   safely upserted without duplication.
 *
 * ─── Public API ───────────────────────────────────────────────────────────
 *
 *   extractEntities(memory) → GraphEntity[]
 */

import { ENTITY_TYPE, VALID_ENTITY_TYPES } from "./graphTypes.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_ENTITIES = 12;
const MIN_NAME_LEN = 2;
const MAX_NAME_LEN = 80;

// Imperative-verb prefixes that introduce a task
const TASK_PREFIXES = /\b(?:implement|build|create|add|fix|refactor|write|set up|deploy|update|remove|delete|migrate|test|review|design)\s+(.{3,60}?)(?:[,;.]|$)/gi;

// Preference assertion patterns — capture the object after the trigger
const PREFERENCE_PATTERNS = /\b(?:i prefer|i like|i love|i want|i use|i rely on|i depend on)\s+(.{3,60}?)(?:[,;.]|$)/gi;

// Decision/choice patterns
const DECISION_PATTERNS = /\b(?:(?:i|we) decided(?: to)?|(?:i|we) chose|(?:i|we) picked|(?:i|we) went with)\s+(.{3,60}?)(?:[,;.]|$)/gi;

// Capitalized multi-word sequences that are likely proper nouns
// Excludes sentence starts (we check position) and common stop openers.
const PROPER_NOUN_RE = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;

// Single capitalized word that looks like a brand/product (all caps or TitleCase)
// Excludes I, A, The, etc.
const SINGLE_PROPER_RE = /\b([A-Z][a-zA-Z]{2,})\b/g;

// Weak single-word proper nouns to skip (common sentence-start words)
const PROPER_SKIP = new Set([
  "The", "This", "That", "These", "Those", "When", "Where", "What", "Which",
  "How", "Why", "Who", "Will", "Can", "Let", "Yes", "No", "Ok", "Just",
  "We", "I", "My", "Our", "Its", "In", "On", "At", "For", "To", "From",
  "With", "And", "But", "Or", "If", "So", "Not"
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalize a name to a consistent lowercase, trimmed string.
 * Used for stable id generation and deduplication.
 *
 * @param {string} name
 * @returns {string}
 */
function normalizeName(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Build a stable, deterministic entity id from its type and name.
 *
 * @param {string} type  - ENTITY_TYPE value
 * @param {string} name  - normalized name
 * @returns {string}
 */
function entityId(type, name) {
  return `${type}:${normalizeName(name)}`;
}

/**
 * Guard: is this a usable entity name?
 *
 * @param {string} name
 * @returns {boolean}
 */
function isUsableName(name) {
  const n = (name || "").trim();
  return n.length >= MIN_NAME_LEN && n.length <= MAX_NAME_LEN;
}

/**
 * Append an entity to the result map, deduplicating by id.
 *
 * @param {Map<string, import("./graphTypes.js").GraphEntity>} map
 * @param {string} type
 * @param {string} name
 * @param {object} [props]
 */
function addEntity(map, type, name, props = {}) {
  if (!VALID_ENTITY_TYPES.has(type) || !isUsableName(name)) return;
  const id = entityId(type, name);
  if (!map.has(id)) {
    map.set(id, { id, name: name.trim(), type, props });
  }
}

// ─── Extraction passes ────────────────────────────────────────────────────────

/**
 * Pass 1 — domain label from metadata → :topic
 */
function extractDomainEntity(memory, map) {
  const domain = memory?.metadata?.domain;
  if (domain && typeof domain === "string" && domain.length >= 2) {
    addEntity(map, ENTITY_TYPE.TOPIC, domain, { source: "domain" });
  }
}

/**
 * Pass 2 — keywords from metadata → :topic (only 3-word-or-fewer phrases)
 */
function extractKeywordEntities(memory, map) {
  const keywords = memory?.metadata?.keywords;
  if (!Array.isArray(keywords)) return;

  for (const kw of keywords) {
    const word = String(kw || "").trim();
    // Skip overly generic single-char or very long phrases
    if (word.length < 3 || word.length > 40) continue;
    // Only treat multi-word keywords as topic entities (single words are noise)
    if (word.split(/\s+/).length >= 2) {
      addEntity(map, ENTITY_TYPE.TOPIC, word, { source: "keyword" });
    }
  }
}

/**
 * Pass 3 — proper-noun scan on content text → :person / :project / :organization
 *
 * Multi-word capitalized sequences get higher priority.  Single capitalized
 * words are added only if they don't appear in PROPER_SKIP.
 */
function extractProperNounEntities(text, map) {
  if (!text) return;

  // Multi-word proper nouns — classify by heuristic
  let match;
  PROPER_NOUN_RE.lastIndex = 0;
  while ((match = PROPER_NOUN_RE.exec(text)) !== null) {
    const name = match[1].trim();
    if (!isUsableName(name)) continue;
    // Heuristic: words ending in Inc, Ltd, LLC, Corp → organization
    if (/\b(?:Inc|Ltd|LLC|Corp|Co)\b/i.test(name)) {
      addEntity(map, ENTITY_TYPE.ORGANIZATION, name, { source: "proper_noun" });
    } else {
      // Default: project (multi-word sequences in tech contexts are usually projects)
      addEntity(map, ENTITY_TYPE.PROJECT, name, { source: "proper_noun" });
    }
  }

  // Single capitalized words → person guess (fallback)
  SINGLE_PROPER_RE.lastIndex = 0;
  while ((match = SINGLE_PROPER_RE.exec(text)) !== null) {
    const name = match[1].trim();
    if (PROPER_SKIP.has(name) || !isUsableName(name)) continue;
    // Skip if already captured as part of a multi-word proper noun
    const normalized = normalizeName(name);
    const alreadyCaptured = [...map.keys()].some((id) =>
      id.endsWith(`:${normalized}`) || id.includes(` ${normalized}`)
    );
    if (!alreadyCaptured) {
      addEntity(map, ENTITY_TYPE.PERSON, name, { source: "single_proper" });
    }
  }
}

/**
 * Pass 4 — task-signal phrases → :task
 */
function extractTaskEntities(text, map) {
  if (!text) return;
  TASK_PREFIXES.lastIndex = 0;
  let match;
  while ((match = TASK_PREFIXES.exec(text)) !== null) {
    const description = match[1].trim().replace(/\s+/g, " ");
    if (isUsableName(description)) {
      addEntity(map, ENTITY_TYPE.TASK, description, { source: "task_signal" });
    }
  }
}

/**
 * Pass 5 — preference-signal phrases → :preference
 */
function extractPreferenceEntities(text, map) {
  if (!text) return;
  PREFERENCE_PATTERNS.lastIndex = 0;
  let match;
  while ((match = PREFERENCE_PATTERNS.exec(text)) !== null) {
    const object = match[1].trim().replace(/\s+/g, " ");
    if (isUsableName(object)) {
      addEntity(map, ENTITY_TYPE.PREFERENCE, object, { source: "preference_signal" });
    }
  }
}

/**
 * Pass 6 — decision-signal phrases → :decision
 */
function extractDecisionEntities(text, map) {
  if (!text) return;
  DECISION_PATTERNS.lastIndex = 0;
  let match;
  while ((match = DECISION_PATTERNS.exec(text)) !== null) {
    const description = match[1].trim().replace(/\s+/g, " ");
    if (isUsableName(description)) {
      addEntity(map, ENTITY_TYPE.DECISION, description, { source: "decision_signal" });
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract candidate graph entities from a memory object.
 *
 * The function is **deterministic** — identical inputs always produce the
 * same output.  No I/O or LLM calls are made.
 *
 * @param {object} memory  - Memory object with `.content`, `.summary`, `.metadata`
 * @returns {import("./graphTypes.js").GraphEntity[]}
 */
export function extractEntities(memory) {
  if (!memory) return [];

  const text = [memory.content, memory.summary].filter(Boolean).join(" ");
  const map  = new Map();

  extractDomainEntity(memory, map);
  extractKeywordEntities(memory, map);
  extractProperNounEntities(text, map);
  extractTaskEntities(text, map);
  extractPreferenceEntities(text, map);
  extractDecisionEntities(text, map);

  // Trim to MAX_ENTITIES, prioritising higher-confidence types
  const PRIORITY = {
    [ENTITY_TYPE.PERSON]:       0,
    [ENTITY_TYPE.PROJECT]:      1,
    [ENTITY_TYPE.ORGANIZATION]: 2,
    [ENTITY_TYPE.TASK]:         3,
    [ENTITY_TYPE.DECISION]:     4,
    [ENTITY_TYPE.PREFERENCE]:   5,
    [ENTITY_TYPE.TOPIC]:        6,
    [ENTITY_TYPE.EVENT]:        7
  };

  return [...map.values()]
    .sort((a, b) => (PRIORITY[a.type] ?? 99) - (PRIORITY[b.type] ?? 99))
    .slice(0, MAX_ENTITIES);
}
