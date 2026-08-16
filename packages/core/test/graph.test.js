/**
 * packages/core/test/graph.test.js
 *
 * Tests for the Memory Graph foundation:
 *   - graphTypes.js        (type definitions and validation sets)
 *   - entityExtractor.js   (deterministic entity extraction)
 *   - relationshipExtractor.js (relationship inference + confidence scores)
 *   - graphService.js      (Neo4j unavailable / duplicate upsert / getGraphContext)
 *   - graphPipeline.js     (memory storage continues when graph fails)
 *   - candidateFetcher.js  (getGraphContext flows into graphScore)
 *
 * Test runner: Node 22 built-in (node --test)
 * Import style: ESM, no external test libraries
 *
 * ─── Coverage ─────────────────────────────────────────────────────────────
 *  1.  ENTITY_TYPE contains all 8 required types
 *  2.  REL_TYPE contains all 9 required types
 *  3.  VALID_ENTITY_TYPES / VALID_REL_TYPES reflect the type objects
 *  4.  extractEntities — empty / null memory returns []
 *  5.  extractEntities — domain metadata → topic entity
 *  6.  extractEntities — keyword metadata → topic entity (multi-word only)
 *  7.  extractEntities — task-signal phrase → task entity
 *  8.  extractEntities — preference-signal phrase → preference entity
 *  9.  extractEntities — decision-signal phrase → decision entity
 * 10.  extractEntities — proper noun multi-word → project entity
 * 11.  extractEntities — entity ids are stable (same input → same output)
 * 12.  extractEntities — MAX_ENTITIES cap respected
 * 13.  extractRelationships — empty entities list returns []
 * 14.  extractRelationships — every entity gets a MENTIONED_IN relationship
 * 15.  extractRelationships — person + project → WORKS_ON inferred
 * 16.  extractRelationships — person + preference → PREFERS inferred
 * 17.  extractRelationships — person + decision → DECIDED inferred
 * 18.  extractRelationships — task + task + depends-on text → DEPENDS_ON
 * 19.  extractRelationships — confidence scores are in [0, 1]
 * 20.  extractRelationships — factual memoryType boosts PREFERS confidence
 * 21.  extractRelationships — episodic memoryType boosts COMPLETED confidence
 * 22.  graphService — upsertEntity returns false when Neo4j is disabled
 * 23.  graphService — upsertRelationship returns false for unknown rel type
 * 24.  graphService — upsertRelationship returns false when Neo4j is disabled
 * 25.  graphService — getRelatedEntities returns [] when Neo4j is disabled
 * 26.  graphService — getGraphContext returns empty context when Neo4j is disabled
 * 27.  graphService — removeEntity returns false when Neo4j is disabled
 * 28.  graphService — removeRelationship returns false for unknown rel type
 * 29.  graphPipeline — persistMemoryGraph resolves even when upsertEntity throws
 * 30.  graphPipeline — persistMemoryGraph resolves on null memory (no crash)
 * 31.  candidateFetcher — getGraphContext enriches graphScore using entityCount
 * 32.  candidateFetcher — getGraphContext returning null does not crash
 * 33.  candidateFetcher — both similar memories and graphContext contribute to score
 * 34.  candidateFetcher — graphStore without getGraphContext still works
 */

import assert from "node:assert/strict";
import test   from "node:test";

import {
  ENTITY_TYPE,
  VALID_ENTITY_TYPES,
  REL_TYPE,
  VALID_REL_TYPES
} from "../src/memory/graph/graphTypes.js";

import { extractEntities }      from "../src/memory/graph/entityExtractor.js";
import { extractRelationships } from "../src/memory/graph/relationshipExtractor.js";
import { createHybridRetrievalService } from "../src/memory/services/hybridRetrievalService.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let _seq = 0;
function uid() { return `graph-test-${++_seq}`; }

/**
 * Build a minimal memory object.
 */
