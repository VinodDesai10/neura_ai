/**
 * packages/core/src/memory/repositories/hotRepository.js
 *
 * Hot-tier repository — holds the most recently accessed memories.
 *
 * Current backing store: in-memory Map.
 *
 * Future adapter target: SQLite (local sub-millisecond reads) or Redis
 * (shared across API replicas with configurable TTL eviction).
 *
 * Design contract — every tier repository exposes the same five methods so
 * the StorageRouter can treat all tiers uniformly:
 *
 *   save(memory)           → stored memory object
 *   get(id)                → memory | undefined
 *   listByUser(userId)     → memory[]
 *   update(id, patch)      → updated memory | null
 *   remove(id)             → boolean (true if the record existed)
 *
 * When swapping to a real adapter:
 *   1. Replace the Map with your DB client / ORM instance.
 *   2. Keep the exact same method signatures so the router requires no changes.
 *   3. The constructor (or a factory) should accept a config/connection object.
 *
 * ─── Hot-tier criteria (evaluated by tierManager.determineTier) ──────────────
 *   • metadata.lastAccessedAt is within the last 7 days, OR
 *   • metadata.accessCount > 0 and the record was just saved (new arrival)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── In-memory store ──────────────────────────────────────────────────────────

/** @type {Map<string, object>} */
const _store = new Map();

// ─── Repository ───────────────────────────────────────────────────────────────

/**
 * Hot-tier memory repository.
 *
 * All methods are async so the interface is identical to future I/O-bound
 * adapters — callers must always await them.
 */
export const hotRepository = {
  /**
   * Persist a memory in the hot tier.
   *
   * The memory is stored as-is (shallow copy).  If a record with the same
   * `id` already exists it is overwritten — equivalent to an upsert.
   *
   * @param {object} memory - Fully-formed memory object with at minimum an
   *   `id` string field.
   * @returns {Promise<object>} The stored memory.
   * @throws {Error} When `memory.id` is missing.
   */
  async save(memory) {
    if (!memory?.id) throw new Error("hotRepository.save: memory.id is required");
    const record = { ...memory };
    _store.set(record.id, record);
    return record;
  },

  /**
   * Retrieve a single memory by its ID.
   *
   * @param {string} id
   * @returns {Promise<object|undefined>} The memory, or `undefined` if not found.
   */
  async get(id) {
    return _store.get(id);
  },

  /**
   * List all memories belonging to a specific user.
   *
   * @param {string} userId
   * @returns {Promise<object[]>}
   */
  async listByUser(userId) {
    const results = [];
    for (const memory of _store.values()) {
      if (memory.userId === userId) {
        results.push(memory);
      }
    }
    return results;
  },

  /**
   * Apply a partial update (patch) to an existing memory.
   *
   * Only fields present in `patch` are updated; all other fields are
   * preserved.  Returns `null` when the ID is not found.
   *
   * @param {string} id
   * @param {object} patch - Partial memory fields to merge in.
   * @returns {Promise<object|null>}
   */
  async update(id, patch) {
    const existing = _store.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, id };
    _store.set(id, updated);
    return updated;
  },

  /**
   * Remove a memory from the hot tier.
   *
   * @param {string} id
   * @returns {Promise<boolean>} `true` if the record existed and was removed.
   */
  async remove(id) {
    return _store.delete(id);
  },

  // ─── Test / introspection helpers ──────────────────────────────────────────
  // These are intentionally NOT part of the public contract (not exported from
  // repositories/index.js) but are available for unit tests that import this
  // file directly.

  /**
   * @internal
   * Return the total number of records in the hot tier.
   * @returns {number}
   */
  size() {
    return _store.size;
  },

  /**
   * @internal
   * Wipe all records — useful for test isolation.
   * @returns {void}
   */
  clear() {
    _store.clear();
  }
};
