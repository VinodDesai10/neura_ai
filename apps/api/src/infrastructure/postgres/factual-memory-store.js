/**
 * infrastructure/postgres/factual-memory-store.js
 *
 * Postgres-backed factual memory store.
 *
 * Changes from original:
 *   - findRelevant() uses the retrieval-scorer hybrid pipeline
 *   - When Postgres is available, combines ts_rank_cd full-text search with
 *     importance ordering; falls back to scoreQueryOverlap on the client side
 *   - Strict namespace isolation: always filters WHERE session_id = $sessionId
 *     (cross-session leakage removed — high-importance memories surface via
 *     importance weight alone, not via an OR clause)
 *   - Every returned memory carries a _retrieval envelope
 */

import { computeMemoryFingerprint, scoreQueryOverlap } from "@neura/core";
import { readRetrievalConfig } from "@neura/shared";
import { computeHybridScore } from "../../services/retrieval-scorer.js";
import { ensurePostgresReady, getPostgresClient } from "./postgres-client.js";

/** In-memory fallback (used when POSTGRES_URL is not set) */
const factualMemories = [];

// ─── Small-talk guard ─────────────────────────────────────────────────────────

function isSmallTalkQuery(query) {
  const trimmed = query.trim().toLowerCase().replace(/[^a-z0-9\s]/g, "");
  return (
    trimmed.split(/\s+/).length <= 2 &&
    ["hi", "hello", "hey", "ok", "okay", "thanks", "bye", "yes", "no", "sure", "great", "cool"]
      .some((w) => trimmed.includes(w))
  );
}

// ─── Row → memory object ──────────────────────────────────────────────────────

