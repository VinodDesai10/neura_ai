/**
 * packages/core/src/memory/services/extractor.js
 *
 * Memory extraction pipeline: domain inference, storage gating, candidate
 * extraction, summary truncation, and fingerprint computation.
 *
 * Public exports (re-exported from memory/index.js and @neura/core):
 *   - inferMemoryDomain
 *   - shouldStoreMemory
 *   - summarizeMemoryCandidate
 *   - extractMemoryCandidates
 *   - computeMemoryFingerprint
 *
 * Design notes:
 *   - inferMemoryDomain is here (not in scorer.js) because both the extractor
 *     and the scorer use it, and having it here avoids a circular import.
 *   - scorer.js imports inferMemoryDomain from this file.
 */

import { DOMAIN_RULES, clampScore, tokenize, hasLowSignalContent } from "@neura/shared";
import { countMatches } from "../utils/scoring-helpers.js";
import {
  inferTags,
  inferKeywords,
  inferEntities,
  scoreSpecificity,
  scorePermanence,
  scoreActionability,
  inferSentiment,
  scoreSignalStrength
} from "../../utils/index.js";
import { classifyMemoryTypeWithConfidence } from "./classifier.js";
import { scoreMemoryConfidence, scoreMemoryImportance } from "./scorer.js";
import { calculateImportance } from "./importanceScorer.js";
import { isDuplicate, mergeMemory } from "./deduplicationService.js";
import {
  METADATA_SCHEMA_VERSION,
  HEURISTIC_GENERATOR_ID,
  HEURISTIC_EXTRACTION_METHOD
} from "../entities/memory-metadata.js";

// ─── Domain inference ─────────────────────────────────────────────────────────

/**
 * Infer the primary memory domain for a piece of content.
 *
 * Two strong shortcut patterns are checked first (identity and preference)
 * before falling back to the weighted domain-rules table in @neura/shared.
 *
 * @param {string} content
 * @returns {{
 *   domain:           string,
 *   domainConfidence: number,
 *   alternateDomains: string[]
 * }}
 */
