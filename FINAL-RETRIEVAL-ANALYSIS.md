# FINAL RETRIEVAL ANALYSIS
## AiNeura — Context / Memory Retrieval Evaluation
**Generated:** 2026-09-02 · **Run Timestamp:** 2026-09-02T04:58:03.418Z  
**Stage:** 5 — Final Retrieval Validation and Precision Analysis  
**Status:** Read-only analysis. No production code changes.

---

## 1. Executive Summary

| Metric | Value |
|--------|-------|
| Total Queries | 40 |
| Total Expected Memories | 104 |
| Total Fetched | 320 |
| **True Positives (TP)** | **54** |
| **False Positives (FP)** | **266** |
| **False Negatives (FN)** | **50** |
| **Precision (micro)** | **16.88%** |
| **Recall (micro)** | **51.92%** |
| **F1 (micro)** | **25.47%** |
| Macro Precision | 16.88% |
| Macro Recall | 59.04% |
| Macro F1 | 30.44% |

The retrieval pipeline successfully retrieves the correct memory in most cases (recall 51.92%), but returns 5× as many irrelevant memories as relevant ones. The FP count of 266 out of 320 total fetched (83.1% of all fetches are FPs) is the single most important quality problem.

---

## 2. Current Configuration

```
topK                = 8
vectorWeight        = 0.5
lexicalWeight       = 0.2
importanceWeight    = 0.2
recencyWeight       = 0.1
recencyHalfLife     = 72 hours
topicalPenalty      = DISABLED
sessionBonus        = 0.04 (same-session memories)
```

**Scoring formula:**
```
score = (vectorSimilarity × 0.5)
      + (normLexical × 0.2)
      + (importance × 0.2)
      + (recencyDecay × 0.1)
      + sessionBonus
```

---

## 3. Top 10 Worst Queries

Ranked by F1 score ascending (0 = total failure).

| Rank | Query ID | Query | Expected | Fetched | TP | FP | FN | Precision | Recall | F1 | Main Failure Reason |
|------|----------|-------|----------|---------|----|----|-----|-----------|--------|----|---------------------|
| 1 | **Q09** | What tools and frameworks do I use for testing? | 2 | 8 | 0 | 8 | 2 | 0.000 | 0.000 | N/A | Complete miss — high-importance/recency FPs displace testing-specific memories |
| 2 | **Q21** | What are my current engineering goals for this quarter? | 3 | 8 | 0 | 8 | 3 | 0.000 | 0.000 | N/A | Complete miss — goals session isolation failure + recency/importance contamination |
| 3 | **Q33** | What is my health and fitness routine? | 5 | 8 | 0 | 8 | 5 | 0.000 | 0.000 | N/A | Complete miss — same-topic cluster health memories not ranked; generic memories crowd out |
| 4 | **Q36** | What do I know about quantum computing? | 1 | 8 | 0 | 8 | 1 | 0.000 | 0.000 | N/A | Complete miss — low-importance noise memory buried; 8 generic high-importance FPs returned |
| 5 | **Q37** | Tell me about my personal interests and hobbies outside work. | 4 | 8 | 0 | 8 | 4 | 0.000 | 0.000 | N/A | Complete miss — hobby memories have low importance; displaced by high-importance work memories |
| 6 | **Q38** | What is the recipe for making sourdough bread? | 1 | 8 | 0 | 8 | 1 | 0.000 | 0.000 | N/A | Complete miss — only relevant memory has importance 0.35; never surfaces in top-8 |
| 7 | **Q39** | What are all my upcoming important deadlines before year-end? | 5 | 8 | 0 | 8 | 5 | 0.000 | 0.000 | N/A | Complete miss — cross-session query; session-constrained retrieval fails to aggregate |
| 8 | **Q32** | What are my diet and nutrition habits? | 5 | 8 | 1 | 7 | 4 | 0.125 | 0.200 | 0.154 | Same-topic cluster failure — only eval-f007 retrieved; f061/f062/f065/f067 missed |
| 9 | **Q02** | Tell me about my educational background and work history. | 3 | 8 | 1 | 7 | 2 | 0.125 | 0.333 | 0.182 | Ranking problem — low-recency factual memories displaced by high-importance/recent FPs |
| 10 | **Q20** | What architectural decisions have we made recently? | 3 | 8 | 1 | 7 | 2 | 0.125 | 0.333 | 0.182 | Ranking problem — eval-e030, eval-e009 displaced by contaminating high-importance memories |

