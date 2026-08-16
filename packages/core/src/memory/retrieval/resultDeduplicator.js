/**
 * packages/core/src/memory/retrieval/resultDeduplicator.js
 *
 * Cross-backend deduplication for the hybrid retrieval pipeline.
 *
 * When the same memory appears from multiple backends (e.g. Qdrant and
 * Postgres both return the same memory id), this module merges the duplicate
 * entries into a single result, preserving the strongest per-signal score
 * from any source and accumulating the list of contributing backends.
 *
 * ─── Public API ───────────────────────────────────────────────────────────────
 *
 *   deduplicateById(memories) → memory[]
 *     Deduplicate an array of annotated memory objects by their `id` field.
 */

// ─── Deduplication ────────────────────────────────────────────────────────────

/**
 * Deduplicate an array of memory objects by their `id` field.
 *
 * When the same id appears multiple times (from different backends):
 *   - `_hybrid.sources` arrays are merged (union, no duplicates)
 *   - Per-signal scores (`vectorScore`, `keywordScore`, `graphScore`) are
 *     kept at their maximum across all occurrences — we preserve the
 *     strongest available signal for each dimension.
 *
 * The first-seen occurrence's base memory fields are retained; only the
 * `_hybrid` envelope is merged.
 *
 * @param {object[]} memories  – Array of memory objects, each optionally
 *                               carrying a `_hybrid` envelope.
 * @returns {object[]}  Deduplicated array in insertion order of first
 *                      occurrence.
 */
export function deduplicateById(memories) {
  /** @type {Map<string, object>} */
  const byId = new Map();

  for (const memory of memories) {
    const key = memory.id;
    if (!byId.has(key)) {
      byId.set(key, memory);
      continue;
    }

    // Merge sources and keep the maximum of each individual pre-rank score
    const existing = byId.get(key);
    const eS = existing._hybrid || {};
    const mS = memory._hybrid   || {};

    const mergedSources = [
      ...new Set([...(eS.sources || []), ...(mS.sources || [])])
    ];

    byId.set(key, {
      ...existing,
      _hybrid: {
        ...eS,
        sources:      mergedSources,
        vectorScore:  Math.max(eS.vectorScore  || 0, mS.vectorScore  || 0),
        keywordScore: Math.max(eS.keywordScore || 0, mS.keywordScore || 0),
        graphScore:   Math.max(eS.graphScore   || 0, mS.graphScore   || 0)
      }
    });
  }

  return [...byId.values()];
}
