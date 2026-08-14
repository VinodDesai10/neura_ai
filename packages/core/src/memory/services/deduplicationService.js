/**
 * packages/core/src/memory/services/deduplicationService.js
 *
 * Lightweight near-duplicate detection and memory merging.
 *
 * Public exports (re-exported from memory/index.js and @neura/core):
 *   - normalizeText
 *   - similarity
 *   - isDuplicate
 *   - mergeMemory
 *
 * ─── Design goals ─────────────────────────────────────────────────────────────
 *
 * 1. **No external dependencies.**  Token-overlap (Jaccard similarity) is
 *    cheap, requires no model, and is good enough for the "same fact, slightly
 *    different phrasing" case that dominates real chat traffic.
 *
 * 2. **Swappable similarity backend.**  The public `similarity(a, b)` function
 *    accepts plain strings and returns a number in [0, 1].  If a caller wants
 *    to pass pre-computed embedding vectors instead of raw text, they can do so
 *    by wrapping this module — the `isDuplicate` signature does not change.
 *    A future embedding-based implementation can replace the body of
 *    `similarity` (or be injected via a factory) without touching callers.
 *
 * 3. **Merge over discard.**  When two memories are near-duplicates, the newer
 *    one is not silently dropped.  Instead `mergeMemory` produces a single
 *    record that keeps the richer content and accumulates confidence and access
 *    metadata from both sources.
 *
 * ─── Similarity algorithm ────────────────────────────────────────────────────
 *
 *   Jaccard(A, B) = |A ∩ B| / |A ∪ B|
 *
 * where A and B are sets of meaningful tokens produced by `normalizeText`.
 * This is O(n) and handles minor phrasing variations well.
 *
 * For very short inputs (< 3 tokens each) a character-level overlap ratio
 * is blended in to reduce false positives on terse phrases.
 */

import { tokenize, clampScore } from "@neura/shared";

// ─── Constants ─────────────────────────────────────────────────────────────────

/**
 * Default similarity threshold above which two memories are considered
 * near-duplicates.  Matches the RETRIEVAL_DEDUP_THRESHOLD env default.
 *
 * @type {number}
 */
export const DEFAULT_DEDUP_THRESHOLD = 0.92;

// ─── Text normalisation ───────────────────────────────────────────────────────

/**
 * Normalise a text string into a canonical form suitable for comparison.
 *
 * Steps:
 *   1. Lower-case the input.
 *   2. Expand common contractions (don't → do not, etc.).
 *   3. Strip punctuation, keeping only alphanumerics and spaces.
 *   4. Collapse multiple whitespace into a single space.
 *   5. Trim leading / trailing whitespace.
 *
 * The output is a plain string, not a token array.  Call `tokenize` on the
 * result if you need individual tokens (stop-words stripped).
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeText(text) {
  if (typeof text !== "string") return "";

  return text
    .toLowerCase()
    // Expand common contractions so "don't" and "do not" normalise the same.
    .replace(/won't/g,  "will not")
    .replace(/can't/g,  "cannot")
    .replace(/n't\b/g,  " not")
    .replace(/i'm\b/g,  "i am")
    .replace(/i've\b/g, "i have")
    .replace(/i'll\b/g, "i will")
    .replace(/i'd\b/g,  "i would")
    .replace(/it's\b/g, "it is")
    .replace(/that's\b/g, "that is")
    .replace(/they're\b/g, "they are")
    .replace(/we're\b/g,  "we are")
    .replace(/you're\b/g, "you are")
    // Remove all punctuation / symbols, keep alphanumerics and spaces.
    .replace(/[^a-z0-9\s]/g, " ")
    // Collapse whitespace.
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Similarity ───────────────────────────────────────────────────────────────

/**
 * Compute a similarity score between two text strings in [0, 1].
 *
 * Uses Jaccard similarity over meaningful tokens (stop-words excluded via
 * `tokenize`).  For very short inputs a character-level overlap is blended in
 * to reduce noise on terse phrases.
 *
 * **Swappable backend note:** This function is the single seam for the
 * similarity computation.  To switch to embedding-based cosine similarity,
 * replace the body of this function (or supply a custom scorer to
 * `isDuplicate`).  The signature — `(string, string) → number` — does not
 * change, so all callers remain unmodified.
 *
 * @param {string} a  - First text (raw or pre-normalised)
 * @param {string} b  - Second text (raw or pre-normalised)
 * @returns {number}  Similarity in [0, 1]
 */
