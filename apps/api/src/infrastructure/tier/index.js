/**
 * apps/api/src/infrastructure/tier/index.js
 *
 * Tier-repository bootstrap for the API process.
 *
 * Builds the three tier repositories by injecting the real persistence
 * drivers (Redis for hot, PostgreSQL for warm) and re-exports them under
 * the same names as the pure core singletons so callers can swap to this
 * module with a one-line import change.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *
 *   // In memory-processor.js or any API service:
 *   import { hotRepository, warmRepository, coldRepository, storageRouter }
 *     from "../infrastructure/tier/index.js";
 *
 * ─── Graceful degradation ─────────────────────────────────────────────────────
 *
 *   If REDIS_URL is absent or Redis is unreachable at startup, the hot driver
 *   silently falls back to its internal in-memory Map.  Same for POSTGRES_URL
 *   and the warm driver.  The cold tier always uses in-memory (no cold storage
 *   infrastructure configured yet).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHotRepository }  from "@neura/core";
import { createWarmRepository } from "@neura/core";
import { createColdRepository } from "@neura/core";
import {
  determineTier,
  getRepositoryForTier as _coreGetRepoForTier,
  Tier
} from "@neura/core";

import { hotRedisDriver }    from "./hot-redis-driver.js";
import { warmPostgresDriver } from "./warm-postgres-driver.js";

// ─── Instantiate tier repositories with real drivers ──────────────────────────

export const hotRepository  = createHotRepository(hotRedisDriver);
export const warmRepository = createWarmRepository(warmPostgresDriver);
export const coldRepository = createColdRepository(null);   // in-memory placeholder

// ─── Tier-aware lookup (same contract as core's getRepositoryForTier) ─────────

const _repoMap = {
  [Tier.HOT]:  hotRepository,
  [Tier.WARM]: warmRepository,
  [Tier.COLD]: coldRepository
};

export function getRepositoryForTier(tier) {
  const repo = _repoMap[tier];
  if (!repo) throw new Error(`tier/index: unknown tier "${tier}"`);
  return repo;
}

// ─── Inline storage-router wired to real adapters ─────────────────────────────
//
// Mirrors storageRouter from @neura/core but uses the persisted repos.
// The core storageRouter imports the core singletons at module load time
// (which are in-memory), so we provide a parallel router here that uses the
// real adapters.

const ALL_TIERS = [
  { tier: Tier.HOT,  repo: hotRepository  },
  { tier: Tier.WARM, repo: warmRepository },
  { tier: Tier.COLD, repo: coldRepository }
];

function withTierMeta(memory, tier) {
  return { ...memory, metadata: { ...memory.metadata, tier } };
}

function stampAccess(memory) {
  return {
    ...memory,
    metadata: {
      ...memory.metadata,
      lastAccessedAt: new Date().toISOString(),
      accessCount:    (memory.metadata?.accessCount ?? 0) + 1
    }
  };
}

export const storageRouter = {
  async saveMemory(memory) {
    const tier = determineTier(memory);
    const repo = getRepositoryForTier(tier);
    return repo.save(withTierMeta(memory, tier));
  },

  async getMemory(id) {
    for (const { repo } of ALL_TIERS) {
      const memory = await repo.get(id);
      if (memory) {
        const accessed = stampAccess(memory);
        await repo.update(id, accessed);
        return accessed;
      }
    }
    return null;
  },

  async searchUserMemories(userId) {
    const [hotMems, warmMems, coldMems] = await Promise.all([
      hotRepository.listByUser(userId),
      warmRepository.listByUser(userId),
      coldRepository.listByUser(userId)
    ]);
    const all = [...hotMems, ...warmMems, ...coldMems];
    all.sort((a, b) => (b.metadata?.importance ?? 0) - (a.metadata?.importance ?? 0));
    return all;
  },

  async updateMemory(id, patch) {
    for (const { repo } of ALL_TIERS) {
      const existing = await repo.get(id);
      if (existing) return repo.update(id, patch);
    }
    return null;
  },

  async removeMemory(id) {
    for (const { repo } of ALL_TIERS) {
      const removed = await repo.remove(id);
      if (removed) return true;
    }
    return false;
  }
};
