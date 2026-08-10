/**
 * packages/core/src/retrieval/index.js
 *
 * Query-level retrieval helpers: overlap scoring and memory relatedness.
 *
 * Public exports (re-exported from @neura/core):
 *   - scoreQueryOverlap
 *   - computeMemoryRelatedness
 */

import { tokenize } from "@neura/shared";
import { inferEntities } from "../utils/index.js";
import { inferMemoryDomain } from "../memory/index.js";

/**
 * Count how many tokenised query terms appear in the content string.
 *
 * @param {string} query
 * @param {string} content
 * @returns {number}
 */
export function scoreQueryOverlap(query, content) {
  const queryTerms   = tokenize(query);
  const contentTerms = new Set(tokenize(content));
  return queryTerms.reduce((score, term) => score + (contentTerms.has(term) ? 1 : 0), 0);
}

/**
 * Compute semantic relatedness between two memory content strings (0–1).
 * Combines Jaccard token overlap, entity overlap, and domain match.
 *
 * @param {string} content1
 * @param {string} content2
 * @returns {number}
 */
export function computeMemoryRelatedness(content1, content2) {
  const tokens1 = new Set(tokenize(content1));
  const tokens2 = new Set(tokenize(content2));

  const intersection  = [...tokens1].filter((t) => tokens2.has(t)).length;
  const union         = new Set([...tokens1, ...tokens2]).size;
  const jaccardScore  = union > 0 ? intersection / union : 0;

  const entities1     = inferEntities(content1).map((e) => e.value.toLowerCase());
  const entities2     = inferEntities(content2).map((e) => e.value.toLowerCase());
  const entityOverlap = entities1.filter((e) => entities2.includes(e)).length;
  const entityScore   = Math.min(
    1,
    (entityOverlap + 0.5) / Math.max(entities1.length, entities2.length, 1)
  );

  const domain1     = inferMemoryDomain(content1);
  const domain2     = inferMemoryDomain(content2);
  const domainScore = domain1.domain === domain2.domain ? 1 : 0;

  return jaccardScore * 0.5 + entityScore * 0.3 + domainScore * 0.2;
}
