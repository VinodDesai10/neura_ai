# Hybrid Memory Retrieval

This document describes the multi-signal retrieval pipeline introduced in
`packages/core/src/memory/services/hybridRetrievalService.js`.

---

## Why hybrid retrieval?

A single retrieval signal is insufficient for the kinds of memories AiNeura
stores.

| Signal alone        | Weakness                                                     |
|---------------------|--------------------------------------------------------------|
| Vector similarity   | Fails on factual memories that are semantically distant yet highly relevant (e.g. a stored preference) |
| Full-text / keyword | Misses paraphrased queries; strong on exact terms            |
| Importance score    | Has no notion of query relevance                             |
| Recency             | Treats all old memories equally regardless of relevance      |
| Graph relationships | Cannot rank memories with no prior connections               |

Combining all five signals in a weighted sum produces a _finalScore_ that is
better than any single signal alone.

---

## Scoring formula

```
finalScore =
  vectorScore     × weights.vector      (default 0.40)
+ keywordScore    × weights.keyword     (default 0.20)
+ importanceScore × weights.importance  (default 0.20)
+ recencyScore    × weights.recency     (default 0.10)
+ graphScore      × weights.graph       (default 0.10)
```

All five signals are normalised to **[0, 1]** before being combined.  The
`finalScore` is clamped to [0, 1].

### Signal definitions

| Signal | Range | Source | Notes |
|--------|-------|--------|-------|
| `vectorScore` | 0–1 | Qdrant cosine similarity | 0 when Qdrant is unavailable or memory has no embedding |
| `keywordScore` | 0–1 | Token overlap (query ∩ memory text) | Always available; soft-capped at 5 matching tokens = 1.0 |
| `importanceScore` | 0–1 | `metadata.importance` | Includes a small access-frequency bonus (≤ 0.15) |
| `recencyScore` | 0–1 | Exponential decay from `metadata.timestamp` | Configurable half-life (default 72 h); old memories never reach 0 |
| `graphScore` | 0–1 | Neo4j SIMILAR_TO neighbourhood size | 0 when Neo4j is unavailable |

### Access-frequency bonus

The stored `metadata.accessCount` contributes a logarithmic bonus blended
into `importanceScore`:

```
accessFreqBonus = min(0.15, log1p(accessCount) / log1p(100))
blendedImportance = min(1, importanceScore + accessFreqBonus)
```

This ensures frequently retrieved memories stay relevant even if their raw
importance score is moderate.

---

## Weight configuration

Weights can be set globally via environment variables:

```env
RETRIEVAL_VECTOR_WEIGHT=0.40
RETRIEVAL_LEXICAL_WEIGHT=0.20
RETRIEVAL_IMPORTANCE_WEIGHT=0.20
RETRIEVAL_RECENCY_WEIGHT=0.10
RETRIEVAL_GRAPH_WEIGHT=0.10
```

They can also be overridden per-call:

```js
const results = await retriever.getRelevantMemories(query, userId, sessionId, {
  weights: {
    vector:     0.50,
    keyword:    0.30,
    importance: 0.10,
    recency:    0.05,
    graph:      0.05
  }
});
```

---

## Retrieval pipeline

```
getRelevantMemories(query, userId, sessionId)
         │
         ▼
   retrieveCandidates()
         │
         ├── embedText(query)                         [best-effort — null on failure]
         │
         ├── vectorStore.findRelevant(...)             [Qdrant — empty on failure]
         ├── keywordStore.findRelevant(...)            [Postgres FTS — empty on failure]
         │
         ├── deduplicateById()                        [merge overlapping results]
         │
         └── for each candidate:
               graphStore.findSimilarMemories(id)     [Neo4j — 0 score on failure]
                 ├── compute graphScore for candidate
                 └── add graph-only neighbours as new candidates
         │
         ▼
   rankMemories(candidates)
         │
         ├── for each candidate:
         │     compute vectorScore, keywordScore, importanceScore,
         │             recencyScore, graphScore, accessFreqBonus
         │     finalScore = weighted sum
         │     attach _hybrid envelope
         │
         ├── filter by minFinalScore (default 0)
         ├── sort descending by finalScore
         └── slice to topK
         │
         ▼
   RankedMemory[]
```