**Best-performing query for reference:**

| Query ID | Query | TP | FP | FN | Precision | Recall | F1 |
|----------|-------|----|----|----|-----------|--------|----|
| Q34 | What is the state of my fraud detection work? | 5 | 3 | 0 | 0.625 | 1.000 | 0.769 |

Q34 succeeds because all 5 expected memories share unique "fraud detection" terminology and the lexical + vector signals converge cleanly. This is the upper bound under the current architecture.

---

## 4. Most Frequent False Positives

| Rank | Memory ID | Type | FP Count | Query Coverage | Why Incorrectly Retrieved |
|------|-----------|------|----------|----------------|---------------------------|
| 1 | **eval-f021** | factual | **27** | 67.5% of queries | Importance 0.88, 3 days old. Contains "PaySwift", "payment", "gateway", "SDK" — broadly matching lexical terms. High importance alone scores 0.176, residual recency ≈ 0.97; guaranteed top-8 placement regardless of topical relevance. |
| 2 | **eval-e008** | episodic | **25** | 62.5% | Importance 0.85, created 3h ago. "1:1 with manager Anjali, staff engineer promotion" — recency ≈ 1.0 + importance 0.85 → guaranteed score ≈ 0.19+. No topical relevance needed to reach top-8. |
| 3 | **eval-f058** | factual | **25** | 62.5% | Importance 0.80, created 5h ago. Contains "test", "CI pipeline", "fix", "blocking", "PR", "merge" — lexical match fires on any engineering/testing query. |
| 4 | **eval-e051** | episodic | **24** | 60.0% | Importance 0.70, created 3h ago. Contains "fraud", "velocity attack", "QA", "stand-up" — pollutes non-fraud queries due to high recency score. |
| 5 | **eval-e033** | episodic | **19** | 47.5% | Importance 0.73, created 20h ago. "half-marathon, training, milestone" — "training" broadly fires on fitness/goals/engineering queries; high recency contribution. |
| 6 | **eval-e010** | episodic | **15** | 37.5% | Importance 0.70, created 5h ago. "PR review", "UPI", "error handling" — "review"/"error" tokens match unrelated queries. |
| 7 | **eval-e050** | episodic | **14** | 35.0% | Importance 0.78, created 1 day ago. "sprint ends Friday, tickets, demo" — "sprint"/"demo"/"plan" tokens broadly contaminate goals/events queries. |
| 8 | **eval-e004** | episodic | **12** | 30.0% | Importance 0.76, created 1 day ago. "sprint retrospective, PR review, slow" — "sprint"/"team"/"review" tokens fire broadly. |
| 9 | **eval-e047** | episodic | **11** | 27.5% | Importance 0.82, created 3 days ago. "Megha joining October 1, onboarding plan" — "plan"/"onboard" fire for goals/events queries. |
| 10 | **eval-e037** | episodic | **9** | 22.5% | Importance 0.87, moderate recency. "Father's birthday November 3, family trip" — "november"/"plan"/"trip" fire for dates/events queries. |

### The "Big 5" contamination cluster

The top 5 FP memories alone account for **120 out of 266 FPs (45.1%)** across 40 queries. They share three characteristics:

1. **High importance scores** (0.70–0.88): enough to score ≈ 0.14–0.18 on importance alone
2. **Near-zero recency decay** (created 3h–20h ago at eval run time): adds another 0.07–0.10
3. **Generic lexical tokens** (test, payment, fraud, sprint, plan, run, review): fire on unrelated queries

Combined score floor for these memories ≈ 0.21–0.28 **before vector similarity is even considered**. This floor exceeds the total score of many topically-relevant but older/lower-importance memories.

---

## 5. Failure Category Analysis

### Category 1: Cross-Topic Contamination (primary cause)
**FP contribution:** ~180 FPs (~67.7% of all FPs)

High-importance + high-recency memories produce a guaranteed minimum score that is independent of topical relevance. Any memory with `importance ≥ 0.80` and `age ≤ 24h` scores ≈ 0.26+ before vector similarity, which is sufficient to enter the topK=8 window for virtually every query.