export function similarity(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return 0;

  const tokensA = new Set(tokenize(normalizeText(a)));
  const tokensB = new Set(tokenize(normalizeText(b)));

  // Perfect match on empty / all-stop-word inputs.
  if (tokensA.size === 0 && tokensB.size === 0) {
    // Fall back to normalised string equality.
    return normalizeText(a) === normalizeText(b) ? 1 : 0;
  }

  // Jaccard: |A ∩ B| / |A ∪ B|
  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++;
  }
  const union        = tokensA.size + tokensB.size - intersection;
  const jaccardScore = union === 0 ? 0 : intersection / union;

  // For very short inputs (< 3 meaningful tokens each) blend in a character-
  // level normalised overlap to reduce sensitivity to stop-word differences.
  if (tokensA.size < 3 || tokensB.size < 3) {
    const normA   = normalizeText(a);
    const normB   = normalizeText(b);
    const longer  = Math.max(normA.length, normB.length);
    const charOverlap = longer === 0 ? 1 : _longestCommonSubstringLen(normA, normB) / longer;
    return clampScore(jaccardScore * 0.6 + charOverlap * 0.4);
  }

  return clampScore(jaccardScore);
}

// ─── Duplicate detection ──────────────────────────────────────────────────────

/**
 * Determine whether `newText` is a near-duplicate of `existingText`.
 *
 * A memory is considered a near-duplicate when `similarity(newText,
 * existingText) >= threshold`.  The threshold defaults to
 * `DEFAULT_DEDUP_THRESHOLD` (0.92) which corresponds to the
 * `RETRIEVAL_DEDUP_THRESHOLD` environment variable.
 *
 * Callers can inject a custom scorer to swap in embedding-based cosine
 * similarity without modifying this function's signature:
 *
 * ```js
 * const cosineSimilarity = (a, b) => cosine(embedding(a), embedding(b));
 * isDuplicate(newText, existingText, 0.92, cosineSimilarity);
 * ```
 *
 * @param {string}   newText      - Candidate memory content
 * @param {string}   existingText - Existing stored memory content
 * @param {number}   [threshold=DEFAULT_DEDUP_THRESHOLD]
 * @param {(a: string, b: string) => number} [scorer=similarity]
 *   Optional custom scorer function (same signature as `similarity`).
 * @returns {boolean}
 */
export function isDuplicate(
  newText,
  existingText,
  threshold = DEFAULT_DEDUP_THRESHOLD,
  scorer    = similarity
) {
  if (typeof newText !== "string" || typeof existingText !== "string") return false;
  const safeThreshold = typeof threshold === "number" ? threshold : DEFAULT_DEDUP_THRESHOLD;
  return scorer(newText, existingText) >= safeThreshold;
}

// ─── Memory merging ───────────────────────────────────────────────────────────

/**
 * Merge an incoming near-duplicate memory into an existing one.
 *
 * Merge policy:
 *   - **Content / summary**: keep the longer (more informative) version.
 *   - **Importance**: take the higher value to avoid information loss.
 *   - **Confidence**: weighted average of both confidence values.
 *   - **Access count**: accumulate (existing + incoming, default 0 each).
 *   - **savedByUser**: true if either record has it set.
 *   - **Tags / keywords / entities**: union both arrays, deduplicate.
 *   - **Timestamp**: keep the most recent timestamp so the merged memory
 *     is treated as "alive" by recency-decay logic.
 *   - **All other metadata fields**: prefer `existing` (more stable) but
 *     fall back to `incoming` when `existing`'s value is null/undefined.
 *
 * The merged record is a **new object** — neither input is mutated.
 *
 * @param {import("../entities/memory-types.js").MemoryCandidate} existing
 *   The record already stored in the memory pipeline.
 * @param {import("../entities/memory-types.js").MemoryCandidate} incoming
 *   The newly extracted candidate that matched the existing record.
 * @returns {import("../entities/memory-types.js").MemoryCandidate}
 *   Merged memory candidate.
 */
