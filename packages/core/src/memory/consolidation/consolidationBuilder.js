/**
 * packages/core/src/memory/consolidation/consolidationBuilder.js
 *
 * Builds a ConsolidatedMemory record from a ConsolidationGroup.
 *
 * ─── Responsibilities ────────────────────────────────────────────────────────
 *
 *   consolidateMemories(group, config?, opts?)
 *     Synthesise a new ConsolidatedMemory from a ConsolidationGroup.
 *     Does NOT write to any store — returns the record for the caller to
 *     persist via consolidationStore.save().
 *
 * ─── Supporting helpers (private) ────────────────────────────────────────────
 *
 *   makeConsolidatedId     — Stable, deterministic ID from userId + topic + sources
 *   electBestSource        — Pick the source with the highest composite score
 *   synthesiseSummary      — Build a short summary from source content (no LLM)
 *   computeAggregateConfidence — Importance-weighted average confidence
 *   computeAggregateImportance — Average importance, slightly boosted, capped at 0.95
 *   unionTags              — Union of all source tags + "consolidated" tag
 *
 * ─── Determinism guarantee ────────────────────────────────────────────────────
 *
 *   No LLM calls.  Summaries are produced via structured extraction:
 *     - Pick the best source (highest confidence × importance, recency tiebreak).
 *     - Trim to ≤ 200 characters.
 *     - Fallback: "Consolidated <topic> knowledge from N sources".
 *
 *   An LLM summariser can be plugged in later via opts.summarise.
 *
 * ─── Public API ───────────────────────────────────────────────────────────────
 *
 *   consolidateMemories(group, config?, opts?) → ConsolidatedMemory
 */

import { clampScore }           from "@neura/shared";
import {
  readConsolidationConfig
} from "./consolidationTypes.js";
import {
  detectGroupConflicts,
  overallSeverity,
  determineStatus
} from "./conflictResolution.js";

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Generate a stable ID for a consolidated memory.
 * Format: "con_{userId}_{topic}_{sortedFirstTwoIds}"
 *
 * Uses the first two sorted source IDs as a deterministic seed so the same
 * group always produces the same ID across re-runs.
 *
 * @param {string}   userId
 * @param {string}   topic
 * @param {string[]} sortedIds  - Source IDs in sorted order
 * @returns {string}
 */
