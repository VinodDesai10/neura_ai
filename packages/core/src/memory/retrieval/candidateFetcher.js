/**
 * packages/core/src/memory/retrieval/candidateFetcher.js
 *
 * Fan-out retrieval layer for the hybrid retrieval pipeline.
 *
 * Responsible for fetching raw memory candidates from all configured
 * backends (Qdrant vector store, Postgres keyword store, Neo4j graph store)
 * and assembling them into a single, deduplicated list ready for ranking.
 *
 * ─── Responsibilities ────────────────────────────────────────────────────────
 *
 *   • Embed the query (best-effort — null embedding is gracefully handled)
 *   • Fan out concurrently to the vector and keyword backends
 *   • Annotate each result with preliminary per-source signal scores
 *   • Deduplicate results that appear from multiple backends
 *   • Enrich via Neo4j graph neighbours (graph-only neighbours become extra
 *     candidates; known candidates receive a graphScore boost)
 *
 * ─── Graceful degradation ────────────────────────────────────────────────────
 *
 *   Any backend that throws is silently skipped — the function never
 *   propagates errors from individual stores.  Partial results (or an empty
 *   array) are always returned.
 *
 * ─── Public API ───────────────────────────────────────────────────────────────
 *
 *   createCandidateFetcher(stores) → { fetchCandidates }
 *
 *     fetchCandidates(query, userId, sessionId, options?)
 *       → Promise<object[]>   annotated candidate list
 */

import { readRetrievalConfig } from "@neura/shared";
import { SOURCE }              from "./retrievalTypes.js";
import { computeKeywordScore } from "./signalScorer.js";
import { deduplicateById }     from "./resultDeduplicator.js";

// ─── No-op stubs (used when a store is not provided) ─────────────────────────

const NULL_VECTOR_STORE  = { async findRelevant() { return []; } };
const NULL_KEYWORD_STORE = { async findRelevant() { return []; } };
const NULL_GRAPH_STORE   = {
  async findSimilarMemories()   { return []; },
  async findMemoriesByKeyword() { return []; },
  async findMemoriesByDomain()  { return []; },
  async findMemoriesByEntity()  { return []; }
};
const NULL_EMBED = async () => null;

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a candidate fetcher bound to the provided store adapters.
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
 * @returns {{ fetchCandidates: Function }}
 */
