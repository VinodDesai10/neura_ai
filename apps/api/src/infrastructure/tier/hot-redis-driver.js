/**
 * apps/api/src/infrastructure/tier/hot-redis-driver.js
 *
 * Redis-backed driver for the hot-tier memory repository.
 *
 * Uses the existing `getRedisClient` connection — no new Redis client is
 * created.  Falls back silently to returning null/empty when Redis is
 * unavailable (e.g. REDIS_URL not set, connection failure in cooldown).
 *
 * ─── Redis key schema ─────────────────────────────────────────────────────────
 *
 *   Memory hash:   neura:tier:hot:{id}          ← JSON-serialised memory object
 *   User index:    neura:tier:hot:user:{userId}  ← Redis Set of IDs for that user
 *
 * ─── TTL ──────────────────────────────────────────────────────────────────────
 *
 *   Both the memory hash and the user-index set are set to HOT_TIER_TTL_SECONDS
 *   (7 days by default, overridable via TIER_HOT_TTL_SECONDS env var).
 *
 *   Every `save` or `update` refreshes the TTL so a memory stays hot as long
 *   as it keeps being written.
 *
 * ─── Graceful degradation ─────────────────────────────────────────────────────
 *
 *   All methods catch Redis errors and fall back to the in-memory Map that the
 *   `createHotRepository` factory maintains internally.  This means hot-tier
 *   reads/writes always succeed — Redis failure is treated as a transient
 *   "cache miss" rather than a hard error.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { getRedisClient } from "../redis/redis-client.js";
import { logger }         from "../../lib/logger.js";

const driverLog = logger.child({ component: "hot-redis-driver" });

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_HOT_TTL_SECONDS = 7 * 24 * 60 * 60;  // 7 days

function getTtl() {
  const v = Number(process.env.TIER_HOT_TTL_SECONDS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_HOT_TTL_SECONDS;
}

function memKey(id)     { return `neura:tier:hot:${id}`; }
function userKey(uid)   { return `neura:tier:hot:user:${uid}`; }

// ─── In-memory fallback (per-driver instance) ─────────────────────────────────

const _fallback = new Map();

function fallbackSave(memory) {
  _fallback.set(memory.id, { ...memory });
  return _fallback.get(memory.id);
}
function fallbackGet(id)        { return _fallback.get(id); }
function fallbackListByUser(uid) {
  return [..._fallback.values()].filter((m) => m.userId === uid);
}
function fallbackUpdate(id, patch) {
  const e = _fallback.get(id);
  if (!e) return null;
  const u = { ...e, ...patch, id };
  _fallback.set(id, u);
  return u;
}
function fallbackRemove(id) { return _fallback.delete(id); }

// ─── Driver ───────────────────────────────────────────────────────────────────

export const hotRedisDriver = {
  /**
   * Save (upsert) a memory to Redis.
   * Falls back to in-memory on error.
   */
  async save(memory) {
    const ttl = getTtl();
    try {
      const redis = await getRedisClient();
      if (redis) {
        const json = JSON.stringify(memory);
        await redis.set(memKey(memory.id), json, { EX: ttl });
        // Add to user index and refresh set TTL
        if (memory.userId) {
          await redis.sAdd(userKey(memory.userId), memory.id);
          await redis.expire(userKey(memory.userId), ttl);
        }
        return memory;
      }
    } catch (err) {
      driverLog.warn({ err, id: memory.id }, "hot-redis-driver.save: Redis error — using fallback");
    }
    return fallbackSave(memory);
  },

  /**
   * Retrieve a memory by ID.
   * Falls back to in-memory on error.
   */
  async get(id) {
    try {
      const redis = await getRedisClient();
      if (redis) {
        const raw = await redis.get(memKey(id));
        return raw ? JSON.parse(raw) : undefined;
      }
    } catch (err) {
      driverLog.warn({ err, id }, "hot-redis-driver.get: Redis error — using fallback");
    }
    return fallbackGet(id);
  },

  /**
   * List all memories for a user.
   * Falls back to in-memory on error.
   */
  async listByUser(userId) {
    try {
      const redis = await getRedisClient();
      if (redis) {
        const ids = await redis.sMembers(userKey(userId));
        if (!ids.length) return [];
        const raws = await redis.mGet(ids.map(memKey));
        return raws
          .filter(Boolean)
          .map((raw) => JSON.parse(raw));
      }
    } catch (err) {
      driverLog.warn({ err, userId }, "hot-redis-driver.listByUser: Redis error — using fallback");
    }
    return fallbackListByUser(userId);
  },

  /**
   * Patch an existing memory.  GET → merge → SET.
   * Falls back to in-memory on error.
   */
  async update(id, patch) {
    const ttl = getTtl();
    try {
      const redis = await getRedisClient();
      if (redis) {
        const raw = await redis.get(memKey(id));
        if (!raw) return null;
        const updated = { ...JSON.parse(raw), ...patch, id };
        await redis.set(memKey(id), JSON.stringify(updated), { EX: ttl });
        return updated;
      }
    } catch (err) {
      driverLog.warn({ err, id }, "hot-redis-driver.update: Redis error — using fallback");
    }
    return fallbackUpdate(id, patch);
  },

  /**
   * Remove a memory and clean up the user index.
   * Falls back to in-memory on error.
   */
  async remove(id) {
    try {
      const redis = await getRedisClient();
      if (redis) {
        // Read first so we know which user index to clean
        const raw = await redis.get(memKey(id));
        if (!raw) return false;
        const memory = JSON.parse(raw);
        await redis.del(memKey(id));
        if (memory.userId) {
          await redis.sRem(userKey(memory.userId), id);
        }
        return true;
      }
    } catch (err) {
      driverLog.warn({ err, id }, "hot-redis-driver.remove: Redis error — using fallback");
    }
    return fallbackRemove(id);
  },

  // ── Test helpers ─────────────────────────────────────────────────────────────
  _size()  { return _fallback.size; },
  _clear() { _fallback.clear(); }
};