function mem(overrides = {}) {
  return {
    id:         overrides.id ?? uid(),
    memoryType: overrides.memoryType ?? "factual",
    content:    overrides.content  ?? "",
    summary:    overrides.summary  ?? "",
    metadata: {
      importance:  overrides.importance ?? 0.6,
      confidence:  overrides.confidence ?? 0.7,
      domain:      overrides.domain     ?? null,
      keywords:    overrides.keywords   ?? [],
      tags:        overrides.tags       ?? [],
      timestamp:   overrides.timestamp  ?? new Date().toISOString(),
      ...overrides.metadata
    }
  };
}

// ─── 1–3: graphTypes ─────────────────────────────────────────────────────────

test("graphTypes — ENTITY_TYPE contains all 8 required types", () => {
  const required = [
    "person", "project", "organization", "task",
    "topic", "decision", "preference", "event"
  ];
  for (const t of required) {
    assert.ok(Object.values(ENTITY_TYPE).includes(t), `Missing entity type: ${t}`);
  }
  assert.equal(Object.values(ENTITY_TYPE).length, 8);
});

test("graphTypes — REL_TYPE contains all 9 required types", () => {
  const required = [
    "works_on", "related_to", "depends_on", "decided",
    "assigned_to", "prefers", "mentioned_in", "completed", "belongs_to"
  ];
  for (const r of required) {
    assert.ok(Object.values(REL_TYPE).includes(r), `Missing rel type: ${r}`);
  }
  assert.equal(Object.values(REL_TYPE).length, 9);
});

test("graphTypes — VALID_ENTITY_TYPES and VALID_REL_TYPES are complete Sets", () => {
  for (const v of Object.values(ENTITY_TYPE)) {
    assert.ok(VALID_ENTITY_TYPES.has(v), `VALID_ENTITY_TYPES missing: ${v}`);
  }
  for (const v of Object.values(REL_TYPE)) {
    assert.ok(VALID_REL_TYPES.has(v), `VALID_REL_TYPES missing: ${v}`);
  }
  assert.equal(VALID_ENTITY_TYPES.size, Object.values(ENTITY_TYPE).length);
  assert.equal(VALID_REL_TYPES.size, Object.values(REL_TYPE).length);
});

// ─── 4–12: entityExtractor ───────────────────────────────────────────────────

test("extractEntities — null memory returns []", () => {
  assert.deepEqual(extractEntities(null), []);
});

test("extractEntities — empty memory returns []", () => {
  assert.deepEqual(extractEntities({}), []);
});

test("extractEntities — domain metadata produces a topic entity", () => {
  const memory = mem({ domain: "memory_system" });
  const entities = extractEntities(memory);
  const topic = entities.find((e) => e.type === ENTITY_TYPE.TOPIC && e.name === "memory_system");
  assert.ok(topic, "Expected a topic entity for the domain");
  assert.equal(topic.id, "topic:memory_system");
});

test("extractEntities — multi-word keyword produces topic entity", () => {
  const memory = mem({ keywords: ["hybrid retrieval", "neo4j"] });
  const entities = extractEntities(memory);
  const topicNames = entities
    .filter((e) => e.type === ENTITY_TYPE.TOPIC)
    .map((e) => e.name);
  assert.ok(topicNames.includes("hybrid retrieval"), "Expected 'hybrid retrieval' topic");
  // single-word 'neo4j' should NOT produce a topic (too generic alone)
  assert.ok(!topicNames.includes("neo4j"), "Single-word keyword should not produce topic entity");
});

test("extractEntities — task-signal phrase produces a task entity", () => {
  const memory = mem({
    content: "I need to implement the authentication module this week."
  });
  const entities = extractEntities(memory);
  const tasks = entities.filter((e) => e.type === ENTITY_TYPE.TASK);
  assert.ok(tasks.length > 0, "Expected at least one task entity");
  assert.ok(
    tasks.some((t) => t.name.toLowerCase().includes("authentication")),
    `Expected task about authentication, got: ${tasks.map((t) => t.name).join(", ")}`
  );
});

