/**
 * packages/core/src/memory/repositories/coldRepository.js
 *
 * Cold-tier repository — long-term archive for old, low-importance memories.
 *
 * ─── Backing store ────────────────────────────────────────────────────────────
 * No existing object-storage (S3/MinIO) infrastructure is available in the
 * current codebase.  The default export uses an in-memory Map as a safe
 * placeholder that works everywhere without configuration.
 *
 * When a real cold-storage adapter becomes available, inject it at startup:
 *
 *   import { createColdRepository } from "@neura/core";
 *   import { s3Driver } from "@neura/api/infrastructure/tier/cold-s3-driver.js";
 *   export const coldRepository = createColdRepository(s3Driver);
 *
 * ─── Driver contract ──────────────────────────────────────────────────────────
 * Any object passed to `createColdRepository` must implement:
 *
 *   save(memory)           → Promise<object>
 *   get(id)                → Promise<object|undefined>
 *   listByUser(userId)     → Promise<object[]>
 *   update(id, patch)      → Promise<object|null>
 *   remove(id)             → Promise<boolean>
 *
 * ─── Cold-tier criteria (evaluated by tierManager.determineTier) ─────────────
 *   • created > 90 days ago AND importance < 0.4
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── In-memory driver (default / placeholder) ─────────────────────────────────

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
 * Create a cold-tier repository backed by the provided driver.
 *
 * The cold tier is intentionally pluggable.  No infrastructure is created
 * automatically — pass a real driver when one becomes available.
 *
 * @param {object|null} driver
 * @returns {{ save, get, listByUser, update, remove, size, clear }}
 */
export function createColdRepository(driver = null) {
  const d = driver || inMemoryDriver;

  return {
    async save(memory) {
      if (!memory?.id) throw new Error("coldRepository.save: memory.id is required");
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

export const coldRepository = createColdRepository(null);
