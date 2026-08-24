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
import { factualMemoryStore } from "../postgres/factual-memory-store.js";
import { vectorMemoryStore }  from "../qdrant/vector-memory-store.js";
import { deleteMemory as deleteNeo4jMemory } from "../neo4j/relationship-graph-store.js";
import { consolidationStore } from "../consolidation-store.js";
import { logger } from "../../lib/logger.js";

const routerLog = logger.child({ component: "storage-router" });

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
    /**
     * Complete cross-store deletion cascade.
     *
     * Every backend is attempted independently so that one failure does not
     * prevent the others from running.  The result carries per-store status
     * so callers can surface partial failures to operators.
     *
     * Returns:
     *   { found: boolean, stores: { [name]: "ok" | "not_found" | "skipped" | Error } }
     *
     * "found" is true when at least one tier repo held the record (the
     * canonical "did this memory exist?" signal).
     * "stores" enumerates every backend that was touched.
     */
    const stores = {};

    // ── 1. Tier repos (hot Redis + warm Postgres + cold) ─────────────────────
    let foundInTier = false;
    for (const { tier, repo } of ALL_TIERS) {
      try {
        const removed = await repo.remove(id);
        if (removed) foundInTier = true;
        stores[`tier:${tier}`] = removed ? "ok" : "not_found";
      } catch (err) {
        stores[`tier:${tier}`] = err;
        routerLog.warn({ err, id, tier }, "removeMemory: tier repo removal failed");
      }
    }

    // ── 2. Postgres factual_memories ─────────────────────────────────────────
    try {
      const removed = await factualMemoryStore.delete(id);
      stores["postgres:factual"] = removed ? "ok" : "not_found";
    } catch (err) {
      stores["postgres:factual"] = err;
      routerLog.warn({ err, id }, "removeMemory: factual-memory-store deletion failed");
    }

    // ── 3. Qdrant vector store ────────────────────────────────────────────────
    try {
      const removed = await vectorMemoryStore.delete(id);
      stores["qdrant:vector"] = removed ? "ok" : "not_found";
    } catch (err) {
      stores["qdrant:vector"] = err;
      routerLog.warn({ err, id }, "removeMemory: vector-memory-store deletion failed");
    }

    // ── 4. Neo4j Memory node (DETACH DELETE — removes all relationships) ──────
    try {
      const removed = await deleteNeo4jMemory(id);
      stores["neo4j:memory"] = removed ? "ok" : "not_found";
    } catch (err) {
      stores["neo4j:memory"] = err;
      routerLog.warn({ err, id }, "removeMemory: Neo4j deletion failed");
    }

    // ── 5. Consolidation provenance ───────────────────────────────────────────
    //
    // Find every consolidation that lists this memory as a source, then:
    //   a) remove the ID from sourceMemoryIds
    //   b) if no sources remain, delete the consolidation entirely
    try {
      const affected = await consolidationStore.findBySourceMemoryId(id);
      for (const consolidation of affected) {
        try {
          const remaining = (consolidation.sourceMemoryIds || []).filter((sid) => sid !== id);
          if (remaining.length === 0) {
            await consolidationStore.remove(consolidation.id);
            stores[`consolidation:${consolidation.id}`] = "removed";
          } else {
            await consolidationStore.update(consolidation.id, { sourceMemoryIds: remaining });
            stores[`consolidation:${consolidation.id}`] = "updated";
          }
        } catch (err) {
          stores[`consolidation:${consolidation.id}`] = err;
          routerLog.warn(
            { err, id, consolidationId: consolidation.id },
            "removeMemory: consolidation provenance update failed"
          );
        }
      }
    } catch (err) {
      stores["consolidation:lookup"] = err;
      routerLog.warn({ err, id }, "removeMemory: consolidation lookup failed");
    }

    // ── Determine whether any failure occurred ────────────────────────────────
    const failures = Object.entries(stores)
      .filter(([, v]) => v instanceof Error)
      .map(([k]) => k);

    if (failures.length > 0) {
      const summary = `removeMemory(${id}): partial failure in [${failures.join(", ")}]`;
      routerLog.error({ id, failures, stores }, summary);
      const err = new Error(summary);
      err.code   = "PARTIAL_DELETE_FAILURE";
      err.stores = stores;
      throw err;
    }

    const found = foundInTier ||
      stores["postgres:factual"] === "ok" ||
      stores["qdrant:vector"]    === "ok" ||
      stores["neo4j:memory"]     === "ok";

    return found;
  }
};
