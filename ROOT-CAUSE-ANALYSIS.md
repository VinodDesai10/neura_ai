# ROOT-CAUSE-ANALYSIS.md
## Neura AI — Context/Memory Retrieval Evaluation

**Evaluation timestamp:** 2026-09-01T12:34:01.269Z  
**Results:** 40 queries · 104 expected · 291 fetched · TP=30 · FP=261 · FN=74  
**Micro-Precision=10.31% · Micro-Recall=28.85% · Micro-F1=15.19%**

---

## 1. Measured Problem

The retrieval system returns 291 memories across 40 queries when only 104 were expected to be relevant. It correctly surfaces just 30 of those 104 relevant memories, misses 74, and brings along 261 irrelevant ones.

FP source breakdown:
- Qdrant episodic: **201 FPs (77%)**
- Postgres factual: **51 FPs (20%)**
- Qdrant semantic: **9 FPs (3%)**

FN source breakdown:
- Postgres factual: **59 FNs (80%)**
- Qdrant episodic: **13 FNs (18%)**
- Qdrant semantic: **2 FNs (3%)**

The overwhelming pattern: **Postgres factual memories are almost never retrieved for semantic queries** (80% of all misses), while **Qdrant episodic memories flood the results for every query regardless of relevance** (77% of all noise).

---

## 2. Root Cause 1 — Postgres Factual Memories Have No Vector Embeddings (Primary, 59/74 FNs)

**Impact: 59 factual FNs across 24 queries. Responsible for 80% of all misses.**

### Mechanism

In `infrastructure/qdrant/qdrant-client.js`, `queryQdrantPoints()` issues a raw vector similarity search with `strictSession=false`. It has no session filter — it searches the entire collection. Qdrant returns `topK*3 = 24` candidates, all with real cosine similarity scores (0.0–1.0).

In `infrastructure/postgres/factual-memory-store.js`, `findRelevant()` returns memories with `vectorScore = 0` hardcoded:

```js
const breakdown = computeHybridScore({
  vectorScore: 0,   // ← factual store has no embedding query
  lexicalScore,
  importanceScore,
  ...
}, cfg);
```

The `rankMemories()` function in `packages/core/src/memory/retrieval/memoryRanker.js` applies this formula with `HYBRID_WEIGHTS_DEFAULTS`:

```
finalScore = vectorScore * 0.40 + keywordScore * 0.20
           + importance * 0.20 + recency * 0.10 + graphScore * 0.10
```

Because `vectorScore=0` for every factual memory, they are structurally capped at a maximum score of `0.20 + 0.20 + 0.10 = 0.50` (keyword + importance + recency at full value). In practice, for semantic queries where keyword overlap is weak (1–2 tokens), the cap is around **0.28**.

Meanwhile any Qdrant episodic memory with cosine similarity ≥ 0.3 receives a score of at least `0.3 * 0.40 + ... ≈ 0.40+`, comfortably outranking the factual memories.

### Score trace: Q01 "What is my name and where do I live?"

**eval-f001** (Postgres, name fact):
```
vectorScore  = 0     (no embedding)
keywordScore = 0.2   (1 token: "name")
importance   = 0.95
recency      ≈ 0.5   (seeded 6 months ago)
finalScore   = 0*0.40 + 0.2*0.20 + 0.95*0.20 + 0.5*0.10 = 0.280
```

**eval-e008** (Qdrant, 1:1 with manager — completely irrelevant):
```
vectorScore  ≈ 0.45  (embedding space proximity)
keywordScore ≈ 0.1
importance   = 0.85
recency      ≈ 0.95  (seeded 3 hours ago — very high)
finalScore   ≈ 0.45*0.40 + 0.1*0.20 + 0.85*0.20 + 0.95*0.10 = 0.487
```

eval-e008 outscores the correct factual answer by 0.21 points — entirely due to the 40% vector weight that Postgres memories can never contribute.

### Why Q34 is the exception

