/**
 * services/deduplication-service.js
 *
 * Near-duplicate detection for memory candidates before insertion.
 *
 * Strategy (two-stage, fast-first):
 *
 * Stage 1 – Fingerprint equality
 *   The fingerprint is a sorted token bag (computed by computeMemoryFingerprint).
 *   An exact fingerprint match is a guaranteed duplicate – skip to upsert without
 *   burning an embedding call.
 *
 * Stage 2 – Cosine similarity on embeddings
 *   When both the candidate and an existing memory have embeddings, compute cosine
 *   similarity.  If it exceeds RETRIEVAL_DEDUP_THRESHOLD the memories are treated
 *   as near-duplicates.
 *
 * The caller (memory-processor.js) decides what to do with the result:
 *   - isDuplicate === true  → skip insert, optionally bump existing importance
 *   - isDuplicate === false → proceed with upsert
 */

import { readRetrievalConfig } from "@neura/shared";

// ─── Cosine similarity (local, no deps) ───────────────────────────────────────

/**
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}  similarity in [-1, 1]
 */
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) {
    return -1;
  }

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  if (magA === 0 || magB === 0) return -1;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Check whether a memory candidate is a near-duplicate of any memory in
 * `existingMemories`.
 *
 * @param {{
 *   fingerprint: string,
 *   embedding:   number[]|null,
 *   sessionId:   string
 * }} candidate
 *
 * @param {Array<{
 *   id:          string,
 *   fingerprint: string,
 *   embedding:   number[]|null,
 *   sessionId:   string,
 *   metadata:    { importance: number }
 * }>} existingMemories  – already-stored memories to compare against
 *
 * @param {object} [cfgOverride]  – override readRetrievalConfig() for testing
 *
 * @returns {{
 *   isDuplicate:  boolean,
 *   existingId:   string|null,
 *   similarity:   number,
 *   reason:       'none'|'fingerprint'|'embedding'
 * }}
 */
export function isSimilarMemory(candidate, existingMemories, cfgOverride) {
  const { dedupThreshold } = cfgOverride ?? readRetrievalConfig();

  if (!Array.isArray(existingMemories) || existingMemories.length === 0) {
    return { isDuplicate: false, existingId: null, similarity: 0, reason: "none" };
  }

  // ── Stage 1: exact fingerprint match ─────────────────────────────────────
  for (const existing of existingMemories) {
    // Always scope deduplication to the same session
    if (existing.sessionId !== candidate.sessionId) continue;

    if (
      candidate.fingerprint &&
      existing.fingerprint &&
      candidate.fingerprint === existing.fingerprint
    ) {
      return {
        isDuplicate: true,
        existingId:  existing.id,
        similarity:  1.0,
        reason:      "fingerprint"
      };
    }
  }

  // ── Stage 2: embedding cosine similarity ─────────────────────────────────
  if (!Array.isArray(candidate.embedding) || candidate.embedding.length === 0) {
    return { isDuplicate: false, existingId: null, similarity: 0, reason: "none" };
  }

  let bestSimilarity = 0;
  let bestId = null;

  for (const existing of existingMemories) {
    if (existing.sessionId !== candidate.sessionId) continue;
    if (!Array.isArray(existing.embedding) || existing.embedding.length === 0) continue;

    const sim = cosineSimilarity(candidate.embedding, existing.embedding);

    if (sim > bestSimilarity) {
      bestSimilarity = sim;
      bestId = existing.id;
    }
  }

  if (bestSimilarity >= dedupThreshold) {
    return {
      isDuplicate: true,
      existingId:  bestId,
      similarity:  bestSimilarity,
      reason:      "embedding"
    };
  }

  return { isDuplicate: false, existingId: null, similarity: bestSimilarity, reason: "none" };
}
