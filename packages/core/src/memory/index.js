/**
 * packages/core/src/memory/index.js
 *
 * Core memory domain logic: classification, extraction, scoring, and storage decisions.
 *
 * Public exports (re-exported from @neura/core):
 *   - classifyMemoryType
 *   - classifyMemoryTypeWithConfidence
 *   - summarizeMemoryCandidate
 *   - inferMemoryDomain
 *   - scoreMemoryConfidence
 *   - scoreMemoryImportance
 *   - shouldStoreMemory
 *   - extractMemoryCandidates
 *   - computeMemoryFingerprint
 */

import {
  DOMAIN_RULES,
  clampScore,
  tokenize,
  hasLowSignalContent
} from "@neura/shared";

import {
  FACTUAL_PATTERNS,
  EPISODIC_PATTERNS,
  SEMANTIC_PATTERNS,
  scoreMemoryTypeMatch,
  countMatches,
  inferTags,
  inferKeywords,
  inferEntities,
  scoreSpecificity,
  scorePermanence,
  scoreActionability,
  inferSentiment,
  scoreSignalStrength
} from "../utils/index.js";

// ─── Classification ───────────────────────────────────────────────────────────

/**
 * Classify memory content into "factual", "episodic", or "semantic".
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

/**
 * Classify with a confidence score and alternative classification hints.
 *
 * @param {string} content
 * @returns {{
 *   memoryType: string,
 *   confidence: number,
 *   alternatives: Array<{type: string, confidence: number}>,
 *   debug: object
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
    maxScore = factualScore;
  } else if (episodicScore > 0) {
    primaryType = "episodic";
    maxScore = episodicScore;
  } else {
    primaryType = "semantic";
    maxScore = semanticScore;
  }

  const totalMatches = factualScore + episodicScore + semanticScore;
  const confidence = Math.min(1, maxScore / Math.max(1, totalMatches - 1) + 0.3);

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
      confidence: clampScore(Math.min(1, (e.score / Math.max(1, totalMatches - 1)) + 0.2))
    })),
    debug: { factualScore, episodicScore, semanticScore }
  };
}

// ─── Summary ──────────────────────────────────────────────────────────────────

/**
 * Truncate content to a 140-character summary.
 *
 * @param {string} content
 * @returns {string}
 */
export function summarizeMemoryCandidate(content) {
  return content.length <= 140 ? content : `${content.slice(0, 137)}...`;
}

// ─── Domain inference ─────────────────────────────────────────────────────────

/**
 * Infer the primary memory domain for a piece of content.
 *
 * @param {string} content
 * @returns {{ domain: string, domainConfidence: number, alternateDomains: string[] }}
 */