export function createCandidateFetcher(stores = {}) {
  const vectorStore  = stores.vectorStore  || NULL_VECTOR_STORE;
  const keywordStore = stores.keywordStore || NULL_KEYWORD_STORE;
  const graphStore   = stores.graphStore   || NULL_GRAPH_STORE;
  const embedText    = stores.embedText    || NULL_EMBED;

  /**
   * Fetch raw memory candidates from all available backends and return a
   * deduplicated, annotated list.
   *
   * Each candidate carries a `_hybrid` envelope with preliminary scores:
   *   - `vectorScore`  — from Qdrant's `_retrieval.vectorScore`
   *   - `keywordScore` — from Postgres's `_retrieval.lexicalScore` or
   *                      computed inline via token overlap
   *   - `graphScore`   — set to 0 here; enriched by the graph pass below
   *
   * @param {string}  query
   * @param {string}  userId
   * @param {string}  sessionId
   * @param {{
   *   topK?: number
   * }} [options]
   * @returns {Promise<object[]>}  Annotated candidates (not yet ranked).
   */
  async function fetchCandidates(query, userId, sessionId, options = {}) {
    const cfg  = readRetrievalConfig();
    const topK = options.topK ?? cfg.topK;

    // ── Embed the query (best-effort) ─────────────────────────────────────
    let queryEmbedding = null;
    try {
      queryEmbedding = await embedText(query);
    } catch {
      // No embedding — keyword + metadata paths take over
    }

    // ── Fan out to vector and keyword backends concurrently ───────────────
    const [vectorResults, keywordResults] = await Promise.all([
      // Vector store (Qdrant)
      (async () => {
        try {
          const results = await vectorStore.findRelevant({
            query,
            queryEmbedding,
            sessionId,
            userId
          });
          return (results || []).map((m) => ({ ...m, _hybridSource: SOURCE.VECTOR }));
        } catch {
          return [];
        }
      })(),

      // Keyword store (Postgres FTS)
      (async () => {
        try {
          const results = await keywordStore.findRelevant(query, sessionId);
          return (results || []).map((m) => ({ ...m, _hybridSource: SOURCE.KEYWORD }));
        } catch {
          return [];
        }
      })()
    ]);

    // ── Combine, annotate, and deduplicate ────────────────────────────────
    const allCandidates = [...vectorResults, ...keywordResults];
    if (allCandidates.length === 0) return [];

    const annotated = allCandidates.map((memory) => {
      const text   = memory.summary || memory.content || "";
      const source = memory._hybridSource || SOURCE.UNKNOWN;

      const vectorScore = memory._retrieval?.vectorScore ?? 0;
      const keywordScore = (
        memory._retrieval?.lexicalScore != null
          ? Math.min(1, memory._retrieval.lexicalScore / 5)
          : computeKeywordScore(query, text)
      );

      // Strip internal routing annotation before returning
      const { _hybridSource, ...cleanMemory } = memory;

      return {
        ...cleanMemory,
        _hybrid: {
          vectorScore,
          keywordScore,
          graphScore:      0,  // enriched in the graph pass below
          importanceScore: 0,  // computed by memoryRanker
          recencyScore:    0,  // computed by memoryRanker
          accessFreqBonus: 0,
          finalScore:      0,
          sources:         [source],
          reason:          "",
          weights:         {}
        }
      };
    });

    // Deduplicate: merge per-source scores when the same id appears from
    // multiple backends
    const deduped = deduplicateById(annotated);

    // ── Graph enrichment (Neo4j) ──────────────────────────────────────────
    // For each deduplicated candidate, query Neo4j for similar memories:
    //   1. Give the candidate itself a graphScore proportional to how many
    //      neighbours it has.
    //   2. Add any new graph-only neighbours as additional candidates.
    //   3. If the graph store exposes getGraphContext(), use entity count as
    //      an additional signal that boosts the graph score further.
    const graphOnlyCandidates = [];

    await Promise.all(
      deduped.slice(0, topK * 2).map(async (candidate) => {
        try {
          // Parallel: fetch similar memories + graph context (if available)
          const [similar, graphCtx] = await Promise.all([
            graphStore.findSimilarMemories(
              candidate.id,
              Math.max(3, Math.ceil(topK / 2))
            ).catch(() => []),
            typeof graphStore.getGraphContext === "function"
              ? graphStore.getGraphContext(candidate.id).catch(() => null)
              : Promise.resolve(null)
          ]);

          const hasSimilar = similar && similar.length > 0;
          const hasCtx     = graphCtx && (graphCtx.entityCount > 0 || graphCtx.relCount > 0);

          if (!hasSimilar && !hasCtx) return;

          // Derive graphScore from both signals
          let graphScore = 0;

          if (hasSimilar) {
            // Base score from similar-memory neighbours
            graphScore = Math.max(graphScore, 0.3 + (similar.length / 5) * 0.5);
          }

          if (hasCtx) {
            // Boost from rich entity/relationship data for this memory
            const entityBoost = Math.min(0.3, (graphCtx.entityCount / 10) * 0.3);
            const relBoost    = Math.min(0.15, (graphCtx.relCount / 10) * 0.15);
            graphScore = Math.max(graphScore, 0.25 + entityBoost + relBoost);
          }

          candidate._hybrid.graphScore = Math.min(1, graphScore);

          // Graph-only neighbours not already in the candidate set
          if (hasSimilar) {
            for (const neighbour of similar) {
              if (!neighbour?.id) continue;
              if (deduped.some((c) => c.id === neighbour.id)) continue;
              if (graphOnlyCandidates.some((c) => c.id === neighbour.id)) continue;

              const text = neighbour.summary || neighbour.content || "";
              graphOnlyCandidates.push({
                id:      neighbour.id,
                content: neighbour.content || "",
                summary: neighbour.summary || "",
                metadata: {
                  importance: Number(neighbour.importance || 0)
                },
                _hybrid: {
                  vectorScore:     0,
                  keywordScore:    computeKeywordScore(query, text),
                  graphScore:      Math.min(1, 0.6 + (neighbour.importance || 0) * 0.4),
                  importanceScore: 0,
                  recencyScore:    0,
                  accessFreqBonus: 0,
                  finalScore:      0,
                  sources:         [SOURCE.GRAPH],
                  reason:          "",
                  weights:         {}
                }
              });
            }
          }
        } catch {
          // Graph unavailable for this candidate — graphScore stays 0
        }
      })
    );

    return [...deduped, ...graphOnlyCandidates];
  }

  return { fetchCandidates };
}