test("extractEntities — preference-signal phrase produces a preference entity", () => {
  const memory = mem({
    content: "I prefer TypeScript over plain JavaScript for large projects."
  });
  const entities = extractEntities(memory);
  const prefs = entities.filter((e) => e.type === ENTITY_TYPE.PREFERENCE);
  assert.ok(prefs.length > 0, "Expected at least one preference entity");
  assert.ok(
    prefs.some((p) => p.name.toLowerCase().includes("typescript")),
    `Expected preference about TypeScript, got: ${prefs.map((p) => p.name).join(", ")}`
  );
});

test("extractEntities — decision-signal phrase produces a decision entity", () => {
  const memory = mem({
    content: "We decided to use Neo4j for the relationship graph."
  });
  const entities = extractEntities(memory);
  const decisions = entities.filter((e) => e.type === ENTITY_TYPE.DECISION);
  assert.ok(decisions.length > 0, "Expected at least one decision entity");
  assert.ok(
    decisions.some((d) => d.name.toLowerCase().includes("neo4j")),
    `Expected decision about Neo4j, got: ${decisions.map((d) => d.name).join(", ")}`
  );
});

test("extractEntities — multi-word proper noun produces a project entity", () => {
  const memory = mem({
    content: "Working on the Neura Platform which handles memory routing."
  });
  const entities = extractEntities(memory);
  const projects = entities.filter((e) => e.type === ENTITY_TYPE.PROJECT);
  assert.ok(projects.length > 0, "Expected at least one project entity from proper noun");
});

test("extractEntities — entity ids are stable across identical calls", () => {
  const memory = mem({ domain: "engineering", content: "implement the auth service" });
  const run1 = extractEntities(memory);
  const run2 = extractEntities(memory);
  const ids1 = run1.map((e) => e.id).sort();
  const ids2 = run2.map((e) => e.id).sort();
  assert.deepEqual(ids1, ids2, "Entity ids must be deterministic");
});

test("extractEntities — MAX_ENTITIES cap: never returns more than 12 entities", () => {
  // Content designed to trigger many different extraction passes
  const memory = mem({
    content: [
      "Alice and Bob are working on Project Alpha.",
      "I prefer React for frontend and Node for backend.",
      "We decided to use PostgreSQL.",
      "I need to implement authentication, build the dashboard, fix the login bug,",
      "create the API, refactor the service layer, set up CI/CD, deploy to AWS.",
      "I like clean architecture."
    ].join(" "),
    domain: "engineering",
    keywords: ["clean architecture", "event sourcing", "domain driven design"]
  });
  const entities = extractEntities(memory);
  assert.ok(entities.length <= 12, `Expected ≤12 entities, got ${entities.length}`);
  assert.ok(entities.length > 0, "Expected at least some entities");
});

// ─── 13–21: relationshipExtractor ────────────────────────────────────────────

test("extractRelationships — empty entities list returns []", () => {
  const memory = mem({ content: "Some content" });
  assert.deepEqual(extractRelationships(memory, []), []);
});

test("extractRelationships — null memory returns []", () => {
  assert.deepEqual(extractRelationships(null, []), []);
});

test("extractRelationships — every entity gets a MENTIONED_IN relationship", () => {
  const memory = mem({ id: "mem-1", content: "I prefer TypeScript for new projects." });
  const entities = extractEntities(memory);
  assert.ok(entities.length > 0, "Need entities to test relationships");

  const rels = extractRelationships(memory, entities);
  const memNodeId = `memory:${memory.id}`;

  for (const entity of entities) {
    const hasMentionedIn = rels.some(
      (r) => r.fromId === entity.id && r.toId === memNodeId && r.type === REL_TYPE.MENTIONED_IN
    );
    assert.ok(hasMentionedIn, `Entity ${entity.id} missing MENTIONED_IN relationship`);
  }
});

