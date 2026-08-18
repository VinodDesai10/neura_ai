/**
 * packages/core/src/memory/consolidation/conflictResolution.js
 *
 * Conflict detection and severity determination for memory consolidation.
 *
 * ─── Responsibilities ────────────────────────────────────────────────────────
 *
 *   detectGroupConflicts(memories, config)
 *     Scan pairs of source memories for contradictions using token-overlap
 *     similarity.  Returns all conflict records and a hasConflict flag.
 *
 *   overallSeverity(records)
 *     Reduce a list of ConflictSeverityRecords to the single worst severity.
 *
 *   determineStatus(memories, hasConflict, config)
 *     Map (source states, conflict flag) → ConsolidationStatus.
 *
 * ─── Conflict detection logic ─────────────────────────────────────────────────
 *
 *   A conflict exists when two sources have similarity in the band
 *   [conflictSimilarityLow, conflictSimilarityHigh).
 *
 *   Below the band  → unrelated; skip.
 *   In the band     → potential contradiction; record + assign severity.
 *   Above the band  → near-duplicate; same fact, different phrasing; skip.
 *
 *   Severity within the band:
 *     sim ≥ 0.60  → LOW    (slight phrasing difference)
 *     sim ≥ 0.40  → MEDIUM (factual disagreement on a detail)
 *     sim < 0.40  → HIGH   (direct contradiction)
 *
 * ─── Public API ───────────────────────────────────────────────────────────────
 *
 *   detectGroupConflicts(memories, cfg)
 *     → { records: ConflictSeverityRecord[], hasConflict: boolean }
 *
 *   overallSeverity(records)
 *     → string  (ConflictSeverity value)
 *
 *   determineStatus(memories, hasConflict, cfg)
 *     → string  (ConsolidationStatus value)
 */

import { clampScore }         from "@neura/shared";
import { similarity }         from "../services/deduplicationService.js";
import { LifecycleState }     from "../lifecycle/lifecycleTypes.js";
import {
  ConsolidationStatus,
  ConflictSeverity
} from "./consolidationTypes.js";

// ─── Conflict detection ───────────────────────────────────────────────────────

/**
 * Detect conflicts between source memories within a group.
 *
 * A conflict exists when:
 *   - Two sources have similarity in the conflict band
 *     [config.conflictSimilarityLow, config.conflictSimilarityHigh)
 *   - They appear to contradict (claims differ, not just rephrase)
 *
 * @param {object[]} memories
 * @param {ReturnType<import("./consolidationTypes.js").readConsolidationConfig>} cfg
 * @returns {{ records: import("./consolidationTypes.js").ConflictSeverityRecord[], hasConflict: boolean }}
 */
export function detectGroupConflicts(memories, cfg) {
  const records = [];

  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const memA = memories[i];
      const memB = memories[j];
      const sim  = similarity(memA?.content ?? "", memB?.content ?? "");

      // Skip near-duplicates (same fact, different phrasing)
      if (sim >= cfg.conflictSimilarityHigh) continue;
      // Skip unrelated (no shared topic)
      if (sim < cfg.conflictSimilarityLow) continue;

      // In the conflict band — determine severity
      let severity;
      let reason;

      if (sim >= 0.60) {
        severity = ConflictSeverity.LOW;
        reason   = `Slight phrasing difference (similarity ${sim.toFixed(2)})`;
      } else if (sim >= 0.40) {
        severity = ConflictSeverity.MEDIUM;
        reason   = `Factual disagreement detected (similarity ${sim.toFixed(2)})`;
      } else {
        severity = ConflictSeverity.HIGH;
        reason   = `Direct contradiction suspected (similarity ${sim.toFixed(2)})`;
      }

      records.push({
        memoryIdA:  memA.id,
        memoryIdB:  memB.id,
        similarity: clampScore(sim),
        severity,
        reason
      });
    }
  }

  return {
    records,
    hasConflict: records.length > 0
  };
}

// ─── Severity aggregation ─────────────────────────────────────────────────────

/**
 * Determine the overall ConflictSeverity from a list of severity records.
 *
 * Returns the worst (highest) severity present.
 *
 * @param {import("./consolidationTypes.js").ConflictSeverityRecord[]} records
 * @returns {string}  ConflictSeverity value
 */
export function overallSeverity(records) {
  if (records.some((r) => r.severity === ConflictSeverity.HIGH))   return ConflictSeverity.HIGH;
  if (records.some((r) => r.severity === ConflictSeverity.MEDIUM)) return ConflictSeverity.MEDIUM;
  if (records.some((r) => r.severity === ConflictSeverity.LOW))    return ConflictSeverity.LOW;
  return ConflictSeverity.NONE;
}

// ─── Status determination ─────────────────────────────────────────────────────

/**
 * Determine the ConsolidationStatus for the result.
 *
 * Rules (in priority order):
 *   1. If there are source conflicts → CONFLICTED
 *   2. If ≥ staleSourceFraction of sources are STALE/ARCHIVED → STALE
 *   3. Otherwise → ACTIVE
 *
 * @param {object[]} memories
 * @param {boolean}  hasConflict
 * @param {ReturnType<import("./consolidationTypes.js").readConsolidationConfig>} cfg
 * @returns {string}
 */
export function determineStatus(memories, hasConflict, cfg) {
  if (hasConflict) return ConsolidationStatus.CONFLICTED;

  const staleOrArchivedCount = memories.filter((m) => {
    const state = m?.metadata?.lifecycleState ?? LifecycleState.ACTIVE;
    return state === LifecycleState.STALE || state === LifecycleState.ARCHIVED;
  }).length;

  if (staleOrArchivedCount / memories.length >= cfg.staleSourceFraction) {
    return ConsolidationStatus.STALE;
  }

  return ConsolidationStatus.ACTIVE;
}