export function inferMemoryDomain(content) {
  const lower = content.toLowerCase();

  const scored = DOMAIN_RULES.map((rule) => ({
    domain: rule.domain,
    score:  Math.min(1, rule.weight * countMatches(content, rule.terms))
  }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const best = scored[0];

  if (/\b(my name is|i am|i'm|we are)\b/.test(lower)) {
    return {
      domain:           "identity",
      domainConfidence: 0.95,
      alternateDomains: scored
        .filter((e) => e.domain !== "identity")
        .slice(0, 3)
        .map((e) => e.domain)
    };
  }

  if (/\b(i prefer|i like|i dislike|i want|we want)\b/.test(lower)) {
    return {
      domain:           "preference",
      domainConfidence: 0.9,
      alternateDomains: scored
        .filter((e) => e.domain !== "preference")
        .slice(0, 3)
        .map((e) => e.domain)
    };
  }

  return {
    domain:           best?.domain || "general",
    domainConfidence: best ? clampScore(Math.min(0.95, best.score)) : 0.35,
    alternateDomains: scored.slice(1, 4).map((e) => e.domain)
  };
}

// ─── Summary truncation ───────────────────────────────────────────────────────

/**
 * Truncate a content string to a 140-character summary.
 * The full content is returned unchanged when it is short enough.
 *
 * @param {string} content
 * @returns {string}
 */
export function summarizeMemoryCandidate(content) {
  return content.length <= 140 ? content : `${content.slice(0, 137)}...`;
}

// ─── Storage gate ─────────────────────────────────────────────────────────────

/**
 * Returns `true` when a memory candidate should be persisted.
 *
 * This is the single gating function for the extraction pipeline.  Any
 * candidate that fails this test is silently dropped — we never store:
 *   - Empty or low-signal content
 *   - Memory queries ("what do you remember", "do you remember")
 *   - Assistant demo/fallback responses
 *   - Assistant replies that carry no planning/decision language
 *   - Semantic memories shorter than 25 chars
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

// ─── Fingerprint ──────────────────────────────────────────────────────────────

/**
 * Compute a stable fingerprint for a memory content string.
 * Two semantically identical messages (same words, any order) produce the
 * same fingerprint, which is used by the deduplication pipeline.
 *
 * Algorithm: tokenise → sort → join.
 *
 * @param {string} content
 * @returns {string}
 */
export function computeMemoryFingerprint(content) {
  return tokenize(content).sort().join(" ");
}

// ─── Candidate extraction ─────────────────────────────────────────────────────

/**
 * Extract and score memory candidates from a raw chat event.
 *
 * The event's `content` is split on sentence boundaries (`.!?`) and
 * newlines.  Each segment is independently classified, scored, and tested
 * through `shouldStoreMemory`.  Segments that do not pass the gate are
 * dropped.
 *
 * After extraction, a within-event deduplication pass merges any candidates
 * whose content is a near-duplicate of a previously accepted candidate
 * (using `isDuplicate` / `mergeMemory`).  This prevents the same fact from
 * being stored multiple times when a single message restates itself across
 * sentences.
 *
 * The returned candidates are "pre-storage" objects: they include all
 * computed metadata but do NOT yet have `id`, `sessionId`, `fingerprint`,
 * or `embedding` — those are added by the memory processor.
 *
 * Each candidate's `metadata.importance` is computed by `calculateImportance`
 * so that it reflects the full composite score (not just the extraction-time
 * signal strength).
 *
 * @param {{
 *   id:        string,
 *   sessionId: string,
 *   role:      string,
 *   content:   string,
 *   createdAt: string
 * }} event
 * @returns {import("../entities/memory-types.js").MemoryCandidate[]}
 */
export function extractMemoryCandidates(event) {
  const content = event.content.trim();
  if (!content) return [];

  const segments = content
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const baseSegments = segments.length ? segments : [content];

  const rawCandidates = baseSegments
    .map((segment, index) => {
      const classification     = classifyMemoryTypeWithConfidence(segment);
      const memoryType         = classification.memoryType;
      const classificationConf = classification.confidence;
      const tags               = inferTags(segment);
      const domainResult       = inferMemoryDomain(segment);
      const confidence         = scoreMemoryConfidence({
        content:         segment,
        role:            event.role,
        memoryType,
        tags,
        domainConfidence: domainResult.domainConfidence
      });

      // Build the candidate with extraction-time importance first so that
      // calculateImportance can reference metadata.importance as its base.
      const extractionImportance = scoreMemoryImportance(segment, event.role, memoryType, event.createdAt);

      const candidate = {
        memoryType,
        content: segment,
        summary: summarizeMemoryCandidate(segment),
        metadata: {
          importance:          extractionImportance,
          confidence,
          timestamp:           event.createdAt,
          domain:              domainResult.domain,
          domainConfidence:    domainResult.domainConfidence,
          alternateDomains:    domainResult.alternateDomains,
          tags,
          role:                event.role,
          schemaVersion:       METADATA_SCHEMA_VERSION,
          generatedBy:         HEURISTIC_GENERATOR_ID,
          extractionMethod:    HEURISTIC_EXTRACTION_METHOD,
          source: {
            eventId:      event.id,
            sessionId:    event.sessionId,
            segmentIndex: index
          },
          signalStrength:  scoreSignalStrength(segment, memoryType, tags),
          specificity:     scoreSpecificity(segment),
          permanence:      scorePermanence(segment, memoryType),
          actionability:   scoreActionability(segment),
          sentiment:       inferSentiment(segment),
          keywords:        inferKeywords(segment),
          entities:        inferEntities(segment),
          classificationConfidence:   classificationConf,
          alternativeClassifications: classification.alternatives,
          classificationDebug:        classification.debug
        }
      };

      // Refine importance using the full composite scorer now that the
      // candidate shape (including metadata.timestamp) is available.
      const { score: compositeImportance } = calculateImportance(candidate);
      candidate.metadata.importance = compositeImportance;

      return candidate;
    })
    .filter((candidate) =>
      shouldStoreMemory({
        role:       event.role,
        content:    candidate.content,
        memoryType: candidate.memoryType
      })
    );

  // ── Within-event deduplication ─────────────────────────────────────────────
  // Merge candidates that restate the same fact within a single event so the
  // caller receives one record per unique memory, not one per sentence.
  const deduplicated = [];
  for (const candidate of rawCandidates) {
    const matchIndex = deduplicated.findIndex((accepted) =>
      isDuplicate(candidate.content, accepted.content)
    );
    if (matchIndex === -1) {
      deduplicated.push(candidate);
    } else {
      // Merge the duplicate into the existing accepted candidate.
      deduplicated[matchIndex] = mergeMemory(deduplicated[matchIndex], candidate);
    }
  }

  return deduplicated;
}
