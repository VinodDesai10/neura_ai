/**
 * packages/core/src/memory/services/classifier.js
 *
 * Memory-type classification: pure, stateless functions that map a content
 * string to one of "factual", "episodic", or "semantic".
 *
 * Public exports (re-exported from memory/index.js and @neura/core):
 *   - classifyMemoryType
 *   - classifyMemoryTypeWithConfidence
 */

import { clampScore } from "@neura/shared";
import {
  FACTUAL_PATTERNS,
  EPISODIC_PATTERNS,
  SEMANTIC_PATTERNS
} from "../utils/pattern-sets.js";
import { scoreMemoryTypeMatch } from "../utils/scoring-helpers.js";

// ─── Simple classification ────────────────────────────────────────────────────

/**
 * Classify memory content into `"factual"`, `"episodic"`, or `"semantic"`.
 *
 * The classifier scores each type by counting how many regex patterns match
 * the content, then returns the type with the highest count.  `"semantic"`
 * is the default / fallback when neither factual nor episodic patterns fire.
 *
 * @param {string} content
 * @returns {"factual" | "episodic" | "semantic"}
 */
export function classifyMemoryType(content) {
  const lower = content.toLowerCase();
  const factualScore  = scoreMemoryTypeMatch(lower, FACTUAL_PATTERNS);
  const episodicScore = scoreMemoryTypeMatch(lower, EPISODIC_PATTERNS);

  if (factualScore > 0 && factualScore >= episodicScore) return "factual";
  if (episodicScore > 0) return "episodic";
  return "semantic";
}

// ─── Confidence-aware classification ─────────────────────────────────────────

/**
 * Classify with a confidence score and alternative classification hints.
 *
 * The confidence is a heuristic estimate of how certain the classification
 * is, based on the ratio of the winning type's score to the total matches
 * across all types.  It is clamped to [0, 1] via `clampScore`.
 *
 * The returned `debug` object contains the raw pattern-match counts for
 * each memory type, useful for unit testing and observability.
 *
 * @param {string} content
 * @returns {{
 *   memoryType:   "factual" | "episodic" | "semantic",
 *   confidence:   number,
 *   alternatives: Array<{type: string, confidence: number}>,
 *   debug: {
 *     factualScore:  number,
 *     episodicScore: number,
 *     semanticScore: number
 *   }
 * }}
 */
export function classifyMemoryTypeWithConfidence(content) {
  const lower = content.toLowerCase();
  const factualScore  = scoreMemoryTypeMatch(lower, FACTUAL_PATTERNS);
  const episodicScore = scoreMemoryTypeMatch(lower, EPISODIC_PATTERNS);
  const semanticScore = scoreMemoryTypeMatch(lower, SEMANTIC_PATTERNS);

  let primaryType;
  let maxScore;

  if (factualScore > 0 && factualScore >= episodicScore) {
    primaryType = "factual";
    maxScore    = factualScore;
  } else if (episodicScore > 0) {
    primaryType = "episodic";
    maxScore    = episodicScore;
  } else {
    primaryType = "semantic";
    maxScore    = semanticScore;
  }

  const totalMatches = factualScore + episodicScore + semanticScore;
  const confidence   = Math.min(1, maxScore / Math.max(1, totalMatches - 1) + 0.3);

  const scoreEntries = [
    { type: "factual",  score: factualScore },
    { type: "episodic", score: episodicScore },
    { type: "semantic", score: semanticScore }
  ]
    .filter((e) => e.type !== primaryType && e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);

  return {
    memoryType: primaryType,
    confidence: clampScore(confidence),
    alternatives: scoreEntries.map((e) => ({
      type: e.type,
      confidence: clampScore(
        Math.min(1, (e.score / Math.max(1, totalMatches - 1)) + 0.2)
      )
    })),
    debug: { factualScore, episodicScore, semanticScore }
  };
}
