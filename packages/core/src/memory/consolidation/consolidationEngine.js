/**
 * packages/core/src/memory/consolidation/consolidationEngine.js
 *
 * Thin orchestration layer for the Memory Consolidation pipeline.
 *
 * ─── Responsibilities ────────────────────────────────────────────────────────
 *
 *   findConsolidationCandidates(userId, storageRouter, config?, options?)
 *     Load all eligible memories for a user from the storage router, group
 *     them via candidateGrouping, and return the candidate groups ready for
 *     consolidation.
 *
 *   runConsolidationSweep(userId, storageRouter, consolidationStore, config?, opts?)
 *     Top-level orchestration sweep:
 *       1. Find candidate groups via findConsolidationCandidates.
 *       2. Load existing consolidations for the user.
 *       3. For each group: update (if shouldReConsolidate) or create new.
 *       4. Persist changes via consolidationStore.
 *       5. Return a result summary.
 *
 * ─── What this module does NOT do ────────────────────────────────────────────
 *
 *   All logic has been delegated to focused modules:
 *     candidateGrouping.js      — grouping and topic inference
 *     conflictResolution.js     — conflict detection and status determination
 *     consolidationBuilder.js   — building new ConsolidatedMemory records
 *     consolidationVersioning.js — updating, versioning, and provenance
 *
 * ─── Public API ───────────────────────────────────────────────────────────────
 *
 *   findConsolidationCandidates  (async)
 *   consolidateMemories          — re-exported from consolidationBuilder.js
 *   updateConsolidatedMemory     — re-exported from consolidationVersioning.js
 *   shouldReConsolidate          — re-exported from consolidationVersioning.js
 *   getProvenance                — re-exported from consolidationVersioning.js
 *   runConsolidationSweep        (async)
 */

import { LifecycleState }             from "../lifecycle/lifecycleTypes.js";
import { groupConsolidationCandidates } from "./candidateGrouping.js";
import { readConsolidationConfig }    from "./consolidationTypes.js";

// ─── Re-export public API from focused modules ────────────────────────────────

export { consolidateMemories }      from "./consolidationBuilder.js";
export {
  updateConsolidatedMemory,
  shouldReConsolidate,
  getProvenance
} from "./consolidationVersioning.js";

// ─── Candidate discovery ──────────────────────────────────────────────────────

/**
 * Fetch and group all eligible memories for a user into consolidation
 * candidate groups.
 *
 * This is the first step in the consolidation pipeline.  The groups returned
 * are ready to be passed to `consolidateMemories`.
 *
 * @param {string} userId
 * @param {{
 *   searchUserMemories: (userId: string) => Promise<object[]>
 * }} storageRouter
 * @param {ReturnType<typeof readConsolidationConfig>} [config]
 * @param {{ includeArchived?: boolean }} [options]
 * @returns {Promise<{
 *   groups:   import("./consolidationTypes.js").ConsolidationGroup[],
 *   total:    number,
 *   eligible: number,
 *   errors:   Array<{ context: string, error: string }>
 * }>}
 */
export async function findConsolidationCandidates(userId, storageRouter, config, options = {}) {
  const cfg    = config ?? readConsolidationConfig();
  const errors = [];

  let allMemories;
  try {
    allMemories = await storageRouter.searchUserMemories(userId);
  } catch (err) {
    return {
      groups:   [],
      total:    0,
      eligible: 0,
      errors:   [{ context: "load", error: err instanceof Error ? err.message : String(err) }]
    };
  }

  let groups;
  try {
    groups = groupConsolidationCandidates(allMemories, cfg, options);
  } catch (err) {
    return {
      groups:   [],
      total:    allMemories.length,
      eligible: 0,
      errors:   [{ context: "grouping", error: err instanceof Error ? err.message : String(err) }]
    };
  }

  const eligibleCount = allMemories.filter(
    (m) => m?.id && (
      (m?.metadata?.lifecycleState ?? LifecycleState.ACTIVE) !== LifecycleState.ARCHIVED ||
      options.includeArchived
    )
  ).length;

  return { groups, total: allMemories.length, eligible: eligibleCount, errors };
}

// ─── Sweep orchestration ──────────────────────────────────────────────────────

/**
 * Run a full consolidation sweep for a user.
 *
 * Orchestration steps:
 *   1. Fetch candidates via findConsolidationCandidates.
 *   2. Load existing consolidations for the user.
 *   3. For each group, check whether an existing consolidation covers it.
 *   4. If yes and shouldReConsolidate → updateConsolidatedMemory + store.update.
 *   5. If no → consolidateMemories + store.save.
 *   6. Return a result summary.
 *
 * @param {string} userId
 * @param {{
 *   searchUserMemories: (userId: string) => Promise<object[]>
 * }} storageRouter
 * @param {{
 *   findByUserId: (userId: string) => Promise<import("./consolidationTypes.js").ConsolidatedMemory[]>,
 *   save:         (record: object) => Promise<object>,
 *   update:       (id: string, patch: object) => Promise<object|null>
 * }} consolidationStore
 * @param {ReturnType<typeof readConsolidationConfig>} [config]
 * @param {{
 *   includeArchived?: boolean,
 *   summarise?: (memories: object[], topic: string) => string
 * }} [opts]
 * @returns {Promise<{
 *   created: number,
 *   updated: number,
 *   skipped: number,
 *   groups:  number,
 *   errors:  Array<{ context: string, error: string }>
 * }>}
 */
export async function runConsolidationSweep(
  userId,
  storageRouter,
  consolidationStore,
  config,
  opts = {}
) {
  // Import lazily to avoid circular references at module load time
  const { consolidateMemories }                  = await import("./consolidationBuilder.js");
  const { shouldReConsolidate, updateConsolidatedMemory } = await import("./consolidationVersioning.js");

  const cfg    = config ?? readConsolidationConfig();
  const errors = [];
  let created  = 0;
  let updated  = 0;
  let skipped  = 0;

  // Step 1: find candidate groups
  const { groups, errors: candidateErrors } = await findConsolidationCandidates(
    userId, storageRouter, cfg, opts
  );
  errors.push(...candidateErrors);

  if (groups.length === 0) {
    return { created, updated, skipped, groups: 0, errors };
  }

  // Step 2: fetch existing consolidations for this user
  let existing = [];
  try {
    existing = await consolidationStore.findByUserId(userId);
  } catch (err) {
    errors.push({
      context: "load-existing",
      error: err instanceof Error ? err.message : String(err)
    });
  }

  // Index existing consolidations by their first sorted source ID for fast lookup
  /** @type {Map<string, import("./consolidationTypes.js").ConsolidatedMemory>} */
  const existingByFirstId = new Map();
  for (const cons of existing) {
    const firstId = [...(cons.sourceMemoryIds ?? [])].sort()[0];
    if (firstId) existingByFirstId.set(firstId, cons);
  }

  // Step 3: process each group
  for (const group of groups) {
    try {
      const sortedGroupIds = [...group.memoryIds].sort();
      const firstId        = sortedGroupIds[0];
      const existingCons   = existingByFirstId.get(firstId);

      if (existingCons) {
        if (shouldReConsolidate(existingCons, group, cfg)) {
          const updated_ = updateConsolidatedMemory(existingCons, group, cfg, opts);
          await consolidationStore.update(existingCons.id, updated_);
          updated++;
        } else {
          skipped++;
        }
      } else {
        const record = consolidateMemories(group, cfg, opts);
        await consolidationStore.save(record);
        created++;
      }
    } catch (err) {
      errors.push({
        context: `group:${group.topic}`,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return { created, updated, skipped, groups: groups.length, errors };
}