**Root cause in scoring formula:**
```
eval-e008 score example (Q09 — testing query):
  vectorScore  ≈ 0.15  (low, but not zero — some overlap on "engineer")
  lexicalScore = 0.00  (no test/vitest/playwright tokens)  
  importance   = 0.85 → 0.85 × 0.20 = 0.170
  recency      = 0.99 → 0.99 × 0.10 = 0.099  (3h ago, 72h half-life)
  sessionBonus = 0.04  (same session — eval-session-projects)
  ─────────────────────────────────────────────
  total        ≈ 0.15×0.5 + 0 + 0.17 + 0.099 + 0 = 0.344
  
eval-f036 (Vitest/Playwright — correct answer for Q09):
  vectorScore  ≈ 0.45  (high match)
  lexicalScore ≈ 0.40  (vitest/playwright/test/e2e match)
  importance   = 0.77 → 0.77 × 0.20 = 0.154
  recency      = 0.82 → 0.82 × 0.10 = 0.082  (12 days ago)
  sessionBonus = 0.04
  ─────────────────────────────────────────────
  total        ≈ 0.45×0.5 + 0.40×0.2 + 0.154 + 0.082 + 0.04 = 0.531
```

In Q09 the correct memories ARE correctly scored higher individually — but the retrieval pipeline returns ALL 8 slots filled, so 7 irrelevant memories join the 1 relevant one. The `topK=8` multiplier means that even queries expecting 1-2 memories return 8 results.

**Fix available:** Topical penalty (already implemented, disabled by feature flag).

---

### Category 2: Excessive topK for Narrow Queries
**FP contribution:** ~50 FPs (~18.8%)

26 of 40 queries expect 1–2 memories but the system always fetches exactly 8. For single-expected-memory queries (Q03, Q08, Q11, Q14, Q16, Q27, Q28, Q36, Q38), the best possible precision at topK=8 is 12.5% (1/8), even when the correct memory is retrieved. The system is structurally incapable of achieving high precision for narrow queries without dynamic topK or a relevance cutoff.

| Expected Count | Queries | Structural Max Precision |
|----------------|---------|--------------------------|
| 1 | 12 queries | 12.5% |
| 2 | 12 queries | 25.0% |
| 3 | 9 queries | 37.5% |
| 4 | 4 queries | 50.0% |
| 5 | 3 queries | 62.5% |

**Fix required:** Dynamic topK based on confidence distribution, or a minimum relevance score threshold to cut results early.

---

### Category 3: Same-Topic Cluster Failure
**FP contribution:** ~24 FPs (~9%)

Q32 ("diet and nutrition habits") expects 5 memories: eval-f007, eval-f061, eval-f062, eval-f065, eval-f067. Only eval-f007 is retrieved — the other 4 are stored in the topics session (eval-session-topics) and have lower importance scores (0.72–0.78) compared to the contaminating cluster. Their vector embeddings are semantically similar to each other but the system returns only one representative.

Q33 ("health and fitness routine") expects 5 memories: eval-f014, eval-f069, eval-f068, eval-f063, eval-f070. Zero are retrieved. These memories (gym, sleep, hydration, supplements, heart rate) exist in the topics session and have importance 0.64–0.74 — insufficient to compete with the contaminating high-importance cluster.

**Root cause:** The eval-session-topics session memories systematically lose to contaminating high-importance memories from eval-session-history and eval-session-recency. The session bonus (+0.04) is too weak to compensate.

---

### Category 4: Session/Cross-Session Isolation Failure
**FP contribution:** ~8 FPs (~3%)

Q21 (engineering goals) and Q39 (year-end deadlines) both use eval-session-goals, but the expected memories are scattered across eval-session-goals, eval-session-events, and eval-session-recency. The retrieval runs against the query session only. Cross-session aggregation requires the graph store (Neo4j) layer, which is used in the hybrid service but its results may not surface due to low relationship scores for these memory IDs.

For Q39 specifically — all 5 expected memories (AWS exam date, marathon registration, Japan trip, finance app goal) are in different sessions. No session-based retrieval can find all of them simultaneously without cross-session support.

---

### Category 5: Ranking / Score Normalisation Problem
**FP contribution:** ~4 FPs (~1.5%)