function rowToMemory(row) {
  return {
    id:            row.id,
    sessionId:     row.session_id,
    fingerprint:   row.fingerprint,
    sourceEventId: row.source_event_id,
    memoryType:    row.memory_type,
    content:       row.content,
    summary:       row.summary,
    metadata:      row.metadata,
    embedding:     row.embedding ?? null
  };
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const factualMemoryStore = {
  // ── upsert ──────────────────────────────────────────────────────────────────
  async upsert(memory) {
    const withFingerprint = {
      ...memory,
      fingerprint: memory.fingerprint || computeMemoryFingerprint(memory.content)
    };

    if (await ensurePostgresReady()) {
      const sql = getPostgresClient();
      const rows = await sql`
        insert into factual_memories (
          id, session_id, fingerprint, source_event_id, memory_type,
          content, summary, metadata, embedding, created_at, updated_at
        ) values (
          ${withFingerprint.id},
          ${withFingerprint.sessionId},
          ${withFingerprint.fingerprint},
          ${withFingerprint.sourceEventId},
          ${withFingerprint.memoryType},
          ${withFingerprint.content},
          ${withFingerprint.summary},
          ${sql.json(withFingerprint.metadata)},
          ${withFingerprint.embedding ? sql.json(withFingerprint.embedding) : null},
          ${withFingerprint.metadata.timestamp},
          ${withFingerprint.metadata.timestamp}
        )
        on conflict (session_id, fingerprint) do update
        set
          summary        = excluded.summary,
          content        = excluded.content,
          source_event_id = excluded.source_event_id,
          updated_at     = excluded.updated_at,
          metadata = jsonb_set(
            case
              when jsonb_typeof(excluded.metadata) = 'object' then excluded.metadata
              else '{}'::jsonb
            end,
            '{importance}',
            to_jsonb(greatest(
              coalesce((factual_memories.metadata->>'importance')::float, 0),
              coalesce((excluded.metadata->>'importance')::float, 0)
            ))
          )
        returning
          id, session_id, fingerprint, source_event_id, memory_type,
          content, summary, metadata, embedding
      `;

      return rowToMemory(rows[0]);
    }

    // In-memory fallback
    const existing = factualMemories.find(
      (e) => e.sessionId === withFingerprint.sessionId && e.fingerprint === withFingerprint.fingerprint
    );

    if (existing) {
      existing.summary   = withFingerprint.summary;
      existing.content   = withFingerprint.content;
      existing.metadata.importance = Math.max(
        existing.metadata.importance,
        withFingerprint.metadata.importance
      );
      existing.metadata.timestamp  = withFingerprint.metadata.timestamp;
      existing.sourceEventId       = withFingerprint.sourceEventId;
      return existing;
    }

    factualMemories.push(withFingerprint);
    return withFingerprint;
  },

  // ── findRelevant ─────────────────────────────────────────────────────────────
  /**
   * Retrieve and score factual memories relevant to `query`.
   *
   * Namespace isolation: only memories belonging to `sessionId` are returned.
   * Cross-session leakage has been removed — importance weight in the hybrid
   * score is sufficient to surface high-value factual memories without the risk
   * of one user's data appearing in another session.
   *
   * @param {string} query
   * @param {string} sessionId
   * @returns {Promise<object[]>}  memories sorted by hybrid score, each with `_retrieval`
   */
  async findRelevant(query, sessionId) {
    if (isSmallTalkQuery(query)) return [];

    const cfg = readRetrievalConfig();

    if (await ensurePostgresReady()) {
      const sql = getPostgresClient();

      // Fetch candidates for this session ordered by importance (high first) then recency.
      // The tsvector-based ts_rank_cd lexical score is computed in Postgres so we can
      // pass it directly into the hybrid formula without a second client-side scan.
      // Fallback: when the search_vector column is not yet populated (first boot before
      // the background index catches up) we gracefully fall back to importance ordering.
      const rows = await sql`
        select
          id, session_id, fingerprint, source_event_id, memory_type,
          content, summary, metadata, embedding, updated_at,
          coalesce(
            ts_rank_cd(search_vector, plainto_tsquery('english', ${query})),
            0
          ) as ts_rank
        from factual_memories
        where session_id = ${sessionId}
        order by (metadata->>'importance')::float desc, updated_at desc
        limit ${cfg.topK * 4}
      `;

      return rows
        .map((row) => {
          const memory = rowToMemory(row);
          // ts_rank is already 0–1 from Postgres; treat it as lexical signal
          const pgLexical    = Number(row.ts_rank) || 0;
          // Fall back to client-side token overlap when ts_rank is 0 (no FTS column yet)
          const clientLexical = pgLexical > 0 ? pgLexical * 5 : scoreQueryOverlap(query, memory.summary || memory.content || "");
          const lexicalScore  = pgLexical > 0 ? pgLexical * 5 : clientLexical;

          const breakdown = computeHybridScore(
            {
              vectorScore:     0,   // factual store has no embedding query
              lexicalScore,
              importanceScore: Number(memory.metadata?.importance || 0),
              timestamp:       memory.metadata?.timestamp || null,
              sessionId:       memory.sessionId,
              querySessionId:  sessionId
            },
            cfg
          );

          // Require at least some lexical signal or high importance to pass filter
          const passes =
            lexicalScore > 0 ||
            Number(memory.metadata?.importance || 0) >= 0.65;

          return passes
            ? {
                memory: {
                  ...memory,
                  _retrieval: {
                    ...breakdown,
                    timestamp: memory.metadata?.timestamp || null,
                    source:    "postgres"
                  }
                },
                score: breakdown.score
              }
            : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .slice(0, cfg.topK)
        .map((e) => e.memory);
    }

    // ── In-memory fallback ───────────────────────────────────────────────────
    return factualMemories
      .filter((m) => m.sessionId === sessionId)
      .map((memory) => {
        const lexicalScore  = scoreQueryOverlap(query, memory.summary || memory.content || "");
        const importanceScore = Number(memory.metadata?.importance || 0);

        const passes = lexicalScore > 0 || importanceScore >= 0.65;
        if (!passes) return null;

        const breakdown = computeHybridScore(
          {
            vectorScore:     0,
            lexicalScore,
            importanceScore,
            timestamp:       memory.metadata?.timestamp || null,
            sessionId:       memory.sessionId,
            querySessionId:  sessionId
          },
          cfg
        );

        return {
          memory: {
            ...memory,
            _retrieval: {
              ...breakdown,
              timestamp: memory.metadata?.timestamp || null,
              source:    "local"
            }
          },
          score: breakdown.score
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, cfg.topK)
      .map((e) => e.memory);
  },

  // ── updateLifecycleState ───────────────────────────────────────────────────
  /**
   * Update only the lifecycle-related metadata fields on a factual memory row.
   *
   * This is a targeted update used by `LifecycleSyncService` so that a lifecycle
   * state change does not have to re-upload the full memory (especially useful
   * because we may not have the embedding available at lifecycle-sweep time).
   *
   * Updates the `metadata` JSONB column in-place, merging only:
   *   lifecycleState, updatedAt, tier, conflicts (if present)
   *
   * @param {string} id              - Memory ID
   * @param {string} lifecycleState  - New LifecycleState value
   * @param {object} metadata        - Full metadata object from the updated memory
   * @returns {Promise<boolean>}     true on success, false if not found
   */
  async updateLifecycleState(id, lifecycleState, metadata) {
    if (await ensurePostgresReady()) {
      const sql = getPostgresClient();

      // Build a deterministic partial-metadata patch so we don't overwrite fields
      // that live in the metadata column but are unrelated to lifecycle (e.g. tags,
      // embedding, importance).  We merge only the lifecycle-critical fields.
      const patch = {
        lifecycleState,
        updatedAt: metadata?.updatedAt ?? new Date().toISOString(),
        tier:      metadata?.tier ?? null
      };
      if (Array.isArray(metadata?.conflicts)) {
        patch.conflicts = metadata.conflicts;
      }

      const rows = await sql`
        update factual_memories
        set
          metadata   = metadata || ${sql.json(patch)},
          updated_at = ${patch.updatedAt}
        where id = ${id}
        returning id
      `;

      return rows.length > 0;
    }

    // In-memory fallback
    const existing = factualMemories.find((m) => m.id === id);
    if (!existing) return false;
    existing.metadata = {
      ...existing.metadata,
      lifecycleState,
      updatedAt: metadata?.updatedAt ?? new Date().toISOString(),
      ...(metadata?.tier      ? { tier:      metadata.tier      } : {}),
      ...(Array.isArray(metadata?.conflicts) ? { conflicts: metadata.conflicts } : {})
    };
    return true;
  },

  // ── all ───────────────────────────────────────────────────────────────────
  async all() {
    if (await ensurePostgresReady()) {
      const sql = getPostgresClient();
      const rows = await sql`
        select
          id, session_id, fingerprint, source_event_id, memory_type,
          content, summary, metadata, embedding
        from factual_memories
        order by updated_at asc
      `;
      return rows.map(rowToMemory);
    }

    return factualMemories;
  }
};
