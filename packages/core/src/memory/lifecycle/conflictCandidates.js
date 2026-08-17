/**
 * packages/core/src/memory/lifecycle/conflictCandidates.js
 *
 * Fast pre-filter that narrows a set of peer memories to only the candidates
 * worth running the expensive `detectConflicts` similarity comparison against.
 *
 * ─── Why this exists ──────────────────────────────────────────────────────────
 *
 *   `processUserMemories` must check every non-archived memory for conflicts.
 *   A naïve implementation passes all other memories as candidates to
 *   `detectConflicts`, which calls `similarity()` (O(token set union)) for
 *   every pair.  Across N memories that is O(N²) similarity calls per sweep.
 *
 *   This module reduces the candidate set using cheap, metadata-only checks
 *   so that `detectConflicts` only receives memories that are plausibly
 *   relevant.  Unrelated memories (different type, no shared tokens) are
 *   excluded without any similarity computation at all.
 *
 * ─── Filter stages (cheapest first) ──────────────────────────────────────────
 *
 *   Stage 1 — exclude self
 *     Skip the memory being evaluated.
 *
 *   Stage 2 — type compatibility
 *     A factual memory can only conflict with another factual memory.
 *     An episodic memory can only conflict with episodic memories.
 *     A semantic memory may conflict with semantic or factual memories.
 *     Null/undefined memoryType is treated as compatible with everything.
 *
 *   Stage 3 — category / topic match (when metadata.category is set)
 *     If both memories carry a category label, they must share it.
 *     Memories without a category pass through unconditionally.
 *
 *   Stage 4 — token overlap pre-filter
 *     Build a token set from the memory's content (lower-cased words, ≥ 3 chars,
 *     stop-words stripped).  Require at least MIN_SHARED_TOKENS shared tokens
 *     before passing the candidate to conflict detection.
 *     This is O(|tokens|) per candidate — far cheaper than the full
 *     Jaccard-based similarity used inside `detectConflicts`.
 *
 * ─── Public API ───────────────────────────────────────────────────────────────
 *
 *   filterConflictCandidates(memory, peers)  → object[]
 *     Returns only the subset of `peers` that pass all four stages.
 *
 *   buildTokenSet(content)                   → Set<string>
 *     Exported for testing; builds the stop-word-stripped token set.
 *
 *   areTypesCompatible(typeA, typeB)         → boolean
 *     Exported for testing; returns true when the two memory types can conflict.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Minimum number of shared content tokens for a candidate to pass
 * the token-overlap pre-filter.
 *
 * Setting this to 1 is intentionally permissive: it lets through anything
 * that shares even one meaningful word (e.g. "Mumbai", "PostgreSQL").
 * The full `detectConflicts` similarity check is the real gate.
 *
 * @type {number}
 */
const MIN_SHARED_TOKENS = 1;

/**
 * English stop words to strip before token comparison.
 * Keeps the token set focused on content-bearing words.
 *
 * @type {Set<string>}
 */
const STOP_WORDS = new Set([
  "the", "and", "for", "are", "was", "were", "has", "have", "had",
  "not", "but", "with", "from", "that", "this", "they", "their",
  "our", "its", "now", "use", "using", "used", "will", "can",
  "into", "onto", "been", "also", "more", "than", "then"
]);

/**
 * Memory-type compatibility table.
 *
 * Key = a memory's memoryType.
 * Value = Set of memoryTypes it can potentially conflict with.
 * Missing keys (null / undefined / unknown) are treated as compatible with all.
 *
 * @type {Map<string, Set<string>>}
 */
const TYPE_COMPAT = new Map([
  ["factual",  new Set(["factual"])],
  ["episodic", new Set(["episodic"])],
  ["semantic", new Set(["semantic", "factual"])]
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a set of normalised content tokens for fast overlap checks.
 *
 * Tokens are lower-cased, trimmed, at least 3 characters long, and not
 * in the stop-word list.
 *
 * @param {string} content
 * @returns {Set<string>}
 */
export function buildTokenSet(content) {
  if (!content || typeof content !== "string") return new Set();
  return new Set(
    content
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")   // strip punctuation
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOP_WORDS.has(t))
  );
}

/**
 * Return true when two memory types are compatible for conflict detection.
 *
 * Memories with null/undefined types pass through (we do not know enough
 * to exclude them).
 *
 * @param {string|null|undefined} typeA
 * @param {string|null|undefined} typeB
 * @returns {boolean}
 */
export function areTypesCompatible(typeA, typeB) {
  // Unknown types are treated as compatible with everything.
  if (!typeA || !typeB) return true;
  const compatSet = TYPE_COMPAT.get(typeA);
  if (!compatSet) return true;   // unknown typeA → compatible
  return compatSet.has(typeB);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Narrow `peers` to those worth comparing with `memory` for conflicts.
 *
 * Applies four cheap stages in order (cheapest first):
 *   1. Exclude self (id match)
 *   2. Type compatibility
 *   3. Category match (when both have metadata.category)
 *   4. Token overlap  (≥ MIN_SHARED_TOKENS shared content tokens)
 *
 * The returned candidates still need to pass the full `detectConflicts`
 * similarity and confidence checks — this pre-filter only eliminates the
 * obvious non-starters.
 *
 * @param {object}   memory  - The memory being evaluated.
 * @param {object[]} peers   - All other memories for the same user.
 * @returns {object[]}  Filtered candidate list (subset of `peers`).
 */
export function filterConflictCandidates(memory, peers) {
  const memType     = memory?.memoryType ?? null;
  const memCategory = memory?.metadata?.category ?? null;
  const memTokens   = buildTokenSet(memory?.content ?? "");

  const candidates = [];

  for (const peer of peers) {
    // ── Stage 1: skip self ─────────────────────────────────────────────────
    if (peer.id && peer.id === memory.id) continue;

    // ── Stage 2: type compatibility ────────────────────────────────────────
    const peerType = peer?.memoryType ?? null;
    if (!areTypesCompatible(memType, peerType)) continue;

    // ── Stage 3: category match ────────────────────────────────────────────
    const peerCategory = peer?.metadata?.category ?? null;
    if (memCategory && peerCategory && memCategory !== peerCategory) continue;

    // ── Stage 4: token overlap pre-filter ──────────────────────────────────
    // Skip if we have no content tokens (no basis for comparison).
    if (memTokens.size > 0) {
      const peerTokens = buildTokenSet(peer?.content ?? "");
      if (peerTokens.size > 0) {
        let sharedCount = 0;
        // Iterate the smaller set for efficiency.
        const [smaller, larger] =
          memTokens.size <= peerTokens.size
            ? [memTokens, peerTokens]
            : [peerTokens, memTokens];
        for (const token of smaller) {
          if (larger.has(token)) {
            sharedCount++;
            if (sharedCount >= MIN_SHARED_TOKENS) break;
          }
        }
        if (sharedCount < MIN_SHARED_TOKENS) continue;
      }
      // Peer with no content tokens: pass through to let detectConflicts handle it.
    }

    candidates.push(peer);
  }

  return candidates;
}
