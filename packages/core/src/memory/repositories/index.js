/**
 * packages/core/src/memory/repositories/index.js
 *
 * Repository interface stubs for the three long-term memory stores.
 *
 * This file defines the CONTRACT (method signatures + JSDoc) that each
 * concrete adapter must implement.  The actual adapters live in:
 *
 *   apps/api/src/infrastructure/postgres/  → factual-memory-store.js
 *   apps/api/src/infrastructure/qdrant/    → vector-memory-store.js
 *   apps/api/src/infrastructure/neo4j/     → relationship-graph-store.js
 *
 * Having the interface here means:
 *   1. Business logic in packages/core can reference the shape without
 *      depending on infrastructure packages.
 *   2. New adapters have a clear spec to implement.
 *   3. In-memory test doubles can be derived from these stubs directly.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IMPORTANT: Do NOT import from apps/api here.  This package (core) must
 * remain a pure domain package with no runtime dependency on infrastructure.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── Factual memory repository ────────────────────────────────────────────────
// Backed by PostgreSQL with full-text search (tsvector).
//
// TODO(postgres): Implement the concrete adapter in
//   apps/api/src/infrastructure/postgres/factual-memory-store.js
//   Methods: upsert, findRelevant, all

/**
 * @interface FactualMemoryRepository
 *
 * Stores stable user facts (name, preferences, decisions) as structured
 * rows in Postgres.  Supports full-text search via a `tsvector` column.
 */
export const FactualMemoryRepository = {
  /**
   * Insert or update a factual memory.
   * Conflict resolution: on fingerprint collision, merge and update importance.
   *
   * TODO(postgres): Implement with ON CONFLICT (fingerprint) DO UPDATE
   *
   * @param {import("../entities/memory-types.js").MemoryCandidate & {
   *   id:          string,
   *   sessionId:   string,
   *   fingerprint: string
   * }} memory
   * @returns {Promise<object>}  Stored memory row with database-assigned fields
   */
  async upsert(memory) {
    // TODO(postgres): INSERT INTO memories (...) ON CONFLICT (fingerprint) DO UPDATE ...
    throw new Error("FactualMemoryRepository.upsert: not implemented");
  },

  /**
   * Return the top-K factual memories that lexically overlap with `query`
   * for the given session.
   *
   * TODO(postgres): Implement with plainto_tsquery / tsvector full-text search
   *
   * @param {string} query      - Raw user query
   * @param {string} sessionId  - Session scope
   * @returns {Promise<object[]>}
   */
  async findRelevant(query, sessionId) {
    // TODO(postgres): SELECT ... WHERE ts_vector @@ plainto_tsquery(query)
    throw new Error("FactualMemoryRepository.findRelevant: not implemented");
  },

  /**
   * Return all stored factual memories (used by debug/admin endpoints).
   *
   * TODO(postgres): SELECT * FROM memories WHERE type = 'factual'
   *
   * @returns {Promise<object[]>}
   */
  async all() {
    // TODO(postgres): full table scan — use sparingly (debug only)
    throw new Error("FactualMemoryRepository.all: not implemented");
  }
};

// ─── Vector memory repository ─────────────────────────────────────────────────
// Backed by Qdrant for episodic and semantic memories via embedding similarity.
//
// TODO(qdrant): Implement the concrete adapter in
//   apps/api/src/infrastructure/qdrant/vector-memory-store.js
//   Methods: upsert, findRelevant, all

/**
 * @interface VectorMemoryRepository
 *
 * Stores episodic and semantic memories as embedding vectors in Qdrant.
 * Retrieval is by cosine similarity over the query embedding.
 */