Q34 ("What is the state of my fraud detection work?") is the one query where factual memories **were** retrieved (eval-f026, eval-f030, eval-f054). Query terms "fraud", "detection", "work" have strong lexical overlap with those factual memories. `computeKeywordScore` returns ~0.6–0.8, giving a final score of 0.6*0.20 + 0.88*0.20 + ... ≈ 0.38–0.42, enough to beat episodic noise. This confirms the diagnosis: **Postgres wins only when there is strong keyword overlap. For every semantic or conversational query, Qdrant's vector score dominates.**

---

## 3. Root Cause 2 — Qdrant Searches Entire Collection (No Session Filter), eval-e008 Appears in 20 Queries (77% of FPs)

**Impact: 201 episodic FPs. eval-e008 alone is a FP in 19 queries.**

### Mechanism

`queryQdrantPoints()` in `qdrant-client.js`:

```js
export async function queryQdrantPoints({ vector, sessionId, limit = 10, strictSession = false }) {
  const body = { query: vector, limit, with_payload: true };
  if (strictSession && sessionId) {
    body.filter = { must: [{ key: "sessionId", match: { value: sessionId } }] };
  }
  // ...
}
```

The default `strictSession = false` means **no session filter is applied**. Every query searches all 70 vector memories in the collection, regardless of which session is being addressed.

`eval-e008` ("1:1 with manager Anjali; on track for staff engineer promotion") is seeded in `eval-session-history` but appears in the FETCHED set for queries from 7 different sessions: personal, projects, goals, events, recency, topics, and history. It has:
- High importance: 0.85
- Very high recency: seeded 3 hours ago → recency score ≈ 0.95
- Moderate embedding similarity to many queries (work, career, engineer appear broadly)

This single memory contributes 19 FPs across 40 queries.

The top 5 cross-session FP offenders:

| Memory ID | FP count | Why it recurs |
|-----------|----------|---------------|
| eval-e008 | 19 | High importance + very high recency + broad "work" topic proximity |
| eval-e051 | 13 | Very recent (3h ago), "standup fraud velocity QA" — moderate broad relevance |
| eval-e021 | 12 | Recent (3 days ago), "Deepa loyalty points schema review" |
| eval-e001 | 12 | Recent (4 days ago), "fraud detection architecture velocity attack rule" |
| eval-e050 | 12 | Recent (1 day ago), "sprint ends September 5 demo" |

All are high-recency, moderate-importance Qdrant memories that score well across queries because `recency * 0.10 + importance * 0.20` provides a floor score independent of query relevance.

---

## 4. Root Cause 3 — Postgres Returns High-Importance Memories Regardless of Query Relevance (20% of FPs)

**Impact: 51 factual FPs, concentrated in Q34–Q40.**

### Mechanism

When the Postgres `findRelevant()` query runs (with `userId = eval-user-001`), the SQL is:

```sql
SELECT ... FROM factual_memories
WHERE session_id = $sessionId OR user_id = $userId
ORDER BY (metadata->>'importance')::float DESC, updated_at DESC
LIMIT 32
```

**There is no query-relevance pre-filter.** The top 32 memories by importance are fetched first, then a client-side `passes` filter is applied:

```js
const passes = lexicalScore > 0 || Number(memory.metadata?.importance || 0) >= 0.65;
```

Because the importance threshold is 0.65 and most seeded memories have importance ≥ 0.70, **nearly all 32 candidates pass**. This floods the candidate pool with high-importance memories from unrelated topics.

### Example: Q35 "What is my career progression and promotion status?"

Expected: eval-f003, eval-e008, eval-e019, eval-f038 (career/promotion memories)

Fetched: eval-f058, eval-f021, eval-f022, eval-f024, eval-f023, eval-f050, eval-f052, eval-f001

All FP factuals are high-importance memories about payment infrastructure (eval-f021: payment gateway SDK; eval-f023: PostgreSQL/Redis stack; eval-f024: JWT auth). They have importance=0.85–0.92 and were the top-ranked by importance in the Postgres query. None are relevant to career progression.

