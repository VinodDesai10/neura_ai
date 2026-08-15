/**
 * packages/core/src/memory/services/tierManager.js
 *
 * Tier assignment and lifecycle management for the hot/warm/cold storage
 * hierarchy.
 *
 * ─── Tier thresholds ─────────────────────────────────────────────────────────
 *
 *   HOT   lastAccessedAt (or timestamp) within the last 7 days
 *         → Fast path. Served from SQLite/Redis in production.
 *
 *   WARM  importance >= 0.7  (and NOT hot)
 *         → Important memories kept in warm storage even after they cool off.
 *           Served from PostgreSQL in production.
 *
 *   COLD  older than 90 days AND importance < 0.4
 *         → Archive tier. Served from S3/MinIO in production.
 *
 *   Anything that doesn't match hot or cold criteria stays in WARM (the
 *   default "middle ground").
 *
 * ─── Promotion / demotion ─────────────────────────────────────────────────────
 *
 *   promote(memory, fromRepo, toRepo)
 *     Saves the memory in the target repo, removes it from the source,
 *     and stamps metadata.tier on the returned record.
 *
 *   demote(memory, fromRepo, toRepo)
 *     Same mechanics — the naming is purely semantic (demote = move to a
 *     slower/cheaper tier).
 *
 * ─── rebalance(userId) ────────────────────────────────────────────────────────
 *
 *   Iterates over all three tiers for a given user and moves memories to
 *   the tier that matches their current determineTier() result.  This is
 *   intended to be called periodically (e.g. a nightly cron job) rather
 *   than on every read.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { hotRepository }  from "../repositories/hotRepository.js";
import { warmRepository } from "../repositories/warmRepository.js";
import { coldRepository } from "../repositories/coldRepository.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Memories accessed within this many milliseconds are HOT. */
const HOT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days

/** Memories older than this many milliseconds with low importance are COLD. */
const COLD_AGE_MS   = 90 * 24 * 60 * 60 * 1000;  // 90 days

/** Importance threshold for the warm tier (inclusive). */
const WARM_IMPORTANCE_THRESHOLD = 0.7;

/** Importance ceiling for the cold tier (exclusive). */
const COLD_IMPORTANCE_THRESHOLD = 0.4;

/** @enum {string} */
export const Tier = Object.freeze({
  HOT:  "hot",
  WARM: "warm",
  COLD: "cold"
});

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Parse a date field (ISO string or Date) to milliseconds-since-epoch.
 * Returns `null` when the value is absent or unparseable.
 *
 * @param {string|Date|null|undefined} value
 * @returns {number|null}
 */
function toMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Resolve the effective "last interaction" timestamp for a memory.
 *
 * Priority:
 *   1. metadata.lastAccessedAt  — most recent read
 *   2. metadata.timestamp       — creation time (fallback)
 *
 * @param {object} memory
 * @returns {number|null}
 */