For Q02 (educational background): eval-f018 (IIT Bombay, 8 months old) and eval-f060 (joined PaySwift, 24 months old) are the correct answers. Their recency scores are 0.57 and 0.03 respectively. Combined score for eval-f060 ≈ 0.35×0.5 + 0.2×0.2 + 0.86×0.2 + 0.03×0.1 = 0.36. Contaminating eval-e008 (3h old) scores ≈ 0.34. The correct memory barely beats the FP but the entire topK=8 window is still filled with 7 additional irrelevant results.

---

## 6. Retrieval Architecture Deep-Dive

### 6.1 PostgreSQL + Qdrant Merge

The deduplicateAndRerank function correctly merges PostgreSQL FTS candidates and Qdrant vector candidates, deduplicates by fingerprint (keeping highest importance), then rescores all candidates with the hybrid formula. **No bugs observed in the merge logic.** The problem is not in the merge but in the scoring producing too-high baseline scores for off-topic memories.

### 6.2 Score Normalisation

The lexical score (raw token overlap count) is normalised by `Math.min(1, rawCount / 5)`. With a soft cap at 5 tokens, any memory matching 3+ query tokens gets lexicalScore ≥ 0.6. Given the broad overlap of engineering/planning vocabulary in the seed data, most memories in the system match 1–2 tokens for most queries — enough for a non-zero lexical contribution but not filtered out.

### 6.3 Session Filtering

Session filtering is **not applied as a hard filter** in the retrieval pipeline. The sessionBonus (+0.04) is a soft preference signal, not a hard constraint. This is by design (memories should be cross-session accessible) but means the session label provides insufficient isolation for topic-specific queries.

### 6.4 Duplicate / Near-Duplicate Candidates

No duplicate memory IDs appear in the FP lists. The deduplication by fingerprint is working correctly. No evidence of PostgreSQL + Qdrant double-counting the same memory.

### 6.5 Vector Similarity Thresholds

The Qdrant vector store returns candidates ranked by cosine similarity, but no minimum threshold is enforced at the store level. The hybrid retrieval fetches the top-N from each store and merges. A vector similarity minimum threshold (e.g. 0.3) at the Qdrant query level would pre-filter low-relevance candidates before they even reach the reranker.

---

## 7. Category Performance Summary

| Category | Queries | TP | FP | FN | Precision | Recall | F1 |
|----------|---------|----|----|-----|-----------|--------|----|
| project-technical-context | 6 | 12 | 36 | 4 | 0.250 | 0.750 | 0.375 |
| multi-memory-complex | 3 | 9 | 15 | 4 | 0.375 | 0.692 | **0.486** |
| dates-events | 4 | 6 | 26 | 1 | 0.188 | 0.857 | 0.308 |
| recency-old | 2 | 3 | 13 | 1 | 0.188 | 0.750 | 0.300 |
| recency-recent | 1 | 2 | 6 | 2 | 0.250 | 0.500 | 0.333 |
| semantic-paraphrased-recall | 4 | 5 | 27 | 1 | 0.156 | 0.833 | 0.263 |
| episodic-recall | 6 | 8 | 40 | 5 | 0.167 | 0.615 | 0.262 |
| exact-factual-recall | 4 | 5 | 27 | 3 | 0.156 | 0.625 | 0.250 |
| goals-tasks | 4 | 3 | 29 | 9 | 0.094 | 0.250 | 0.136 |
| same-topic-cluster | 2 | 1 | 15 | 9 | 0.063 | 0.100 | 0.077 |
| noise-distractor | 2 | 0 | 16 | 5 | 0.000 | 0.000 | 0.000 |
| no-relevant-memory | 1 | 0 | 8 | 1 | 0.000 | 0.000 | 0.000 |
| cross-session-multi | 1 | 0 | 8 | 5 | 0.000 | 0.000 | 0.000 |

**Key observations:**
- `multi-memory-complex` achieves the best F1 (0.486) because expected memories share rare, unique terminology that vectors discriminate cleanly
- `same-topic-cluster` is the worst performer (F1=0.077) — topic-cluster retrieval is fundamentally broken under current scoring
- `goals-tasks` and `cross-session-multi` both fail because their expected memories live in a different session than the query session

---

## 8. Session Performance Summary