export function inferMemoryDomain(content) {
  const scored = DOMAIN_RULES.map((rule) => ({
    domain: rule.domain,
    score: Math.min(1, rule.weight * countMatches(content, rule.terms))
  }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const best  = scored[0];
  const lower = content.toLowerCase();

  if (/\b(my name is|i am|i'm|we are)\b/.test(lower)) {
    return {
      domain: "identity",
      domainConfidence: 0.95,
      alternateDomains: scored.filter((e) => e.domain !== "identity").slice(0, 3).map((e) => e.domain)
    };
  }

  if (/\b(i prefer|i like|i dislike|i want|we want)\b/.test(lower)) {
    return {
      domain: "preference",
      domainConfidence: 0.9,
      alternateDomains: scored.filter((e) => e.domain !== "preference").slice(0, 3).map((e) => e.domain)
    };
  }

  return {
    domain: best?.domain || "general",
    domainConfidence: best ? clampScore(Math.min(0.95, best.score)) : 0.35,
    alternateDomains: scored.slice(1, 4).map((e) => e.domain)
  };
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

/**
 * Score a memory candidate's confidence (0–1).
 *
 * @param {{
 *   content: string,
 *   role: string,
 *   memoryType: string,
 *   tags: string[],
 *   domainConfidence: number
 * }} params
 * @returns {number}
 */
export function scoreMemoryConfidence({ content, role, memoryType, tags, domainConfidence }) {
  const lower = content.toLowerCase();
  const specificity = scoreSpecificity(content);
  let score = role === "user" ? 0.58 : 0.44;

  score += specificity * 0.18;
  score += domainConfidence * 0.12;
  score += Math.min(0.08, tags.length * 0.02);

  if (memoryType === "factual") score += 0.08;

  const factualIndicators = countMatches(lower, ["my name is", "i prefer", "i want", "we want", "our project"]);
  if (factualIndicators > 0) score += Math.min(0.12, factualIndicators * 0.05);

  if (lower.includes("?")) score -= 0.16;

  const uncertaintyTerms = ["maybe", "perhaps", "not sure", "i think", "probably", "might"];
  const uncertaintyCount = countMatches(lower, uncertaintyTerms);
  if (uncertaintyCount > 0) score -= Math.min(0.2, uncertaintyCount * 0.08);

  if (role === "assistant" && !/\b(decision|plan|architecture|next step|we should)\b/i.test(lower)) {
    score -= 0.08;
  }

  return clampScore(score);
}

/**
 * Score the overall importance of a memory candidate (0–1).
 *
 * @param {string}      content
 * @param {string}      role
 * @param {string}      memoryType
 * @param {string|null} [timestamp]
 * @returns {number}
 */
export function scoreMemoryImportance(content, role, memoryType, timestamp = null) {
  const tags              = inferTags(content);
  const { domainConfidence } = inferMemoryDomain(content);
  const signalStrength    = scoreSignalStrength(content, memoryType, tags);
  const specificity       = scoreSpecificity(content);
  const permanence        = scorePermanence(content, memoryType);
  const actionability     = scoreActionability(content);
  const confidence        = scoreMemoryConfidence({ content, role, memoryType, tags, domainConfidence });

  let score =
    signalStrength   * 0.28 +
    confidence       * 0.20 +
    specificity      * 0.16 +
    permanence       * 0.16 +
    actionability    * 0.12 +
    domainConfidence * 0.08;

  if (role === "user") score += 0.06;
  if (memoryType === "factual")  score += 0.08;
  if (memoryType === "episodic") score += 0.04;

  if (/\b(my name is|project|capstone|goal|want|architecture|decision|must|important|major)\b/i.test(content)) {
    score += 0.08;
  }

  if (content.length > 220)        score += 0.03;
  if (content.trim().endsWith("?")) score -= 0.08;

  if (timestamp && memoryType === "episodic") {
    const ageMs     = Date.now() - new Date(timestamp).getTime();
    const ageHours  = ageMs / (1000 * 60 * 60);
    const decayFactor = Math.exp(-0.015 * Math.min(ageHours, 720));
    score *= decayFactor;
  }

  return clampScore(score);
}

// ─── Storage gate ─────────────────────────────────────────────────────────────

/**
 * Returns `true` when a memory candidate should be persisted.
 *
 * @param {{ role: string, content: string, memoryType: string }} params
 * @returns {boolean}
 */
export function shouldStoreMemory({ role, content, memoryType }) {
  const lower = content.toLowerCase().trim();

  if (!lower || hasLowSignalContent(lower)) return false;

  if (
    lower.startsWith("what do you remember") ||
    lower.startsWith("do you remember") ||
    lower.startsWith("can you remember") ||
    lower.startsWith("what do you know")
  ) {
    return false;
  }

  if (role === "assistant") {
    if (
      lower.startsWith("aineura demo response:") ||
      lower.includes("currently running with a local fallback responder")
    ) {
      return false;
    }

    return (
      lower.includes("plan") ||
      lower.includes("decision") ||
      lower.includes("architecture") ||
      lower.includes("we should") ||
      lower.includes("next step")
    );
  }

  if (memoryType === "semantic") return lower.length > 24;

  return true;
}

// ─── Extraction ───────────────────────────────────────────────────────────────

/**
 * Extract and score memory candidates from a raw event.
 *
 * @param {{
 *   id: string,
 *   sessionId: string,
 *   role: string,
 *   content: string,
 *   createdAt: string
 * }} event
 * @returns {Array<object>}
 */
export function extractMemoryCandidates(event) {
  const content = event.content.trim();
  if (!content) return [];

  const segments = content
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const baseSegments = segments.length ? segments : [content];

  return baseSegments
    .map((segment, index) => {
      const classification     = classifyMemoryTypeWithConfidence(segment);
      const memoryType         = classification.memoryType;
      const classificationConf = classification.confidence;
      const tags               = inferTags(segment);
      const domainResult       = inferMemoryDomain(segment);
      const confidence         = scoreMemoryConfidence({
        content: segment,
        role: event.role,
        memoryType,
        tags,
        domainConfidence: domainResult.domainConfidence
      });

      return {
        memoryType,
        content: segment,
        summary: summarizeMemoryCandidate(segment),
        metadata: {
          importance:   scoreMemoryImportance(segment, event.role, memoryType, event.createdAt),
          confidence,
          timestamp:    event.createdAt,
          domain:       domainResult.domain,
          domainConfidence: domainResult.domainConfidence,
          alternateDomains: domainResult.alternateDomains,
          tags,
          role:         event.role,
          schemaVersion:    3,
          generatedBy:      "heuristic-metadata-v3",
          extractionMethod: "enhanced-pattern-scoring-analysis",
          source: {
            eventId:      event.id,
            sessionId:    event.sessionId,
            segmentIndex: index
          },
          signalStrength: scoreSignalStrength(segment, memoryType, tags),
          specificity:    scoreSpecificity(segment),
          permanence:     scorePermanence(segment, memoryType),
          actionability:  scoreActionability(segment),
          sentiment:      inferSentiment(segment),
          keywords:       inferKeywords(segment),
          entities:       inferEntities(segment),
          classificationConfidence:   classificationConf,
          alternativeClassifications: classification.alternatives,
          classificationDebug:        classification.debug
        }
      };
    })
    .filter((candidate) =>
      shouldStoreMemory({
        role: event.role,
        content: candidate.content,
        memoryType: candidate.memoryType
      })
    );
}

// ─── Fingerprint ──────────────────────────────────────────────────────────────

/**
 * Compute a stable fingerprint for a memory content string.
 * Two semantically identical messages produce the same fingerprint.
 *
 * @param {string} content
 * @returns {string}
 */
export function computeMemoryFingerprint(content) {
  return tokenize(content).sort().join(" ");
}
