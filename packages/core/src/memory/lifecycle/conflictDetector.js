/**
 * packages/core/src/memory/lifecycle/conflictDetector.js
 *
 * Detects conflicting memories for the same user.
 *
 * A "conflict" is when two memories make contradictory factual claims about
 * the same topic.  Classic examples:
 *
 *   "I live in Mumbai."  →  "I live in Bangalore."
 *   "Neura uses PostgreSQL."  →  "Neura uses MongoDB."
 *
 * ─── Design principles ────────────────────────────────────────────────────────
 *
 *   • Never silently overwrite.  Both records are preserved.
 *   • Use the existing `similarity` function from deduplicationService.js
 *     for token-level overlap — no new similarity engine.
 *   • Conflict ≠ duplicate.  Duplicates are near-identical (similarity ≥ 0.92).
 *     Conflicts share a topic but differ in the stated value (similarity in
 *     a middle band: [conflictSimilarity, dupThreshold)).
 *   • Only one record "wins" during retrieval (the newer / higher-confidence
 *     one), but neither is deleted.
 *   • The result carries enough metadata for the AI to surface the change.
 *
 * ─── Exported functions ───────────────────────────────────────────────────────
 *
 *   detectConflicts(memory, candidates, config?)
 *     → ConflictDetectionResult
 *
 *   buildConflictRecord(memory, other, similarity, config?)
 *     → ConflictRecord | null
 */

import { similarity, DEFAULT_DEDUP_THRESHOLD } from "../services/deduplicationService.js";
import { normalizeText }                        from "../services/deduplicationService.js";
import { readLifecycleConfig }                  from "./lifecycleTypes.js";
import { clampScore }                           from "@neura/shared";

// ─── Conflict topic patterns ──────────────────────────────────────────────────

/**
 * Patterns that indicate a memory is making a mutable personal/factual claim.
 * When two memories share a pattern key and differ in the claim value,
 * that is a high-confidence conflict signal.
 *
 * @type {Array<{ key: string, regex: RegExp }>}
 */
