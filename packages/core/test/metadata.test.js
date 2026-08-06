import assert from "node:assert/strict";
import test from "node:test";

import {
  extractMemoryCandidates,
  inferMemoryDomain,
  scoreMemoryConfidence,
  scoreMemoryImportance,
  classifyMemoryType,
  classifyMemoryTypeWithConfidence
} from "../src/index.js";

const baseEvent = {
  id: "event-1",
  sessionId: "session-1",
  role: "user",
  createdAt: "2026-04-21T10:00:00.000Z"
};

test("generates rich metadata for memory candidates", () => {
  const [candidate] = extractMemoryCandidates({
    ...baseEvent,
    content: "My name is Vinod and I prefer precise metadata for the AiNeura memory system."
  });

  assert.equal(candidate.memoryType, "factual");
  assert.equal(candidate.metadata.schemaVersion, 3);
  assert.equal(candidate.metadata.domain, "identity");
  assert.equal(candidate.metadata.role, "user");
  assert.equal(candidate.metadata.source.eventId, "event-1");
  assert.ok(candidate.metadata.confidence > 0.7);
  assert.ok(candidate.metadata.importance > 0.7);
  assert.ok(candidate.metadata.keywords.includes("vinod"));
  assert.ok(candidate.metadata.tags.includes("identity"));
});

test("confidence is dynamic instead of role-static", () => {
  const strongConfidence = scoreMemoryConfidence({
    content: "My name is Vinod and our project is AiNeura.",
    role: "user",
    memoryType: "factual",
    tags: ["identity", "project"],
    domainConfidence: 0.95
  });
  const weakConfidence = scoreMemoryConfidence({
    content: "I think maybe this could be useful?",
    role: "user",
    memoryType: "semantic",
    tags: [],
    domainConfidence: 0.35
  });

  assert.ok(strongConfidence > weakConfidence);
});

test("domain and importance respond to content signal", () => {
  const memoryDomain = inferMemoryDomain(
    "Improve metadata, embeddings, and retrieval for the memory pipeline."
  );
  const weakImportance = scoreMemoryImportance("Maybe ok?", "user", "semantic");
  const strongImportance = scoreMemoryImportance(
    "We must improve metadata importance scoring for the AiNeura memory architecture.",
    "user",
    "semantic"
  );

  assert.equal(memoryDomain.domain, "memory_system");
  assert.ok(strongImportance > weakImportance);
});

// NEW TESTS FOR ENHANCED CLASSIFICATION
test("improved classification: strong factual detection", () => {
  const result = classifyMemoryTypeWithConfidence("My name is Alice and I prefer TypeScript");
  assert.equal(result.memoryType, "factual");
  assert.ok(result.confidence > 0.5);
});

test("improved classification: episodic detection with confidence", () => {
  const result = classifyMemoryTypeWithConfidence("Yesterday we discussed the architecture and I fixed the bug");
  assert.equal(result.memoryType, "episodic");
  assert.ok(result.confidence > 0.4);
});

test("improved classification: detects multiple pattern matches", () => {
  const result = classifyMemoryTypeWithConfidence(
    "I'm Vinod and I prefer Node.js. I decided to use it last week."
  );
  assert.equal(result.memoryType, "factual");
  assert.ok(result.confidence > 0.6);
  // Should have episodic as alternative due to "last week"
  assert.ok(result.alternatives.some(alt => alt.type === "episodic"));
});

test("improved classification: semantic as fallback", () => {
  const result = classifyMemoryTypeWithConfidence(
    "React is a JavaScript library for building user interfaces"
  );
  assert.equal(result.memoryType, "semantic");
  assert.ok(result.confidence > 0.2);
});

test("improved classification: alternatives ranked correctly", () => {
  const result = classifyMemoryTypeWithConfidence(
    "I built the API yesterday and I prefer this architecture"
  );
  assert.ok(result.alternatives.length > 0);
  // Check alternatives are sorted by confidence
  for (let i = 0; i < result.alternatives.length - 1; i++) {
    assert.ok(
      result.alternatives[i].confidence >= result.alternatives[i + 1].confidence,
      "Alternatives not sorted by confidence"
    );
  }
});

test("improved classification debug data tracks pattern matches", () => {
  const result = classifyMemoryTypeWithConfidence("My name is Bob and I want to use this today");
  assert.ok(typeof result.debug.factualScore === "number");
  assert.ok(typeof result.debug.episodicScore === "number");
  assert.ok(typeof result.debug.semanticScore === "number");
  assert.ok(result.debug.factualScore > 0);
});

test("extractMemoryCandidates includes classification metadata", () => {
  const [candidate] = extractMemoryCandidates({
    ...baseEvent,
    content: "Yesterday I completed the Redis integration for the memory system"
  });

  assert.equal(candidate.metadata.schemaVersion, 3);
  assert.ok(typeof candidate.metadata.classificationConfidence === "number");
  assert.ok(Array.isArray(candidate.metadata.alternativeClassifications));
});

test("backward compatibility: classifyMemoryType still works", () => {
  const type1 = classifyMemoryType("My name is Alice");
  assert.equal(type1, "factual");

  const type2 = classifyMemoryType("Today we worked on the project");
  assert.equal(type2, "episodic");

  const type3 = classifyMemoryType("React is cool");
  assert.equal(type3, "semantic");
});