function lastInteractionMs(memory) {
  return (
    toMs(memory.metadata?.lastAccessedAt) ??
    toMs(memory.metadata?.timestamp)      ??
    null
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Determine which storage tier a memory belongs in based on its current
 * metadata values.
 *
 * Rules (evaluated in priority order):
 *   1. HOT  — last interaction within 7 days
 *   2. COLD — creation time > 90 days ago AND importance < 0.4
 *   3. WARM — default (includes: important memories that have cooled off)
 *
 * @param {object} memory
 * @returns {"hot"|"warm"|"cold"}
 */
export function determineTier(memory) {
  const nowMs    = Date.now();
  const lastMs   = lastInteractionMs(memory);
  const importance = memory.metadata?.importance ?? 0;

  // Rule 1 — HOT: recently accessed
  if (lastMs !== null && nowMs - lastMs <= HOT_WINDOW_MS) {
    return Tier.HOT;
  }

  // Rule 2 — COLD: stale + low importance
  const createdMs = toMs(memory.metadata?.timestamp);
  if (
    createdMs !== null &&
    nowMs - createdMs > COLD_AGE_MS &&
    importance < COLD_IMPORTANCE_THRESHOLD
  ) {
    return Tier.COLD;
  }

  // Rule 3 — WARM: default (covers high-importance memories that cooled off)
  return Tier.WARM;
}

/**
 * Move a memory from a source repository into the hot tier.
 *
 * Also sets `metadata.tier = "hot"` and `metadata.lastAccessedAt` on the
 * record so subsequent calls to `determineTier` keep it hot.
 *
 * @param {object} memory
 * @param {{ remove: (id: string) => Promise<boolean> }} fromRepo
 *   The repository the memory currently lives in.
 * @returns {Promise<object>} The newly saved hot record.
 */
export async function promote(memory, fromRepo) {
  const promoted = {
    ...memory,
    metadata: {
      ...memory.metadata,
      tier:           Tier.HOT,
      lastAccessedAt: new Date().toISOString()
    }
  };

  const saved = await hotRepository.save(promoted);
  await fromRepo.remove(memory.id);
  return saved;
}

/**
 * Move a memory from a source repository into a lower (cooler) tier.
 *
 * `toRepo` must be either `warmRepository` or `coldRepository`.
 *
 * @param {object} memory
 * @param {{ remove: (id: string) => Promise<boolean> }} fromRepo
 *   The repository the memory currently lives in.
 * @param {{ save: (memory: object) => Promise<object> }} toRepo
 *   The target (cooler) repository.
 * @returns {Promise<object>} The newly saved demoted record.
 */
export async function demote(memory, fromRepo, toRepo) {
  const targetTier = toRepo === coldRepository ? Tier.COLD : Tier.WARM;

  const demoted = {
    ...memory,
    metadata: {
      ...memory.metadata,
      tier: targetTier
    }
  };

  const saved = await toRepo.save(demoted);
  await fromRepo.remove(memory.id);
  return saved;
}

/**
 * Rebalance all memories for a given user across the three tiers.
 *
 * For each memory in each tier, `determineTier` is called.  When the
 * computed tier differs from the memory's current location, the record is
 * moved to the correct tier.
 *
 * The function returns a summary of what was moved.
 *
 * @param {string} userId
 * @returns {Promise<{
 *   moved:  Array<{ id: string, from: string, to: string }>,
 *   total:  number,
 *   errors: Array<{ id: string, error: string }>
 * }>}
 */
export async function rebalance(userId) {
  const tierMap = {
    [Tier.HOT]:  hotRepository,
    [Tier.WARM]: warmRepository,
    [Tier.COLD]: coldRepository
  };

  const moved  = [];
  const errors = [];

  // Gather all memories across tiers for this user
  const [hotMemories, warmMemories, coldMemories] = await Promise.all([
    hotRepository.listByUser(userId),
    warmRepository.listByUser(userId),
    coldRepository.listByUser(userId)
  ]);

  const entries = [
    ...hotMemories.map((m) => ({ memory: m, currentTier: Tier.HOT })),
    ...warmMemories.map((m) => ({ memory: m, currentTier: Tier.WARM })),
    ...coldMemories.map((m) => ({ memory: m, currentTier: Tier.COLD }))
  ];

  for (const { memory, currentTier } of entries) {
    const targetTier = determineTier(memory);
    if (targetTier === currentTier) continue;

    try {
      const fromRepo = tierMap[currentTier];
      const toRepo   = tierMap[targetTier];

      const updated = {
        ...memory,
        metadata: {
          ...memory.metadata,
          tier: targetTier
        }
      };

      await toRepo.save(updated);
      await fromRepo.remove(memory.id);

      moved.push({ id: memory.id, from: currentTier, to: targetTier });
    } catch (err) {
      errors.push({
        id:    memory.id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return {
    moved,
    total:  entries.length,
    errors
  };
}

/**
 * Convenience: resolve the repository instance for a given tier name.
 *
 * @param {"hot"|"warm"|"cold"} tier
 * @returns {{ save, get, listByUser, update, remove }}
 * @throws {Error} For unknown tier values.
 */
export function getRepositoryForTier(tier) {
  switch (tier) {
    case Tier.HOT:  return hotRepository;
    case Tier.WARM: return warmRepository;
    case Tier.COLD: return coldRepository;
    default:
      throw new Error(`tierManager.getRepositoryForTier: unknown tier "${tier}"`);
  }
}

// ─── Re-export constants for convenience ─────────────────────────────────────
export { HOT_WINDOW_MS, COLD_AGE_MS, WARM_IMPORTANCE_THRESHOLD, COLD_IMPORTANCE_THRESHOLD };
