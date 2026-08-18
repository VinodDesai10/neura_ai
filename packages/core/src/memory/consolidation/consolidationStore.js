/**
 * packages/core/src/memory/consolidation/consolidationStore.js
 *
 * Repository interface and in-memory adapter for ConsolidatedMemory records.
 *
 * ─── Design goals ─────────────────────────────────────────────────────────────
 *
 *   1. Mirror the repository factory pattern used by hotRepository.js —
 *      createConsolidationStore(driver?) accepts an optional driver and
 *      falls back to an in-memory adapter.
 *
 *   2. Keep the in-memory adapter correct and complete so the consolidation
 *      engine works everywhere without external dependencies.
 *
 *   3. Design the interface so a PostgreSQL adapter can be dropped in later
 *      without changing any caller.  The SQL mapping notes in the interface
 *      spec mark the intended target columns.
 *
 * ─── Driver contract ─────────────────────────────────────────────────────────
 *
 *   Any object passed to createConsolidationStore must implement:
 *
 *     save(record)              → Promise<ConsolidatedMemory>
 *     get(id)                   → Promise<ConsolidatedMemory|null>
 *     update(id, patch)         → Promise<ConsolidatedMemory|null>
 *     remove(id)                → Promise<boolean>
 *     findByUserId(userId)      → Promise<ConsolidatedMemory[]>
 *     findBySourceMemoryId(memId) → Promise<ConsolidatedMemory[]>
 *
 * ─── PostgreSQL adapter notes (future) ───────────────────────────────────────
 *
 *   Suggested table: consolidated_memories
 *     id              TEXT PRIMARY KEY
 *     user_id         TEXT NOT NULL
 *     topic           TEXT NOT NULL
 *     summary         TEXT NOT NULL
 *     source_ids      JSONB NOT NULL       -- string[]
 *     confidence      FLOAT NOT NULL
 *     importance      FLOAT NOT NULL
 *     created_at      TIMESTAMPTZ NOT NULL
 *     updated_at      TIMESTAMPTZ NOT NULL
 *     version         INTEGER NOT NULL DEFAULT 1
 *     status          TEXT NOT NULL
 *     conflict_meta   JSONB
 *     memory_type     TEXT
 *     tags            JSONB
 *     domain          TEXT
 *
 *   Indices:
 *     (user_id)
 *     GIN(source_ids)   -- for findBySourceMemoryId
 *     (status)
 */

// ─── In-memory driver ─────────────────────────────────────────────────────────

/**
 * Create an isolated in-memory driver.
 *
 * Each call returns a new driver with its own Map so tests can create
 * independent store instances without shared state.
 *
 * @returns {object} In-memory driver
 */
export function createInMemoryDriver() {
  /** @type {Map<string, import("./consolidationTypes.js").ConsolidatedMemory>} */
  const store = new Map();

  return {
    async save(record) {
      if (!record?.id) throw new Error("consolidationStore.save: record.id is required");
      const copy = { ...record };
      store.set(copy.id, copy);
      return copy;
    },

    async get(id) {
      return store.get(id) ?? null;
    },

    async update(id, patch) {
      const existing = store.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...patch, id };
      store.set(id, updated);
      return updated;
    },

    async remove(id) {
      return store.delete(id);
    },

    async findByUserId(userId) {
      const results = [];
      for (const record of store.values()) {
        if (record.userId === userId) results.push(record);
      }
      // Sort by importanceScore desc
      results.sort((a, b) => (b.importanceScore ?? 0) - (a.importanceScore ?? 0));
      return results;
    },

    /**
     * Find all consolidations that include `memoryId` as a source.
     *
     * This is a linear scan in the in-memory driver.  The PostgreSQL adapter
     * should use a GIN index on the `source_ids` JSONB column instead.
     *
     * @param {string} memoryId
     * @returns {Promise<import("./consolidationTypes.js").ConsolidatedMemory[]>}
     */
    async findBySourceMemoryId(memoryId) {
      const results = [];
      for (const record of store.values()) {
        if (record.sourceMemoryIds?.includes(memoryId)) results.push(record);
      }
      return results;
    },

    /**
     * Find consolidations by topic for a user.
     *
     * @param {string} userId
     * @param {string} topic
     * @returns {Promise<import("./consolidationTypes.js").ConsolidatedMemory[]>}
     */
    async findByTopic(userId, topic) {
      const results = [];
      for (const record of store.values()) {
        if (record.userId === userId && record.topic === topic) results.push(record);
      }
      return results;
    },

    /**
     * Find consolidations by status.
     *
     * @param {string} userId
     * @param {string} status  - ConsolidationStatus value
     * @returns {Promise<import("./consolidationTypes.js").ConsolidatedMemory[]>}
     */
    async findByStatus(userId, status) {
      const results = [];
      for (const record of store.values()) {
        if (record.userId === userId && record.status === status) results.push(record);
      }
      return results;
    },

    // ── Test / introspection helpers ───────────────────────────────────────
    _size()  { return store.size; },
    _clear() { store.clear(); },
    _all()   { return [...store.values()]; }
  };
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a consolidation store repository backed by the provided driver.
 *
 * @param {object|null} [driver]  A driver implementing the contract above.
 *                                Pass `null` (or omit) to use the built-in
 *                                in-memory driver.
 * @returns {{
 *   save:                   (record: object) => Promise<object>,
 *   get:                    (id: string) => Promise<object|null>,
 *   update:                 (id: string, patch: object) => Promise<object|null>,
 *   remove:                 (id: string) => Promise<boolean>,
 *   findByUserId:           (userId: string) => Promise<object[]>,
 *   findBySourceMemoryId:   (memoryId: string) => Promise<object[]>,
 *   findByTopic:            (userId: string, topic: string) => Promise<object[]>,
 *   findByStatus:           (userId: string, status: string) => Promise<object[]>,
 *   size:                   () => number|undefined,
 *   clear:                  () => void
 * }}
 */
