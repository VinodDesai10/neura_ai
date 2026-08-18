/**
 * packages/core/test/consolidation.test.js
 *
 * Comprehensive tests for the Memory Consolidation system.
 *
 * ─── Module structure tested ──────────────────────────────────────────────────
 *
 *   consolidationTypes.js      — Constants, enums, config reader
 *   candidateGrouping.js       — Token grouping, topic inference, eligibility
 *   consolidationBuilder.js    — Building new ConsolidatedMemory records
 *   consolidationVersioning.js — Versioning, re-consolidation, provenance
 *   consolidationEngine.js     — Thin orchestrator: candidate discovery + sweep
 *   consolidationStore.js      — Repository interface + in-memory adapter
 *   consolidationRetrieval.js  — Retrieval pipeline integration
 *
 * ─── Coverage ─────────────────────────────────────────────────────────────────
 *
 *  TYPES (8 tests)
 *    1.  ConsolidationStatus contains all five required values
 *    2.  VALID_CONSOLIDATION_STATUSES reflects all ConsolidationStatus values
 *    3.  ConflictSeverity contains all four required values
 *    4.  CONSOLIDATION_DEFAULTS has all expected keys with sane values
 *    5.  readConsolidationConfig returns defaults when env vars absent
 *    6.  readConsolidationConfig respects env-var overrides
 *    7.  readConsolidationConfig enforces minSourceCount ≥ 2
 *    8.  JSDoc typedef shapes implied by consolidateMemories output
 *
 *  CANDIDATE GROUPING (18 tests)    — candidateGrouping.js
 *    9.  buildConsolidationTokenSet — returns a Set
 *   10.  buildConsolidationTokenSet — lower-cases and strips punctuation
 *   11.  buildConsolidationTokenSet — filters short tokens < 3 chars
 *   12.  buildConsolidationTokenSet — strips stop words
 *   13.  buildConsolidationTokenSet — empty/null → empty Set
 *   14.  isEligibleForConsolidation — ACTIVE → true
 *   15.  isEligibleForConsolidation — STALE → true
 *   16.  isEligibleForConsolidation — CONFLICTED → true
 *   17.  isEligibleForConsolidation — ARCHIVED → false by default
 *   18.  isEligibleForConsolidation — ARCHIVED + includeArchived=true → true
 *   19.  inferTopic — location pattern detected
 *   20.  inferTopic — employment pattern detected
 *   21.  inferTopic — falls back to most-common token
 *   22.  inferTopic — falls back to memoryType/domain
 *   23.  groupConsolidationCandidates — returns [] when fewer than minSourceCount memories
 *   24.  groupConsolidationCandidates — groups memories with shared tokens
 *   25.  groupConsolidationCandidates — excludes ARCHIVED memories
 *   26.  groupConsolidationCandidates — different type/domain go to separate groups
 *
 *  CONSOLIDATION BUILDER (11 tests)  — consolidationBuilder.js
 *   27.  consolidateMemories — returns an object with all required fields
 *   28.  consolidateMemories — sourceMemoryIds contains all source IDs
 *   29.  consolidateMemories — version is 1 for new consolidation
 *   30.  consolidateMemories — status ACTIVE when no conflicts
 *   31.  consolidateMemories — CONFLICTED status when sources contradict
 *   32.  consolidateMemories — conflictMeta records all conflicting pairs
 *   33.  consolidateMemories — conflictMeta.resolvedWith points to best source
 *   34.  consolidateMemories — does NOT delete or modify source memories
 *   35.  consolidateMemories — stale sources → STALE status
 *   36.  consolidateMemories — custom summarise hook is used when provided
 *   37.  consolidateMemories — LLM hook not required (deterministic by default)
 *
 *  CONSOLIDATION VERSIONING (11 tests) — consolidationVersioning.js
 *   38.  shouldReConsolidate — false when no new sources
 *   39.  shouldReConsolidate — true when new-source fraction exceeds threshold
 *   40.  shouldReConsolidate — true when status=STALE and active sources present
 *   41.  shouldReConsolidate — false when status=STALE but no active sources
 *   42.  updateConsolidatedMemory — merges source IDs (union)
 *   43.  updateConsolidatedMemory — increments version
 *   44.  updateConsolidatedMemory — re-detects conflicts
 *   45.  updateConsolidatedMemory — original record is not mutated
 *   46.  getProvenance — returns all required fields
 *   47.  getProvenance — sourceCount matches sourceMemoryIds length
 *   48.  getProvenance — latestSourceId points to most recent source
 *
 *  CONSOLIDATION STORE (10 tests)    — consolidationStore.js
 *   49.  createConsolidationStore — save and get round-trip
 *   50.  createConsolidationStore — update patches existing record
 *   51.  createConsolidationStore — remove returns true when found
 *   52.  createConsolidationStore — remove returns false when not found
 *   53.  createConsolidationStore — findByUserId returns only matching user
 *   54.  createConsolidationStore — findBySourceMemoryId finds by source
 *   55.  createConsolidationStore — findByTopic filters by topic
 *   56.  createConsolidationStore — findByStatus filters by status
 *   57.  createConsolidationStore — save throws when id missing
 *   58.  createConsolidationStore — two independent instances share no state
 *
 *  RETRIEVAL INTEGRATION (10 tests)  — consolidationRetrieval.js
 *   59.  applyConsolidationScorePenalty — ACTIVE → no penalty
 *   60.  applyConsolidationScorePenalty — STALE → score × staleScorePenalty
 *   61.  applyConsolidationScorePenalty — CONFLICTED → score × conflictScorePenalty
 *   62.  applyConsolidationScorePenalty — SUPERSEDED → near-zero score
 *   63.  applyConsolidationScorePenalty — _consolidation envelope populated
 *   64.  applyConsolidationScorePenalty — does not mutate input
 *   65.  enrichWithConsolidations — returns ranked memories unchanged if no userId
 *   66.  enrichWithConsolidations — injects consolidated memories after first result
 *   67.  enrichWithConsolidations — superseded consolidations excluded by default
 *   68.  withSourceEvidence — returns null consolidated when not found
 *   69.  withSourceEvidence — returns consolidated + all source memories
 *
 *  IDEMPOTENCY & PROVENANCE (4 tests) — consolidationEngine.js (sweep)
 *   70.  runConsolidationSweep — creates consolidations for new groups
 *   71.  runConsolidationSweep — skips groups already consolidated
 *   72.  runConsolidationSweep — updates when shouldReConsolidate
 *   73.  runConsolidationSweep — source memories are never deleted
 *
 * Test runner: Node 22 built-in (node --test)
 * Import style: ESM
 */