The same ~7 sticky factuals (eval-f058, eval-f021, eval-f022, eval-f024, eval-f023, eval-f050, eval-f052) appear repeatedly across Q34–Q40 because they are always the highest-importance memories and the Postgres query has no query-relevance gate.

---

## 5. Root Cause 4 — topK=8 Hard Cap Creates a Structural Precision Ceiling

**Impact: Structural. Maximum achievable precision for 3-expected-item queries is 37.5%. For 5-expected-item queries it is 62.5%.**

### Mechanism

`readRetrievalConfig().topK = 8`. The `rankMemories()` function in `memoryRanker.js` slices to this limit unconditionally. Because root causes 1–3 flood the candidate list with low-quality entries, the 8 slots are largely occupied by irrelevant memories before relevant ones get a chance.

For 25 of the 40 queries, the maximum theoretically achievable precision (if ALL fetched memories were TP) is ≤ 37.5%. The topK cap is not itself a bug, but it means no amount of reranking can recover precision for queries where the candidate pool is already dominated by noise.

---

## 6. Root Cause 5 — Episodic FNs: Qdrant Missed 13 Expected Memories (18% of FNs)

**Impact: 13 episodic/semantic FNs across 15 query slots.**

These are cases where Qdrant did have the relevant memory embedded, but it was displaced from the top-8 by higher-scoring but irrelevant memories. Key examples:

**Q15** ("What production incidents have we had recently?"): eval-e016 ("race condition in webhook dedup causing double-processed payments") was a FN. The memory is seeded ~11 days ago (moderate recency) and the specific phrase "race condition" may not have been close enough in embedding space to "production incidents."

**Q19** ("What is the update from my 1:1 with my manager?"): eval-e019 ("annual review 4.2/5; qualifies for 15% salary increment") was a FN. eval-e008 (the other 1:1 memory) was a TP, suggesting eval-e019 scored below the topK=8 cutoff.

**Q36** ("What do I know about quantum computing?"): eval-s006 was expected and missed entirely, while the system returned 8 Postgres factual memories about payment infrastructure. This is the most striking case — the one query specifically about noise-category knowledge, and the system returned zero relevant results. The session was `eval-session-noise` which has no Postgres factual memories seeded for that userId's noise session, so the fallback was the globally-high-importance Postgres memories.

---

## 7. Representative Examples

### Example A — Total Recall Failure (Q01)

```
QUERY: "What is my name and where do I live?"
SESSION: eval-session-personal

EXPECTED:
  eval-f001 — "My name is Arjun Mehta and I am 32 years old."
  eval-f002 — "I live in Bengaluru, India, in the Koramangala neighbourhood."

FETCHED:
  eval-e008 — "1:1 with manager Anjali; on track for staff engineer promotion."
  eval-e033 — "Ran half-marathon yesterday in 2:08 as training milestone."
  eval-e037 — "Father's 65th birthday: November 3. Planning surprise family trip."
  eval-e036 — "Wedding anniversary: March 12. Married 4 years."

TP: []   FP: 4   FN: 2
Precision: 0%   Recall: 0%

ROOT CAUSE: eval-f001 scored ≈0.280 (vectorScore=0, 1 keyword match).
eval-e008 scored ≈0.487 (vectorScore≈0.45, high recency). 
Qdrant's 40% vector weight advantage makes the factual answer invisible.
```

---

### Example B — Partial Success with Noise (Q07)