export function createConsolidationStore(driver = null) {
  const d = driver ?? createInMemoryDriver();

  return {
    /**
     * Persist a new ConsolidatedMemory record.
     *
     * @param {import("./consolidationTypes.js").ConsolidatedMemory} record
     * @returns {Promise<import("./consolidationTypes.js").ConsolidatedMemory>}
     */
    async save(record) {
      if (!record?.id) throw new Error("consolidationStore.save: record.id is required");
      return d.save(record);
    },

    /**
     * Retrieve a ConsolidatedMemory by its ID.
     *
     * @param {string} id
     * @returns {Promise<import("./consolidationTypes.js").ConsolidatedMemory|null>}
     */
    async get(id) {
      return d.get(id);
    },

    /**
     * Apply a partial update to an existing ConsolidatedMemory.
     *
     * @param {string} id
     * @param {object} patch
     * @returns {Promise<import("./consolidationTypes.js").ConsolidatedMemory|null>}
     */
    async update(id, patch) {
      return d.update(id, patch);
    },

    /**
     * Remove a ConsolidatedMemory by ID.
     *
     * @param {string} id
     * @returns {Promise<boolean>}
     */
    async remove(id) {
      return d.remove(id);
    },

    /**
     * Return all ConsolidatedMemory records for a user, sorted by
     * importanceScore descending.
     *
     * @param {string} userId
     * @returns {Promise<import("./consolidationTypes.js").ConsolidatedMemory[]>}
     */
    async findByUserId(userId) {
      return d.findByUserId(userId);
    },

    /**
     * Return all ConsolidatedMemory records that include `memoryId` as a
     * source memory.
     *
     * Useful for answering "which consolidated memory was derived from this
     * source memory?" — the core provenance query.
     *
     * @param {string} memoryId
     * @returns {Promise<import("./consolidationTypes.js").ConsolidatedMemory[]>}
     */
    async findBySourceMemoryId(memoryId) {
      return d.findBySourceMemoryId(memoryId);
    },

    /**
     * Return all ConsolidatedMemory records for a user with the given topic.
     *
     * @param {string} userId
     * @param {string} topic
     * @returns {Promise<import("./consolidationTypes.js").ConsolidatedMemory[]>}
     */
    async findByTopic(userId, topic) {
      return typeof d.findByTopic === "function"
        ? d.findByTopic(userId, topic)
        : (await d.findByUserId(userId)).filter((r) => r.topic === topic);
    },

    /**
     * Return all ConsolidatedMemory records for a user with the given status.
     *
     * @param {string} userId
     * @param {string} status
     * @returns {Promise<import("./consolidationTypes.js").ConsolidatedMemory[]>}
     */
    async findByStatus(userId, status) {
      return typeof d.findByStatus === "function"
        ? d.findByStatus(userId, status)
        : (await d.findByUserId(userId)).filter((r) => r.status === status);
    },

    // ── Introspection helpers ────────────────────────────────────────────────
    size()  { return typeof d._size  === "function" ? d._size()  : undefined; },
    clear() { if (typeof d._clear === "function") d._clear(); }
  };
}

// ─── Default singleton ────────────────────────────────────────────────────────

/**
 * Default consolidation store backed by an in-memory driver.
 *
 * Safe to use everywhere — no external service required.
 * Swap it for a PostgreSQL-backed instance in production by calling
 * `createConsolidationStore(pgDriver)`.
 */
export const consolidationStore = createConsolidationStore(null);