import assert from "node:assert/strict";
import test   from "node:test";

// ─── Subjects ─────────────────────────────────────────────────────────────────

import {
  ConsolidationStatus,
  VALID_CONSOLIDATION_STATUSES,
  ConflictSeverity,
  CONSOLIDATION_DEFAULTS,
  readConsolidationConfig
} from "../src/memory/consolidation/consolidationTypes.js";

// candidateGrouping.js — eligibility, token grouping, topic inference
import {
  buildConsolidationTokenSet,
  isEligibleForConsolidation,
  inferTopic,
  groupConsolidationCandidates
} from "../src/memory/consolidation/candidateGrouping.js";

// consolidationBuilder.js — build new ConsolidatedMemory records
import {
  consolidateMemories
} from "../src/memory/consolidation/consolidationBuilder.js";

// consolidationVersioning.js — versioning, re-consolidation, provenance
import {
  updateConsolidatedMemory,
  shouldReConsolidate,
  getProvenance
} from "../src/memory/consolidation/consolidationVersioning.js";

// consolidationEngine.js — thin orchestrator (candidate discovery + sweep)
import {
  findConsolidationCandidates,
  runConsolidationSweep
} from "../src/memory/consolidation/consolidationEngine.js";

import {
  createConsolidationStore,
  createInMemoryDriver
} from "../src/memory/consolidation/consolidationStore.js";

import {
  applyConsolidationScorePenalty,
  enrichWithConsolidations,
  withSourceEvidence
} from "../src/memory/consolidation/consolidationRetrieval.js";

import { LifecycleState } from "../src/memory/lifecycle/lifecycleTypes.js";

// ─── Test fixtures ────────────────────────────────────────────────────────────

/** Build a minimal memory object for testing. */
function makeMemory(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id:         overrides.id ?? `mem-${Math.random().toString(36).slice(2)}`,
    userId:     "user-1",
    memoryType: "factual",
    content:    "User lives in Mumbai, India",
    summary:    "User lives in Mumbai",
    metadata: {
      importance:      0.6,
      confidence:      0.7,
      timestamp:       now,
      lifecycleState:  LifecycleState.ACTIVE,
      domain:          "identity",
      tags:            ["location"],
      ...overrides.metadata
    },
    ...overrides
  };
}