export const VectorMemoryRepository = {
  /**
   * Insert or update an episodic/semantic memory with its embedding vector.
   *
   * TODO(qdrant): Implement using qdrantClient.upsert() with the memory's
   *   embedding as the payload vector.
   *
   * @param {import("../entities/memory-types.js").MemoryCandidate & {
   *   id:        string,
   *   sessionId: string,
   *   embedding: number[]
   * }} memory
   * @returns {Promise<object>}
   */
  async upsert(memory) {
    // TODO(qdrant): qdrantClient.upsert(collection, { points: [{ id, vector, payload }] })
    throw new Error("VectorMemoryRepository.upsert: not implemented");
  },

  /**
   * Return the top-K most similar memories to `queryEmbedding` in the session.
   *
   * TODO(qdrant): Implement using qdrantClient.search() with cosine distance
   *
   * @param {{
   *   query:          string,
   *   queryEmbedding: number[],
   *   sessionId:      string,
   *   userId?:        string|null
   * }} params
   * @returns {Promise<object[]>}
   */
  async findRelevant({ query, queryEmbedding, sessionId, userId }) {
    // TODO(qdrant): qdrantClient.search(collection, { vector: queryEmbedding, limit: topK })
    throw new Error("VectorMemoryRepository.findRelevant: not implemented");
  },

  /**
   * Return all vector memories for a session (debug/admin only).
   *
   * TODO(qdrant): qdrantClient.scroll(collection, { filter: { sessionId }, limit })
   *
   * @param {string} sessionId
   * @returns {Promise<object[]>}
   */
  async all(sessionId) {
    // TODO(qdrant): full collection scroll — use sparingly (debug only)
    throw new Error("VectorMemoryRepository.all: not implemented");
  }
};

// ─── Relationship graph repository ───────────────────────────────────────────
// Backed by Neo4j for linking memories, sessions, events, and tags.
//
// TODO(neo4j): Implement the concrete adapter in
//   apps/api/src/infrastructure/neo4j/relationship-graph-store.js
//   Methods: linkBatchMemoryRelationships, findRelatedMemories, getSessionGraph

/**
 * @interface RelationshipGraphRepository
 *
 * Stores and queries the graph of relationships between memories, sessions,
 * events, users, and domain tags in Neo4j.
 *
 * The graph model:
 *   (Session)-[:HAS_EVENT]->(Event)-[:PRODUCED]->(Memory)
 *   (Memory)-[:TAGGED]->(Tag)
 *   (Memory)-[:SIMILAR_TO]->(Memory)   ← populated by dedup pipeline
 *   (User)-[:OWNS]->(Session)
 */
export const RelationshipGraphRepository = {
  /**
   * Create graph nodes and edges for a batch of freshly stored memories.
   *
   * TODO(neo4j): Implement using a single Cypher UNWIND batch write:
   *   UNWIND $batch AS m
   *   MERGE (mem:Memory {id: m.id})
   *   MERGE (sess:Session {id: m.sessionId})
   *   MERGE (sess)-[:CONTAINS]->(mem)
   *   FOREACH (tag IN m.tags | MERGE (t:Tag {name: tag}) MERGE (mem)-[:TAGGED]->(t))
   *
   * @param {object[]} memories  - Memories that have just been upserted to a store
   * @returns {Promise<void>}
   */
  async linkBatchMemoryRelationships(memories) {
    // TODO(neo4j): batch Cypher write — see docs/architecture.md for graph model
    throw new Error("RelationshipGraphRepository.linkBatchMemoryRelationships: not implemented");
  },

  /**
   * Return memories related to `memoryId` by traversing the graph
   * up to `depth` hops.
   *
   * TODO(neo4j): MATCH (m:Memory {id: $memoryId})-[:SIMILAR_TO*1..depth]-(related)
   *              RETURN related ORDER BY related.importance DESC LIMIT $limit
   *
   * @param {string} memoryId
   * @param {{ depth?: number, limit?: number }} [options]
   * @returns {Promise<object[]>}
   */
  async findRelatedMemories(memoryId, options = {}) {
    // TODO(neo4j): graph traversal — add vector similarity edges when cosine ≥ threshold
    throw new Error("RelationshipGraphRepository.findRelatedMemories: not implemented");
  },

  /**
   * Return the full session graph for debugging: all memories, events,
   * tags, and their relationships for a given session.
   *
   * TODO(neo4j): MATCH (s:Session {id: $sessionId})-[r*1..3]-(n) RETURN s, r, n
   *
   * @param {string} sessionId
   * @returns {Promise<object>}  Neo4j graph result (nodes + relationships)
   */
  async getSessionGraph(sessionId) {
    // TODO(neo4j): used by the /graph debug endpoint
    throw new Error("RelationshipGraphRepository.getSessionGraph: not implemented");
  }
};
