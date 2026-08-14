/**
 * packages/core/src/memory/utils/scoring-helpers.js
 *
 * Low-level scoring helpers that are used exclusively by the memory
 * classification and scoring pipeline.
 *
 * `scoreMemoryTypeMatch` and `countMatches` were previously inlined into
 * packages/core/src/utils/index.js alongside all the other helpers.  They
 * live here now so the memory module is self-contained.
 *
 * Both functions are pure: no state, no side effects, no I/O.
 */

// ─── Pattern scoring ──────────────────────────────────────────────────────────

/**
 * Count how many patterns in an array match the content string.
 *
 * Used by the memory classifier to derive a raw score for each memory type
 * before picking the type with the highest count.
 *
 * @param {string}   content  - Text to test (caller may lowercase it first)
 * @param {RegExp[]} patterns - Array of regex patterns to test against content
 * @returns {number} Number of patterns that match (0 to patterns.length)
 */
export function scoreMemoryTypeMatch(content, patterns) {
  let matchCount = 0;
  for (const pattern of patterns) {
    if (pattern.test(content)) {
      matchCount++;
    }
  }
  return matchCount;
}

// ─── Term frequency helper ────────────────────────────────────────────────────

/**
 * Count how many terms from `terms` appear as substrings in `content`.
 *
 * The search is case-insensitive — `content` is lower-cased before each
 * check, so callers may pass either cased or lower-cased content.
 *
 * Used in scoring functions where a quick substring-frequency count is
 * sufficient (domain inference, permanence scoring, actionability scoring,
 * etc.).
 *
 * @param {string}   content - Source text to search
 * @param {string[]} terms   - Substrings to count
 * @returns {number} Number of distinct terms found (max = terms.length)
 */
export function countMatches(content, terms) {
  const lower = content.toLowerCase();
  return terms.reduce(
    (count, term) => count + (lower.includes(term) ? 1 : 0),
    0
  );
}
