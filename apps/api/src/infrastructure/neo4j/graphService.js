/**
 * apps/api/src/infrastructure/neo4j/graphService.js
 *
 * Clean abstraction around the Neo4j driver for the Memory Graph.
 *
 * This module exposes a typed-entity/relationship CRUD layer on top of the
 * existing Neo4j connection infrastructure.  It reuses `ensureNeo4jReady()`
 * and `getDriver()` from `relationship-graph-store.js` so there is exactly
 * one driver singleton, one schema-bootstrap sequence, and one connection
 * check guard across the entire application.
 *
 * ─── Security contract ────────────────────────────────────────────────────
 *
 *   ALL Cypher queries use parameterized variables — no query is ever built
 *   by string-concatenating user-controlled values.
 *
 * ─── Availability contract ────────────────────────────────────────────────
 *
 *   Every exported function catches Neo4j errors and returns a safe
 *   fallback (false / null / []).  Callers are NEVER expected to wrap these
 *   in their own try/catch for availability purposes (though they may for
 *   logic purposes).
 *
 * ─── Public API ───────────────────────────────────────────────────────────
 *
 *   upsertEntity(entity)                → Promise<boolean>
 *   upsertRelationship(rel)             → Promise<boolean>
 *   getRelatedEntities(entityId, opts?) → Promise<GraphEntity[]>
 *   getGraphContext(memoryId)           → Promise<GraphContext>
 *   removeEntity(entityId)             → Promise<boolean>
 *   removeRelationship(fromId, toId, type) → Promise<boolean>
 */

import { logger } from "../../lib/logger.js";
// Re-use the shared driver + readiness utilities
import {
  _getDriver as getDriver,
  _ensureNeo4jReady as ensureNeo4jReady,
  _isNeo4jEnabled as isNeo4jEnabled
} from "./relationship-graph-store.js";

const graphServiceLog = logger.child({ component: "graph-service" });

// ─── Session helper ───────────────────────────────────────────────────────────

/**
 * Open a Neo4j session scoped to the configured database.
 *
 * @returns {import("neo4j-driver").Session}
 */
function openSession() {
  return getDriver().session({
    database: process.env.NEO4J_DATABASE || "neo4j"
  });
}

// ─── upsertEntity ─────────────────────────────────────────────────────────────

/**
 * Create or update a typed entity node.
 *
 * The node is identified by `entity.id`.  If a node with that id already
 * exists its `name`, `type`, and `props` are overwritten.
 *
 * @param {import("@neura/core").GraphEntity} entity
 * @returns {Promise<boolean>}  true on success, false on failure / Neo4j unavailable
 */
export async function upsertEntity(entity) {
  if (!isNeo4jEnabled()) return false;

  try {
    if (!(await ensureNeo4jReady())) return false;

    const session = openSession();
    try {
      await session.executeWrite((tx) =>
        tx.run(
          `
          merge (e:GraphEntity {id: $id})
          set
            e.name      = $name,
            e.type      = $type,
            e.updatedAt = timestamp(),
            e.source    = $source
          `,
          {
            id:     String(entity.id),
            name:   String(entity.name),
            type:   String(entity.type),
            source: String(entity.props?.source || "extractor")
          }
        )
      );
      return true;
    } finally {
      await session.close();
    }
  } catch (err) {
    graphServiceLog.warn({ err, entityId: entity?.id }, "graph-service.upsertEntity.failed");
    return false;
  }
}

// ─── upsertRelationship ───────────────────────────────────────────────────────

/**
 * Create or update a directed relationship between two entity nodes.
 *
 * Both nodes are MERGED (created if absent) to ensure the relationship
 * can always be stored even if `upsertEntity` was not called first.
 *
 * @param {import("@neura/core").GraphRelationship} rel
 * @returns {Promise<boolean>}
 */
