/**
 * packages/core/src/memory/repositories/hotRepository.js
 *
 * Hot-tier repository — holds the most recently accessed memories.
 *
 * ─── Backing store ────────────────────────────────────────────────────────────
 * The default export (`hotRepository`) uses an in-memory Map so the package
 * works standalone without any external service.
 *
 * For production use, inject a Redis-backed driver via `createHotRepository`:
 *
 *   import { createHotRepository } from "@neura/core";
 *   import { redisDriver } from "@neura/api/infrastructure/tier/hot-redis-driver.js";
 *   export const hotRepository = createHotRepository(redisDriver);
 *
 * ─── Driver contract ──────────────────────────────────────────────────────────
 * Any object passed to `createHotRepository` must implement:
 *
 *   save(memory)           → Promise<object>
 *   get(id)                → Promise<object|undefined>
 *   listByUser(userId)     → Promise<object[]>
 *   update(id, patch)      → Promise<object|null>
 *   remove(id)             → Promise<boolean>
 *
 * If `null` is passed the factory falls back to the built-in in-memory driver.
 *
 * ─── Hot-tier criteria (evaluated by tierManager.determineTier) ──────────────
 *   • lastAccessedAt (or timestamp) within the last 7 days
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── In-memory driver (default) ───────────────────────────────────────────────

/** @type {Map<string, object>} */
const _store = new Map();

const inMemoryDriver = {
  async save(memory) {
    const record = { ...memory };
    _store.set(record.id, record);
    return record;
  },
  async get(id) {
    return _store.get(id);
  },
  async listByUser(userId) {
    const results = [];
    for (const memory of _store.values()) {
      if (memory.userId === userId) results.push(memory);
    }
    return results;
  },
  async update(id, patch) {
    const existing = _store.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, id };
    _store.set(id, updated);
    return updated;
  },
  async remove(id) {
    return _store.delete(id);
  },
  // Test helpers
  _size() { return _store.size; },
  _clear() { _store.clear(); }
};

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a hot-tier repository backed by the provided driver.
 *
 * @param {object|null} driver  A driver implementing save/get/listByUser/update/remove.
 *                              Pass `null` to use the built-in in-memory driver.
 * @returns {{ save, get, listByUser, update, remove, size, clear }}
 */
export function createHotRepository(driver = null) {
  const d = driver || inMemoryDriver;

  return {
    /**
     * @param {object} memory - Must have an `id` string field.
     * @returns {Promise<object>}
     */
    async save(memory) {
      if (!memory?.id) throw new Error("hotRepository.save: memory.id is required");
      return d.save(memory);
    },

    /** @returns {Promise<object|undefined>} */
    async get(id) {
      return d.get(id);
    },

    /** @returns {Promise<object[]>} */
    async listByUser(userId) {
      return d.listByUser(userId);
    },

    /**
     * @param {string} id
     * @param {object} patch
     * @returns {Promise<object|null>}
     */
    async update(id, patch) {
      return d.update(id, patch);
    },

    /** @returns {Promise<boolean>} */
    async remove(id) {
      return d.remove(id);
    },

    // ── Test / introspection helpers ─────────────────────────────────────────
    size()  { return typeof d._size  === "function" ? d._size()  : undefined; },
    clear() { if (typeof d._clear === "function") d._clear(); }
  };
}

// ─── Default singleton (in-memory) ────────────────────────────────────────────

/**
 * Default hot-tier repository backed by an in-memory Map.
 * Safe to use everywhere — no external service required.
 */
export const hotRepository = createHotRepository(null);
