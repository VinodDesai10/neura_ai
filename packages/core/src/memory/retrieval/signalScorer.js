/**
 * packages/core/src/memory/retrieval/signalScorer.js
 *
 * Pure, stateless score-computation functions for the hybrid retrieval
 * pipeline.  Every function here is deterministic given its inputs and has no
 * I/O side-effects, making them trivially testable in isolation.
 *
 * ─── Signals ──────────────────────────────────────────────────────────────────
 *
 *   computeKeywordScore    – token-overlap between query and memory text
 *   computeRecencyScore    – exponential decay based on memory age
 *   computeAccessFreqBonus – log-scaled bonus from metadata.accessCount
 *   buildReason            – human-readable summary of why a memory was selected
 *   resolveWeights         – merge caller overrides into HYBRID_WEIGHTS_DEFAULTS
 */

import { tokenize } from "@neura/shared";
import { HYBRID_WEIGHTS_DEFAULTS } from "./retrievalTypes.js";

// ─── Weight resolution ────────────────────────────────────────────────────────

/**
 * Resolve weights: merge caller-supplied overrides into the defaults.
 * Each individual weight is clamped to [0, 1].
 *
 * @param {Partial<import("./retrievalTypes.js").HybridWeights>} [overrides]
 * @returns {import("./retrievalTypes.js").HybridWeights}
 */
export function resolveWeights(overrides) {
  const w = { ...HYBRID_WEIGHTS_DEFAULTS, ...(overrides || {}) };
  return {
    vector:     Math.max(0, Math.min(1, w.vector)),
    keyword:    Math.max(0, Math.min(1, w.keyword)),
    importance: Math.max(0, Math.min(1, w.importance)),
    recency:    Math.max(0, Math.min(1, w.recency)),
    graph:      Math.max(0, Math.min(1, w.graph))
  };
}

// ─── Keyword score ────────────────────────────────────────────────────────────

/**
 * Compute keyword overlap between a query and memory text.
 *
 * Tokenises both strings and counts how many query tokens appear in the
 * content.  Returns a value normalised to [0, 1] using a soft cap of 5
 * matches — i.e. five matching tokens gives a perfect score of 1.0.
 *
 * @param {string} query  – The user's retrieval query.
 * @param {string} text   – The memory's `summary` or `content` field.
 * @returns {number}  Score in [0, 1].
 */
export function computeKeywordScore(query, text) {
  if (!query || !text) return 0;
  const queryTerms   = tokenize(query);
  const contentTerms = new Set(tokenize(text));
  const matches      = queryTerms.reduce(
    (n, t) => n + (contentTerms.has(t) ? 1 : 0),
    0
  );
  return Math.min(1, matches / 5);
}

// ─── Recency score ────────────────────────────────────────────────────────────

/**
 * Compute recency decay: exponential decay anchored at the memory's
 * creation timestamp using a configurable half-life.
 *
 * Score is 1.0 when the memory is brand new and decays towards (but never
 * reaches) 0.  When `timestamp` is absent the memory is treated as fresh
 * and returns 1.0.
 *
 * Decay is capped at 10× the half-life to avoid extremely small values for
 * very old memories (floor ≈ 0.001).
 *
 * @param {string|number|null} timestamp  – ISO-8601 string or epoch ms.
 * @param {number}             halfLifeHours  – Score halves every N hours.
 * @returns {number}  Score in (0, 1].
 */
export function computeRecencyScore(timestamp, halfLifeHours) {
  if (!timestamp) return 1.0;
  const halfLifeMs = halfLifeHours * 60 * 60 * 1000;
  const ageMs = Date.now() - (
    typeof timestamp === "number" ? timestamp : Date.parse(timestamp)
  );
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1.0;
  const lambda   = Math.LN2 / halfLifeMs;
  const cappedMs = Math.min(ageMs, halfLifeMs * 10); // floor ≈ 0.001
  return Math.exp(-lambda * cappedMs);
}

// ─── Access frequency bonus ───────────────────────────────────────────────────

/**
 * Normalise access frequency (`metadata.accessCount`) into a small 0–0.15
 * bonus using a log scale.
 *
 * A log scale prevents heavily-accessed memories from completely dominating
 * the importance dimension.  The cap at 0.15 keeps the bonus from
 * overwhelming the stored importance score.
 *
 * @param {number} accessCount  – Raw `metadata.accessCount` value.
 * @returns {number}  Bonus in [0, 0.15].
 */
export function computeAccessFreqBonus(accessCount) {
  if (!accessCount || accessCount <= 0) return 0;
  return Math.min(0.15, Math.log1p(accessCount) / Math.log1p(100));
}

// ─── Reason builder ───────────────────────────────────────────────────────────

/**
 * Build the human-readable `reason` string that explains why a memory was
 * selected.  Useful for debugging and evaluation.
 *
 * @param {{
 *   vectorScore:     number,
 *   keywordScore:    number,
 *   importanceScore: number,
 *   recencyScore:    number,
 *   graphScore:      number,
 *   sources:         string[]
 * }} signals
 * @returns {string}
 */
export function buildReason({
  vectorScore,
  keywordScore,
  importanceScore,
  recencyScore,
  graphScore,
  sources
}) {
  const parts = [];
  if (vectorScore  >= 0.5)  parts.push("strong vector similarity");
  else if (vectorScore > 0) parts.push("partial vector similarity");
  if (keywordScore >= 0.4)  parts.push("keyword match");
  if (importanceScore >= 0.7) parts.push("high importance");
  else if (importanceScore >= 0.4) parts.push("moderate importance");
  if (recencyScore >= 0.8) parts.push("recent");
  if (graphScore   >= 0.5)  parts.push("graph-connected");
  if (parts.length === 0)   parts.push("low-signal match");
  return `Selected via ${sources.join("+")} — ${parts.join(", ")}`;
}