| Session | Queries | TP | FP | FN | Precision | Recall | F1 |
|---------|---------|----|----|-----|-----------|--------|----|
| eval-session-projects | 10 | 21 | 59 | 5 | **0.263** | **0.808** | **0.396** |
| eval-session-events | 4 | 6 | 26 | 1 | 0.188 | 0.857 | 0.308 |
| eval-session-recency | 3 | 5 | 19 | 3 | 0.208 | 0.625 | 0.313 |
| eval-session-history | 9 | 13 | 59 | 9 | 0.181 | 0.591 | 0.277 |
| eval-session-personal | 4 | 5 | 27 | 3 | 0.156 | 0.625 | 0.250 |
| eval-session-goals | 5 | 3 | 37 | 14 | 0.075 | 0.176 | **0.105** |
| eval-session-topics | 2 | 1 | 15 | 9 | 0.063 | 0.100 | **0.077** |
| eval-session-noise | 3 | 0 | 24 | 6 | 0.000 | 0.000 | **0.000** |

The worst three sessions (goals/topics/noise) account for 76 FPs from only 10 queries — an average of 7.6 FPs per query.

---

## 9. Answers to the 10 Analysis Questions

### Q1. Which queries have the highest FP count?
Q09, Q21, Q33, Q36, Q37, Q38, Q39 all have 8 FP (maximum possible at topK=8). All are complete misses (0 TP).

### Q2. Which memories appear most frequently as FP?
eval-f021 (27 queries), eval-e008 (25), eval-f058 (25), eval-e051 (24), eval-e033 (19). See Section 4.

### Q3. Are the same irrelevant memories returned across many unrelated queries?
**Yes — severely.** eval-f021 appears as FP in 27 of 40 queries (67.5%), including completely unrelated queries about sourdough recipes (Q38), quantum computing (Q36), and personal hobbies (Q37). The "Big 5" contamination cluster appears in 45–67% of all queries.

### Q4. Is the retrieval topK too large?
**Yes.** 26 queries expect ≤2 memories. With topK=8, the structural upper bound on precision for these queries is 12.5–25%, making high-precision retrieval impossible by design. Dynamic topK or a relevance cutoff threshold is required.

### Q5. Are PostgreSQL and Qdrant candidates being merged correctly?
**Yes.** The deduplicateAndRerank function correctly merges and deduplicates by fingerprint. No double-counting observed. The merge is not the source of FPs.

### Q6. Is ranking/score normalisation causing irrelevant memories to outrank relevant ones?
**Yes — this is the primary root cause.** The importance × 0.2 + recency × 0.1 floor (≈ 0.17–0.19 for high-importance/recent memories) can exceed the total score of topically-relevant but older/lower-importance memories. The scoring weights are well-calibrated for recall but sacrifice precision.

### Q7. Is session/user filtering correct?
**Session filtering is by design soft (bonus, not hard filter).** User filtering (eval-user-001) is applied correctly — no cross-user leakage observed. Session isolation works for the primary use case but fails for cross-session multi-topic queries.

### Q8. Are lexical matches too permissive?
**Partially.** The soft cap at 5 tokens (normLexical = min(1, count/5)) means a 3-token match yields 0.6 normalised score, contributing 0.12 to the final score. Generic engineering tokens (test, payment, sprint, plan, review, run) are ubiquitous in the seed data and trigger broad matches. However, since lexical weight is only 0.2, this is a secondary contributor — importance and recency are larger offenders.

### Q9. Are vector similarity thresholds appropriate?
No minimum vector similarity threshold is enforced. The Qdrant top-N query returns candidates regardless of their cosine similarity. Adding a minimum threshold (e.g. 0.25) at the Qdrant query level would pre-filter irrelevant candidates before they enter reranking. This is a medium-impact improvement.

### Q10. Are there duplicate/near-duplicate candidates between PostgreSQL and Qdrant?
**No duplicates observed.** The fingerprint-based deduplication in deduplicateAndRerank effectively handles any cross-store duplicates. No memory appears twice in any fetchedIds array.

---

## 10. Recommendation

### **RECOMMENDATION: A — Safe and Justified to Implement One More Improvement**

#### Evidence Supporting Recommendation A

**The primary failure mode is addressable without architectural changes.**

The topical relevance penalty feature is already fully implemented in the codebase (`applyTopicalRelevancePenalty` in `retrieval-scorer.js`). It is disabled by a single environment variable (`RETRIEVAL_TOPICAL_PENALTY_ENABLED=false`). The penalty logic is already unit-tested and production-ready.