```
QUERY: "What is the fraud detection service and how does it work?"
SESSION: eval-session-projects

EXPECTED:
  eval-f026 — "User owns fraud detection microservice (rule-based engine)."
  eval-f030 — "Fraud detection service handles ~50K transactions/day."
  eval-s002 — "Rule-only fraud detection has high false positives; ML improves accuracy."
  eval-f054 — "Goal: migrate fraud detection rules to OPA policy-as-code."

FETCHED:
  eval-e051 — "Stand-up: velocity attack fraud rule is ready for QA."  ← FP
  eval-e001 — "Discussed fraud detection architecture; velocity attack rule."  ← FP
  eval-s002 — "Rule-only fraud detection..." ✓ TP
  eval-e034 — "Completed on-call rotation setup via PagerDuty."  ← FP
  eval-e045 — "Q3 ends September 30..."  ← FP
  eval-e041 — "PCI-DSS audit November 10-12."  ← FP
  eval-s001 — "Payment systems need strong consistency..."  ← FP
  eval-s004 — "DB connection pooling prevents connection storms."  ← FP

TP: eval-s002   FP: 7   FN: eval-f026, eval-f030, eval-f054
Precision: 12%   Recall: 25%

ROOT CAUSE: eval-s002 (Qdrant semantic) correctly found. eval-f026, eval-f030, 
eval-f054 (Postgres factual) likely scored ≈0.35 but 7 other Qdrant memories 
scored higher due to vector weight advantage. eval-e051 and eval-e001 are 
partially relevant (mention fraud/velocity) but are episodic history records, 
not the authoritative factual descriptions that were expected.
```

---

### Example C — Importance Flood (Q35)

```
QUERY: "What is my career progression and promotion status?"
SESSION: eval-session-history

EXPECTED:
  eval-f003 — "User is senior software engineer at PaySwift."
  eval-e008 — "1:1 with Anjali; on track for staff engineer promotion."
  eval-e019 — "Annual review 4.2/5; qualifies for 15% salary increment."
  eval-f038 — "User leads a team of 5 engineers at PaySwift."

FETCHED:
  eval-f058 — "Just approved BNPL refund flow PR for merge."  ← FP (imp=0.80)
  eval-f021 — "Building PaySwift payment gateway checkout SDK."  ← FP (imp=0.88)
  eval-f022 — "Checkout SDK: TypeScript, React, Vue."  ← FP (imp=0.82)
  eval-f024 — "JWT auth with 15-minute access token TTL."  ← FP (imp=0.87)
  eval-f023 — "PostgreSQL + Redis stack."  ← FP (imp=0.85)
  eval-f050 — "Task: set up on-call rotation."  ← FP (imp=0.84)
  eval-f052 — "Plan: add structured logging with correlation IDs."  ← FP (imp=0.79)
  eval-f001 — "Name is Arjun Mehta, age 32."  ← FP (imp=0.95)

TP: []   FP: 8   FN: all 4

ROOT CAUSE: Postgres ORDER BY importance DESC returned the top 8 high-importance
factual memories without any query-relevance filter. None of them match 
"career progression." The session-based Qdrant retrieval for eval-session-history
did not run (or was outscored), so eval-e008 and eval-e019 were not included.
```

---

### Example D — Best Case (Q25)

```
QUERY: "What important events or deadlines do I have coming up in November?"
SESSION: eval-session-events

EXPECTED:
  eval-e037 — "Father's 65th birthday: November 3."
  eval-e044 — "Bengaluru marathon: November 17, bib #4523."
  eval-e041 — "PCI-DSS audit: November 10-12. Documentation due November 1."

FETCHED:
  eval-e008 — "1:1 with manager..."  ← FP (cross-session)
  eval-e037 — "Father's 65th birthday: November 3." ✓ TP
  eval-e050 — "Sprint ends September 5."  ← FP (date/deadline proximity)
  eval-e047 — "Megha joins October 1."  ← FP (upcoming event)
  eval-e041 — "PCI-DSS audit November 10-12." ✓ TP
  eval-e046 — "Dentist appointment September 10."  ← FP (event)
  eval-e045 — "Q3 ends September 30."  ← FP (deadline)
  eval-e044 — "Bengaluru marathon November 17." ✓ TP

TP: 3   FP: 5   FN: 0
Precision: 38%   Recall: 100%   F1: 55%

ROOT CAUSE of FPs: Qdrant's vector search for "upcoming events deadlines" 
matched nearby temporal memories (September/October events). These are 
semantically adjacent but specifically not November. No temporal filtering 
exists in the retrieval pipeline.
```