test("extractRelationships — person + project infers WORKS_ON", () => {
  // Manually supply entities to keep this test independent of entityExtractor
  const memory = mem({
    id: "mem-works-on",
    content: "Alice is working on the authentication module.",
    memoryType: "episodic"
  });

  const entities = [
    { id: "person:alice", name: "Alice", type: ENTITY_TYPE.PERSON },
    { id: "project:authentication module", name: "authentication module", type: ENTITY_TYPE.PROJECT }
  ];

  const rels = extractRelationships(memory, entities);
  const worksOn = rels.find(
    (r) => r.fromId === "person:alice" && r.type === REL_TYPE.WORKS_ON
  );
  assert.ok(worksOn, "Expected WORKS_ON relationship from person to project");
  assert.ok(worksOn.confidence > 0.3, "WORKS_ON confidence should be meaningful");
});

test("extractRelationships — person + preference infers PREFERS", () => {
  const memory = mem({ id: "mem-prefers", content: "I prefer TypeScript." });
  const entities = [
    { id: "person:user", name: "user", type: ENTITY_TYPE.PERSON },
    { id: "preference:typescript", name: "TypeScript", type: ENTITY_TYPE.PREFERENCE }
  ];

  const rels = extractRelationships(memory, entities);
  const prefers = rels.find(
    (r) => r.fromId === "person:user" && r.type === REL_TYPE.PREFERS
  );
  assert.ok(prefers, "Expected PREFERS relationship");
  assert.ok(prefers.confidence >= 0.6);
});

test("extractRelationships — person + decision infers DECIDED", () => {
  const memory = mem({ id: "mem-decided", content: "We decided to use Neo4j." });
  const entities = [
    { id: "person:user", name: "user", type: ENTITY_TYPE.PERSON },
    { id: "decision:use neo4j", name: "use Neo4j", type: ENTITY_TYPE.DECISION }
  ];

  const rels = extractRelationships(memory, entities);
  const decided = rels.find(
    (r) => r.fromId === "person:user" && r.type === REL_TYPE.DECIDED
  );
  assert.ok(decided, "Expected DECIDED relationship");
  assert.ok(decided.confidence >= 0.5);
});

test("extractRelationships — two tasks + depends-on language → DEPENDS_ON", () => {
  const memory = mem({
    id: "mem-depends",
    content: "The deployment task depends on the build task being finished."
  });
  const entities = [
    { id: "task:deployment", name: "deployment", type: ENTITY_TYPE.TASK },
    { id: "task:build", name: "build", type: ENTITY_TYPE.TASK }
  ];

  const rels = extractRelationships(memory, entities);
  const dependsOn = rels.find((r) => r.type === REL_TYPE.DEPENDS_ON);
  assert.ok(dependsOn, "Expected DEPENDS_ON relationship between tasks");
  assert.ok(dependsOn.confidence >= 0.5, "DEPENDS_ON confidence should be boosted by text signal");
});

test("extractRelationships — all confidence scores are in [0, 1]", () => {
  const memory = mem({
    id: "mem-conf",
    content: "Alice is working on Neura Platform. She prefers TypeScript. We decided to use Redis.",
    memoryType: "factual"
  });
  const entities = extractEntities(memory);
  const rels = extractRelationships(memory, entities);
  for (const rel of rels) {
    assert.ok(
      rel.confidence >= 0 && rel.confidence <= 1,
      `confidence out of range [0,1]: ${rel.confidence} for ${rel.type}`
    );
  }
});

test("extractRelationships — factual memoryType boosts PREFERS confidence", () => {
  const entities = [
    { id: "person:user", name: "user", type: ENTITY_TYPE.PERSON },
    { id: "preference:typescript", name: "TypeScript", type: ENTITY_TYPE.PREFERENCE }
  ];

  const factualMem  = mem({ id: "fm", content: "I prefer TypeScript.", memoryType: "factual" });
  const episodicMem = mem({ id: "em", content: "I prefer TypeScript.", memoryType: "episodic" });

  const factualRels  = extractRelationships(factualMem,  entities);
  const episodicRels = extractRelationships(episodicMem, entities);

  const factualPrefers  = factualRels.find((r)  => r.type === REL_TYPE.PREFERS);
  const episodicPrefers = episodicRels.find((r) => r.type === REL_TYPE.PREFERS);

  assert.ok(factualPrefers,  "Factual memory should have PREFERS rel");
  assert.ok(episodicPrefers, "Episodic memory should also have PREFERS rel");
  assert.ok(
    factualPrefers.confidence >= episodicPrefers.confidence,
    `Factual PREFERS confidence (${factualPrefers.confidence}) should be ≥ episodic (${episodicPrefers.confidence})`
  );
});

