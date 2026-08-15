/**
 * packages/core/src/memory/services/storageRouter.js
 *
 * Central entry point for reading and writing tiered memories.
 *
 * The router is the ONLY component callers should interact with when
 * persisting or retrieving memories.  It handles:
 *
 *   • Tier assignment   — calls tierManager.determineTier() on every save
 *   • Cross-tier reads  — getMemory / searchUserMemories fans out to all tiers
 *   • Access tracking   — bumps metadata.lastAccessedAt and accessCount on get
 *   • Update routing    — finds the correct tier before patching
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *
 *   import { storageRouter } from "@neura/core";
 *
 *   // Store a new memory (tier is chosen automatically)
 *   const saved = await storageRouter.saveMemory(candidate);
 *
 *   // Retrieve by ID (searches all three tiers)
 *   const mem = await storageRouter.getMemory(id);
 *
 *   // All memories for a user, sorted by importance desc
 *   const all = await storageRouter.searchUserMemories(userId);
 *
 *   // Apply a partial update
 *   const updated = await storageRouter.updateMemory(id, { content: "…" });
 *
 *   // Remove a memory (searches all three tiers)
 *   const removed = await storageRouter.removeMemory(id);
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  determineTier,
  getRepositoryForTier,
  Tier
} from "./tierManager.js";

import { hotRepository }  from "../repositories/hotRepository.js";
import { warmRepository } from "../repositories/warmRepository.js";
import { coldRepository } from "../repositories/coldRepository.js";

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** @type {Array<{ tier: string, repo: object }>} */
const ALL_TIERS = [
  { tier: Tier.HOT,  repo: hotRepository  },
  { tier: Tier.WARM, repo: warmRepository },
  { tier: Tier.COLD, repo: coldRepository }
];

/**
 * Stamp the memory with the resolved tier in its metadata.
 *
 * @param {object} memory
 * @param {string} tier
 * @returns {object}
 */
function withTierMeta(memory, tier) {
  return {
    ...memory,
    metadata: {
      ...memory.metadata,
      tier
    }
  };
}

/**
 * Return an updated copy of memory with lastAccessedAt set to now and
 * accessCount incremented by 1.
 *
 * @param {object} memory
 * @returns {object}
 */
function stampAccess(memory) {
  const accessCount = (memory.metadata?.accessCount ?? 0) + 1;
  return {
    ...memory,
    metadata: {
      ...memory.metadata,
      lastAccessedAt: new Date().toISOString(),
      accessCount
    }
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Determine the appropriate tier and persist the memory.
 *
 * The memory object should have at minimum:
 *   - id           {string}  — unique identifier
 *   - userId       {string|null}
 *   - metadata.importance  {number}
 *   - metadata.timestamp   {string}  — ISO-8601 creation time
 *
 * If `metadata.tier` is already set it is overwritten by the router's own
 * tier evaluation to prevent callers from bypassing tier logic.
 *
 * @param {object} memory
 * @returns {Promise<object>} The stored memory with `metadata.tier` set.
 */
export async function saveMemory(memory) {
  const tier = determineTier(memory);
  const repo = getRepositoryForTier(tier);
  return repo.save(withTierMeta(memory, tier));
}

/**
 * Retrieve a memory by ID, searching hot → warm → cold.
 *
 * On a cache hit the record's `lastAccessedAt` and `accessCount` are updated
 * in-place so the tier manager can keep the record hot on the next rebalance.
 *
 * @param {string} id
 * @returns {Promise<object|null>} The memory, or `null` if not found in any tier.
 */
export async function getMemory(id) {
  for (const { tier, repo } of ALL_TIERS) {
    const memory = await repo.get(id);
    if (memory) {
      // Stamp the access and persist back so tier-recalc picks it up
      const accessed = stampAccess(memory);
      await repo.update(id, accessed);
      return accessed;
    }
  }
  return null;
}

/**
 * Return all memories for a user, merged across all three tiers.
 *
 * Results are sorted by `metadata.importance` descending so callers get the
 * highest-value memories first.
 *
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
export async function searchUserMemories(userId) {
  const [hotMems, warmMems, coldMems] = await Promise.all([
    hotRepository.listByUser(userId),
    warmRepository.listByUser(userId),
    coldRepository.listByUser(userId)
  ]);

  const all = [...hotMems, ...warmMems, ...coldMems];

  // Sort by importance descending; fallback to 0 for missing values
  all.sort(
    (a, b) =>
      (b.metadata?.importance ?? 0) - (a.metadata?.importance ?? 0)
  );

  return all;
}

/**
 * Apply a partial update to a memory wherever it lives.
 *
 * Searches hot → warm → cold.  Returns `null` if the memory is not found.
 *
 * @param {string} id
 * @param {object} patch
 * @returns {Promise<object|null>}
 */
export async function updateMemory(id, patch) {
  for (const { repo } of ALL_TIERS) {
    const existing = await repo.get(id);
    if (existing) {
      return repo.update(id, patch);
    }
  }
  return null;
}

/**
 * Remove a memory from whatever tier it lives in.
 *
 * @param {string} id
 * @returns {Promise<boolean>} `true` if the record was found and removed.
 */
export async function removeMemory(id) {
  for (const { repo } of ALL_TIERS) {
    const removed = await repo.remove(id);
    if (removed) return true;
  }
  return false;
}

/**
 * Convenience: expose all three repositories for cases where callers need
 * direct tier access (e.g. the tier manager's rebalance loop).
 */
export { hotRepository, warmRepository, coldRepository };

// ─── Named export object for convenience import ───────────────────────────────

/**
 * Default export — a single object bundling all router methods.
 * Allows `import storageRouter from "…"` as well as named imports.
 */
export const storageRouter = {
  saveMemory,
  getMemory,
  searchUserMemories,
  updateMemory,
  removeMemory
};
