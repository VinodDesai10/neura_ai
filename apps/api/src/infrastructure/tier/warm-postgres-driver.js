/**
 * apps/api/src/infrastructure/tier/warm-postgres-driver.js
 *
 * PostgreSQL-backed driver for the warm-tier memory repository.
 *
 * Uses the existing `ensurePostgresReady` / `getPostgresClient` helpers —
 * no new connection pool is created.  Falls back silently to an in-memory Map
 * when POSTGRES_URL is not set or the DB is unreachable.
 *
 * ─── Schema ───────────────────────────────────────────────────────────────────
 *
 *   Table: tier_warm_memories
 *
 *   id         TEXT PRIMARY KEY
 *   user_id    TEXT NOT NULL
 *   content    TEXT NOT NULL
 *   summary    TEXT NOT NULL
 *   memory_type TEXT NOT NULL
 *   metadata   JSONB NOT NULL
 *   tier       TEXT NOT NULL DEFAULT 'warm'
 *   created_at TIMESTAMPTZ NOT NULL DEFAULT now()
 *   updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
 *
 * The table is bootstrapped automatically on first use via `ensureWarmTableReady`.
 * This mirrors the pattern in `postgres-client.js` (ensurePostgresReady) so the
 * schema is always in sync without manual migrations.
 *
 * ─── Graceful degradation ─────────────────────────────────────────────────────
 *
 *   All methods catch Postgres errors and fall back to in-memory storage so the
 *   application continues working even when the DB is temporarily unreachable.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { ensurePostgresReady, getPostgresClient } from "../postgres/postgres-client.js";
import { logger } from "../../lib/logger.js";

const driverLog = logger.child({ component: "warm-postgres-driver" });

// ─── Schema bootstrap ─────────────────────────────────────────────────────────

let _tableReady = false;
let _tableReadyPromise = null;

/**
 * Idempotently ensure `tier_warm_memories` exists.
 * Mirrors the `ensurePostgresReady` pattern from postgres-client.js.
 *
 * @returns {Promise<boolean>} true when Postgres is ready, false otherwise
 */
async function ensureWarmTableReady() {
  const pgReady = await ensurePostgresReady();
  if (!pgReady) return false;

  if (_tableReady) return true;

  if (!_tableReadyPromise) {
    _tableReadyPromise = (async () => {
      const sql = getPostgresClient();

      await sql`
        create table if not exists tier_warm_memories (
          id          text primary key,
          user_id     text not null,
          content     text not null,
          summary     text not null,
          memory_type text not null,
          metadata    jsonb not null,
          tier        text not null default 'warm',
          created_at  timestamptz not null default now(),
          updated_at  timestamptz not null default now()
        )
      `;

      await sql`
        create index if not exists tier_warm_memories_user_idx
        on tier_warm_memories (user_id)
      `;

      await sql`
        create index if not exists tier_warm_memories_updated_idx
        on tier_warm_memories (updated_at desc)
      `;

      _tableReady = true;
    })().catch((err) => {
      _tableReadyPromise = null;
      driverLog.error({ err }, "warm-postgres-driver: table bootstrap failed");
      throw err;
    });
  }

  await _tableReadyPromise;
  return true;
}

// ─── Row ↔ memory conversion ──────────────────────────────────────────────────

function rowToMemory(row) {
  return {
    id:         row.id,
    userId:     row.user_id,
    content:    row.content,
    summary:    row.summary,
    memoryType: row.memory_type,
    metadata:   typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
    tier:       row.tier
  };
}

// ─── In-memory fallback ───────────────────────────────────────────────────────

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

export const warmPostgresDriver = {
  /**
   * Upsert a memory into `tier_warm_memories`.
   * On conflict (same id) the row is overwritten.
   */
  async save(memory) {
    try {
      const ready = await ensureWarmTableReady();
      if (ready) {
        const sql = getPostgresClient();
        const now = new Date().toISOString();
        const rows = await sql`
          insert into tier_warm_memories
            (id, user_id, content, summary, memory_type, metadata, tier, created_at, updated_at)
          values (
            ${memory.id},
            ${memory.userId ?? ""},
            ${memory.content ?? ""},
            ${memory.summary ?? ""},
            ${memory.memoryType ?? "factual"},
            ${sql.json(memory.metadata ?? {})},
            ${memory.metadata?.tier ?? "warm"},
            ${memory.metadata?.timestamp ?? now},
            ${now}
          )
          on conflict (id) do update set
            content     = excluded.content,
            summary     = excluded.summary,
            memory_type = excluded.memory_type,
            metadata    = excluded.metadata,
            tier        = excluded.tier,
            updated_at  = excluded.updated_at
          returning *
        `;
        return rowToMemory(rows[0]);
      }
    } catch (err) {
      driverLog.warn({ err, id: memory.id }, "warm-postgres-driver.save: Postgres error — using fallback");
    }
    return fallbackSave(memory);
  },

  /**
   * Retrieve a single memory by ID.
   */
  async get(id) {
    try {
      const ready = await ensureWarmTableReady();
      if (ready) {
        const sql = getPostgresClient();
        const rows = await sql`
          select * from tier_warm_memories where id = ${id} limit 1
        `;
        return rows.length ? rowToMemory(rows[0]) : undefined;
      }
    } catch (err) {
      driverLog.warn({ err, id }, "warm-postgres-driver.get: Postgres error — using fallback");
    }
    return fallbackGet(id);
  },

  /**
   * List all memories for a user, newest first.
   */
  async listByUser(userId) {
    try {
      const ready = await ensureWarmTableReady();
      if (ready) {
        const sql = getPostgresClient();
        const rows = await sql`
          select * from tier_warm_memories
          where user_id = ${userId}
          order by updated_at desc
        `;
        return rows.map(rowToMemory);
      }
    } catch (err) {
      driverLog.warn({ err, userId }, "warm-postgres-driver.listByUser: Postgres error — using fallback");
    }
    return fallbackListByUser(userId);
  },

  /**
   * Apply a partial patch to an existing warm record.
   * Reads first, merges, then upserts.
   */
  async update(id, patch) {
    try {
      const ready = await ensureWarmTableReady();
      if (ready) {
        const existing = await this.get(id);
        if (!existing) return null;
        const merged = { ...existing, ...patch, id };
        return this.save(merged);
      }
    } catch (err) {
      driverLog.warn({ err, id }, "warm-postgres-driver.update: Postgres error — using fallback");
    }
    return fallbackUpdate(id, patch);
  },

  /**
   * Remove a memory from the warm table.
   */
  async remove(id) {
    try {
      const ready = await ensureWarmTableReady();
      if (ready) {
        const sql = getPostgresClient();
        const result = await sql`
          delete from tier_warm_memories where id = ${id}
        `;
        // postgres.js result has `count` on DELETE
        return result.count > 0;
      }
    } catch (err) {
      driverLog.warn({ err, id }, "warm-postgres-driver.remove: Postgres error — using fallback");
    }
    return fallbackRemove(id);
  },

  // ── Test / introspection helpers ──────────────────────────────────────────
  _size()  { return _fallback.size; },
  _clear() {
    _fallback.clear();
    // Reset bootstrap state so tests can re-initialise cleanly
    _tableReady = false;
    _tableReadyPromise = null;
  }
};
