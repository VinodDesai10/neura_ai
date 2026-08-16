/**
 * packages/core/src/memory/services/hybridRetrievalService.js
 *
 * Hybrid Memory Retrieval — thin orchestration layer.
 *
 * This module composes the focused retrieval modules into a single, unified
 * service object.  All heavy lifting (score computation, backend fan-out,
 * deduplication, ranking) is delegated to the modules under
 * `../retrieval/`.  This file's job is wiring them together and exposing the
 * public API.
 *
 * ─── Scoring formula ──────────────────────────────────────────────────────────
 *
 *   finalScore =
 *     vectorScore     * weights.vector     +   (default 0.40)
 *     keywordScore    * weights.keyword    +   (default 0.20)
 *     importanceScore * weights.importance +   (default 0.20)
 *     recencyScore    * weights.recency    +   (default 0.10)
 *     graphScore      * weights.graph          (default 0.10)
 *
 * All weights must sum to 1.0.  Individual weights can be overridden per
 * call via the `options.weights` parameter.
 *
 * ─── Dependency injection ─────────────────────────────────────────────────────
 *
 *   const retriever = createHybridRetrievalService({
 *     vectorStore,   // implements { findRelevant({query,queryEmbedding,sessionId,userId}) }
 *     keywordStore,  // implements { findRelevant(query, sessionId) }
 *     graphStore,    // implements { findSimilarMemories(memoryId, limit), ... }
 *     embedText,     // async (text: string) → number[]|null
 *   });
 *
 * All four stores are optional — omitting any falls back to a no-op stub.
 *
 * ─── Public API ───────────────────────────────────────────────────────────────
 *
 *   retrieveCandidates(query, userId, sessionId, options?)
 *     → Promise<RawCandidate[]>
 *
 *   rankMemories(candidates, options?)
 *     → RankedMemory[]
 *
 *   getRelevantMemories(query, userId, sessionId, options?)
 *     → Promise<RankedMemory[]>
 *
 * See `../retrieval/retrievalTypes.js` for type definitions.
 */

import { HYBRID_WEIGHTS_DEFAULTS } from "../retrieval/retrievalTypes.js";
import { createCandidateFetcher }  from "../retrieval/candidateFetcher.js";
import { rankMemories as doRank }  from "../retrieval/memoryRanker.js";

// Re-export the defaults constant so callers that previously imported it
// from this module continue to work unchanged.
export { HYBRID_WEIGHTS_DEFAULTS };

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a configured hybrid retrieval service.
 *
 * @param {{
 *   vectorStore?:  { findRelevant(params: object): Promise<object[]> },
 *   keywordStore?: { findRelevant(query: string, sessionId: string): Promise<object[]> },
 *   graphStore?:   {
 *     findSimilarMemories(memoryId: string, limit: number): Promise<object[]>,
 *     findMemoriesByKeyword?(sessionId: string, keyword: string, limit: number): Promise<object[]>,
 *     findMemoriesByDomain?(sessionId: string, domain: string, limit: number): Promise<object[]>,
 *     findMemoriesByEntity?(sessionId: string, entityValue: string, limit: number): Promise<object[]>
 *   },
 *   embedText?:    (text: string) => Promise<number[]|null>
 * }} [stores]
 * @returns {{ retrieveCandidates, rankMemories, getRelevantMemories }}
 */
export function createHybridRetrievalService(stores = {}) {
  const { fetchCandidates } = createCandidateFetcher(stores);

  /**
   * Fetch raw memory candidates from all available backends and return a
   * deduplicated, annotated list.
   *
   * @param {string}  query
   * @param {string}  userId
   * @param {string}  sessionId
   * @param {{ topK?: number, weights?: object }} [options]
   * @returns {Promise<object[]>}
   */
  async function retrieveCandidates(query, userId, sessionId, options = {}) {
    return fetchCandidates(query, userId, sessionId, options);
  }

  /**
   * Apply the weighted hybrid formula to a list of candidates and return
   * them sorted by finalScore descending.
   *
   * @param {object[]} candidates
   * @param {{
   *   topK?:          number,
   *   weights?:       object,
   *   halfLifeHours?: number,
   *   minFinalScore?: number
   * }} [options]
   * @returns {object[]}  RankedMemory[]
   */
  function rankMemories(candidates, options = {}) {
    return doRank(candidates, options);
  }

  /**
   * End-to-end convenience: fetch candidates then rank and return.
   *
   * @param {string}  query
   * @param {string}  userId
   * @param {string}  sessionId
   * @param {{
   *   topK?:          number,
   *   weights?:       object,
   *   halfLifeHours?: number,
   *   minFinalScore?: number
   * }} [options]
   * @returns {Promise<object[]>}  RankedMemory[]
   */
  async function getRelevantMemories(query, userId, sessionId, options = {}) {
    const candidates = await retrieveCandidates(query, userId, sessionId, options);
    return rankMemories(candidates, options);
  }

  return { retrieveCandidates, rankMemories, getRelevantMemories };
}

// ─── Default singleton (no-op stores — usable in core without infra) ──────────

/**
 * Default service instance with no-op stores.
 *
 * In production, replace with a properly-wired instance created by
 * `createHybridRetrievalService({ vectorStore, keywordStore, graphStore, embedText })`.
 */
export const hybridRetrievalService = createHybridRetrievalService();