export async function upsertRelationship(rel) {
  if (!isNeo4jEnabled()) return false;

  // Guard: REL_TYPE values must be valid Neo4j relationship type identifiers
  // (uppercase alphanumeric + underscore).  Convert our snake_case values to
  // UPPER_SNAKE_CASE before building the parameterized query.  The type is
  // used as a literal in the Cypher pattern — we validate it against a
  // whitelist to ensure no injection.
  const ALLOWED_REL_TYPES = new Set([
    "WORKS_ON", "RELATED_TO", "DEPENDS_ON", "DECIDED",
    "ASSIGNED_TO", "PREFERS", "MENTIONED_IN", "COMPLETED", "BELONGS_TO"
  ]);
  const relTypeUpper = String(rel.type).toUpperCase().replace(/-/g, "_");
  if (!ALLOWED_REL_TYPES.has(relTypeUpper)) {
    graphServiceLog.warn({ relType: rel.type }, "graph-service.upsertRelationship.unknown-type");
    return false;
  }

  try {
    if (!(await ensureNeo4jReady())) return false;

    const session = openSession();
    try {
      // Neo4j does not allow parameterized relationship types, so we use the
      // whitelist-validated string literal.  The actual user data (ids,
      // confidence, source) are all parameterized.
      const cypher = `
        merge (a:GraphEntity {id: $fromId})
        merge (b:GraphEntity {id: $toId})
        merge (a)-[r:${relTypeUpper}]->(b)
        set
          r.confidence = $confidence,
          r.updatedAt  = timestamp(),
          r.source     = $source
      `;
      await session.executeWrite((tx) =>
        tx.run(cypher, {
          fromId:     String(rel.fromId),
          toId:       String(rel.toId),
          confidence: Number(rel.confidence ?? 0),
          source:     String(rel.props?.source || "extractor")
        })
      );
      return true;
    } finally {
      await session.close();
    }
  } catch (err) {
    graphServiceLog.warn({ err, fromId: rel?.fromId, toId: rel?.toId }, "graph-service.upsertRelationship.failed");
    return false;
  }
}

// ─── getRelatedEntities ───────────────────────────────────────────────────────

/**
 * Return entities that are directly connected to the given entity.
 *
 * @param {string} entityId  - The `id` of the starting entity node.
 * @param {{ limit?: number, minConfidence?: number }} [opts]
 * @returns {Promise<import("@neura/core").GraphEntity[]>}
 */
export async function getRelatedEntities(entityId, opts = {}) {
  if (!isNeo4jEnabled()) return [];

  try {
    if (!(await ensureNeo4jReady())) return [];

    const limit         = Math.min(50, opts.limit ?? 10);
    const minConfidence = opts.minConfidence ?? 0;

    const session = openSession();
    try {
      const result = await session.executeRead((tx) =>
        tx.run(
          `
          match (a:GraphEntity {id: $entityId})-[r]->(b:GraphEntity)
          where r.confidence >= $minConfidence
          return
            b.id   as id,
            b.name as name,
            b.type as type,
            r.confidence as confidence,
            type(r) as relType
          order by r.confidence desc
          limit $limit
          `,
          {
            entityId:      String(entityId),
            minConfidence: Number(minConfidence),
            limit
          }
        )
      );

      return result.records.map((rec) => ({
        id:         rec.get("id"),
        name:       rec.get("name"),
        type:       rec.get("type"),
        confidence: rec.get("confidence"),
        relType:    rec.get("relType")
      }));
    } finally {
      await session.close();
    }
  } catch (err) {
    graphServiceLog.warn({ err, entityId }, "graph-service.getRelatedEntities.failed");
    return [];
  }
}

// ─── getGraphContext ──────────────────────────────────────────────────────────

/**
 * Retrieve the graph context for a memory: all entities and relationships
 * that were extracted from it.
 *
 * This is the key method consumed by the hybrid retrieval pipeline to
 * compute an improved `graphScore` for a memory candidate.
 *
 * @param {string} memoryId
 * @returns {Promise<{
 *   entities: import("@neura/core").GraphEntity[],
 *   relationships: import("@neura/core").GraphRelationship[],
 *   entityCount: number,
 *   relCount: number
 * }>}
 */
