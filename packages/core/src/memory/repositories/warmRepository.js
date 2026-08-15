/**
 * packages/core/src/memory/repositories/warmRepository.js
 *
 * Warm-tier repository — holds important memories that have cooled off.
 *
 * ─── Backing store ────────────────────────────────────────────────────────────
 * The default export (`warmRepository`) uses an in-memory Map so the package
 * works standalone without any external service.
 *
 * For production use, inject a PostgreSQL-backed driver via `createWarmRepository`:
 *
 *   import { createWarmRepository } from "@neura/core";
 *   import { postgresDriver } from "@neura/api/infrastructure/tier/warm-postgres-driver.js";
 *   export const warmRepository = createWarmRepository(postgresDriver);
 *
 * ─── Driver contract ──────────────────────────────────────────────────────────
 * Any object passed to `createWarmRepository` must implement:
 *
 *   save(memory)           → Promise<object>
 *   get(id)                → Promise<object|undefined>
 *   listByUser(userId)     → Promise<object[]>
 *   update(id, patch)      → Promise<object|null>
 *   remove(id)             → Promise<boolean>
 *
 * ─── Warm-tier criteria (evaluated by tierManager.determineTier) ─────────────
 *   • importance >= 0.7 AND not hot
 *   • OR: any memory that doesn't qualify as hot or cold
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
  _size()  { return _store.size; },
  _clear() { _store.clear(); }
};

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a warm-tier repository backed by the provided driver.
 *
 * @param {object|null} driver
 * @returns {{ save, get, listByUser, update, remove, size, clear }}
 */
export function createWarmRepository(driver = null) {
  const d = driver || inMemoryDriver;

  return {
    async save(memory) {
      if (!memory?.id) throw new Error("warmRepository.save: memory.id is required");
      return d.save(memory);
    },
    async get(id) {
      return d.get(id);
    },
    async listByUser(userId) {
      return d.listByUser(userId);
    },
    async update(id, patch) {
      return d.update(id, patch);
    },
    async remove(id) {
      return d.remove(id);
    },
    size()  { return typeof d._size  === "function" ? d._size()  : undefined; },
    clear() { if (typeof d._clear === "function") d._clear(); }
  };
}

// ─── Default singleton (in-memory) ────────────────────────────────────────────

export const warmRepository = createWarmRepository(null);
