/**
 * apps/api/src/services/hybrid-retrieval.js
 *
 * Wires the infrastructure adapters (Qdrant, Postgres, Neo4j) into the
 * domain-layer `createHybridRetrievalService` factory and exports a
 * ready-to-use singleton.
 *
 * This is the only file in apps/api that imports from both infrastructure
 * and @neura/core for hybrid retrieval.  The domain service itself has no
 * infrastructure imports.
 */

import { createHybridRetrievalService } from "@neura/core";
import { vectorMemoryStore }  from "../infrastructure/vector-memory-store.js";
import { factualMemoryStore } from "../infrastructure/factual-memory-store.js";
import {
  findSimilarMemories,
  findMemoriesByKeyword,
  findMemoriesByDomain,
  findMemoriesByEntity
} from "../infrastructure/relationship-graph-store.js";
import { getGraphContext } from "../infrastructure/neo4j/graphService.js";
import { openAIAdapter } from "./openai-adapter.js";

/**
 * Graph store adapter — wraps the individual Neo4j query exports into the
 * interface expected by `createHybridRetrievalService`.
 *
 * `getGraphContext` exposes the structured entity/relationship data extracted
 * by the Memory Graph pipeline so the candidateFetcher can use the entity
 * count as an additional graph-score signal.
 */
const graphStoreAdapter = {
  findSimilarMemories,
  findMemoriesByKeyword,
  findMemoriesByDomain,
  findMemoriesByEntity,
  getGraphContext
};

/**
 * Production hybrid retrieval singleton.
 *
 * Uses:
 *   vectorStore  → Qdrant-backed vector-memory-store (falls back to in-memory)
 *   keywordStore → Postgres-backed factual-memory-store (falls back to in-memory)
 *   graphStore   → Neo4j relationship-graph-store (falls back to empty results)
 *   embedText    → OpenAI embedding via openai-adapter (falls back to null)
 */
export const hybridRetrieval = createHybridRetrievalService({
  vectorStore:  vectorMemoryStore,
  keywordStore: factualMemoryStore,
  graphStore:   graphStoreAdapter,
  embedText:    (text) => openAIAdapter.embedText(text).catch(() => null)
});
