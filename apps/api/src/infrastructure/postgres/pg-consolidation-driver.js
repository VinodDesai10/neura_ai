/**
 * apps/api/src/infrastructure/postgres/pg-consolidation-driver.js
 *
 * PostgreSQL-backed driver for the ConsolidationStore repository.
 *
 * Implements the driver contract expected by `createConsolidationStore` from
 * @neura/core:
 *
 *   save(record)                  → Promise<ConsolidatedMemory>
 *   get(id)                       → Promise<ConsolidatedMemory|null>
 *   update(id, patch)             → Promise<ConsolidatedMemory|null>
 *   remove(id)                    → Promise<boolean>
 *   findByUserId(userId)          → Promise<ConsolidatedMemory[]>
 *   findBySourceMemoryId(memId)   → Promise<ConsolidatedMemory[]>
 *   findByTopic(userId, topic)    → Promise<ConsolidatedMemory[]>
 *   findByStatus(userId, status)  → Promise<ConsolidatedMemory[]>
 *
 * Uses the existing `ensurePostgresReady` / `getPostgresClient` helpers —
 * no new connection pool is created.  Falls back silently to an in-memory Map
 * when POSTGRES_URL is not set or the DB is unreachable.
 *
 * ─── Schema ───────────────────────────────────────────────────────────────────
 *
 *   Table: consolidated_memories
 *
 *   id            TEXT PRIMARY KEY
 *   user_id       TEXT NOT NULL
 *   topic         TEXT NOT NULL
 *   summary       TEXT NOT NULL
 *   source_ids    JSONB NOT NULL          -- string[] (sourceMemoryIds)
 *   confidence    FLOAT NOT NULL
 *   importance    FLOAT NOT NULL          -- importanceScore
 *   created_at    TIMESTAMPTZ NOT NULL
 *   updated_at    TIMESTAMPTZ NOT NULL
 *   version       INTEGER NOT NULL DEFAULT 1
 *   status        TEXT NOT NULL
 *   conflict_meta JSONB                   -- ConsolidationConflictMeta | null
 *   memory_type   TEXT
 *   tags          JSONB                   -- string[]
 *   domain        TEXT
 *
 * Indices:
 *   (user_id)
 *   GIN(source_ids)               -- for findBySourceMemoryId
 *   (status)
 *   (user_id, topic)
 *
 * ─── Graceful degradation ─────────────────────────────────────────────────────
 *
 *   All methods catch Postgres errors and fall back to an in-memory Map so the
 *   application continues working even when the DB is temporarily unreachable.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { ensurePostgresReady, getPostgresClient } from "./postgres-client.js";
import { logger } from "../../lib/logger.js";

const driverLog = logger.child({ component: "pg-consolidation-driver" });

// ─── Schema bootstrap ─────────────────────────────────────────────────────────

let _tableReady = false;
let _tableReadyPromise = null;

/**
 * Idempotently ensure `consolidated_memories` exists.
 * Mirrors the `ensureWarmTableReady` pattern from warm-postgres-driver.js.
 *
 * @returns {Promise<boolean>} true when Postgres is ready, false otherwise
 */
async function ensureConsolidationTableReady() {
  const pgReady = await ensurePostgresReady();
  if (!pgReady) return false;

  if (_tableReady) return true;

  if (!_tableReadyPromise) {
    _tableReadyPromise = (async () => {
      const sql = getPostgresClient();

      await sql`
        create table if not exists consolidated_memories (
          id            text        primary key,
          user_id       text        not null,
          topic         text        not null,
          summary       text        not null,
          source_ids    jsonb       not null default '[]'::jsonb,
          confidence    float       not null default 0,
          importance    float       not null default 0,
          created_at    timestamptz not null default now(),
          updated_at    timestamptz not null default now(),
          version       integer     not null default 1,
          status        text        not null default 'active',
          conflict_meta jsonb,
          memory_type   text,
          tags          jsonb,
          domain        text
        )
      `;

      // user_id lookup (findByUserId, findByTopic, findByStatus)
      await sql`
        create index if not exists consolidated_memories_user_idx
        on consolidated_memories (user_id)
      `;

      // GIN index for @> containment queries (findBySourceMemoryId)
      await sql`
        create index if not exists consolidated_memories_source_ids_gin_idx
        on consolidated_memories using gin (source_ids)
      `;

      // status index (findByStatus — cross-user analytics)
      await sql`
        create index if not exists consolidated_memories_status_idx
        on consolidated_memories (status)
      `;

      // composite index for findByTopic
      await sql`
        create index if not exists consolidated_memories_user_topic_idx
        on consolidated_memories (user_id, topic)
      `;

      _tableReady = true;
    })().catch((err) => {
      _tableReadyPromise = null;
      driverLog.error({ err }, "pg-consolidation-driver: table bootstrap failed");
      throw err;
    });
  }

  await _tableReadyPromise;
  return true;
}

// ─── Row ↔ record conversion ──────────────────────────────────────────────────