const CONFLICT_TOPIC_PATTERNS = [
  { key: "location",    regex: /\b(?:i live|i'm based|i am based|i moved|my (?:home|city|location) is)\b/i },
  { key: "employment",  regex: /\b(?:i work at|i'm working at|i am working at|my (?:job|company|employer) is|i joined)\b/i },
  { key: "project_db",  regex: /\b(?:uses?|using|we use|switched to|migrated to)\s+\w+(?:db|sql|mongo|postgres|redis|mysql|dynamo|neo4j|qdrant)\b/i },
  { key: "preference",  regex: /\b(?:i prefer|i like|my (?:favorite|preferred)|i (?:switched|changed) to)\b/i },
  { key: "tech_stack",  regex: /\b(?:we (?:use|are using|switched to)|our (?:stack|backend|frontend|database|framework|language) is)\b/i },
  { key: "name",        regex: /\b(?:my name is|i am called|people call me|call me)\b/i },
  { key: "age",         regex: /\b(?:i am|i'm)\s+\d+\s+(?:years? old|yo)\b/i }
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract which conflict-topic keys a memory's content matches.
 *
 * @param {string} content
 * @returns {string[]}  matched topic keys
 */
function extractTopics(content) {
  const matched = [];
  for (const { key, regex } of CONFLICT_TOPIC_PATTERNS) {
    if (regex.test(content)) matched.push(key);
  }
  return matched;
}

/**
 * Check whether two normalised content strings differ in their key claim.
 *
 * The simplest heuristic: the tokens that follow the shared pattern are
 * different in the two strings.
 *
 * @param {string} a  normalised content of memory A
 * @param {string} b  normalised content of memory B
 * @returns {boolean}
 */
function claimsDiffer(a, b) {
  // If they are very similar (≥ 0.9 by token overlap), they say the same thing.
  const sim = similarity(a, b);
  return sim < 0.88;
}

/**
 * Compute a conflict confidence score.
 *
 * Higher confidence when:
 *   - Memories share a topic pattern AND their claims differ
 *   - Token overlap is in the conflict band (not too low = unrelated, not
 *     too high = duplicate)
 *   - The newer memory has higher stored confidence
 *
 * @param {number}   sim         - token-overlap similarity
 * @param {boolean}  topicMatch  - true when both memories share a topic key
 * @param {object}   candidate   - the conflicting memory
 * @param {object}   memory      - the target memory
 * @returns {number}  confidence in [0, 1]
 */
function computeConflictConfidence(sim, topicMatch, candidate, memory) {
  let score = 0;

  // Topic match is the strongest signal
  if (topicMatch) score += 0.50;

  // Token overlap in the conflict band (0.35 – 0.88) adds confidence
  const bandScore = (sim - 0.35) / (0.88 - 0.35);
  score += clampScore(bandScore) * 0.25;

  // Higher confidence in either memory → more credible conflict
  const candidateConf = candidate?.metadata?.confidence ?? 0.5;
  const memoryConf    = memory?.metadata?.confidence   ?? 0.5;
  score += Math.max(candidateConf, memoryConf) * 0.15;

  // Newer memory replaces older → stronger conflict signal
  const candTs  = candidate?.metadata?.timestamp ? new Date(candidate.metadata.timestamp).getTime() : 0;
  const memTs   = memory?.metadata?.timestamp    ? new Date(memory.metadata.timestamp).getTime()    : 0;
  if (candTs > 0 && memTs > 0 && candTs !== memTs) score += 0.10;

  return clampScore(score);
}

/**
 * Determine which of two conflicting memories should win retrieval.
 *
 * Preference rules (in priority order):
 *   1. Higher stored confidence wins.
 *   2. If confidence is equal, the newer memory wins.
 *   3. If timestamps are equal, prefer the candidate (newer extract).
 *
 * @param {object} memory     - The target memory being evaluated.
 * @param {object} candidate  - A potentially conflicting memory.
 * @returns {boolean}  `true` if `candidate` should be preferred over `memory`.
 */
function candidatePreferred(memory, candidate) {
  const memConf  = memory?.metadata?.confidence    ?? 0;
  const candConf = candidate?.metadata?.confidence ?? 0;
  if (Math.abs(candConf - memConf) > 0.05) return candConf > memConf;

  const memTs  = memory?.metadata?.timestamp    ? new Date(memory.metadata.timestamp).getTime()    : 0;
  const candTs = candidate?.metadata?.timestamp ? new Date(candidate.metadata.timestamp).getTime() : 0;
  return candTs >= memTs;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a single conflict record for a pair of memories, or return `null`
 * if the pair does not meet the conflict confidence threshold.
 *
 * @param {object} memory      - The memory being evaluated.
 * @param {object} candidate   - A potentially conflicting peer memory.
 * @param {number} sim         - Pre-computed similarity score.
 * @param {ReturnType<import("./lifecycleTypes.js").readLifecycleConfig>} [config]
 * @returns {import("./lifecycleTypes.js").ConflictRecord | null}
 */
export function buildConflictRecord(memory, candidate, sim, config) {
  const cfg = config ?? readLifecycleConfig();

  const memContent   = normalizeText(memory?.content   ?? "");
  const candContent  = normalizeText(candidate?.content ?? "");

  const memTopics    = extractTopics(memContent);
  const candTopics   = extractTopics(candContent);
  const sharedTopics = memTopics.filter((t) => candTopics.includes(t));
  const topicMatch   = sharedTopics.length > 0 && claimsDiffer(memContent, candContent);

  const confidence   = computeConflictConfidence(sim, topicMatch, candidate, memory);

  if (confidence < cfg.conflictConfidenceMin) return null;

  const preferOther = candidatePreferred(memory, candidate);

  const topicLabel = sharedTopics.length > 0
    ? sharedTopics.join(", ")
    : "overlapping content";

  const reason = topicMatch
    ? `Conflicting ${topicLabel} claim detected (similarity ${sim.toFixed(2)})`
    : `Potentially contradictory content on overlapping topic (similarity ${sim.toFixed(2)})`;

  return {
    conflictingId: candidate.id ?? null,
    similarity:    clampScore(sim),
    confidence:    clampScore(confidence),
    reason,
    detectedAt:    new Date().toISOString(),
    preferOther
  };
}

/**
 * Detect conflicts between a target memory and a list of candidate memories.
 *
 * Scans each candidate:
 *   • Skips duplicates (similarity ≥ DEFAULT_DEDUP_THRESHOLD).
 *   • Skips candidates with similarity below `config.conflictSimilarity`.
 *   • For candidates in the conflict band, builds a ConflictRecord.
 *
 * @param {object}   memory      - The memory being evaluated.
 * @param {object[]} candidates  - Other stored memories for the same user.
 * @param {ReturnType<import("./lifecycleTypes.js").readLifecycleConfig>} [config]
 * @returns {import("./lifecycleTypes.js").ConflictDetectionResult}
 */
export function detectConflicts(memory, candidates, config) {
  const cfg = config ?? readLifecycleConfig();

  const conflicts = [];

  for (const candidate of candidates) {
    // Skip self-comparison
    if (candidate.id && candidate.id === memory.id) continue;

    // Skip candidates with no content
    const candContent = candidate?.content;
    const memContent  = memory?.content;
    if (!candContent || !memContent) continue;

    const sim = similarity(memContent, candContent);

    // Too similar → duplicate, not a conflict
    if (sim >= DEFAULT_DEDUP_THRESHOLD) continue;

    // Too dissimilar → unrelated
    if (sim < cfg.conflictSimilarity) continue;

    // In the conflict band — check further
    const record = buildConflictRecord(memory, candidate, sim, cfg);
    if (record) conflicts.push(record);
  }

  return {
    hasConflict:    conflicts.length > 0,
    conflicts,
    conflictingIds: conflicts.map((c) => c.conflictingId).filter(Boolean)
  };
}
