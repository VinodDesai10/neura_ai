/**
 * packages/core/src/memory/repositories/coldRepository.js
 *
 * Cold-tier repository — long-term archive for old, low-importance memories.
 *
 * Current backing store: in-memory Map.
 *
 * Future adapter target: Object storage (S3, MinIO, R2) or a separate
 * low-cost relational table with infrequent-access storage class.
 *
 * Cold storage is designed for write-once / read-rarely access patterns.
 * Reads typically only happen during a full-history search or when the
 * tier manager promotes a cold record back to warm/hot.
 *
 * ─── Cold-tier criteria (evaluated by tierManager.determineTier) ─────────────
 *   • metadata.timestamp older than 90 days, AND
 *   • metadata.importance < 0.4
 *
 * ─── Adapter notes for S3 / MinIO ────────────────────────────────────────────
 *   Object key schema:  memories/cold/{userId}/{id}.json
 *   Content-type:       application/json
 *   Storage class:      STANDARD_IA (S3) or equivalent
 *
 *   For `listByUser` on S3 use s3.listObjectsV2 with a prefix filter, then
 *   batch-fetch the objects.  Wrap in a local index (DynamoDB / SQLite) for
 *   sub-second listing without needing to enumerate all objects.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── In-memory store ──────────────────────────────────────────────────────────

/** @type {Map<string, object>} */
const _store = new Map();

// ─── Repository ───────────────────────────────────────────────────────────────

/**
 * Cold-tier memory repository.
 *
 * Interface mirrors hotRepository and warmRepository exactly.
 */
export const coldRepository = {
  /**
   * Persist a memory in the cold tier.
   *
   * In a real object-storage adapter this would serialise the memory to JSON
   * and PUT it to the configured bucket.
   *
   * @param {object} memory - Memory with a mandatory `id` field.
   * @returns {Promise<object>}
   * @throws {Error} When `memory.id` is missing.
   */
  async save(memory) {
    if (!memory?.id) throw new Error("coldRepository.save: memory.id is required");
    const record = { ...memory };
    _store.set(record.id, record);
    return record;
  },

  /**
   * Retrieve a single memory by its ID.
   *
   * In a real adapter: GET s3://bucket/memories/cold/{userId}/{id}.json
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
   * In a real S3 adapter: listObjectsV2 with Prefix = `memories/cold/{userId}/`
   * then batch-GET each object.
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
   * Apply a partial update to an existing cold record.
   *
   * Cold records are "write-once" by convention, but the interface supports
   * updates to allow tier metadata fields (e.g. `lastAccessedAt`) to be
   * patched without a full re-upload.
   *
   * In a real adapter: GET → merge → PUT.
   *
   * @param {string} id
   * @param {object} patch
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
   * Remove a memory from the cold tier.
   *
   * In a real adapter: DELETE s3://bucket/memories/cold/{userId}/{id}.json
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
