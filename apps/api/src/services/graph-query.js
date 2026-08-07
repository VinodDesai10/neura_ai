/**
 * services/graph-query.js
 *
 * Thin service layer over the Neo4j graph store query functions.
 * Controllers call these instead of reaching directly into infrastructure.
 */
export {
  findMemoriesByDomain,
  findMemoriesByEntity,
  findMemoriesByKeyword,
  findSimilarMemories,
  getMemoryGraphStats
} from "../infrastructure/relationship-graph-store.js";