---

## Return shape

Every element in the returned array is a `RankedMemory`:

```js
{
  // ...all original memory fields (id, content, summary, metadata, …)
  _hybrid: {
    finalScore:      number,   // weighted combination of all signals
    vectorScore:     number,   // Qdrant cosine similarity
    keywordScore:    number,   // normalised token overlap
    importanceScore: number,   // stored importance (before access-freq blend)
    recencyScore:    number,   // exponential decay factor
    graphScore:      number,   // graph neighbourhood score
    accessFreqBonus: number,   // bonus from access frequency
    sources:         string[], // e.g. ["qdrant", "postgres", "graph"]
    reason:          string,   // human-readable selection justification
    weights:         object    // the weights used for this result
  }
}
```

The `reason` string explains why the memory was selected, for example:

> "Selected via qdrant+postgres — strong vector similarity, keyword match, high importance"

---

## Graceful degradation

The service never throws because a backend is unavailable.

| Failure | Behaviour |
|---------|-----------|
| Qdrant unreachable | `vectorScore = 0` for all candidates; keyword + metadata paths proceed normally |
| Neo4j unreachable | `graphScore = 0` for all candidates; graph neighbours are not added |
| Postgres unreachable | `keywordScore = 0` from store (in-process token overlap still applies) |
| `embedText` throws | `queryEmbedding = null`; vector store is called with `null` (falls back to in-memory or skips) |
| All stores return nothing | Returns `[]` without error |

---

## Dependency injection

The service is pure domain code — it imports nothing from `apps/api`.
Infrastructure is injected via the factory:

```js
import { createHybridRetrievalService } from "@neura/core";

const retriever = createHybridRetrievalService({
  vectorStore,   // { findRelevant({query, queryEmbedding, sessionId, userId}) }
  keywordStore,  // { findRelevant(query, sessionId) }
  graphStore,    // { findSimilarMemories(memoryId, limit), … }
  embedText      // async (text) → number[] | null
});
```

The production-wired singleton lives in
`apps/api/src/services/hybrid-retrieval.js` and is consumed by
`memory-orchestrator.js`.

---

## Integration with the existing orchestrator

`memory-orchestrator.js` calls `hybridRetrieval.getRelevantMemories()` in
parallel with the existing `factualMemoryStore.findRelevant()` and
`vectorMemoryStore.findRelevant()` calls.  Results from all three are merged
via `deduplicateAndRerank()` before being written to working memory.

Hybrid-only results carry a `_hybrid` envelope.  A normalisation helper in
the orchestrator translates this into the `_retrieval` shape that
`deduplicateAndRerank()` expects, ensuring backward compatibility with all
existing callers.

---

## Public API

```js
import { createHybridRetrievalService, HYBRID_WEIGHTS_DEFAULTS } from "@neura/core";

const retriever = createHybridRetrievalService({ vectorStore, keywordStore, graphStore, embedText });

// Full pipeline
const memories = await retriever.getRelevantMemories(query, userId, sessionId, options);

// Fetch candidates only (useful for testing or custom re-ranking)
const candidates = await retriever.retrieveCandidates(query, userId, sessionId, options);

// Re-rank a pre-fetched list
const ranked = retriever.rankMemories(candidates, options);
```

### `options` reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `topK` | `number` | `8` (from env) | Maximum results to return |
| `weights` | `object` | `HYBRID_WEIGHTS_DEFAULTS` | Per-signal weight overrides |
| `halfLifeHours` | `number` | `72` (from env) | Recency half-life in hours |
| `minFinalScore` | `number` | `0` | Minimum finalScore threshold |