/**
 * Convert a Postgres row (snake_case) to a ConsolidatedMemory object (camelCase).
 *
 * @param {object} row
 * @returns {import("@neura/core").ConsolidatedMemory}
 */
function rowToRecord(row) {
  return {
    id:              row.id,
    userId:          row.user_id,
    topic:           row.topic,
    summary:         row.summary,
    sourceMemoryIds: Array.isArray(row.source_ids)
      ? row.source_ids
      : (typeof row.source_ids === "string" ? JSON.parse(row.source_ids) : []),
    confidence:      Number(row.confidence),
    importanceScore: Number(row.importance),
    createdAt:       row.created_at instanceof Date
      ? row.created_at.toISOString()
      : row.created_at,
    updatedAt:       row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : row.updated_at,
    version:         Number(row.version),
    status:          row.status,
    conflictMeta:    row.conflict_meta
      ? (typeof row.conflict_meta === "string" ? JSON.parse(row.conflict_meta) : row.conflict_meta)
      : null,
    memoryType:      row.memory_type ?? null,
    tags:            row.tags
      ? (typeof row.tags === "string" ? JSON.parse(row.tags) : row.tags)
      : [],
    domain:          row.domain ?? null
  };
}

// ─── In-memory fallback ───────────────────────────────────────────────────────

/** @type {Map<string, object>} */
const _fallback = new Map();

function fbSave(record) {
  const copy = { ...record };
  _fallback.set(copy.id, copy);
  return copy;
}

function fbGet(id) {
  return _fallback.get(id) ?? null;
}

function fbUpdate(id, patch) {
  const existing = _fallback.get(id);
  if (!existing) return null;
  const updated = { ...existing, ...patch, id };
  _fallback.set(id, updated);
  return updated;
}

function fbRemove(id) {
  return _fallback.delete(id);
}

function fbFindByUserId(userId) {
  const results = [];
  for (const r of _fallback.values()) {
    if (r.userId === userId) results.push(r);
  }
  results.sort((a, b) => (b.importanceScore ?? 0) - (a.importanceScore ?? 0));
  return results;
}

function fbFindBySourceMemoryId(memoryId) {
  const results = [];
  for (const r of _fallback.values()) {
    if (r.sourceMemoryIds?.includes(memoryId)) results.push(r);
  }
  return results;
}

function fbFindByTopic(userId, topic) {
  const results = [];
  for (const r of _fallback.values()) {
    if (r.userId === userId && r.topic === topic) results.push(r);
  }
  return results;
}

function fbFindByStatus(userId, status) {
  const results = [];
  for (const r of _fallback.values()) {
    if (r.userId === userId && r.status === status) results.push(r);
  }
  return results;
}

// ─── Driver ───────────────────────────────────────────────────────────────────