---

## 8. Is the Ground Truth Reasonable?

Yes, with one exception.

**Q36** ("What do I know about quantum computing?") expected `eval-s006` (the seeded noise memory about quantum computing). The system returned 8 Postgres factual payment memories. `eval-s006` is a Qdrant semantic memory seeded in `eval-session-noise`. The query was run against `eval-session-noise` and `eval-user-001`. Qdrant's search (no session filter) should have found `eval-s006` if the embedding was close. Its absence from FETCHED suggests the cosine similarity between "What do I know about quantum computing" and "Quantum computing leverages superposition and entanglement" was below the `score > 0.05` filter, or it was outranked by the Postgres importance-based flood (eval-f058 et al. scored ~0.3+ on importance alone). This is a genuine system failure, not a GT error.

All other expected memory sets are directly justified by memory content and represent information a competent assistant would need to answer the query.

---

## 9. Root Causes Ranked by Impact

| # | Root Cause | FP/FN impact | Queries affected |
|---|------------|-------------|-----------------|
| 1 | **Factual memories have no vector embeddings** — `vectorScore=0` means they can never win against Qdrant memories for semantic queries | 59 FNs (80% of all misses) | 24 queries with 0 factual TP |
| 2 | **Qdrant searches entire collection (no session filter)** — `strictSession=false` allows all 70 memories to compete for every query | ~150 FPs (est., primarily eval-e008 cluster) | 40 queries (all) |
| 3 | **Postgres pre-fetches by importance with no relevance gate** — SQL `ORDER BY importance DESC` returns top-32 regardless of query; importance ≥ 0.65 passes filter | 51 FPs (20% of noise) | Q34–Q40 + others |
| 4 | **topK=8 structural cap** — limits max precision; no room for all expected memories when slots filled by noise | Multiplies impact of 1–3 | All queries |
| 5 | **High recency of recently-seeded memories boosts irrelevant episodic results** — eval-e008 (seeded 3h ago) has recency≈0.95, adding ~0.095 to its score floor | Amplifies RC2 | 20 queries |
| 6 | **Qdrant FNs: topK competition displaces lower-scoring relevant memories** | 13 FNs (18% of misses) | 9 queries |

---

## 10. Recommended Fixes

### Fix 1 — Embed factual memories (addresses RC1, highest impact)

At upsert time in `factualMemoryStore.upsert()`, compute an embedding via `openAIAdapter.embedText()` and store it in Qdrant alongside the Postgres row. During retrieval, include factual memories in the Qdrant vector search. This gives factual memories a non-zero `vectorScore` and makes them competitive for semantic queries.

Alternative (simpler): store the embedding in the Postgres `embedding` column (already exists in the schema) and query it using `pgvector` extension with approximate nearest-neighbour search.

### Fix 2 — Apply session/user scope to Qdrant search (addresses RC2)

Change `queryQdrantPoints()` default to filter by `userId` rather than no filter:

```js
// Current: no filter (searches entire collection)
// Proposed: filter to this user's memories
body.filter = userId
  ? { must: [{ key: "userId", match: { value: userId } }] }
  : { must: [{ key: "sessionId", match: { value: sessionId } }] };
```

This requires `userId` to be indexed in Qdrant (it already exists in the payload — just add a keyword index). The cross-session personal memories (names, preferences) would still be retrieved because they all belong to the same `userId`.

### Fix 3 — Add query-relevance pre-filter to Postgres (addresses RC3)

Replace the pure importance-ordering with FTS-first ordering:

