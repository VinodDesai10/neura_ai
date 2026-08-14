/**
 * packages/core/src/memory/services/scorer.js
 *
 * Memory importance and confidence scoring — pure, stateless functions.
 *
 * Public exports (re-exported from memory/index.js and @neura/core):
 *   - scoreMemoryConfidence
 *   - scoreMemoryImportance
 *
 * Both functions depend on helpers that live in packages/core/src/utils/index.js
 * (inferTags, scoreSpecificity, scorePermanence, scoreActionability,
 * scoreSignalStrength) and on inferMemoryDomain from extractor.js.
 * Those are imported directly so this module stays self-contained.
 */

import { clampScore } from "@neura/shared";
import { countMatches } from "../utils/scoring-helpers.js";
import {
  inferTags,
  scoreSpecificity,
  scorePermanence,
  scoreActionability,
  scoreSignalStrength
} from "../../utils/index.js";
import { inferMemoryDomain } from "./extractor.js";

// ─── Confidence scoring ───────────────────────────────────────────────────────

/**
 * Score a memory candidate's extraction confidence (0–1).
 *
 * Confidence reflects how certain we are that the extracted segment
 * actually encodes a memory-worthy fact.  It is influenced by:
 *
 * - Role (user utterances carry more signal than assistant replies)
 * - Content specificity (names, numbers, entities boost confidence)
 * - Domain confidence from the domain classifier
 * - Tag density (more tags → higher confidence)
 * - Factual memory type gets a bonus
 * - Questions and hedging language (maybe, perhaps, I think) reduce confidence
 * - Assistant turns without planning/decision language are penalised
 *
 * @param {{
 *   content:         string,
 *   role:            string,
 *   memoryType:      string,
 *   tags:            string[],
 *   domainConfidence: number
 * }} params
 * @returns {number}  confidence in [0, 1]
 */
export function scoreMemoryConfidence({ content, role, memoryType, tags, domainConfidence }) {
  const lower = content.toLowerCase();
  const specificity = scoreSpecificity(content);

  let score = role === "user" ? 0.58 : 0.44;

  score += specificity * 0.18;
  score += domainConfidence * 0.12;
  score += Math.min(0.08, tags.length * 0.02);

  if (memoryType === "factual") score += 0.08;

  const factualIndicators = countMatches(lower, [
    "my name is", "i prefer", "i want", "we want", "our project"
  ]);
  if (factualIndicators > 0) score += Math.min(0.12, factualIndicators * 0.05);

  if (lower.includes("?")) score -= 0.16;

  const uncertaintyTerms  = ["maybe", "perhaps", "not sure", "i think", "probably", "might"];
  const uncertaintyCount  = countMatches(lower, uncertaintyTerms);
  if (uncertaintyCount > 0) score -= Math.min(0.2, uncertaintyCount * 0.08);

  if (
    role === "assistant" &&
    !/\b(decision|plan|architecture|next step|we should)\b/i.test(lower)
  ) {
    score -= 0.08;
  }

  return clampScore(score);
}

// ─── Importance scoring ───────────────────────────────────────────────────────

/**
 * Score the overall importance of a memory candidate (0–1).
 *
 * Importance is a composite of six sub-scores combined with fixed weights,
 * plus a set of additive bonuses and penalties:
 *
 *   score = signalStrength × 0.28
 *         + confidence     × 0.20
 *         + specificity    × 0.16
 *         + permanence     × 0.16
 *         + actionability  × 0.12
 *         + domainConf     × 0.08
 *         + role/type/length bonuses
 *         − recency penalty (episodic memories decay with age)
 *
 * @param {string}      content
 * @param {string}      role        - "user" | "assistant"
 * @param {string}      memoryType  - "factual" | "episodic" | "semantic"
 * @param {string|null} [timestamp] - ISO-8601 timestamp; episodic memories decay
 * @returns {number}  importance in [0, 1]
 */
export function scoreMemoryImportance(content, role, memoryType, timestamp = null) {
  const tags                   = inferTags(content);
  const { domainConfidence }   = inferMemoryDomain(content);
  const signalStrength         = scoreSignalStrength(content, memoryType, tags);
  const specificity            = scoreSpecificity(content);
  const permanence             = scorePermanence(content, memoryType);
  const actionability          = scoreActionability(content);
  const confidence             = scoreMemoryConfidence({
    content,
    role,
    memoryType,
    tags,
    domainConfidence
  });

  let score =
    signalStrength   * 0.28 +
    confidence       * 0.20 +
    specificity      * 0.16 +
    permanence       * 0.16 +
    actionability    * 0.12 +
    domainConfidence * 0.08;

  if (role === "user")            score += 0.06;
  if (memoryType === "factual")   score += 0.08;
  if (memoryType === "episodic")  score += 0.04;

  if (/\b(my name is|project|capstone|goal|want|architecture|decision|must|important|major)\b/i.test(content)) {
    score += 0.08;
  }

  if (content.length > 220)         score += 0.03;
  if (content.trim().endsWith("?")) score -= 0.08;

  // Episodic memories decay with age (exponential, capped at 720 hours)
  if (timestamp && memoryType === "episodic") {
    const ageMs       = Date.now() - new Date(timestamp).getTime();
    const ageHours    = ageMs / (1000 * 60 * 60);
    const decayFactor = Math.exp(-0.015 * Math.min(ageHours, 720));
    score *= decayFactor;
  }

  return clampScore(score);
}