export const pgConsolidationDriver = {
  /**
   * Persist a ConsolidatedMemory record.
   * On conflict (same id) the row is replaced entirely.
   *
   * @param {object} record
   * @returns {Promise<object>}
   */
  async save(record) {
    try {
      const ready = await ensureConsolidationTableReady();
      if (ready) {
        const sql = getPostgresClient();
        const rows = await sql`
          insert into consolidated_memories (
            id, user_id, topic, summary, source_ids,
            confidence, importance, created_at, updated_at,
            version, status, conflict_meta, memory_type, tags, domain
          ) values (
            ${record.id},
            ${record.userId ?? ""},
            ${record.topic ?? ""},
            ${record.summary ?? ""},
            ${sql.json(record.sourceMemoryIds ?? [])},
            ${record.confidence ?? 0},
            ${record.importanceScore ?? 0},
            ${record.createdAt ?? new Date().toISOString()},
            ${record.updatedAt ?? new Date().toISOString()},
            ${record.version ?? 1},
            ${record.status ?? "active"},
            ${record.conflictMeta != null ? sql.json(record.conflictMeta) : null},
            ${record.memoryType ?? null},
            ${record.tags != null ? sql.json(record.tags) : sql.json([])},
            ${record.domain ?? null}
          )
          on conflict (id) do update set
            user_id       = excluded.user_id,
            topic         = excluded.topic,
            summary       = excluded.summary,
            source_ids    = excluded.source_ids,
            confidence    = excluded.confidence,
            importance    = excluded.importance,
            updated_at    = excluded.updated_at,
            version       = excluded.version,
            status        = excluded.status,
            conflict_meta = excluded.conflict_meta,
            memory_type   = excluded.memory_type,
            tags          = excluded.tags,
            domain        = excluded.domain
          returning *
        `;
        return rowToRecord(rows[0]);
      }
    } catch (err) {
      driverLog.warn({ err, id: record.id }, "pg-consolidation-driver.save: Postgres error — using fallback");
    }
    return fbSave(record);
  },

  /**
   * Retrieve a single ConsolidatedMemory by ID.
   *
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async get(id) {
    try {
      const ready = await ensureConsolidationTableReady();
      if (ready) {
        const sql = getPostgresClient();
        const rows = await sql`
          select * from consolidated_memories where id = ${id} limit 1
        `;
        return rows.length ? rowToRecord(rows[0]) : null;
      }
    } catch (err) {
      driverLog.warn({ err, id }, "pg-consolidation-driver.get: Postgres error — using fallback");
    }
    return fbGet(id);
  },

  /**
   * Apply a partial patch to an existing ConsolidatedMemory.
   * Reads the current row, merges the patch, then upserts.
   *
   * @param {string} id
   * @param {object} patch
   * @returns {Promise<object|null>}
   */
  async update(id, patch) {
    try {
      const ready = await ensureConsolidationTableReady();
      if (ready) {
        const existing = await this.get(id);
        if (!existing) return null;
        const merged = { ...existing, ...patch, id };
        return this.save(merged);
      }
    } catch (err) {
      driverLog.warn({ err, id }, "pg-consolidation-driver.update: Postgres error — using fallback");
    }
    return fbUpdate(id, patch);
  },

  /**
   * Remove a ConsolidatedMemory by ID.
   *
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async remove(id) {
    try {
      const ready = await ensureConsolidationTableReady();
      if (ready) {
        const sql = getPostgresClient();
        const result = await sql`
          delete from consolidated_memories where id = ${id}
        `;
        return result.count > 0;
      }
    } catch (err) {
      driverLog.warn({ err, id }, "pg-consolidation-driver.remove: Postgres error — using fallback");
    }
    return fbRemove(id);
  },

  /**
   * Return all ConsolidatedMemory records for a user, sorted by
   * importanceScore (importance column) descending.
   *
   * @param {string} userId
   * @returns {Promise<object[]>}
   */
  async findByUserId(userId) {
    try {
      const ready = await ensureConsolidationTableReady();
      if (ready) {
        const sql = getPostgresClient();
        const rows = await sql`
          select * from consolidated_memories
          where user_id = ${userId}
          order by importance desc, updated_at desc
        `;
        return rows.map(rowToRecord);
      }
    } catch (err) {
      driverLog.warn({ err, userId }, "pg-consolidation-driver.findByUserId: Postgres error — using fallback");
    }
    return fbFindByUserId(userId);
  },

  /**
   * Return all ConsolidatedMemory records that include `memoryId` in
   * their source_ids JSONB array.
   *
   * Uses the GIN index for efficient containment search.
   *
   * @param {string} memoryId
   * @returns {Promise<object[]>}
   */
  async findBySourceMemoryId(memoryId) {
    try {
      const ready = await ensureConsolidationTableReady();
      if (ready) {
        const sql = getPostgresClient();
        // JSONB @> containment: source_ids must contain the scalar value
        const rows = await sql`
          select * from consolidated_memories
          where source_ids @> ${sql.json([memoryId])}
          order by updated_at desc
        `;
        return rows.map(rowToRecord);
      }
    } catch (err) {
      driverLog.warn({ err, memoryId }, "pg-consolidation-driver.findBySourceMemoryId: Postgres error — using fallback");
    }
    return fbFindBySourceMemoryId(memoryId);
  },

  /**
   * Return all ConsolidatedMemory records for a user with the given topic.
   *
   * @param {string} userId
   * @param {string} topic
   * @returns {Promise<object[]>}
   */
  async findByTopic(userId, topic) {
    try {
      const ready = await ensureConsolidationTableReady();
      if (ready) {
        const sql = getPostgresClient();
        const rows = await sql`
          select * from consolidated_memories
          where user_id = ${userId} and topic = ${topic}
          order by importance desc, updated_at desc
        `;
        return rows.map(rowToRecord);
      }
    } catch (err) {
      driverLog.warn({ err, userId, topic }, "pg-consolidation-driver.findByTopic: Postgres error — using fallback");
    }
    return fbFindByTopic(userId, topic);
  },

  /**
   * Return all ConsolidatedMemory records for a user with the given status.
   *
   * @param {string} userId
   * @param {string} status  - ConsolidationStatus value
   * @returns {Promise<object[]>}
   */
  async findByStatus(userId, status) {
    try {
      const ready = await ensureConsolidationTableReady();
      if (ready) {
        const sql = getPostgresClient();
        const rows = await sql`
          select * from consolidated_memories
          where user_id = ${userId} and status = ${status}
          order by importance desc, updated_at desc
        `;
        return rows.map(rowToRecord);
      }
    } catch (err) {
      driverLog.warn({ err, userId, status }, "pg-consolidation-driver.findByStatus: Postgres error — using fallback");
    }
    return fbFindByStatus(userId, status);
  },

  // ── Test / introspection helpers ─────────────────────────────────────────

  /** Returns the number of records in the fallback Map (only meaningful in-memory mode). */
  _size()  { return _fallback.size; },

  /**
   * Clear the fallback Map and reset bootstrap state so tests can re-initialise cleanly.
   * Does NOT drop the Postgres table (use a test-scoped transaction or truncate for that).
   */
  _clear() {
    _fallback.clear();
    _tableReady        = false;
    _tableReadyPromise = null;
  },

  /** Expose the bootstrap guard for integration tests that want to re-run it. */
  _ensureReady: ensureConsolidationTableReady
};