export function mergeMemory(existing, incoming) {
  const eMeta = existing?.metadata  ?? {};
  const iMeta = incoming?.metadata  ?? {};

  // ── Content / summary ───────────────────────────────────────────────────────
  const existingContent = existing?.content ?? "";
  const incomingContent = incoming?.content ?? "";
  const mergedContent   = incomingContent.length > existingContent.length
    ? incomingContent
    : existingContent;

  const existingSummary = existing?.summary ?? "";
  const incomingSummary = incoming?.summary ?? "";
  const mergedSummary   = incomingSummary.length > existingSummary.length
    ? incomingSummary
    : existingSummary;

  // ── Importance ──────────────────────────────────────────────────────────────
  const existingImportance = typeof eMeta.importance === "number" ? eMeta.importance : 0.5;
  const incomingImportance = typeof iMeta.importance === "number" ? iMeta.importance : 0.5;
  const mergedImportance   = clampScore(Math.max(existingImportance, incomingImportance));

  // ── Confidence ──────────────────────────────────────────────────────────────
  // Weighted average: existing gets 2/3 weight (more established), incoming 1/3.
  const existingConfidence = typeof eMeta.confidence === "number" ? eMeta.confidence : 0.5;
  const incomingConfidence = typeof iMeta.confidence === "number" ? iMeta.confidence : 0.5;
  const mergedConfidence   = clampScore(existingConfidence * (2 / 3) + incomingConfidence * (1 / 3));

  // ── Access count ─────────────────────────────────────────────────────────────
  const existingAccess = typeof eMeta.accessCount === "number" ? eMeta.accessCount : 0;
  const incomingAccess = typeof iMeta.accessCount === "number" ? iMeta.accessCount : 0;
  const mergedAccess   = existingAccess + incomingAccess;

  // ── savedByUser ──────────────────────────────────────────────────────────────
  const mergedSaved = !!(eMeta.savedByUser || iMeta.savedByUser);

  // ── Tags / keywords / entities ───────────────────────────────────────────────
  const mergedTags     = _union(eMeta.tags,     iMeta.tags);
  const mergedKeywords = _union(eMeta.keywords, iMeta.keywords);
  const mergedEntities = _unionEntities(eMeta.entities, iMeta.entities);

  // ── Timestamps ───────────────────────────────────────────────────────────────
  // Keep the most recent so recency-decay is accurate.
  const eTs = eMeta.timestamp ? new Date(eMeta.timestamp).getTime() : 0;
  const iTs = iMeta.timestamp ? new Date(iMeta.timestamp).getTime() : 0;
  const mergedTimestamp = iTs > eTs
    ? iMeta.timestamp
    : (eMeta.timestamp ?? iMeta.timestamp ?? null);

  // ── Assemble merged metadata ─────────────────────────────────────────────────
  const mergedMeta = {
    ...eMeta,                         // existing fields as base
    ...iMeta,                         // incoming fields override (e.g. extractionMethod)
    ...eMeta,                         // existing wins for stable fields (re-apply)
    importance:   mergedImportance,
    confidence:   mergedConfidence,
    accessCount:  mergedAccess,
    savedByUser:  mergedSaved,
    tags:         mergedTags,
    keywords:     mergedKeywords,
    entities:     mergedEntities,
    timestamp:    mergedTimestamp,
  };

  return {
    ...existing,
    content:  mergedContent,
    summary:  mergedSummary,
    metadata: mergedMeta
  };
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Length of the longest common substring of two strings.
 * Used as a character-level similarity proxy for very short inputs.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function _longestCommonSubstringLen(a, b) {
  if (!a || !b) return 0;
  let maxLen = 0;
  const m = a.length;
  const n = b.length;
  // Build a (m+1) × (n+1) DP table using two rows to keep memory O(n).
  let prev = new Array(n + 1).fill(0);
  let curr = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
        if (curr[j] > maxLen) maxLen = curr[j];
      } else {
        curr[j] = 0;
      }
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return maxLen;
}

/**
 * Union two arrays of primitives, deduplicated.
 *
 * @param {any[]} [a=[]]
 * @param {any[]} [b=[]]
 * @returns {any[]}
 */
function _union(a = [], b = []) {
  return [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])].filter(Boolean);
}

/**
 * Union two entity arrays ({type, value} objects), deduplicating by
 * the "type:value" composite key.
 *
 * @param {Array<{type: string, value: string}>} [a=[]]
 * @param {Array<{type: string, value: string}>} [b=[]]
 * @returns {Array<{type: string, value: string}>}
 */
function _unionEntities(a = [], b = []) {
  const seen = new Map();
  for (const entity of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (entity && typeof entity === "object") {
      const key = `${entity.type}:${entity.value}`;
      if (!seen.has(key)) seen.set(key, entity);
    }
  }
  return [...seen.values()];
}
