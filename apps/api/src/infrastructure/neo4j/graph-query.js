/**
 * infrastructure/neo4j/graph-query.js
 *
 * Named graph query functions over the Neo4j relationship store.
 * Services import from here rather than reaching into relationship-graph-store
 * directly, keeping the query API surface explicit.
 */
export {
  findMemoriesByDomain,
  findMemoriesByEntity,
  findMemoriesByKeyword,
  findSimilarMemories,
  getMemoryGraphStats
} from "./relationship-graph-store.js";