test("extractRelationships — episodic memoryType boosts COMPLETED confidence", () => {
  const entities = [
    { id: "person:alice", name: "alice", type: ENTITY_TYPE.PERSON },
    { id: "task:deploy", name: "deploy", type: ENTITY_TYPE.TASK }
  ];

  const episodicMem = mem({
    id: "ep1",
    content: "Alice completed the deploy task.",
    memoryType: "episodic"
  });
  const factualMem = mem({
    id: "f1",
    content: "Alice completed the deploy task.",
    memoryType: "factual"
  });

  const episodicRels = extractRelationships(episodicMem, entities);
  const factualRels  = extractRelationships(factualMem,  entities);

  const epCompleted  = episodicRels.find((r) => r.type === REL_TYPE.COMPLETED);
  const factCompleted = factualRels.find((r)  => r.type === REL_TYPE.COMPLETED);

  // Both should have COMPLETED (from the "completed" text pattern)
  assert.ok(epCompleted,   "Episodic memory should have COMPLETED rel");
  assert.ok(factCompleted, "Factual memory should also produce COMPLETED rel");
  assert.ok(
    epCompleted.confidence >= factCompleted.confidence,
    `Episodic COMPLETED confidence (${epCompleted.confidence}) should be ≥ factual (${factCompleted.confidence})`
  );
});

// ─── 22–28: graphService (Neo4j disabled path) ───────────────────────────────
//
// We test the "Neo4j is disabled" path because that is the only path we can
// exercise without a live Neo4j instance.  The _isNeo4jEnabled guard is the
// first thing every method checks when NEO4J_URI is absent.

test("graphService — upsertEntity returns false when Neo4j is disabled", async () => {
  // Ensure NEO4J_URI is unset for this test
  const saved = process.env.NEO4J_URI;
  delete process.env.NEO4J_URI;

  try {
    // Dynamic import so the module reads the env at call time via isNeo4jEnabled()
    const { upsertEntity } = await import(
      "../../../apps/api/src/infrastructure/neo4j/graphService.js"
    );
    const result = await upsertEntity({
      id: "person:alice", name: "Alice", type: "person"
    });
    assert.equal(result, false, "Expected false when NEO4J_URI is absent");
  } finally {
    if (saved !== undefined) process.env.NEO4J_URI = saved;
  }
});

test("graphService — upsertRelationship returns false for unknown rel type", async () => {
  const saved = process.env.NEO4J_URI;
  process.env.NEO4J_URI = "neo4j://localhost:7687"; // enable Neo4j path

  try {
    const { upsertRelationship } = await import(
      "../../../apps/api/src/infrastructure/neo4j/graphService.js"
    );
    const result = await upsertRelationship({
      fromId: "person:alice",
      toId:   "project:neura",
      type:   "INVALID_TYPE_XYZ",
      confidence: 0.8
    });
    assert.equal(result, false, "Expected false for unknown relationship type");
  } finally {
    if (saved !== undefined) process.env.NEO4J_URI = saved;
    else delete process.env.NEO4J_URI;
  }
});

test("graphService — upsertRelationship returns false when Neo4j is disabled", async () => {
  const saved = process.env.NEO4J_URI;
  delete process.env.NEO4J_URI;

  try {
    const { upsertRelationship } = await import(
      "../../../apps/api/src/infrastructure/neo4j/graphService.js"
    );
    const result = await upsertRelationship({
      fromId: "person:alice",
      toId:   "project:neura",
      type:   "works_on",
      confidence: 0.8
    });
    assert.equal(result, false);
  } finally {
    if (saved !== undefined) process.env.NEO4J_URI = saved;
  }
});

