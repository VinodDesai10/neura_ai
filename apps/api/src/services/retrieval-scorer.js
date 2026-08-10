/**
 * services/retrieval-scorer.js
 *
 * Pure, stateless scoring engine for the hybrid retrieval pipeline.
 *
 * Responsibilities:
 *   - applyRecencyDecay   – time-based score decay (configurable half-life)
 *   - computeHybridScore  – weighted combination of vector, lexical, importance, recency
 *   - deduplicateAndRerank – merge memory lists, deduplicate by fingerprint, rerank by score
 *
 * No database calls, no side effects. All functions are safe to unit-test in isolation.
 */

import { readRetrievalConfig } from "@neura/shared";

// ─── Recency decay ─────────────────────────────────────────────────────────────

/**
 * Compute a recency factor in [0, 1] using exponential decay.
 *
 * The score is 1.0 immediately after creation and halves every
 * `halfLifeHours`. We clamp the age at 10× the half-life so very old
 * memories never reach absolute zero — they still contribute something.
 *
 * @param {string|number|null} timestamp  – ISO string or epoch ms; null → returns 1.0
 * @param {number} halfLifeHours          – configurable; defaults to RETRIEVAL_DEFAULTS
 * @returns {number}  recency factor in (0, 1]
 */
export function applyRecencyDecay(timestamp, halfLifeHours) {
  if (!timestamp) return 1.0;

  const cfg = halfLifeHours ?? readRetrievalConfig().recencyHalfLifeHours;
  const halfLifeMs = cfg * 60 * 60 * 1000;
  const ageMs = Date.now() - (typeof timestamp === "number" ? timestamp : Date.parse(timestamp));

  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1.0;

  // Exponential decay: factor = e^(-λ·t)  where  λ = ln(2) / halfLife
  const lambda = Math.LN2 / halfLifeMs;
  // Cap age at 10 half-lives so very old memories still score > 0.001
  const cappedAge = Math.min(ageMs, halfLifeMs * 10);
  return Math.exp(-lambda * cappedAge);
}

// ─── Hybrid score ──────────────────────────────────────────────────────────────

/**
 * Compute a weighted hybrid retrieval score for a single memory.
 *
 * @param {{
 *   vectorScore:    number,   – Qdrant cosine similarity (0–1) or -1 when unavailable
 *   lexicalScore:   number,   – token-overlap count (raw, unbounded)
 *   importanceScore:number,   – stored metadata.importance (0–1)
 *   timestamp:      string|null,
 *   sessionId:      string,
 *   querySessionId: string
 * }} params
 * @param {object} [cfg]  – override readRetrievalConfig() for testing
 * @returns {{
 *   score:            number,
 *   vectorScore:      number,
 *   lexicalScore:     number,
 *   importanceScore:  number,
 *   recencyScore:     number,
 *   sessionBonus:     number
 * }}
 */
export function computeHybridScore(
  { vectorScore, lexicalScore, importanceScore, timestamp, sessionId, querySessionId },
  cfg
) {
  const config = cfg ?? readRetrievalConfig();

  // Normalise raw lexical overlap (0-N) to a 0-1 scale using a soft cap at 5 matches
  const normLexical = Math.min(1, lexicalScore / 5);
  // Clamp vector score to [0, 1] (-1 means "no embedding")
  const normVector  = Math.max(0, Math.min(1, vectorScore));
  // Importance is already 0-1
  const normImportance = Math.max(0, Math.min(1, importanceScore || 0));
  // Recency decay
  const recency = applyRecencyDecay(timestamp, config.recencyHalfLifeHours);

  // Bonus for memories from the same session (small tiebreaker)
  const sessionBonus = sessionId === querySessionId ? 0.04 : 0;

  const score =
    normVector     * config.vectorWeight      +
    normLexical    * config.lexicalWeight     +
    normImportance * config.importanceWeight  +
    recency        * config.recencyWeight     +
    sessionBonus;

  return {
    score:           Math.min(1, score),
    vectorScore:     normVector,
    lexicalScore:    normLexical,
    importanceScore: normImportance,
    recencyScore:    recency,
    sessionBonus
  };
}

// ─── Deduplicate and rerank ────────────────────────────────────────────────────

/**
 * Merge multiple memory arrays, deduplicate by fingerprint (keeping the
 * highest-scored version of each duplicate), apply recency-aware hybrid
 * scoring, sort descending, and slice to topK.
 *
 * Each returned memory gains a `_retrieval` envelope containing the full
 * score breakdown so callers can surface it in debug/API responses.
 *
 * @param {Array<object>} memories   – flat array of memory objects (may include duplicates)
 * @param {{
 *   query:          string,
 *   querySessionId: string,
 *   scoredEntries?: Array<{memory: object, vectorScore: number, lexicalScore: number}>
 * }} context   – retrieval context
 * @param {object} [cfg]  – override config for testing
 * @returns {Array<object>}  memory objects (≤ topK) each with a `_retrieval` field
 */
export function deduplicateAndRerank(memories, context, cfg) {
  const config     = cfg ?? readRetrievalConfig();
  const { querySessionId, scoredEntries = [] } = context;

  // Build a lookup: memoryId → {vectorScore, lexicalScore} from store-level scoring
  const scoreMap = new Map(
    scoredEntries.map((e) => [e.memory.id, { vectorScore: e.vectorScore, lexicalScore: e.lexicalScore }])
  );

  // Deduplicate: fingerprint → best entry (highest importance as tiebreaker before scoring)
  const byFingerprint = new Map();

  for (const memory of memories) {
    const key = memory.fingerprint || memory.id;
    const existing = byFingerprint.get(key);
    const importance = Number(memory.metadata?.importance || 0);
    const existingImportance = Number(existing?.metadata?.importance || 0);

    if (!existing || importance > existingImportance) {
      byFingerprint.set(key, memory);
    }
  }

  // Score every unique memory and attach _retrieval metadata
  const scored = Array.from(byFingerprint.values()).map((memory) => {
    const lookup       = scoreMap.get(memory.id) || {};
    const vectorScore  = lookup.vectorScore  ?? 0;
    const lexicalScore = lookup.lexicalScore ?? 0;
    const importanceScore = Number(memory.metadata?.importance || 0);
    const timestamp    = memory.metadata?.timestamp || null;

    const breakdown = computeHybridScore(
      {
        vectorScore,
        lexicalScore,
        importanceScore,
        timestamp,
        sessionId:      memory.sessionId,
        querySessionId
      },
      config
    );

    return {
      memory: {
        ...memory,
        _retrieval: {
          ...breakdown,
          timestamp,
          source: memory._retrieval?.source || "memory"
        }
      },
      score: breakdown.score
    };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, config.topK)
    .map((e) => e.memory);
}
