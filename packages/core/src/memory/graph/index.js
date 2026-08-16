/**
 * packages/core/src/memory/graph/index.js
 *
 * Public barrel for the Memory Graph module.
 *
 * Re-exports everything that application code or tests need to import from
 * the graph layer.  Infrastructure-level services (graphService.js) live in
 * `apps/api` because they hold the Neo4j driver dependency; only the pure
 * domain logic lives here in @neura/core.
 *
 * ─── Exports ──────────────────────────────────────────────────────────────
 *
 *   graphTypes.js        → ENTITY_TYPE, VALID_ENTITY_TYPES,
 *                          REL_TYPE, VALID_REL_TYPES
 *
 *   entityExtractor.js   → extractEntities(memory) → GraphEntity[]
 *
 *   relationshipExtractor.js → extractRelationships(memory, entities)
 *                              → GraphRelationship[]
 */

export {
  ENTITY_TYPE,
  VALID_ENTITY_TYPES,
  REL_TYPE,
  VALID_REL_TYPES
} from "./graphTypes.js";

export { extractEntities }       from "./entityExtractor.js";
export { extractRelationships }  from "./relationshipExtractor.js";