function makeConsolidatedId(userId, topic, sortedIds) {
  const seed = sortedIds.slice(0, 2).join("-");
  return `con_${userId}_${topic}_${seed}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Elect the "best" source memory from a group.
 *
 * Preference:
 *   1. Highest (confidence × importance) composite score.
 *   2. Most recent timestamp as tiebreaker.
 *
 * @param {object[]} memories
 * @returns {object}
 */
export function electBestSource(memories) {
  let best      = memories[0];
  let bestScore = 0;

  for (const mem of memories) {
    const conf = mem?.metadata?.confidence ?? 0.5;
    const imp  = mem?.metadata?.importance ?? 0.5;
    const ts   = mem?.metadata?.timestamp
      ? new Date(mem.metadata.timestamp).getTime()
      : 0;
    // Composite: 70% conf×imp + 30% recency (normalised to 0–1 over process lifetime)
    const recencyNorm = Math.min(1, ts / Date.now());
    const score = (conf * imp) * 0.7 + recencyNorm * 0.3;

    if (score > bestScore) {
      bestScore = score;
      best = mem;
    }
  }

  return best;
}

/**
 * Synthesise a short summary from a group of source memories.
 *
 * Deterministic — no LLM.  Takes the best source's content and trims it.
 * The design allows swapping this function for an async LLM call in the
 * future by making callers pass an optional `summarise` hook via opts.
 *
 * @param {object[]} memories  - Source memories in the group
 * @param {string}   topic     - Inferred topic label
 * @returns {string}
 */
function synthesiseSummary(memories, topic) {
  const best    = electBestSource(memories);
  const content = best?.content ?? best?.summary ?? "";

  // Prefer summary if content is very long
  const source = content.length > 200 && best?.summary
    ? best.summary
    : content;

  const trimmed = source.length > 200 ? source.slice(0, 197) + "…" : source;
  return trimmed || `Consolidated ${topic} knowledge from ${memories.length} sources`;
}

/**
 * Compute aggregate confidence from source memories.
 *
 * Weighted average: higher-importance sources carry more weight.
 *
 * @param {object[]} memories
 * @returns {number}
 */
export function computeAggregateConfidence(memories) {
  let weightedSum = 0;
  let totalWeight = 0;

  for (const mem of memories) {
    const conf = mem?.metadata?.confidence ?? 0.5;
    const imp  = mem?.metadata?.importance ?? 0.5;
    weightedSum += conf * imp;
    totalWeight += imp;
  }

  return totalWeight > 0
    ? clampScore(weightedSum / totalWeight)
    : clampScore(memories.reduce((s, m) => s + (m?.metadata?.confidence ?? 0.5), 0) / memories.length);
}

/**
 * Compute aggregate importance from source memories.
 *
 * Slightly boosted (×1.1) to reflect the extra value of synthesis.
 * Capped at 0.95 to signal that consolidated memories are derivatives.
 *
 * @param {object[]} memories
 * @returns {number}
 */
export function computeAggregateImportance(memories) {
  const avg = memories.reduce((s, m) => s + (m?.metadata?.importance ?? 0.5), 0) / memories.length;
  return clampScore(Math.min(0.95, avg * 1.1));
}

/**
 * Collect the union of tags from all source memories.
 * Always includes the "consolidated" tag.
 *
 * @param {object[]} memories
 * @returns {string[]}
 */
export function unionTags(memories) {
  const tags = new Set();
  for (const mem of memories) {
    const memTags = mem?.metadata?.tags ?? [];
    for (const t of memTags) tags.add(t);
  }
  tags.add("consolidated");
  return [...tags];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Synthesise a ConsolidatedMemory from a ConsolidationGroup.
 *
 * Does NOT write to any store — returns the new record for the caller to
 * persist via consolidationStore.save().
 *
 * @param {import("./consolidationTypes.js").ConsolidationGroup} group
 * @param {ReturnType<typeof readConsolidationConfig>} [config]
 * @param {{
 *   summarise?: (memories: object[], topic: string) => string
 * }} [opts]
 * @returns {import("./consolidationTypes.js").ConsolidatedMemory}
 */
export function consolidateMemories(group, config, opts = {}) {
  const cfg      = config ?? readConsolidationConfig();
  const memories = group.memories;

  // Sort source IDs deterministically so the generated ID is stable.
  const sortedIds = [...group.memoryIds].sort();

  // Conflict detection
  const { records: conflictRecords, hasConflict } = detectGroupConflicts(memories, cfg);

  // Summary synthesis (deterministic by default; LLM hook available via opts.summarise)
  const summary = typeof opts.summarise === "function"
    ? opts.summarise(memories, group.topic)
    : synthesiseSummary(memories, group.topic);

  // Status
  const status = determineStatus(memories, hasConflict, cfg);

  // Aggregate scores
  const confidence      = computeAggregateConfidence(memories);
  const importanceScore = computeAggregateImportance(memories);

  // Preferred source for conflict resolution
  const bestSource = electBestSource(memories);

  // Conflict metadata
  const conflictMeta = hasConflict
    ? {
        conflicts:      conflictRecords,
        conflictingIds: [...new Set(conflictRecords.flatMap((r) => [r.memoryIdA, r.memoryIdB]))],
        severity:       overallSeverity(conflictRecords),
        resolvedWith:   bestSource.id,
        detectedAt:     new Date().toISOString(),
        reason:         `${conflictRecords.length} conflict(s) detected among ${memories.length} source memories`
      }
    : null;

  const now = new Date().toISOString();

  return {
    id:              makeConsolidatedId(group.userId ?? "unknown", group.topic, sortedIds),
    userId:          group.userId,
    topic:           group.topic,
    summary,
    sourceMemoryIds: sortedIds,
    confidence,
    importanceScore,
    createdAt:       now,
    updatedAt:       now,
    version:         1,
    status,
    conflictMeta,
    memoryType:      group.memoryType,
    tags:            unionTags(memories),
    domain:          memories[0]?.metadata?.domain ?? "general"
  };
}