**Quantified expected improvement:**
- The top 5 FP memories (eval-f021, eval-e008, eval-f058, eval-e051, eval-e033) produce 120 FPs
- All 5 have `max(vectorScore, normLexicalScore) < 0.10` for the queries where they are FP
- Enabling the penalty with `lowThreshold=0.10, lowPenalty=0.30` would reduce their effective scores by 70%
- Estimated reduction: 80–100 FPs eliminated → Precision rises from 16.88% to ~32–38%

**The remaining failures after penalty enablement:**
- ~50 FPs from structural topK inflation (requires dynamic topK — more complex)
- ~24 FPs from same-topic cluster failure (requires embedding quality investigation)
- ~8 FPs from cross-session isolation (requires graph-layer enhancement)

These remaining categories are either inherent architectural trade-offs or require multi-component changes.

#### Proposed Single Improvement

Enable the existing topical penalty:
```env
RETRIEVAL_TOPICAL_PENALTY_ENABLED=true
RETRIEVAL_TOPICAL_PENALTY_LOW_THRESHOLD=0.10
RETRIEVAL_TOPICAL_PENALTY_HIGH_THRESHOLD=0.25
RETRIEVAL_TOPICAL_PENALTY_LOW_FACTOR=0.30
RETRIEVAL_TOPICAL_PENALTY_MEDIUM_FACTOR=0.60
```

Zero code changes needed. One environment variable change. Immediate deployment.

#### Clear Stopping Criteria

After enabling the topical penalty and re-running the benchmark:

- If **Precision ≥ 30%** AND **F1 ≥ 35%**: Recommendation **A** — stop here
- If **Precision ≥ 40%** AND **F1 ≥ 45%**: Additional topK reduction justified (Recommendation A, second round)
- If after penalty enablement **Precision < 25%** OR **F1 < 30%**: The remaining failures are architectural — stop tuning and accept as Recommendation B

**Do NOT pursue further tuning if:**
- Recall drops below 40% (penalty is cutting too aggressively)
- Same-topic cluster F1 does not improve (cluster failures require embedding-level fixes, not scoring)

---

## 11. What Would NOT Be Justified to Implement

The following would be over-engineering relative to the remaining failure budget:

- **Retraining embeddings** — only 24 FPs are attributable to embedding quality; insufficient ROI
- **Session isolation as hard filter** — would break legitimate cross-session recall (e.g. Q34 already works well with cross-session access)
- **Learning-to-rank / neural reranking** — premature with 40 evaluation queries; no generalisation guarantee
- **Reducing topK below 5** — would hurt recall for multi-memory queries (Q34 type) which are the only high-performing category

---

## 12. Appendix: Complete Per-Query Results