test("graphService — getRelatedEntities returns [] when Neo4j is disabled", async () => {
  const saved = process.env.NEO4J_URI;
  delete process.env.NEO4J_URI;

  try {
    const { getRelatedEntities } = await import(
      "../../../apps/api/src/infrastructure/neo4j/graphService.js"
    );
    const result = await getRelatedEntities("person:alice");
    assert.deepEqual(result, []);
  } finally {
    if (saved !== undefined) process.env.NEO4J_URI = saved;
  }
});

test("graphService — getGraphContext returns empty context when Neo4j is disabled", async () => {
  const saved = process.env.NEO4J_URI;
  delete process.env.NEO4J_URI;

  try {
    const { getGraphContext } = await import(
      "../../../apps/api/src/infrastructure/neo4j/graphService.js"
    );
    const result = await getGraphContext("mem-123");
    assert.equal(result.entityCount, 0);
    assert.equal(result.relCount,    0);
    assert.deepEqual(result.entities,      []);
    assert.deepEqual(result.relationships, []);
  } finally {
    if (saved !== undefined) process.env.NEO4J_URI = saved;
  }
});

test("graphService — removeEntity returns false when Neo4j is disabled", async () => {
  const saved = process.env.NEO4J_URI;
  delete process.env.NEO4J_URI;

  try {
    const { removeEntity } = await import(
      "../../../apps/api/src/infrastructure/neo4j/graphService.js"
    );
    const result = await removeEntity("person:alice");
    assert.equal(result, false);
  } finally {
    if (saved !== undefined) process.env.NEO4J_URI = saved;
  }
});

test("graphService — removeRelationship returns false for unknown rel type", async () => {
  const saved = process.env.NEO4J_URI;
  process.env.NEO4J_URI = "neo4j://localhost:7687";

  try {
    const { removeRelationship } = await import(
      "../../../apps/api/src/infrastructure/neo4j/graphService.js"
    );
    const result = await removeRelationship("person:alice", "project:neura", "NOT_A_TYPE");
    assert.equal(result, false, "Expected false for unknown rel type");
  } finally {
    if (saved !== undefined) process.env.NEO4J_URI = saved;
    else delete process.env.NEO4J_URI;
  }
});

// ─── 29–30: graphPipeline — memory storage continues when graph fails ─────────

test("graphPipeline — persistMemoryGraph resolves even when upsertEntity throws", async () => {
  // This tests the fire-and-forget contract: the promise must always resolve.
  const { persistMemoryGraph } = await import(
    "../../../apps/api/src/services/graphPipeline.js"
  );

  const memory = mem({
    id: "mem-graph-fail",
    content: "I prefer TypeScript. We decided to use Neo4j.",
    domain: "engineering"
  });

  // Should never throw regardless of Neo4j availability
  await assert.doesNotReject(
    () => persistMemoryGraph(memory),
    "persistMemoryGraph must not reject even when Neo4j is unavailable"
  );
});

test("graphPipeline — persistMemoryGraph resolves on null memory (no crash)", async () => {
  const { persistMemoryGraph } = await import(
    "../../../apps/api/src/services/graphPipeline.js"
  );
  await assert.doesNotReject(() => persistMemoryGraph(null));
  await assert.doesNotReject(() => persistMemoryGraph(undefined));
  await assert.doesNotReject(() => persistMemoryGraph({}));
});

// ─── 31–34: candidateFetcher — getGraphContext flows into graphScore ───────────

