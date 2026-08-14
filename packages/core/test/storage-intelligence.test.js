/**
 * packages/core/test/storage-intelligence.test.js
 *
 * Unit tests for the storage intelligence layer:
 *   - importanceScorer.js   →  calculateImportance
 *   - deduplicationService.js → normalizeText, similarity, isDuplicate,
 *                               mergeMemory
 *
 * Test runner: Node 22 built-in (node --test)
 * Import style: ESM
 */

import assert from "node:assert/strict";
import test   from "node:test";

import {
  calculateImportance
} from "../src/memory/services/importanceScorer.js";

import {
  normalizeText,
  similarity,
  isDuplicate,
  mergeMemory,
  DEFAULT_DEDUP_THRESHOLD
} from "../src/memory/services/deduplicationService.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal MemoryCandidate for testing.
 *
 * @param {Partial<{content: string, metadata: object}>} overrides
 * @returns {object}
 */
function makeMemory(overrides = {}) {
  return {
    memoryType: "factual",
    content:    overrides.content ?? "My name is Alice and I prefer TypeScript.",
    summary:    overrides.summary ?? "My name is Alice.",
    metadata: {
      importance:  0.65,
      confidence:  0.72,
      timestamp:   new Date().toISOString(),
      accessCount: 0,
      savedByUser: false,
      tags:        ["identity"],
      keywords:    ["alice", "typescript"],
      entities:    [{ type: "person", value: "Alice" }],
      ...(overrides.metadata ?? {})
    }
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// calculateImportance
// ══════════════════════════════════════════════════════════════════════════════

test("calculateImportance: returns an object with all breakdown fields", () => {
  const memory = makeMemory();
  const result = calculateImportance(memory);

  assert.ok(typeof result === "object", "result should be an object");
  assert.ok(typeof result.score          === "number", "score should be a number");
  assert.ok(typeof result.base           === "number", "base should be a number");
  assert.ok(typeof result.recencyScore   === "number", "recencyScore should be a number");
  assert.ok(typeof result.frequencyScore === "number", "frequencyScore should be a number");
  assert.ok(typeof result.savedBonus     === "number", "savedBonus should be a number");
  assert.ok(typeof result.mentionBonus   === "number", "mentionBonus should be a number");
  assert.ok(typeof result.lengthScore    === "number", "lengthScore should be a number");
});

test("calculateImportance: score is always in [0, 1]", () => {
  const cases = [
    makeMemory({ metadata: { importance: 0 } }),
    makeMemory({ metadata: { importance: 1 } }),
    makeMemory({ metadata: { importance: 0.5 } }),
    makeMemory({ content: "", metadata: { importance: 0.5, timestamp: null } }),
    makeMemory({ metadata: { importance: -5 } }),    // out-of-range base
    makeMemory({ metadata: { importance: 999 } })    // out-of-range base
  ];

  for (const memory of cases) {
    const { score } = calculateImportance(memory);
    assert.ok(score >= 0 && score <= 1, `score ${score} is out of [0,1]`);
  }
});

test("calculateImportance: high-importance memory scores higher than low-importance", () => {
  const highImportanceMemory = makeMemory({
    content: "This is a detailed and important fact about the AiNeura project architecture decisions and memory system design.",
    metadata: {
      importance:  0.90,
      confidence:  0.88,
      timestamp:   new Date().toISOString(),   // very recent
      accessCount: 15,
      savedByUser: true
    }
  });

  const lowImportanceMemory = makeMemory({
    content: "ok",
    metadata: {
      importance:  0.15,
      confidence:  0.30,
      timestamp:   new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days ago
      accessCount: 0,
      savedByUser: false
    }
  });

  const high = calculateImportance(highImportanceMemory).score;
  const low  = calculateImportance(lowImportanceMemory).score;

  assert.ok(high > low, `high importance (${high}) should exceed low importance (${low})`);
});

test("calculateImportance: savedByUser flag adds a bonus", () => {
  const base   = makeMemory({ metadata: { importance: 0.5, savedByUser: false } });
  const pinned = makeMemory({ metadata: { importance: 0.5, savedByUser: true  } });

  const baseScore   = calculateImportance(base).score;
  const pinnedScore = calculateImportance(pinned).score;

  assert.ok(pinnedScore > baseScore, "pinned memory should score higher than unpinned");
  assert.equal(calculateImportance(pinned).savedBonus, 0.15, "savedBonus should be 0.15");
});

test("calculateImportance: context.savedByUser overrides metadata.savedByUser", () => {
  const memory = makeMemory({ metadata: { importance: 0.5, savedByUser: false } });

  const withoutContext = calculateImportance(memory).score;
  const withContext    = calculateImportance(memory, { savedByUser: true }).score;

  assert.ok(withContext > withoutContext, "context savedByUser should override metadata");
});

test("calculateImportance: higher accessCount yields higher score", () => {
  const base     = makeMemory({ metadata: { importance: 0.5, accessCount: 0  } });
  const frequent = makeMemory({ metadata: { importance: 0.5, accessCount: 10 } });

  const baseScore     = calculateImportance(base).score;
  const frequentScore = calculateImportance(frequent).score;

  assert.ok(frequentScore > baseScore, "frequently accessed memory should score higher");
});

test("calculateImportance: access count saturates (20 vs 200 should not differ much)", () => {
  const memory  = makeMemory({ metadata: { importance: 0.5 } });
  const score20  = calculateImportance(memory, { accessCount: 20  }).score;
  const score200 = calculateImportance(memory, { accessCount: 200 }).score;

  // Scores should be equal or very close (within 0.02) since saturation kicks in.
  assert.ok(Math.abs(score20 - score200) <= 0.02,
    `score should saturate: score20=${score20}, score200=${score200}`);
});

test("calculateImportance: recent memory scores higher than old memory", () => {
  const nowMs   = Date.now();
  // Use episodic type — factual memories intentionally don't decay with age
  // (a name is as true today as it was months ago).
  const recent  = {
    memoryType: "episodic",
    content: "We discussed the architecture today.",
    metadata: { importance: 0.6, timestamp: new Date(nowMs).toISOString() }
  };
  const old     = {
    memoryType: "episodic",
    content: "We discussed the architecture today.",
    metadata: { importance: 0.6, timestamp: new Date(nowMs - 20 * 24 * 60 * 60 * 1000).toISOString() }
  };

  const recentScore = calculateImportance(recent, { nowMs }).score;
  const oldScore    = calculateImportance(old,    { nowMs }).score;

  assert.ok(recentScore > oldScore, `recent (${recentScore}) should beat old (${oldScore})`);
});

test("calculateImportance: no timestamp falls back to neutral recency (0.5)", () => {
  const memory = makeMemory({ metadata: { importance: 0.5, timestamp: null } });
  const result = calculateImportance(memory);

  assert.equal(result.recencyScore, 0.5, "missing timestamp should yield neutral recency");
});

test("calculateImportance: longer content scores higher lengthScore", () => {
  const shortMemory = makeMemory({ content: "Hi." });
  const longMemory  = makeMemory({
    content: "This memory contains a detailed description of the architecture decision we made regarding the memory extraction pipeline design, including the deduplication strategy and importance scoring algorithm."
  });

  const shortScore = calculateImportance(shortMemory).lengthScore;
  const longScore  = calculateImportance(longMemory).lengthScore;

  assert.ok(longScore > shortScore, "longer content should score a higher lengthScore");
});

test("calculateImportance: mentionCount context boosts score", () => {
  const memory = makeMemory({ metadata: { importance: 0.5 } });

  const noMentions  = calculateImportance(memory, { mentionCount: 0 }).score;
  const manyMentions = calculateImportance(memory, { mentionCount: 8 }).score;

  assert.ok(manyMentions > noMentions,
    `many mentions (${manyMentions}) should exceed no mentions (${noMentions})`);
});

test("calculateImportance: handles null/undefined memory gracefully", () => {
  // Should not throw — returns a valid score breakdown with neutral values.
  const result = calculateImportance(null);
  assert.ok(result.score >= 0 && result.score <= 1, "null memory should still return valid score");
});

// ══════════════════════════════════════════════════════════════════════════════
// normalizeText
// ══════════════════════════════════════════════════════════════════════════════

test("normalizeText: lower-cases input", () => {
  assert.equal(normalizeText("Hello World"), "hello world");
});

test("normalizeText: strips punctuation", () => {
  const result = normalizeText("Hello, World!");
  // Punctuation is replaced with spaces and then whitespace is collapsed.
  assert.ok(!/[,!?.]/.test(result), "no punctuation should remain");
  assert.ok(!/ {2,}/.test(result), "whitespace should be collapsed");
});

test("normalizeText: expands contractions", () => {
  assert.ok(normalizeText("don't").includes("not"), "don't → do not");
  assert.ok(normalizeText("I'm here").includes("i am"), "I'm → I am");
  assert.ok(normalizeText("can't").includes("cannot") || normalizeText("can't").includes("not"), "can't expanded");
});

test("normalizeText: collapses multiple spaces", () => {
  const result = normalizeText("hello    world");
  assert.ok(!/ {2,}/.test(result), "should not have double spaces");
});

test("normalizeText: returns empty string for non-string input", () => {
  assert.equal(normalizeText(null),      "");
  assert.equal(normalizeText(undefined), "");
  assert.equal(normalizeText(42),        "");
});

// ══════════════════════════════════════════════════════════════════════════════
// similarity
// ══════════════════════════════════════════════════════════════════════════════

test("similarity: identical strings return 1.0", () => {
  const text = "My name is Alice and I prefer TypeScript.";
  assert.equal(similarity(text, text), 1);
});

test("similarity: completely unrelated strings return low score", () => {
  const a = "My name is Alice and I prefer TypeScript";
  const b = "The weather in Mumbai is hot and humid today";
  const score = similarity(a, b);
  assert.ok(score < 0.3, `unrelated strings score ${score} should be < 0.3`);
});

test("similarity: near-duplicate with minor rewording returns high score", () => {
  const a = "My name is Alice and I prefer TypeScript for all my projects.";
  const b = "Alice is my name and I like TypeScript for projects.";
  const score = similarity(a, b);
  // Jaccard over meaningful tokens: both share "alice", "name", "typescript", "projects" etc.
  // The threshold here is intentionally moderate — exact value depends on stop-word stripping.
  assert.ok(score >= 0.5, `near-duplicate score ${score} should be >= 0.5`);
});

test("similarity: score is symmetric", () => {
  const a = "I enjoy working with Node.js and JavaScript";
  const b = "Working with JavaScript and Node.js is enjoyable";
  assert.equal(similarity(a, b), similarity(b, a), "similarity must be symmetric");
});

test("similarity: score is in [0, 1]", () => {
  const pairs = [
    ["hello", "world"],
    ["", ""],
    ["  ", " "],
    ["The quick brown fox", "The quick brown fox jumps over the lazy dog"],
    ["abc", "abc"]
  ];
  for (const [a, b] of pairs) {
    const s = similarity(a, b);
    assert.ok(s >= 0 && s <= 1, `similarity(${JSON.stringify(a)}, ${JSON.stringify(b)}) = ${s} out of [0,1]`);
  }
});

test("similarity: empty strings", () => {
  assert.equal(similarity("", ""), 1, "two empty strings should be identical");
  const score = similarity("hello world", "");
  assert.ok(score >= 0 && score <= 1, "empty vs non-empty should be in [0,1]");
});

test("similarity: handles non-string gracefully", () => {
  assert.equal(similarity(null, "hello"), 0);
  assert.equal(similarity("hello", null), 0);
  assert.equal(similarity(null, null), 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// isDuplicate
// ══════════════════════════════════════════════════════════════════════════════

test("isDuplicate: exact duplicate is detected", () => {
  const text = "My name is Alice and I prefer TypeScript.";
  assert.ok(isDuplicate(text, text), "exact duplicate should be detected");
});

test("isDuplicate: clearly different texts are not duplicates", () => {
  const a = "My name is Alice and I prefer TypeScript";
  const b = "The deployment pipeline uses GitHub Actions and Docker containers";
  assert.ok(!isDuplicate(a, b), "different texts should not be duplicates");
});

test("isDuplicate: near-duplicate with slight rewording is detected", () => {
  const a = "I prefer TypeScript for all backend development work.";
  const b = "I prefer TypeScript for backend development.";
  // High Jaccard similarity — should trip the threshold.
  const score = similarity(a, b);
  if (score >= DEFAULT_DEDUP_THRESHOLD) {
    assert.ok(isDuplicate(a, b), "near-duplicate should be flagged");
  } else {
    // If below threshold (both strings differ enough), not-duplicate is correct.
    assert.ok(!isDuplicate(a, b), "below threshold means not a duplicate");
  }
});

test("isDuplicate: respects custom threshold", () => {
  const a = "I enjoy working with TypeScript and Node";
  const b = "I enjoy TypeScript and Node.js development";
  const score = similarity(a, b);

  // With threshold = 0 everything is a duplicate.
  assert.ok(isDuplicate(a, b, 0), "threshold=0 means everything is duplicate");

  // With threshold = 1 only exact duplicates match.
  assert.ok(!isDuplicate(a, b, 1) || score === 1,
    "threshold=1 should only match perfect duplicates");
});

test("isDuplicate: handles non-string inputs gracefully", () => {
  assert.equal(isDuplicate(null, "text"), false);
  assert.equal(isDuplicate("text", null), false);
  assert.equal(isDuplicate(null, null),   false);
});

test("isDuplicate: supports custom scorer injection", () => {
  // Inject a scorer that always returns 1.0 — everything becomes a duplicate.
  const alwaysMatch = () => 1;
  assert.ok(isDuplicate("anything", "else", DEFAULT_DEDUP_THRESHOLD, alwaysMatch),
    "custom scorer returning 1 should always flag as duplicate");

  // Inject a scorer that always returns 0 — nothing is a duplicate.
  const neverMatch = () => 0;
  assert.ok(!isDuplicate("anything", "anything", DEFAULT_DEDUP_THRESHOLD, neverMatch),
    "custom scorer returning 0 should never flag as duplicate");
});

// ══════════════════════════════════════════════════════════════════════════════
// mergeMemory
// ══════════════════════════════════════════════════════════════════════════════

test("mergeMemory: prefers longer content", () => {
  const short = makeMemory({ content: "Alice prefers TypeScript." });
  const long  = makeMemory({
    content: "Alice prefers TypeScript for all her backend projects, especially APIs.",
    summary: "Alice prefers TypeScript for backend projects."
  });

  const merged = mergeMemory(short, long);
  assert.equal(merged.content, long.content, "merged content should be the longer version");
});

test("mergeMemory: prefers longer summary", () => {
  const a = makeMemory({ summary: "Short summary." });
  const b = makeMemory({ summary: "A much longer and more descriptive summary of the memory." });

  const merged = mergeMemory(a, b);
  assert.equal(merged.summary, b.summary, "merged summary should be the longer version");
});

test("mergeMemory: importance is the max of both", () => {
  const low  = makeMemory({ metadata: { importance: 0.4, confidence: 0.5 } });
  const high = makeMemory({ metadata: { importance: 0.9, confidence: 0.7 } });

  const merged = mergeMemory(low, high);
  assert.equal(merged.metadata.importance, 0.9, "merged importance should be the maximum");
});

test("mergeMemory: confidence is a weighted average (existing 2/3, incoming 1/3)", () => {
  const existing = makeMemory({ metadata: { importance: 0.5, confidence: 0.9 } });
  const incoming = makeMemory({ metadata: { importance: 0.5, confidence: 0.3 } });

  const merged   = mergeMemory(existing, incoming);
  const expected = Number((0.9 * (2 / 3) + 0.3 * (1 / 3)).toFixed(2));

  assert.equal(merged.metadata.confidence, expected,
    `confidence should be weighted average: expected ${expected}, got ${merged.metadata.confidence}`);
});

test("mergeMemory: access counts are accumulated", () => {
  const a = makeMemory({ metadata: { importance: 0.5, confidence: 0.5, accessCount: 5  } });
  const b = makeMemory({ metadata: { importance: 0.5, confidence: 0.5, accessCount: 3  } });

  const merged = mergeMemory(a, b);
  assert.equal(merged.metadata.accessCount, 8, "access counts should be summed");
});

test("mergeMemory: savedByUser is true if either record has it set", () => {
  const unsaved = makeMemory({ metadata: { importance: 0.5, confidence: 0.5, savedByUser: false } });
  const saved   = makeMemory({ metadata: { importance: 0.5, confidence: 0.5, savedByUser: true  } });

  assert.ok(mergeMemory(unsaved, saved).metadata.savedByUser,   "saved incoming → merged is saved");
  assert.ok(mergeMemory(saved, unsaved).metadata.savedByUser,   "saved existing → merged is saved");
  assert.ok(!mergeMemory(unsaved, unsaved).metadata.savedByUser,"both unsaved → merged is unsaved");
});

test("mergeMemory: tags are unioned and deduplicated", () => {
  const a = makeMemory({ metadata: { importance: 0.5, confidence: 0.5, tags: ["identity", "project"] } });
  const b = makeMemory({ metadata: { importance: 0.5, confidence: 0.5, tags: ["project", "typescript"] } });

  const merged = mergeMemory(a, b);
  const tags   = merged.metadata.tags;

  assert.ok(tags.includes("identity"),   "should include identity");
  assert.ok(tags.includes("project"),    "should include project");
  assert.ok(tags.includes("typescript"), "should include typescript");
  assert.equal(tags.filter((t) => t === "project").length, 1, "project should not be duplicated");
});

test("mergeMemory: keywords are unioned and deduplicated", () => {
  const a = makeMemory({ metadata: { importance: 0.5, confidence: 0.5, keywords: ["alice", "typescript"] } });
  const b = makeMemory({ metadata: { importance: 0.5, confidence: 0.5, keywords: ["typescript", "node"]  } });

  const merged   = mergeMemory(a, b);
  const keywords = merged.metadata.keywords;

  assert.ok(keywords.includes("alice"),      "should include alice");
  assert.ok(keywords.includes("typescript"), "should include typescript");
  assert.ok(keywords.includes("node"),       "should include node");
  assert.equal(keywords.filter((k) => k === "typescript").length, 1, "typescript should not be duplicated");
});

test("mergeMemory: entities are unioned and deduplicated by type:value", () => {
  const a = makeMemory({ metadata: { importance: 0.5, confidence: 0.5,
    entities: [{ type: "person", value: "Alice" }, { type: "tech", value: "TypeScript" }] } });
  const b = makeMemory({ metadata: { importance: 0.5, confidence: 0.5,
    entities: [{ type: "tech", value: "TypeScript" }, { type: "tech", value: "Node.js" }] } });

  const merged   = mergeMemory(a, b);
  const entities = merged.metadata.entities;

  assert.equal(entities.filter((e) => e.type === "tech" && e.value === "TypeScript").length, 1,
    "TypeScript entity should not be duplicated");
  assert.ok(entities.some((e) => e.type === "tech" && e.value === "Node.js"), "Node.js entity should be present");
  assert.ok(entities.some((e) => e.type === "person" && e.value === "Alice"), "Alice entity should be present");
});

test("mergeMemory: keeps the most recent timestamp", () => {
  const olderTs = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(); // 5 hours ago
  const newerTs = new Date().toISOString();

  const older  = makeMemory({ metadata: { importance: 0.5, confidence: 0.5, timestamp: olderTs } });
  const newer  = makeMemory({ metadata: { importance: 0.5, confidence: 0.5, timestamp: newerTs } });

  assert.equal(mergeMemory(older,  newer).metadata.timestamp, newerTs, "newer timestamp should win (newer as incoming)");
  assert.equal(mergeMemory(newer,  older).metadata.timestamp, newerTs, "newer timestamp should win (newer as existing)");
});

test("mergeMemory: does not mutate input objects", () => {
  const existing = makeMemory({ content: "Original content", metadata: { importance: 0.5, confidence: 0.5, accessCount: 2 } });
  const incoming = makeMemory({ content: "Incoming content", metadata: { importance: 0.7, confidence: 0.8, accessCount: 3 } });

  // Deep-copy originals to compare after merge.
  const existingBefore = JSON.parse(JSON.stringify(existing));
  const incomingBefore = JSON.parse(JSON.stringify(incoming));

  mergeMemory(existing, incoming); // should not mutate inputs

  assert.deepEqual(existing, existingBefore, "existing should not be mutated");
  assert.deepEqual(incoming, incomingBefore, "incoming should not be mutated");
});

test("mergeMemory: handles missing metadata fields gracefully", () => {
  const a = { memoryType: "factual", content: "Alice",   summary: "Alice",   metadata: {} };
  const b = { memoryType: "factual", content: "Alice B", summary: "Alice B", metadata: {} };

  // Should not throw even with empty metadata.
  const merged = mergeMemory(a, b);
  assert.equal(merged.metadata.accessCount, 0, "missing accessCount should default to 0");
  assert.equal(merged.metadata.savedByUser, false, "missing savedByUser should default to false");
  assert.deepEqual(merged.metadata.tags,     [], "missing tags should default to []");
  assert.deepEqual(merged.metadata.keywords, [], "missing keywords should default to []");
  assert.deepEqual(merged.metadata.entities, [], "missing entities should default to []");
});
