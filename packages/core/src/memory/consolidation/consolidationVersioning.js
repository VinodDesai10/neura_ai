/**
 * packages/core/src/memory/consolidation/consolidationVersioning.js
 *
 * Versioning, re-consolidation decisions, and provenance for consolidated
 * memories.
 *
 * ─── Responsibilities ────────────────────────────────────────────────────────
 *
 *   updateConsolidatedMemory(existing, group, config?, opts?)
 *     Merge new source memories into an existing ConsolidatedMemory.
 *     Bumps the version counter, re-runs conflict detection, and re-computes
 *     scores with the expanded source set.  The original record is not mutated.
 *
 *   shouldReConsolidate(existing, group, config?)
 *     Return true when re-consolidation is warranted:
 *       - Fraction of genuinely new sources exceeds reConsolidateThreshold, OR
 *       - Existing record is STALE and at least one source is now ACTIVE.
 *
 *   getProvenance(consolidated, sourceMemories)
 *     Extract the full ProvenanceInfo for a ConsolidatedMemory.
 *
 * ─── Provenance guarantee ────────────────────────────────────────────────────
 *
 *   Source memories are NEVER deleted.  updateConsolidatedMemory takes the
 *   UNION of old + new source IDs, so provenance only ever grows.
 *   Archived source IDs are retained in the ID list for historical traceability.
 *
 * ─── Public API ───────────────────────────────────────────────────────────────
 *
 *   updateConsolidatedMemory(existing, group, config?, opts?) → ConsolidatedMemory
 *   shouldReConsolidate(existing, group, config?)             → boolean
 *   getProvenance(consolidated, sourceMemories)               → ProvenanceInfo
 */

import { LifecycleState }       from "../lifecycle/lifecycleTypes.js";
import {
  ConsolidationStatus,
  readConsolidationConfig
} from "./consolidationTypes.js";
import {
  detectGroupConflicts,
  overallSeverity,
  determineStatus
} from "./conflictResolution.js";
import {
  electBestSource,
  computeAggregateConfidence,
  computeAggregateImportance,
  unionTags
} from "./consolidationBuilder.js";

// ─── Re-consolidation decision ────────────────────────────────────────────────

/**
 * Decide whether an existing ConsolidatedMemory should be re-consolidated.
 *
 * Returns true when:
 *   - The fraction of sources in `group.memoryIds` that are NOT already in
 *     `existing.sourceMemoryIds` exceeds `config.reConsolidateThreshold`.
 *   - OR the existing status is STALE and there are new ACTIVE sources.
 *
 * @param {import("./consolidationTypes.js").ConsolidatedMemory} existing
 * @param {import("./consolidationTypes.js").ConsolidationGroup} group
 * @param {ReturnType<typeof readConsolidationConfig>} [config]
 * @returns {boolean}
 */
export function shouldReConsolidate(existing, group, config) {
  const cfg    = config ?? readConsolidationConfig();
  const oldSet = new Set(existing.sourceMemoryIds ?? []);
  const newIds = group.memoryIds ?? [];

  if (newIds.length === 0) return false;

  const genuinelyNew = newIds.filter((id) => !oldSet.has(id));
  const newFraction  = genuinelyNew.length / newIds.length;

  if (newFraction >= cfg.reConsolidateThreshold) return true;

  // Re-consolidate if stale and there are active sources
  if (existing.status === ConsolidationStatus.STALE) {
    const hasActiveSource = group.memories.some(
      (m) => (m?.metadata?.lifecycleState ?? LifecycleState.ACTIVE) === LifecycleState.ACTIVE
    );
    return hasActiveSource;
  }

  return false;
}

// ─── Version update ───────────────────────────────────────────────────────────

/**
 * Merge new source memories into an existing ConsolidatedMemory.
 *
 * Called when shouldReConsolidate() returns true.  Bumps the version,
 * re-computes scores, re-detects conflicts, and updates the summary
 * with the expanded source set.
 *
 * Source memories already in the consolidation are retained.
 * New source memories are added to sourceMemoryIds.
 * Archived sources are left in the ID list (provenance) but noted in status.
 *
 * The original `existing` record is NOT mutated — a new object is returned.
 *
 * @param {import("./consolidationTypes.js").ConsolidatedMemory} existing
 * @param {import("./consolidationTypes.js").ConsolidationGroup} group   - Group from the latest sweep
 * @param {ReturnType<typeof readConsolidationConfig>} [config]
 * @param {{
 *   summarise?: (memories: object[], topic: string) => string
 * }} [opts]
 * @returns {import("./consolidationTypes.js").ConsolidatedMemory}
 */