export async function getGraphContext(memoryId) {
  const empty = { entities: [], relationships: [], entityCount: 0, relCount: 0 };

  if (!isNeo4jEnabled()) return empty;

  try {
    if (!(await ensureNeo4jReady())) return empty;

    const memNodeId = `memory:${memoryId}`;
    const session   = openSession();

    try {
      // Fetch entities linked to this memory via MENTIONED_IN
      const entityResult = await session.executeRead((tx) =>
        tx.run(
          `
          match (e:GraphEntity)-[r:MENTIONED_IN]->(m:GraphEntity {id: $memNodeId})
          return
            e.id   as id,
            e.name as name,
            e.type as type,
            r.confidence as confidence
          order by r.confidence desc
          limit 20
          `,
          { memNodeId: String(memNodeId) }
        )
      );

      const entities = entityResult.records.map((rec) => ({
        id:         rec.get("id"),
        name:       rec.get("name"),
        type:       rec.get("type"),
        confidence: rec.get("confidence")
      }));

      // Fetch relationships among those entities
      const entityIds = entities.map((e) => e.id);
      let relationships = [];

      if (entityIds.length > 1) {
        const relResult = await session.executeRead((tx) =>
          tx.run(
            `
            match (a:GraphEntity)-[r]->(b:GraphEntity)
            where a.id in $entityIds and b.id in $entityIds
              and type(r) <> 'MENTIONED_IN'
            return
              a.id as fromId,
              b.id as toId,
              type(r) as relType,
              r.confidence as confidence
            limit 30
            `,
            { entityIds }
          )
        );

        relationships = relResult.records.map((rec) => ({
          fromId:     rec.get("fromId"),
          toId:       rec.get("toId"),
          type:       rec.get("relType").toLowerCase(),
          confidence: rec.get("confidence")
        }));
      }

      return {
        entities,
        relationships,
        entityCount: entities.length,
        relCount:    relationships.length
      };
    } finally {
      await session.close();
    }
  } catch (err) {
    graphServiceLog.warn({ err, memoryId }, "graph-service.getGraphContext.failed");
    return empty;
  }
}

// ─── removeEntity ─────────────────────────────────────────────────────────────

/**
 * Delete a GraphEntity node and all its relationships.
 *
 * @param {string} entityId
 * @returns {Promise<boolean>}
 */
export async function removeEntity(entityId) {
  if (!isNeo4jEnabled()) return false;

  try {
    if (!(await ensureNeo4jReady())) return false;

    const session = openSession();
    try {
      await session.executeWrite((tx) =>
        tx.run(
          `
          match (e:GraphEntity {id: $entityId})
          detach delete e
          `,
          { entityId: String(entityId) }
        )
      );
      return true;
    } finally {
      await session.close();
    }
  } catch (err) {
    graphServiceLog.warn({ err, entityId }, "graph-service.removeEntity.failed");
    return false;
  }
}

// ─── removeRelationship ───────────────────────────────────────────────────────

/**
 * Delete a specific directed relationship between two entities.
 *
 * @param {string} fromId
 * @param {string} toId
 * @param {string} type   - REL_TYPE value (snake_case)
 * @returns {Promise<boolean>}
 */
export async function removeRelationship(fromId, toId, type) {
  if (!isNeo4jEnabled()) return false;

  const ALLOWED_REL_TYPES = new Set([
    "WORKS_ON", "RELATED_TO", "DEPENDS_ON", "DECIDED",
    "ASSIGNED_TO", "PREFERS", "MENTIONED_IN", "COMPLETED", "BELONGS_TO"
  ]);
  const relTypeUpper = String(type).toUpperCase().replace(/-/g, "_");
  if (!ALLOWED_REL_TYPES.has(relTypeUpper)) return false;

  try {
    if (!(await ensureNeo4jReady())) return false;

    const session = openSession();
    try {
      const cypher = `
        match (a:GraphEntity {id: $fromId})-[r:${relTypeUpper}]->(b:GraphEntity {id: $toId})
        delete r
      `;
      await session.executeWrite((tx) =>
        tx.run(cypher, {
          fromId: String(fromId),
          toId:   String(toId)
        })
      );
      return true;
    } finally {
      await session.close();
    }
  } catch (err) {
    graphServiceLog.warn({ err, fromId, toId, type }, "graph-service.removeRelationship.failed");
    return false;
  }
}
