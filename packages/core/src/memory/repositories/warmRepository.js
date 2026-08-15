/**
 * packages/core/src/memory/repositories/warmRepository.js
 *
 * Warm-tier repository — holds important memories that are no longer
 * actively accessed but are too significant to archive.
 *
 * Current backing store: in-memory Map.
 *
 * Future adapter target: PostgreSQL (or any relational DB).  The warm tier
 * maps naturally to a SQL table because warm memories tend to have higher
 * structured-query needs (filter by domain, importance range, etc.).
 *
 * ─── Warm-tier criteria (evaluated by tierManager.determineTier) ─────────────
 *   • metadata.importance >= 0.7, AND
 *   • NOT already hot (lastAccessedAt within 7 days)
 *
 * ─── Adapter notes for PostgreSQL ────────────────────────────────────────────
 *   Table: memories_warm
 *   Columns:
 *     id            TEXT PRIMARY KEY
 *     user_id       TEXT
 *     memory_type   TEXT
 *     content       TEXT
 *     summary       TEXT
 *     metadata      JSONB
 *     created_at    TIMESTAMPTZ DEFAULT NOW()
 *     updated_at    TIMESTAMPTZ DEFAULT NOW()
 *
 *   Replace the Map operations below with parameterised pg queries.
 *   Keep method signatures identical.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── In-memory store ──────────────────────────────────────────────────────────

/** @type {Map<string, object>} */
const _store = new Map();

// ─── Repository ───────────────────────────────────────────────────────────────

/**
 * Warm-tier memory repository.
 *
 * Identical interface to hotRepository and coldRepository — all methods
 * are async so callers can swap backends without changing call sites.
 */
export const warmRepository = {
  /**
   * Persist a memory in the warm tier.
   *
   * @param {object} memory - Memory with a mandatory `id` field.
   * @returns {Promise<object>}
   * @throws {Error} When `memory.id` is missing.
   */
  async save(memory) {
    if (!memory?.id) throw new Error("warmRepository.save: memory.id is required");
    const record = { ...memory };
    _store.set(record.id, record);
    return record;
  },

  /**
   * Retrieve a single memory by its ID.
   *
   * @param {string} id
   * @returns {Promise<object|undefined>}
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
   * @param {string} id
   * @param {object} patch
   * @returns {Promise<object|null>} Updated memory, or `null` if not found.
   */
  async update(id, patch) {
    const existing = _store.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, id };
    _store.set(id, updated);
    return updated;
  },

  /**
   * Remove a memory from the warm tier.
   *
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async remove(id) {
    return _store.delete(id);
  },

  // ─── Test / introspection helpers ──────────────────────────────────────────

  /** @internal */
  size() {
    return _store.size;
  },

  /** @internal */
  clear() {
    _store.clear();
  }
};
