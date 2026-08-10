/**
 * packages/core/src/utils/index.js
 *
 * Internal helpers used across the core package.
 * None of these are part of the public @neura/core API.
 *
 * Exports:
 *   - Pattern constants: FACTUAL_PATTERNS, EPISODIC_PATTERNS, SEMANTIC_PATTERNS
 *   - scoreMemoryTypeMatch
 *   - countMatches
 *   - inferTags
 *   - inferKeywords
 *   - inferEntities
 *   - scoreSpecificity
 *   - scorePermanence
 *   - scoreActionability
 *   - inferSentiment
 *   - scoreSignalStrength
 */

import {
  ENTITY_PATTERNS,
  clampScore,
  unique,
  tokenize,
  hasLowSignalContent
} from "@neura/shared";

// ─── Pattern sets for memory-type classification ──────────────────────────────

export const FACTUAL_PATTERNS = [
  // Identity assertions
  /\b(my name is|i am|i'm|we are|i'm a|i am a)\b/i,
  // Preferences
  /\b(i prefer|i like|i dislike|i want|we want|i don't want)\b/i,
  // Project/ownership
  /\b(my project|our project|our goal|my goal|i own|we own)\b/i,
  // Stable characteristics
  /\b(i'm based in|i live in|i work at|i study at|my role is)\b/i,
  // Decisions made
  /\b(i decided|we decided|i chose|we chose)\b/i,
  // Persistent facts
  /\b(my email|my phone|my username|my password|my url|my domain)\b/i,
  // Family/relationships
  /\b(my (mother|father|sibling|spouse|partner|daughter|son))\b/i,
  // Education/credentials
  /\b(i studied|i graduated|i majored|my degree|my certification)\b/i
];

export const EPISODIC_PATTERNS = [
  // Recent past
  /\b(yesterday|today|this morning|this afternoon|tonight)\b/i,
  // Temporal references
  /\b(last (time|week|month|day)|earlier|previously|before)\b/i,
  // Conversation history
  /\b(we (discussed|talked|decided|built|made)|you (said|told|mentioned)|i (told|said|mentioned))\b/i,
  // Experience markers
  /\b(i (experienced|encountered|faced|went through|just finished|completed))\b/i,
  // Specific events
  /\b(when we|during|at that|in that session|that time)\b/i,
  // Recent actions
  /\b(i (built|created|added|fixed|changed|updated).*yesterday|today|last)\b/i,
  // Session-specific
  /\b(in this conversation|in this session|just now|moments ago|a few minutes ago)\b/i,
  // Timeline progression
  /\b(first|then|next|after that|later|afterward)\b/i
];

export const SEMANTIC_PATTERNS = [
  // General knowledge
  /\b(generally|usually|typically|normally|in general)\b/i,
  // Conceptual
  /\b(concept of|idea|approach|method|strategy|pattern)\b/i,
  // Reasoning
  /\b(because|since|therefore|thus|which means)\b/i,
  // Technical knowledge
  /\b(react|nodejs|database|api|architecture|algorithm)\b/i,
  // Universal statements
  /\b((all|most|many|some)([\s\w]+)?(is|are|require|need|benefit from|involve))\b/i,
  // Definitions
  /\b((is defined as|refers to|means|implies|represents|signifies))\b/i,
  // Best practices
  /\b(best practice|good practice|standard|convention|rule|principle)\b/i
];

// ─── Scoring helpers ──────────────────────────────────────────────────────────

/**
 * Count how many patterns in an array match the content string.
 *
 * @param {string} content
 * @param {RegExp[]} patterns
 * @returns {number}
 */
export function scoreMemoryTypeMatch(content, patterns) {
  let matchCount = 0;
  for (const pattern of patterns) {
    if (pattern.test(content)) {
      matchCount++;
    }
  }
  return matchCount;
}

/**
 * Count how many terms from a list appear (as substrings) in content.
 *
 * @param {string} content  – should already be lower-cased by caller
 * @param {string[]} terms
 * @returns {number}
 */
export function countMatches(content, terms) {
  const lower = content.toLowerCase();
  return terms.reduce(
    (count, term) => count + (lower.includes(term) ? 1 : 0),
    0
  );
}

// ─── Metadata inference helpers ───────────────────────────────────────────────

/**
 * Infer topic tags from content.
 *
 * @param {string} content
 * @returns {string[]}
 */
export function inferTags(content) {
  const lower = content.toLowerCase();
  const tags = [];

  if (lower.includes("project") || lower.includes("capstone")) tags.push("project");
  if (lower.includes("memory") || lower.includes("retrieval") || lower.includes("embedding")) tags.push("memory");
  if (lower.includes("architecture") || lower.includes("pipeline") || lower.includes("system")) tags.push("architecture");
  if (lower.includes("name is") || lower.includes("i am") || lower.includes("i'm")) tags.push("identity");
  if (lower.includes("prefer") || lower.includes("like") || lower.includes("want")) tags.push("preference");
  if (lower.includes("plan") || lower.includes("decision") || lower.includes("next step")) tags.push("planning");
  if (lower.includes("bug") || lower.includes("code") || lower.includes("test")) tags.push("engineering");

  return unique(tags);
}

/**
 * Extract the top-N most significant keywords from content using TF-IDF-like scoring.
 *
 * @param {string} content
 * @param {number} [limit=8]
 * @returns {string[]}
 */
export function inferKeywords(content, limit = 8) {
  const tokens = tokenize(content);
  const counts = new Map();
  const docLength = tokens.length;

  for (const term of tokens) {
    if (term.length < 3) continue;
    counts.set(term, (counts.get(term) || 0) + 1);
  }

  return [...counts.entries()]
    .map(([term, count]) => {
      const tf = count / Math.max(1, docLength);
      const idfLike = Math.log(1 + 1 / count);
      const frequency = count / docLength;
      const entropy = frequency * Math.log(frequency + 1);
      return { term, score: tf * idfLike * (1 - entropy * 0.1), count };
    })
    .sort((a, b) => b.score - a.score || b.count - a.count)
    .slice(0, limit)
    .map((e) => e.term);
}

/**
 * Extract named entities and pattern-matched values from content.
 *
 * @param {string} content
 * @returns {Array<{type: string, value: string}>}
 */
export function inferEntities(content) {
  const entities = [];
  const ignoredNames = new Set([
    "A", "I", "My", "Our", "The", "This", "That", "We", "You"
  ]);

  for (const pattern of ENTITY_PATTERNS) {
    for (const match of content.matchAll(pattern.regex)) {
      entities.push({ type: pattern.type, value: match[0] });
    }
  }

  const properNames = content.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g) || [];
  for (const name of properNames) {
    if (!ignoredNames.has(name)) {
      entities.push({ type: "name_or_title", value: name });
    }
  }

  return unique(entities.map((e) => `${e.type}:${e.value}`))
    .slice(0, 10)
    .map((entry) => {
      const sep = entry.indexOf(":");
      return { type: entry.slice(0, sep), value: entry.slice(sep + 1) };
    });
}

/**
 * Score how specific (concrete) a piece of content is (0–1).
 *
 * @param {string} content
 * @returns {number}
 */
export function scoreSpecificity(content) {
  const terms = tokenize(content);
  const entities = inferEntities(content);
  let score = 0.2;

  if (terms.length >= 6)  score += 0.15;
  if (terms.length >= 14) score += 0.12;
  if (entities.length > 0) score += 0.18;
  if (/\b\d+\b/.test(content)) score += 0.12;
  if (/\b(because|so that|means|requires|must|should|will|decided)\b/i.test(content)) score += 0.14;

  return clampScore(score);
}

/**
 * Score how permanent (long-lived) a memory is likely to be (0–1).
 *
 * @param {string} content
 * @param {string} memoryType
 * @returns {number}
 */
export function scorePermanence(content, memoryType) {
  const lower = content.toLowerCase();
  let score = memoryType === "factual" ? 0.68 : memoryType === "semantic" ? 0.54 : 0.42;

  if (countMatches(lower, ["my name is", "i am", "i'm", "we are", "i prefer", "we want", "our project"]) > 0) score += 0.18;
  if (countMatches(lower, ["today", "tomorrow", "yesterday", "currently", "now", "temporary"]) > 0) score -= 0.14;
  if (countMatches(lower, ["always", "usually", "default", "primary", "major"]) > 0) score += 0.08;

  return clampScore(score);
}

/**
 * Score how actionable a memory is — how likely it maps to a task or decision (0–1).
 *
 * @param {string} content
 * @returns {number}
 */
export function scoreActionability(content) {
  const lower = content.toLowerCase();
  let score = 0.15;

  if (countMatches(lower, ["need to", "have to", "must", "should", "lets", "let's", "work on", "add", "fix", "build", "change", "improve"]) > 0) score += 0.35;
  if (countMatches(lower, ["next step", "todo", "deadline", "plan", "decision"]) > 0) score += 0.2;
  if (lower.includes("?")) score -= 0.1;

  return clampScore(score);
}

/**
 * Infer the emotional tone of content.
 *
 * @param {string} content
 * @returns {"positive" | "negative" | "neutral"}
 */
export function inferSentiment(content) {
  const lower = content.toLowerCase();
  const positive = countMatches(lower, ["like", "prefer", "good", "great", "best", "clear", "improve", "working"]);
  const negative = countMatches(lower, ["dislike", "bad", "issue", "problem", "bug", "failed", "wrong", "not working"]);

  if (positive > negative) return "positive";
  if (negative > positive) return "negative";
  return "neutral";
}

/**
 * Score how strong the memory signal is — how much useful information content carries (0–1).
 *
 * @param {string} content
 * @param {string} memoryType
 * @param {string[]} tags
 * @returns {number}
 */
export function scoreSignalStrength(content, memoryType, tags) {
  const terms = tokenize(content);
  let score = 0.25;

  if (memoryType === "factual")       score += 0.2;
  else if (memoryType === "episodic") score += 0.14;
  else                                score += 0.08;

  score += Math.min(0.16, terms.length * 0.01);
  score += Math.min(0.16, tags.length * 0.04);

  if (hasLowSignalContent(content)) score -= 0.3;
  if (/\b(maybe|perhaps|not sure|i think|probably)\b/i.test(content)) score -= 0.08;

  return clampScore(score);
}