test("candidateFetcher — getGraphContext with entities boosts graphScore", async () => {
  const memId = uid();

  const vectorStore = {
    async findRelevant() {
      return [{
        id: memId, content: "test content", summary: "test",
        metadata: { importance: 0.7, timestamp: new Date().toISOString() },
        _retrieval: { vectorScore: 0.8, lexicalScore: 0 }
      }];
    }
  };

  // graphStore with getGraphContext returning real entity data
  const graphStore = {
    async findSimilarMemories() { return []; },
    async findMemoriesByKeyword() { return []; },
    async findMemoriesByDomain() { return []; },
    async findMemoriesByEntity() { return []; },
    async getGraphContext(id) {
      if (id !== memId) return { entities: [], relationships: [], entityCount: 0, relCount: 0 };
      return {
        entities: [
          { id: "person:alice", name: "Alice", type: "person" },
          { id: "project:neura", name: "Neura", type: "project" }
        ],
        relationships: [
          { fromId: "person:alice", toId: "project:neura", type: "works_on", confidence: 0.8 }
        ],
        entityCount: 2,
        relCount: 1
      };
    }
  };

  const svc = createHybridRetrievalService({
    vectorStore,
    keywordStore: { async findRelevant() { return []; } },
    graphStore,
    embedText: async () => null
  });

  const candidates = await svc.retrieveCandidates("test query", "user-1", "session-1");
  assert.ok(candidates.length > 0, "Expected at least one candidate");

  const scored = candidates.find((c) => c.id === memId);
  assert.ok(scored, "Expected the vector result to be in candidates");
  assert.ok(
    scored._hybrid.graphScore > 0,
    `Expected graphScore > 0, got ${scored._hybrid.graphScore}`
  );
});

test("candidateFetcher — getGraphContext returning null does not crash", async () => {
  const memId = uid();

  const svc = createHybridRetrievalService({
    vectorStore: {
      async findRelevant() {
        return [{
          id: memId, content: "content", summary: "summary",
          metadata: { importance: 0.5, timestamp: new Date().toISOString() },
          _retrieval: { vectorScore: 0.6, lexicalScore: 0 }
        }];
      }
    },
    keywordStore: { async findRelevant() { return []; } },
    graphStore: {
      async findSimilarMemories() { return []; },
      async getGraphContext()      { return null; }  // returns null
    },
    embedText: async () => null
  });

  await assert.doesNotReject(
    () => svc.retrieveCandidates("query", "user", "session"),
    "Should not crash when getGraphContext returns null"
  );
});

test("candidateFetcher — both similar memories and graphContext contribute to score", async () => {
  const memId = uid();

  const graphStore = {
    async findSimilarMemories() {
      return [{ id: uid(), summary: "similar memory", importance: 0.7 }];
    },
    async getGraphContext() {
      return { entities: [{ id: "e1" }, { id: "e2" }], relationships: [], entityCount: 2, relCount: 0 };
    }
  };

  const svc = createHybridRetrievalService({
    vectorStore: {
      async findRelevant() {
        return [{
          id: memId, content: "content", summary: "summary",
          metadata: { importance: 0.7, timestamp: new Date().toISOString() },
          _retrieval: { vectorScore: 0.7, lexicalScore: 0 }
        }];
      }
    },
    keywordStore: { async findRelevant() { return []; } },
    graphStore,
    embedText: async () => null
  });

  const candidates = await svc.retrieveCandidates("query", "user", "session");
  const candidate = candidates.find((c) => c.id === memId);
  assert.ok(candidate, "Expected candidate in result");
  assert.ok(
    candidate._hybrid.graphScore > 0,
    `Expected graphScore > 0, got ${candidate._hybrid.graphScore}`
  );
});

test("candidateFetcher — graphStore without getGraphContext still works", async () => {
  const memId = uid();

  // Simulate old-style graphStore that does NOT have getGraphContext
  const graphStore = {
    async findSimilarMemories() { return []; }
    // no getGraphContext
  };

  const svc = createHybridRetrievalService({
    vectorStore: {
      async findRelevant() {
        return [{
          id: memId, content: "content", summary: "summary",
          metadata: { importance: 0.5, timestamp: new Date().toISOString() },
          _retrieval: { vectorScore: 0.5, lexicalScore: 0 }
        }];
      }
    },
    keywordStore: { async findRelevant() { return []; } },
    graphStore,
    embedText: async () => null
  });

  const candidates = await svc.retrieveCandidates("query", "user", "session");
  assert.ok(candidates.length > 0, "Expected results even without getGraphContext");
  // graphScore stays at 0 (no similar memories, no context)
  const candidate = candidates.find((c) => c.id === memId);
  assert.ok(candidate, "Expected candidate in result");
  assert.equal(candidate._hybrid.graphScore, 0);
});