```sql
SELECT ...
FROM factual_memories
WHERE (session_id = $sessionId OR user_id = $userId)
  AND (
    ts_rank_cd(search_vector, plainto_tsquery('english', $query)) > 0
    OR (metadata->>'importance')::float >= 0.80  -- only highest importance bypass FTS
  )
ORDER BY ts_rank_cd(search_vector, plainto_tsquery('english', $query)) DESC,
         (metadata->>'importance')::float DESC
LIMIT 32
```

This ensures Postgres only returns factual memories that either match the query lexically OR have very high importance (stricter threshold than the current 0.65).

### Fix 4 — Enable topical relevance penalty (addresses RC2 + RC5)

The codebase already has `RETRIEVAL_TOPICAL_PENALTY_ENABLED=false`. Enable it:

```env
RETRIEVAL_TOPICAL_PENALTY_ENABLED=true
RETRIEVAL_TOPICAL_PENALTY_LOW_THRESHOLD=0.08
RETRIEVAL_TOPICAL_PENALTY_HIGH_THRESHOLD=0.20
RETRIEVAL_TOPICAL_PENALTY_LOW_FACTOR=0.20
RETRIEVAL_TOPICAL_PENALTY_MEDIUM_FACTOR=0.50
```

Memories with near-zero vector AND keyword scores (like eval-e008 appearing in a "name/location" query) would have their final score multiplied by 0.20, dropping them below the relevant factual memories.

### Fix 5 — Recency weight for seeded data (addresses RC5)

The evaluation seeded recent memories (eval-e051 at 3h, eval-e008 at 3h) which receive a recency bonus of ~0.095 on top of their importance. For production, this is correct behaviour. For the evaluation, the recency of seeded memories creates an artificial bias. The eval script could normalise all seeded memories to the same timestamp to isolate scoring factors — this would not improve production performance but would make future evaluations more controlled.

---

## 11. Limitations of the Current Evaluation

1. **No retrieval scores captured.** The evaluation runner records FETCHED IDs but not the actual `_hybrid.finalScore` values per memory per query. Without those scores, the exact ranking position of expected memories (were they #9, #20, or never fetched at all?) cannot be determined. Future runs should log scores.

2. **Single-user evaluation.** All 40 queries use `eval-user-001`. Different users with different memory corpus compositions may behave differently.

3. **Artificial recency distribution.** Seeded memories were created at specific past timestamps. Some categories are very recent (hours ago, high recency score), others very old (months ago, lower recency). Real users have memories distributed naturally.

4. **No ground-truth scores from Qdrant.** The evaluation cannot confirm the actual cosine similarity that Qdrant returned for each memory because the evaluation script does not instrument the retrieval pipeline for score capture. The score estimates in this analysis are computed analytically, not measured.

5. **topK=8 means recall is structurally bounded.** Five queries expect 4–5 relevant memories. Even a perfect retriever would be limited to 62.5% precision on these queries.

6. **Neo4j returned no useful results.** All Neo4j queries failed with `Invalid input '4.0' is not a valid value... FLOAT` (pre-existing production bug). The graph score component contributed 0 for all queries. This means the 10% graph weight was wasted and the other weights effectively operated at 90% budget — slightly inflating vector and keyword contributions.

---

## 12. Verification

All findings above were derived from:

- `reports/context-retrieval-raw-results.json` — actual FETCHED IDs from 40 live retrieval calls
- `apps/api/src/infrastructure/postgres/factual-memory-store.js` — confirmed `vectorScore: 0` hardcoded
- `apps/api/src/infrastructure/qdrant/qdrant-client.js` — confirmed `strictSession = false` default
- `packages/core/src/memory/retrieval/retrievalTypes.js` — confirmed weights (vector=0.40, keyword=0.20, importance=0.20, recency=0.10, graph=0.10)
- `packages/core/src/memory/retrieval/memoryRanker.js` — confirmed topK=8 hard cut
- `tools/eval-ground-truth.js` — ground truth defined independently before retrieval

No production code was modified. No ground truth was changed. No metrics were adjusted.

---

**ROOT CAUSE ANALYSIS: COMPLETE**