export function updateConsolidatedMemory(existing, group, config, opts = {}) {
  const cfg = config ?? readConsolidationConfig();

  // Merge source ID lists — union of old + new, deduplicated and sorted
  const oldIds = new Set(existing.sourceMemoryIds ?? []);
  const newIds = group.memoryIds ?? [];
  const merged = [...new Set([...oldIds, ...newIds])].sort();

  // Use the memories present in the new group for scoring and conflict detection
  const memories = group.memories;

  // Re-run conflict detection on the current source set
  const { records: conflictRecords, hasConflict } = detectGroupConflicts(memories, cfg);

  // Summary synthesis (deterministic default or provided hook)
  let summary;
  if (typeof opts.summarise === "function") {
    summary = opts.summarise(memories, group.topic);
  } else {
    // Import lazily to avoid circular dependency — synthesiseSummary is internal to builder
    // We replicate the trim logic here rather than export a private function.
    const bestSource = electBestSource(memories);
    const content    = bestSource?.content ?? bestSource?.summary ?? "";
    const src        = content.length > 200 && bestSource?.summary ? bestSource.summary : content;
    summary = src.length > 200 ? src.slice(0, 197) + "…" : src;
    summary = summary || `Consolidated ${group.topic} knowledge from ${memories.length} sources`;
  }

  const status         = determineStatus(memories, hasConflict, cfg);
  const confidence     = computeAggregateConfidence(memories);
  const importanceScore = computeAggregateImportance(memories);
  const bestSource     = electBestSource(memories);

  const conflictMeta = hasConflict
    ? {
        conflicts:      conflictRecords,
        conflictingIds: [...new Set(conflictRecords.flatMap((r) => [r.memoryIdA, r.memoryIdB]))],
        severity:       overallSeverity(conflictRecords),
        resolvedWith:   bestSource.id,
        detectedAt:     new Date().toISOString(),
        reason:         `${conflictRecords.length} conflict(s) detected after re-consolidation`
      }
    : null;

  return {
    ...existing,
    sourceMemoryIds: merged,
    summary,
    confidence,
    importanceScore,
    updatedAt:   new Date().toISOString(),
    version:     (existing.version ?? 1) + 1,
    status,
    conflictMeta,
    tags:        unionTags(memories),
    domain:      memories[0]?.metadata?.domain ?? existing.domain ?? "general"
  };
}

// ─── Provenance ───────────────────────────────────────────────────────────────

/**
 * Extract full provenance information for a ConsolidatedMemory.
 *
 * @param {import("./consolidationTypes.js").ConsolidatedMemory} consolidated
 * @param {object[]} sourceMemories - The actual source memory objects
 * @returns {import("./consolidationTypes.js").ProvenanceInfo}
 */
export function getProvenance(consolidated, sourceMemories) {
  const byId = new Map(sourceMemories.map((m) => [m.id, m]));

  // Find the most recent source memory
  let latestSource   = null;
  let latestSourceTs = 0;

  for (const id of consolidated.sourceMemoryIds ?? []) {
    const mem = byId.get(id);
    if (!mem) continue;
    const ts = mem?.metadata?.timestamp
      ? new Date(mem.metadata.timestamp).getTime()
      : 0;
    if (ts > latestSourceTs) {
      latestSourceTs = ts;
      latestSource   = mem;
    }
  }

  return {
    consolidatedMemoryId: consolidated.id,
    sourceMemoryIds:      consolidated.sourceMemoryIds ?? [],
    sourceCount:          (consolidated.sourceMemoryIds ?? []).length,
    latestSourceId:       latestSource?.id ?? null,
    latestSourceAt:       latestSource?.metadata?.timestamp ?? null,
    confidence:           consolidated.confidence,
    conflictInfo:         consolidated.conflictMeta ?? null,
    version:              consolidated.version ?? 1
  };
}