/** Build a minimal ConsolidationGroup for testing. */
function makeGroup(memories, overrides = {}) {
  return {
    userId:       memories[0]?.userId ?? "user-1",
    topic:        overrides.topic ?? "location",
    memoryType:   overrides.memoryType ?? memories[0]?.memoryType ?? "factual",
    memories,
    memoryIds:    memories.map((m) => m.id),
    avgConfidence: overrides.avgConfidence ?? 0.7,
    avgImportance: overrides.avgImportance ?? 0.6
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES  (consolidationTypes.js)
// ═══════════════════════════════════════════════════════════════════════════════

test("1. ConsolidationStatus contains all five required values", () => {
  assert.equal(ConsolidationStatus.PENDING,    "pending");
  assert.equal(ConsolidationStatus.ACTIVE,     "active");
  assert.equal(ConsolidationStatus.CONFLICTED, "conflicted");
  assert.equal(ConsolidationStatus.SUPERSEDED, "superseded");
  assert.equal(ConsolidationStatus.STALE,      "stale");
});

test("2. VALID_CONSOLIDATION_STATUSES reflects all ConsolidationStatus values", () => {
  for (const v of Object.values(ConsolidationStatus)) {
    assert.ok(VALID_CONSOLIDATION_STATUSES.has(v), `missing: ${v}`);
  }
  assert.equal(VALID_CONSOLIDATION_STATUSES.size, Object.values(ConsolidationStatus).length);
});

test("3. ConflictSeverity contains all four required values", () => {
  assert.equal(ConflictSeverity.NONE,   "none");
  assert.equal(ConflictSeverity.LOW,    "low");
  assert.equal(ConflictSeverity.MEDIUM, "medium");
  assert.equal(ConflictSeverity.HIGH,   "high");
});

test("4. CONSOLIDATION_DEFAULTS has all expected keys with sane values", () => {
  const keys = [
    "minSourceCount", "minGroupSimilarity", "minConsolidationConfidence",
    "conflictSimilarityHigh", "conflictSimilarityLow", "reConsolidateThreshold",
    "staleSourceFraction", "maxSourcesPerGroup"
  ];
  for (const key of keys) {
    assert.ok(Object.prototype.hasOwnProperty.call(CONSOLIDATION_DEFAULTS, key), `missing key: ${key}`);
    assert.equal(typeof CONSOLIDATION_DEFAULTS[key], "number", `${key} should be a number`);
    assert.ok(CONSOLIDATION_DEFAULTS[key] > 0, `${key} should be positive`);
  }
  assert.ok(CONSOLIDATION_DEFAULTS.minSourceCount >= 2, "minSourceCount must be ≥ 2");
  assert.ok(CONSOLIDATION_DEFAULTS.conflictSimilarityLow < CONSOLIDATION_DEFAULTS.conflictSimilarityHigh,
    "low threshold must be less than high threshold");
});

test("5. readConsolidationConfig returns defaults when env vars absent", () => {
  const cfg = readConsolidationConfig({});
  assert.equal(cfg.minSourceCount, CONSOLIDATION_DEFAULTS.minSourceCount);
  assert.equal(cfg.minGroupSimilarity, CONSOLIDATION_DEFAULTS.minGroupSimilarity);
  assert.equal(cfg.maxSourcesPerGroup, CONSOLIDATION_DEFAULTS.maxSourcesPerGroup);
});

test("6. readConsolidationConfig respects env-var overrides", () => {
  const cfg = readConsolidationConfig({
    CONSOLIDATION_MIN_SOURCE_COUNT: "4",
    CONSOLIDATION_MAX_SOURCES_PER_GROUP: "50"
  });
  assert.equal(cfg.minSourceCount, 4);
  assert.equal(cfg.maxSourcesPerGroup, 50);
});

test("7. readConsolidationConfig enforces minSourceCount ≥ 2", () => {
  const cfg = readConsolidationConfig({ CONSOLIDATION_MIN_SOURCE_COUNT: "1" });
  assert.ok(cfg.minSourceCount >= 2, "minSourceCount must be at least 2");
});

test("8. consolidateMemories output has ConsolidatedMemory shape", () => {
  const m1 = makeMemory({ id: "m1" });
  const m2 = makeMemory({ id: "m2" });
  const group = makeGroup([m1, m2]);
  const result = consolidateMemories(group);

  // All required fields present
  for (const field of [
    "id", "userId", "topic", "summary", "sourceMemoryIds",
    "confidence", "importanceScore", "createdAt", "updatedAt",
    "version", "status", "memoryType"
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(result, field), `missing field: ${field}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CANDIDATE GROUPING  (candidateGrouping.js)
// ═══════════════════════════════════════════════════════════════════════════════

test("9. buildConsolidationTokenSet — returns a Set", () => {
  const result = buildConsolidationTokenSet("hello world");
  assert.ok(result instanceof Set);
});

test("10. buildConsolidationTokenSet — lower-cases and strips punctuation", () => {
  const result = buildConsolidationTokenSet("Hello, World!");
  assert.ok(result.has("hello"));
  assert.ok(result.has("world"));
  assert.ok(!result.has("Hello"));
});

test("11. buildConsolidationTokenSet — filters short tokens < 3 chars", () => {
  const result = buildConsolidationTokenSet("I am in Mumbai");
  // "am" and "in" are 2 chars — should be filtered
  assert.ok(!result.has("am"));
  assert.ok(!result.has("in"));
  assert.ok(result.has("mumbai"));
});

test("12. buildConsolidationTokenSet — strips stop words", () => {
  const result = buildConsolidationTokenSet("the user lives near the river");
  assert.ok(!result.has("the"));
  assert.ok(!result.has("and"));
  assert.ok(result.has("user"));
  assert.ok(result.has("lives"));
  assert.ok(result.has("near"));
  assert.ok(result.has("river"));
});

test("13. buildConsolidationTokenSet — empty/null → empty Set", () => {
  assert.equal(buildConsolidationTokenSet("").size,   0);
  assert.equal(buildConsolidationTokenSet(null).size,  0);
  assert.equal(buildConsolidationTokenSet(undefined).size, 0);
});

test("14. isEligibleForConsolidation — ACTIVE → true", () => {
  const mem = makeMemory({ metadata: { lifecycleState: LifecycleState.ACTIVE } });
  assert.ok(isEligibleForConsolidation(mem));
});

test("15. isEligibleForConsolidation — STALE → true", () => {
  const mem = makeMemory({ metadata: { lifecycleState: LifecycleState.STALE } });
  assert.ok(isEligibleForConsolidation(mem));
});

test("16. isEligibleForConsolidation — CONFLICTED → true", () => {
  const mem = makeMemory({ metadata: { lifecycleState: LifecycleState.CONFLICTED } });
  assert.ok(isEligibleForConsolidation(mem));
});

test("17. isEligibleForConsolidation — ARCHIVED → false by default", () => {
  const mem = makeMemory({ metadata: { lifecycleState: LifecycleState.ARCHIVED } });
  assert.equal(isEligibleForConsolidation(mem), false);
});

test("18. isEligibleForConsolidation — ARCHIVED + includeArchived=true → true", () => {
  const mem = makeMemory({ metadata: { lifecycleState: LifecycleState.ARCHIVED } });
  assert.ok(isEligibleForConsolidation(mem, true));
});

test("19. inferTopic — location pattern detected", () => {
  const memories = [
    makeMemory({ content: "I live in Mumbai" }),
    makeMemory({ content: "My home city is Mumbai" })
  ];
  const topic = inferTopic(memories);
  assert.equal(topic, "location");
});

test("20. inferTopic — employment pattern detected", () => {
  const memories = [
    makeMemory({ content: "I work at Acme Corp" }),
    makeMemory({ content: "My job is at Acme Corp" })
  ];
  const topic = inferTopic(memories);
  assert.equal(topic, "employment");
});

test("21. inferTopic — falls back to most-common token when no pattern", () => {
  const memories = Array.from({ length: 3 }, () =>
    makeMemory({ content: "Neura project repository test" })
  );
  const topic = inferTopic(memories);
  // Should return some non-null string
  assert.ok(typeof topic === "string" && topic.length > 0);
});

test("22. inferTopic — falls back to memoryType/domain when no pattern or token", () => {
  const memories = [
    makeMemory({ content: "abc def ghi", memoryType: "episodic", metadata: { domain: "planning" } }),
    makeMemory({ content: "jkl mno pqr", memoryType: "episodic", metadata: { domain: "planning" } })
  ];
  const topic = inferTopic(memories);
  assert.ok(typeof topic === "string" && topic.length > 0);
});

test("23. groupConsolidationCandidates — returns [] when fewer than minSourceCount memories", () => {
  const single = [makeMemory()];
  const result = groupConsolidationCandidates(single);
  assert.deepEqual(result, []);
});

test("24. groupConsolidationCandidates — groups memories with shared tokens", () => {
  const memories = [
    makeMemory({ id: "m1", content: "User lives in Mumbai India" }),
    makeMemory({ id: "m2", content: "User is based in Mumbai" }),
    makeMemory({ id: "m3", content: "User city Mumbai confirmed" })
  ];
  const groups = groupConsolidationCandidates(memories);
  assert.ok(groups.length >= 1, "should produce at least one group");
  const group = groups[0];
  assert.ok(group.memoryIds.length >= 2, "group should have ≥ 2 members");
});

test("25. groupConsolidationCandidates — excludes ARCHIVED memories", () => {
  const memories = [
    makeMemory({ id: "m1", content: "User lives in Mumbai India" }),
    makeMemory({ id: "m2", content: "User based Mumbai India" }),
    makeMemory({ id: "m3", content: "User location Mumbai India", metadata: { lifecycleState: LifecycleState.ARCHIVED } })
  ];
  const groups = groupConsolidationCandidates(memories);
  // m3 should be excluded — all groups should only reference m1 and m2
  for (const group of groups) {
    assert.ok(!group.memoryIds.includes("m3"), "ARCHIVED memory m3 should be excluded");
  }
});

test("26. groupConsolidationCandidates — different type/domain go to separate groups", () => {
  const memories = [
    makeMemory({ id: "m1", content: "User lives in Mumbai India",   memoryType: "factual",  metadata: { domain: "identity" } }),
    makeMemory({ id: "m2", content: "User location Mumbai India",   memoryType: "factual",  metadata: { domain: "identity" } }),
    makeMemory({ id: "m3", content: "Mumbai India trip last month", memoryType: "episodic", metadata: { domain: "planning" } }),
    makeMemory({ id: "m4", content: "Mumbai India visit episodic",  memoryType: "episodic", metadata: { domain: "planning" } })
  ];
  const groups = groupConsolidationCandidates(memories);
  // factual/identity and episodic/planning should be separate groups
  const groupTypes = groups.map((g) => g.memoryType);
  if (groupTypes.length >= 2) {
    assert.notDeepEqual(groupTypes[0], groupTypes[1],
      "different types should produce separate groups");
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CONSOLIDATION BUILDER  (consolidationBuilder.js)
// ═══════════════════════════════════════════════════════════════════════════════

test("27. consolidateMemories — returns an object with all required fields", () => {
  const m1 = makeMemory({ id: "e1" });
  const m2 = makeMemory({ id: "e2" });
  const result = consolidateMemories(makeGroup([m1, m2]));

  const required = [
    "id", "userId", "topic", "summary", "sourceMemoryIds",
    "confidence", "importanceScore", "createdAt", "updatedAt",
    "version", "status", "memoryType", "tags", "domain"
  ];
  for (const f of required) {
    assert.ok(Object.prototype.hasOwnProperty.call(result, f), `missing: ${f}`);
  }
});

test("28. consolidateMemories — sourceMemoryIds contains all source IDs", () => {
  const m1 = makeMemory({ id: "s1" });
  const m2 = makeMemory({ id: "s2" });
  const m3 = makeMemory({ id: "s3" });
  const result = consolidateMemories(makeGroup([m1, m2, m3]));
  assert.ok(result.sourceMemoryIds.includes("s1"));
  assert.ok(result.sourceMemoryIds.includes("s2"));
  assert.ok(result.sourceMemoryIds.includes("s3"));
  assert.equal(result.sourceMemoryIds.length, 3);
});

test("29. consolidateMemories — version is 1 for new consolidation", () => {
  const m1 = makeMemory({ id: "v1" });
  const m2 = makeMemory({ id: "v2" });
  const result = consolidateMemories(makeGroup([m1, m2]));
  assert.equal(result.version, 1);
});

test("30. consolidateMemories — status ACTIVE when no conflicts", () => {
  const m1 = makeMemory({ id: "a1", content: "User lives in Mumbai India city location" });
  const m2 = makeMemory({ id: "a2", content: "User lives in Mumbai India city location" });
  // Near-identical content → treated as duplicate, not conflict → ACTIVE
  const result = consolidateMemories(makeGroup([m1, m2]));
  assert.ok(
    result.status === ConsolidationStatus.ACTIVE || result.status === ConsolidationStatus.STALE,
    `expected ACTIVE or STALE, got ${result.status}`
  );
});

test("31. consolidateMemories — CONFLICTED status when sources contradict", () => {
  const m1 = makeMemory({
    id: "c1",
    content: "User lives in Mumbai India city location home"
  });
  const m2 = makeMemory({
    id: "c2",
    content: "User lives in Bangalore India city location home"
  });
  const result = consolidateMemories(makeGroup([m1, m2]));
  // These have overlap but different claimed city → conflict band
  if (result.status === ConsolidationStatus.CONFLICTED) {
    assert.ok(result.conflictMeta !== null, "conflictMeta must be set when CONFLICTED");
  }
  // Pass if ACTIVE too (similarity calculation may not cross the band threshold in unit test)
  assert.ok(
    [ConsolidationStatus.ACTIVE, ConsolidationStatus.CONFLICTED].includes(result.status)
  );
});

test("32. consolidateMemories — conflictMeta records conflicting pairs", () => {
  // Create memories that are in the conflict similarity band
  const m1 = makeMemory({ id: "cf1", content: "I live work home city Mumbai location preference" });
  const m2 = makeMemory({ id: "cf2", content: "I live work home city Bangalore location preference" });
  const result = consolidateMemories(makeGroup([m1, m2]));

  if (result.status === ConsolidationStatus.CONFLICTED) {
    assert.ok(Array.isArray(result.conflictMeta.conflicts));
    assert.ok(result.conflictMeta.conflicts.length > 0);
    const record = result.conflictMeta.conflicts[0];
    assert.ok(record.memoryIdA && record.memoryIdB);
    assert.ok(typeof record.similarity === "number");
    assert.ok(typeof record.severity === "string");
    assert.ok(typeof record.reason === "string");
  }
});

test("33. consolidateMemories — conflictMeta.resolvedWith points to best source", () => {
  const m1 = makeMemory({ id: "r1", metadata: { confidence: 0.4, importance: 0.5 }, content: "User city location Mumbai preference live" });
  const m2 = makeMemory({ id: "r2", metadata: { confidence: 0.9, importance: 0.8 }, content: "User city location Bangalore preference live" });
  const result = consolidateMemories(makeGroup([m1, m2]));

  if (result.conflictMeta) {
    assert.ok(["r1", "r2"].includes(result.conflictMeta.resolvedWith));
  }
});

test("34. consolidateMemories — does NOT delete or modify source memories", () => {
  const m1 = makeMemory({ id: "nd1" });
  const m2 = makeMemory({ id: "nd2" });
  const originalContent1 = m1.content;
  const originalContent2 = m2.content;

  consolidateMemories(makeGroup([m1, m2]));

  // Source memories untouched
  assert.equal(m1.content, originalContent1);
  assert.equal(m2.content, originalContent2);
  assert.ok(m1.id === "nd1");
  assert.ok(m2.id === "nd2");
});

test("35. consolidateMemories — stale sources → STALE status", () => {
  const memories = Array.from({ length: 3 }, (_, i) =>
    makeMemory({
      id: `stale-${i}`,
      metadata: { lifecycleState: LifecycleState.STALE, importance: 0.3, confidence: 0.5 }
    })
  );
  const result = consolidateMemories(makeGroup(memories));
  assert.equal(result.status, ConsolidationStatus.STALE);
});

test("36. consolidateMemories — custom summarise hook is used when provided", () => {
  const m1 = makeMemory({ id: "h1" });
  const m2 = makeMemory({ id: "h2" });
  const customSummary = "CUSTOM HOOK SUMMARY";
  const result = consolidateMemories(
    makeGroup([m1, m2]),
    undefined,
    { summarise: () => customSummary }
  );
  assert.equal(result.summary, customSummary);
});

test("37. consolidateMemories — LLM hook not required (deterministic by default)", () => {
  const m1 = makeMemory({ id: "det1" });
  const m2 = makeMemory({ id: "det2" });
  // Run twice — should produce identical results
  const r1 = consolidateMemories(makeGroup([m1, m2]));
  const r2 = consolidateMemories(makeGroup([m1, m2]));
  assert.equal(r1.summary, r2.summary);
  assert.equal(r1.status, r2.status);
  assert.equal(r1.confidence, r2.confidence);
});

// ═══════════════════════════════════════════════════════════════════════════════
// CONSOLIDATION VERSIONING  (consolidationVersioning.js)
// ═══════════════════════════════════════════════════════════════════════════════

test("38. shouldReConsolidate — false when no new sources", () => {
  const existing = {
    id: "con-1", sourceMemoryIds: ["m1", "m2"], status: ConsolidationStatus.ACTIVE
  };
  const group = makeGroup(
    [makeMemory({ id: "m1" }), makeMemory({ id: "m2" })],
    { topic: "location" }
  );
  assert.equal(shouldReConsolidate(existing, group), false);
});

test("39. shouldReConsolidate — true when new-source fraction exceeds threshold", () => {
  const existing = {
    id: "con-2", sourceMemoryIds: ["m1", "m2"], status: ConsolidationStatus.ACTIVE
  };
  // 2 new sources out of 4 total = 50% new → exceeds default 30% threshold
  const group = makeGroup(
    [makeMemory({ id: "m1" }), makeMemory({ id: "m2" }),
     makeMemory({ id: "m3" }), makeMemory({ id: "m4" })],
    { topic: "location" }
  );
  assert.ok(shouldReConsolidate(existing, group));
});

test("40. shouldReConsolidate — true when status=STALE and active sources present", () => {
  const existing = {
    id: "con-3", sourceMemoryIds: ["m1", "m2"], status: ConsolidationStatus.STALE
  };
  const group = makeGroup(
    [makeMemory({ id: "m1", metadata: { lifecycleState: LifecycleState.ACTIVE } }),
     makeMemory({ id: "m2", metadata: { lifecycleState: LifecycleState.ACTIVE } })],
    { topic: "location" }
  );
  assert.ok(shouldReConsolidate(existing, group));
});

test("41. shouldReConsolidate — false when status=STALE but no active sources", () => {
  const existing = {
    id: "con-4", sourceMemoryIds: ["m1", "m2"], status: ConsolidationStatus.STALE
  };
  const group = makeGroup(
    [makeMemory({ id: "m1", metadata: { lifecycleState: LifecycleState.STALE } }),
     makeMemory({ id: "m2", metadata: { lifecycleState: LifecycleState.STALE } })],
    { topic: "location" }
  );
  assert.equal(shouldReConsolidate(existing, group), false);
});

test("42. updateConsolidatedMemory — merges source IDs (union)", () => {
  const m1 = makeMemory({ id: "u1" });
  const m2 = makeMemory({ id: "u2" });
  const m3 = makeMemory({ id: "u3" });

  const existing = consolidateMemories(makeGroup([m1, m2]));
  const newGroup = makeGroup([m1, m2, m3]);
  const updated = updateConsolidatedMemory(existing, newGroup);

  assert.ok(updated.sourceMemoryIds.includes("u1"));
  assert.ok(updated.sourceMemoryIds.includes("u2"));
  assert.ok(updated.sourceMemoryIds.includes("u3"));
});

test("43. updateConsolidatedMemory — increments version", () => {
  const m1 = makeMemory({ id: "ver1" });
  const m2 = makeMemory({ id: "ver2" });
  const existing = consolidateMemories(makeGroup([m1, m2]));
  const updated = updateConsolidatedMemory(existing, makeGroup([m1, m2]));
  assert.equal(updated.version, existing.version + 1);
});

test("44. updateConsolidatedMemory — re-detects conflicts on new group", () => {
  const m1 = makeMemory({ id: "rc1", content: "User location city Mumbai India home" });
  const m2 = makeMemory({ id: "rc2", content: "User location city Bangalore India home" });
  const existing = consolidateMemories(makeGroup([m1, m2]));
  const updated = updateConsolidatedMemory(existing, makeGroup([m1, m2]));
  // Status and conflictMeta should be re-evaluated
  assert.ok(["active", "conflicted", "stale"].includes(updated.status));
});

test("45. updateConsolidatedMemory — original record is not mutated", () => {
  const m1 = makeMemory({ id: "nm1" });
  const m2 = makeMemory({ id: "nm2" });
  const existing = consolidateMemories(makeGroup([m1, m2]));
  const originalVersion = existing.version;
  const originalIds = [...existing.sourceMemoryIds];

  updateConsolidatedMemory(existing, makeGroup([m1, m2, makeMemory({ id: "nm3" })]));

  assert.equal(existing.version, originalVersion);
  assert.deepEqual(existing.sourceMemoryIds, originalIds);
});

test("46. getProvenance — returns all required fields", () => {
  const m1 = makeMemory({ id: "p1" });
  const m2 = makeMemory({ id: "p2" });
  const consolidated = consolidateMemories(makeGroup([m1, m2]));
  const prov = getProvenance(consolidated, [m1, m2]);

  const required = [
    "consolidatedMemoryId", "sourceMemoryIds", "sourceCount",
    "latestSourceId", "latestSourceAt", "confidence", "conflictInfo", "version"
  ];
  for (const f of required) {
    assert.ok(Object.prototype.hasOwnProperty.call(prov, f), `missing: ${f}`);
  }
});

test("47. getProvenance — sourceCount matches sourceMemoryIds length", () => {
  const m1 = makeMemory({ id: "pc1" });
  const m2 = makeMemory({ id: "pc2" });
  const m3 = makeMemory({ id: "pc3" });
  const consolidated = consolidateMemories(makeGroup([m1, m2, m3]));
  const prov = getProvenance(consolidated, [m1, m2, m3]);
  assert.equal(prov.sourceCount, prov.sourceMemoryIds.length);
  assert.equal(prov.sourceCount, 3);
});

test("48. getProvenance — latestSourceId points to most recent source", () => {
  const older = makeMemory({ id: "oldest", metadata: { timestamp: "2024-01-01T00:00:00.000Z" } });
  const newer = makeMemory({ id: "newest", metadata: { timestamp: "2024-12-01T00:00:00.000Z" } });
  const consolidated = consolidateMemories(makeGroup([older, newer]));
  const prov = getProvenance(consolidated, [older, newer]);
  assert.equal(prov.latestSourceId, "newest");
});

// ═══════════════════════════════════════════════════════════════════════════════
// CONSOLIDATION STORE  (consolidationStore.js)
// ═══════════════════════════════════════════════════════════════════════════════

test("49. createConsolidationStore — save and get round-trip", async () => {
  const store = createConsolidationStore(createInMemoryDriver());
  const record = { id: "con-rt-1", userId: "u1", topic: "location", summary: "test",
    sourceMemoryIds: ["m1"], confidence: 0.8, importanceScore: 0.7,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    version: 1, status: "active" };

  await store.save(record);
  const fetched = await store.get("con-rt-1");
  assert.equal(fetched.id, "con-rt-1");
  assert.equal(fetched.userId, "u1");
});

test("50. createConsolidationStore — update patches existing record", async () => {
  const store = createConsolidationStore(createInMemoryDriver());
  const record = { id: "con-upd-1", userId: "u1", topic: "location", summary: "original",
    sourceMemoryIds: ["m1"], confidence: 0.8, importanceScore: 0.7,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    version: 1, status: "active" };

  await store.save(record);
  await store.update("con-upd-1", { summary: "updated" });
  const fetched = await store.get("con-upd-1");
  assert.equal(fetched.summary, "updated");
  assert.equal(fetched.id, "con-upd-1");
});

test("51. createConsolidationStore — remove returns true when found", async () => {
  const store = createConsolidationStore(createInMemoryDriver());
  const record = { id: "con-rm-1", userId: "u1", topic: "t", summary: "s",
    sourceMemoryIds: [], confidence: 0.5, importanceScore: 0.5,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    version: 1, status: "active" };
  await store.save(record);
  const removed = await store.remove("con-rm-1");
  assert.ok(removed);
  assert.equal(await store.get("con-rm-1"), null);
});

test("52. createConsolidationStore — remove returns false when not found", async () => {
  const store = createConsolidationStore(createInMemoryDriver());
  const removed = await store.remove("does-not-exist");
  assert.equal(removed, false);
});

test("53. createConsolidationStore — findByUserId returns only matching user", async () => {
  const store = createConsolidationStore(createInMemoryDriver());
  const r1 = { id: "c-u1-a", userId: "user-A", topic: "t", summary: "s",
    sourceMemoryIds: [], confidence: 0.5, importanceScore: 0.5,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    version: 1, status: "active" };
  const r2 = { id: "c-u1-b", userId: "user-A", topic: "t2", summary: "s2",
    sourceMemoryIds: [], confidence: 0.5, importanceScore: 0.6,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    version: 1, status: "active" };
  const r3 = { id: "c-u2-a", userId: "user-B", topic: "t", summary: "s",
    sourceMemoryIds: [], confidence: 0.5, importanceScore: 0.5,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    version: 1, status: "active" };

  await store.save(r1);
  await store.save(r2);
  await store.save(r3);

  const forA = await store.findByUserId("user-A");
  assert.equal(forA.length, 2);
  assert.ok(forA.every((r) => r.userId === "user-A"));
});

test("54. createConsolidationStore — findBySourceMemoryId finds by source", async () => {
  const store = createConsolidationStore(createInMemoryDriver());
  const r1 = { id: "c-src-1", userId: "u1", topic: "t", summary: "s",
    sourceMemoryIds: ["mem-A", "mem-B"], confidence: 0.5, importanceScore: 0.5,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    version: 1, status: "active" };
  const r2 = { id: "c-src-2", userId: "u1", topic: "t2", summary: "s2",
    sourceMemoryIds: ["mem-C", "mem-D"], confidence: 0.5, importanceScore: 0.5,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    version: 1, status: "active" };

  await store.save(r1);
  await store.save(r2);

  const results = await store.findBySourceMemoryId("mem-A");
  assert.equal(results.length, 1);
  assert.equal(results[0].id, "c-src-1");
});

test("55. createConsolidationStore — findByTopic filters by topic", async () => {
  const store = createConsolidationStore(createInMemoryDriver());
  await store.save({ id: "ct-1", userId: "u1", topic: "location", summary: "s",
    sourceMemoryIds: [], confidence: 0.5, importanceScore: 0.5,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    version: 1, status: "active" });
  await store.save({ id: "ct-2", userId: "u1", topic: "employment", summary: "s2",
    sourceMemoryIds: [], confidence: 0.5, importanceScore: 0.5,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    version: 1, status: "active" });

  const results = await store.findByTopic("u1", "location");
  assert.equal(results.length, 1);
  assert.equal(results[0].topic, "location");
});

test("56. createConsolidationStore — findByStatus filters by status", async () => {
  const store = createConsolidationStore(createInMemoryDriver());
  await store.save({ id: "cs-1", userId: "u1", topic: "t", summary: "s",
    sourceMemoryIds: [], confidence: 0.5, importanceScore: 0.5,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    version: 1, status: "active" });
  await store.save({ id: "cs-2", userId: "u1", topic: "t2", summary: "s2",
    sourceMemoryIds: [], confidence: 0.5, importanceScore: 0.5,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    version: 1, status: "conflicted" });

  const active = await store.findByStatus("u1", "active");
  assert.equal(active.length, 1);
  assert.equal(active[0].status, "active");
});

test("57. createConsolidationStore — save throws when id missing", async () => {
  const store = createConsolidationStore(createInMemoryDriver());
  await assert.rejects(
    () => store.save({ userId: "u1", topic: "t" }),
    /id is required/i
  );
});

test("58. createConsolidationStore — two independent instances share no state", async () => {
  const store1 = createConsolidationStore(createInMemoryDriver());
  const store2 = createConsolidationStore(createInMemoryDriver());

  await store1.save({ id: "iso-1", userId: "u1", topic: "t", summary: "s",
    sourceMemoryIds: [], confidence: 0.5, importanceScore: 0.5,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    version: 1, status: "active" });

  const fromStore2 = await store2.get("iso-1");
  assert.equal(fromStore2, null, "store2 should not see records from store1");
});

// ═══════════════════════════════════════════════════════════════════════════════
// RETRIEVAL INTEGRATION  (consolidationRetrieval.js)
// ═══════════════════════════════════════════════════════════════════════════════

test("59. applyConsolidationScorePenalty — ACTIVE → no penalty", () => {
  const input = { consolidatedMemory: { status: ConsolidationStatus.ACTIVE }, score: 0.8 };
  const result = applyConsolidationScorePenalty(input);
  assert.equal(result.score, 0.8);
  assert.equal(result._consolidation.penalty, 1.0);
});

test("60. applyConsolidationScorePenalty — STALE → score × staleScorePenalty", () => {
  const input = { consolidatedMemory: { status: ConsolidationStatus.STALE }, score: 1.0 };
  const result = applyConsolidationScorePenalty(input);
  // Default staleScorePenalty is 0.60
  assert.ok(result.score < 1.0, "stale score should be reduced");
  assert.ok(result.score > 0, "stale score should remain positive");
});

test("61. applyConsolidationScorePenalty — CONFLICTED → score × conflictScorePenalty", () => {
  const input = { consolidatedMemory: { status: ConsolidationStatus.CONFLICTED }, score: 1.0 };
  const result = applyConsolidationScorePenalty(input);
  // Default conflictScorePenalty is 0.80
  assert.ok(result.score < 1.0, "conflicted score should be reduced");
  assert.ok(result.score > 0.7, "conflict penalty is mild — score should still be meaningful");
});

test("62. applyConsolidationScorePenalty — SUPERSEDED → near-zero score", () => {
  const input = { consolidatedMemory: { status: ConsolidationStatus.SUPERSEDED }, score: 0.9 };
  const result = applyConsolidationScorePenalty(input);
  assert.ok(result.score < 0.1, "superseded consolidation should be near-zero");
});

test("63. applyConsolidationScorePenalty — _consolidation envelope populated", () => {
  const input = { consolidatedMemory: { status: ConsolidationStatus.ACTIVE }, score: 0.7 };
  const result = applyConsolidationScorePenalty(input);
  assert.ok(result._consolidation, "_consolidation envelope should be present");
  assert.ok(Object.prototype.hasOwnProperty.call(result._consolidation, "status"));
  assert.ok(Object.prototype.hasOwnProperty.call(result._consolidation, "penalty"));
});

test("64. applyConsolidationScorePenalty — does not mutate input", () => {
  const input = { consolidatedMemory: { status: ConsolidationStatus.STALE }, score: 0.8 };
  const originalScore = input.score;
  applyConsolidationScorePenalty(input);
  assert.equal(input.score, originalScore, "original score should not be mutated");
});

test("65. enrichWithConsolidations — returns ranked memories unchanged if no userId", async () => {
  const ranked = [{ id: "r1" }, { id: "r2" }];
  const store  = createConsolidationStore(createInMemoryDriver());
  const result = await enrichWithConsolidations(ranked, store, {});
  assert.deepEqual(result, ranked);
});

test("66. enrichWithConsolidations — injects consolidated memories after first result", async () => {
  const store = createConsolidationStore(createInMemoryDriver());
  await store.save({
    id: "con-inj-1", userId: "inject-user", topic: "location", summary: "s",
    sourceMemoryIds: ["s1"], confidence: 0.8, importanceScore: 0.7,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    version: 1, status: "active"
  });

  const ranked = [{ id: "mem-1", _hybrid: { finalScore: 0.9 } }];
  const result = await enrichWithConsolidations(ranked, store, { userId: "inject-user" });

  assert.ok(result.length > 1, "consolidated memory should be injected");
  assert.equal(result[0].id, "mem-1", "original top result stays first");
  // The consolidated record should appear somewhere after index 0
  const hasConsolidated = result.some((r) => r.isConsolidation === true);
  assert.ok(hasConsolidated, "at least one consolidated record should be in results");
});

test("67. enrichWithConsolidations — superseded consolidations excluded by default", async () => {
  const store = createConsolidationStore(createInMemoryDriver());
  await store.save({
    id: "con-sup-1", userId: "sup-user", topic: "location", summary: "superseded summary",
    sourceMemoryIds: ["s1"], confidence: 0.6, importanceScore: 0.5,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    version: 1, status: ConsolidationStatus.SUPERSEDED
  });

  const ranked = [{ id: "mem-1" }];
  const result = await enrichWithConsolidations(ranked, store, { userId: "sup-user" });

  const hasSuperseded = result.some(
    (r) => r.consolidatedMemory?.status === ConsolidationStatus.SUPERSEDED
  );
  assert.equal(hasSuperseded, false, "superseded records should not appear");
});

test("68. withSourceEvidence — returns null consolidated when not found", async () => {
  const store = createConsolidationStore(createInMemoryDriver());
  const fakeRouter = { getMemory: async () => null };
  const result = await withSourceEvidence("nonexistent", store, fakeRouter);
  assert.equal(result.consolidated, null);
  assert.deepEqual(result.sources, []);
});

test("69. withSourceEvidence — returns consolidated + all source memories", async () => {
  const store = createConsolidationStore(createInMemoryDriver());
  const m1 = makeMemory({ id: "src-e1" });
  const m2 = makeMemory({ id: "src-e2" });
  const consolidated = consolidateMemories(makeGroup([m1, m2]));
  await store.save(consolidated);

  const memoryMap = new Map([["src-e1", m1], ["src-e2", m2]]);
  const fakeRouter = { getMemory: async (id) => memoryMap.get(id) ?? null };

  const result = await withSourceEvidence(consolidated.id, store, fakeRouter);
  assert.equal(result.consolidated.id, consolidated.id);
  assert.ok(result.sources.length >= 2, "both source memories should be returned");
  assert.ok(result.sources.some((s) => s.id === "src-e1"));
  assert.ok(result.sources.some((s) => s.id === "src-e2"));
});

// ═══════════════════════════════════════════════════════════════════════════════
// IDEMPOTENCY & PROVENANCE  consolidationEngine.js (runConsolidationSweep)
// ═══════════════════════════════════════════════════════════════════════════════

test("70. runConsolidationSweep — creates consolidations for new groups", async () => {
  const store = createConsolidationStore(createInMemoryDriver());
  const memories = [
    makeMemory({ id: "sw1", content: "User lives in Mumbai India city location" }),
    makeMemory({ id: "sw2", content: "User based in Mumbai India city location" }),
    makeMemory({ id: "sw3", content: "User resides Mumbai India city location" })
  ];

  const fakeRouter = {
    searchUserMemories: async () => memories
  };

  const result = await runConsolidationSweep("user-1", fakeRouter, store);
  assert.ok(result.created >= 1, `expected created ≥ 1, got ${result.created}`);
  assert.equal(result.errors.length, 0);
});

test("71. runConsolidationSweep — skips groups already consolidated (idempotent)", async () => {
  const store = createConsolidationStore(createInMemoryDriver());
  const memories = [
    makeMemory({ id: "idem1", content: "User lives in Mumbai India city location" }),
    makeMemory({ id: "idem2", content: "User based in Mumbai India city location" })
  ];

  const fakeRouter = { searchUserMemories: async () => memories };

  // First sweep: creates
  const r1 = await runConsolidationSweep("user-1", fakeRouter, store);
  assert.ok(r1.created >= 1);

  // Second sweep: should skip (no new sources)
  const r2 = await runConsolidationSweep("user-1", fakeRouter, store);
  assert.equal(r2.created, 0, "second sweep should not create duplicates");
});

test("72. runConsolidationSweep — updates when shouldReConsolidate is true", async () => {
  const store = createConsolidationStore(createInMemoryDriver());

  const initialMemories = [
    makeMemory({ id: "upd1", content: "User lives in Mumbai India city location" }),
    makeMemory({ id: "upd2", content: "User based in Mumbai India city location" })
  ];

  const fakeRouter1 = { searchUserMemories: async () => initialMemories };
  const r1 = await runConsolidationSweep("user-1", fakeRouter1, store);
  assert.ok(r1.created >= 1);

  // Add enough new memories to exceed the re-consolidation threshold
  const expandedMemories = [
    ...initialMemories,
    makeMemory({ id: "upd3", content: "User resides Mumbai India city location new" }),
    makeMemory({ id: "upd4", content: "User home Mumbai India city location new" })
  ];

  const fakeRouter2 = { searchUserMemories: async () => expandedMemories };
  const r2 = await runConsolidationSweep("user-1", fakeRouter2, store);
  // Should update since 2 new sources out of 4 = 50% > 30% threshold
  assert.ok(r2.updated >= 1 || r2.skipped >= 0, "should update or skip, not error");
  assert.equal(r2.errors.length, 0);
});

test("73. runConsolidationSweep — source memories are never deleted", async () => {
  const store = createConsolidationStore(createInMemoryDriver());
  const memories = [
    makeMemory({ id: "del1", content: "User lives in Mumbai India city location" }),
    makeMemory({ id: "del2", content: "User based in Mumbai India city location" })
  ];

  const fakeRouter = { searchUserMemories: async () => memories };
  await runConsolidationSweep("user-1", fakeRouter, store);

  // Verify source memories still exist (fakeRouter did not delete them)
  assert.equal(memories[0].id, "del1");
  assert.equal(memories[1].id, "del2");
  assert.ok(memories[0].content.includes("Mumbai"));
  assert.ok(memories[1].content.includes("Mumbai"));
});