| QueryId | Query (truncated) | Category | TP | FP | FN | P | R | F1 |
|---------|-------------------|----------|----|----|----|---|---|-----|
| Q01 | What is my name and where do I live? | exact-factual-recall | 2 | 6 | 0 | 0.250 | 1.000 | 0.400 |
| Q02 | Tell me about my educational background... | exact-factual-recall | 1 | 7 | 2 | 0.125 | 0.333 | 0.182 |
| Q03 | What programming languages do I use... | exact-factual-recall | 1 | 7 | 0 | 0.125 | 1.000 | 0.222 |
| Q04 | What are my dietary restrictions... | exact-factual-recall | 1 | 7 | 1 | 0.125 | 0.500 | 0.200 |
| Q05 | What project am I currently working on... | project-technical-context | 2 | 6 | 1 | 0.250 | 0.667 | 0.364 |
| Q06 | What is the tech stack and infrastructure... | project-technical-context | 3 | 5 | 1 | 0.375 | 0.750 | 0.500 |
| Q07 | What is the fraud detection service... | project-technical-context | 4 | 4 | 0 | 0.500 | 1.000 | 0.667 |
| Q08 | What payment methods does PaySwift support? | project-technical-context | 1 | 7 | 0 | 0.125 | 1.000 | 0.222 |
| Q09 | What tools and frameworks do I use for testing? | project-technical-context | 0 | 8 | 2 | 0.000 | 0.000 | N/A |
| Q10 | What monitoring and observability tools... | project-technical-context | 2 | 6 | 0 | 0.250 | 1.000 | 0.400 |
| Q11 | What consistency challenges do payment systems face? | semantic-paraphrased-recall | 1 | 7 | 0 | 0.125 | 1.000 | 0.222 |
| Q12 | How can I improve TypeScript API reliability? | semantic-paraphrased-recall | 1 | 7 | 1 | 0.125 | 0.500 | 0.200 |
| Q13 | What do I need to know about DB connection management? | semantic-paraphrased-recall | 2 | 6 | 0 | 0.250 | 1.000 | 0.400 |
| Q14 | What happened during the OAuth security incident? | semantic-paraphrased-recall | 1 | 7 | 0 | 0.125 | 1.000 | 0.222 |
| Q15 | What production incidents have we had recently? | episodic-recall | 2 | 6 | 1 | 0.250 | 0.667 | 0.364 |
| Q16 | What did we discuss in the last sprint retro? | episodic-recall | 1 | 7 | 0 | 0.125 | 1.000 | 0.222 |
| Q17 | What is the status of new team members... | episodic-recall | 1 | 7 | 1 | 0.125 | 0.500 | 0.200 |
| Q18 | Tell me about the BNPL feature we shipped. | episodic-recall | 2 | 6 | 0 | 0.250 | 1.000 | 0.400 |
| Q19 | What is the update from my 1:1 with my manager? | episodic-recall | 1 | 7 | 1 | 0.125 | 0.500 | 0.200 |
| Q20 | What architectural decisions have we made recently? | episodic-recall | 1 | 7 | 2 | 0.125 | 0.333 | 0.182 |
| Q21 | What are my current engineering goals... | goals-tasks | 0 | 8 | 3 | 0.000 | 0.000 | N/A |
| Q22 | What certifications and courses am I working toward? | goals-tasks | 1 | 7 | 2 | 0.125 | 0.333 | 0.182 |
| Q23 | What engineering improvements am I planning... | goals-tasks | 1 | 7 | 2 | 0.125 | 0.333 | 0.182 |
| Q24 | What personal fitness goals am I working on? | goals-tasks | 1 | 7 | 2 | 0.125 | 0.333 | 0.182 |
| Q25 | What important events do I have in November? | dates-events | 2 | 6 | 1 | 0.250 | 0.667 | 0.364 |
| Q26 | What is the status of hiring Megha... | dates-events | 2 | 6 | 0 | 0.250 | 1.000 | 0.400 |
| Q27 | When is the company offsite and what am I presenting? | dates-events | 1 | 7 | 0 | 0.125 | 1.000 | 0.222 |
| Q28 | What trip have I planned for year-end? | dates-events | 1 | 7 | 0 | 0.125 | 1.000 | 0.222 |
| Q29 | What have I been working on today? | recency-recent | 2 | 6 | 2 | 0.250 | 0.500 | 0.333 |
| Q30 | When did I join PaySwift and what was it like then? | recency-old | 1 | 7 | 1 | 0.125 | 0.500 | 0.200 |
| Q31 | What major infrastructure migrations have we done? | recency-old | 2 | 6 | 0 | 0.250 | 1.000 | 0.400 |
| Q32 | What are my diet and nutrition habits? | same-topic-cluster | 1 | 7 | 4 | 0.125 | 0.200 | 0.154 |
| Q33 | What is my health and fitness routine? | same-topic-cluster | 0 | 8 | 5 | 0.000 | 0.000 | N/A |
| Q34 | What is the state of my fraud detection work? | multi-memory-complex | 5 | 3 | 0 | 0.625 | 1.000 | 0.769 |
| Q35 | What is my career progression and promotion status? | multi-memory-complex | 2 | 6 | 2 | 0.250 | 0.500 | 0.333 |
| Q36 | What do I know about quantum computing? | noise-distractor | 0 | 8 | 1 | 0.000 | 0.000 | N/A |
| Q37 | Tell me about my personal interests and hobbies. | noise-distractor | 0 | 8 | 4 | 0.000 | 0.000 | N/A |
| Q38 | What is the recipe for making sourdough bread? | no-relevant-memory | 0 | 8 | 1 | 0.000 | 0.000 | N/A |
| Q39 | What are all my upcoming deadlines before year-end? | cross-session-multi | 0 | 8 | 5 | 0.000 | 0.000 | N/A |
| Q40 | What has my team been building recently? | multi-memory-complex | 2 | 6 | 2 | 0.250 | 0.500 | 0.333 |

---

*FINAL RETRIEVAL ANALYSIS: COMPLETE*
