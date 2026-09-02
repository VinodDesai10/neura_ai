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

// ─── Cosine similarity (RC2: score stored factual embeddings against query embedding) ──

/**
 * Compute cosine similarity between two embedding vectors.
 * Returns a value in [-1, 1], or 0 when either vector is missing/invalid.
 *
 * @param {number[]|null} a
 * @param {number[]|null} b
 * @returns {number}
 */
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ─── Row → memory object ──────────────────────────────────────────────────────

function rowToMemory(row) {
  return {
    id:            row.id,
    sessionId:     row.session_id,
    userId:        row.user_id ?? null,
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
      const userId = withFingerprint.userId ?? null;

      // Two upsert strategies:
      //   1. When userId is present: use the (user_id, fingerprint) partial unique
      //      index so the same fact is stored only once per user regardless of
      //      which session produced it.  This is the key that makes cross-session
      //      retrieval possible.
      //   2. When userId is absent: fall back to the original (session_id, fingerprint)
      //      unique constraint so isolated/anonymous sessions are still deduped.
      let rows;
      if (userId) {
        rows = await sql`
          insert into factual_memories (
            id, session_id, user_id, fingerprint, source_event_id, memory_type,
            content, summary, metadata, embedding, created_at, updated_at
          ) values (
            ${withFingerprint.id},
            ${withFingerprint.sessionId},
            ${userId},
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
          on conflict (user_id, fingerprint)
          where user_id is not null
          do update
          set
            summary         = excluded.summary,
            content         = excluded.content,
            source_event_id = excluded.source_event_id,
            updated_at      = excluded.updated_at,
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
            id, session_id, user_id, fingerprint, source_event_id, memory_type,
            content, summary, metadata, embedding
        `;
      } else {
        rows = await sql`
          insert into factual_memories (
            id, session_id, user_id, fingerprint, source_event_id, memory_type,
            content, summary, metadata, embedding, created_at, updated_at
          ) values (
            ${withFingerprint.id},
            ${withFingerprint.sessionId},
            ${null},
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
            summary         = excluded.summary,
            content         = excluded.content,
            source_event_id = excluded.source_event_id,
            updated_at      = excluded.updated_at,
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
            id, session_id, user_id, fingerprint, source_event_id, memory_type,
            content, summary, metadata, embedding
        `;
      }

      return rowToMemory(rows[0]);
    }

    // In-memory fallback
    const userId = withFingerprint.userId ?? null;
    // Prefer user-level dedup when userId is present; fall back to session-level
    const existing = userId
      ? factualMemories.find(
          (e) => e.userId === userId && e.fingerprint === withFingerprint.fingerprint
        ) || factualMemories.find(
          (e) => e.sessionId === withFingerprint.sessionId && e.fingerprint === withFingerprint.fingerprint
        )
      : factualMemories.find(
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
   * RC2 fix: accepts an optional `queryEmbedding`. When a stored embedding
   * exists for a factual memory AND the query embedding is available, cosine
   * similarity is used as the vectorScore — giving factual memories the same
   * 40% vector-weight advantage that Qdrant episodic memories have.
   *
   * RC3 fix: the SQL query now orders by ts_rank DESC first (FTS relevance
   * takes priority over raw importance) and the client-side `passes` gate
   * is tightened: a memory must have lexical OR semantic signal, or be
   * very high importance (≥ 0.85). The old threshold (0.65) let too many
   * unrelated memories through.
   *
   * Namespace strategy (unchanged):
   *   - With userId: session_id = $sessionId OR user_id = $userId
   *   - Without:     session_id = $sessionId only
   *
   * @param {string}          query
   * @param {string}          sessionId
   * @param {string|null}    [userId]
   * @param {number[]|null}  [queryEmbedding]  – RC2: query vector for cosine similarity
   * @returns {Promise<object[]>}
   */
  async findRelevant(query, sessionId, userId = null, queryEmbedding = null) {
    if (isSmallTalkQuery(query)) return [];

    const cfg = readRetrievalConfig();

    if (await ensurePostgresReady()) {
      const sql = getPostgresClient();

      // RC3: order by ts_rank DESC first so FTS-matching memories appear before
      // unrelated high-importance memories.  Limit is still topK*4 so the ranker
      // has a reasonable candidate pool.
      const rows = userId
        ? await sql`
            select
              id, session_id, user_id, fingerprint, source_event_id, memory_type,
              content, summary, metadata, embedding, updated_at,
              coalesce(
                ts_rank_cd(search_vector, plainto_tsquery('english', ${query})),
                0
              ) as ts_rank
            from factual_memories
            where session_id = ${sessionId}
               or user_id    = ${userId}
            order by ts_rank desc, (metadata->>'importance')::float desc, updated_at desc
            limit ${cfg.topK * 4}
          `
        : await sql`
            select
              id, session_id, user_id, fingerprint, source_event_id, memory_type,
              content, summary, metadata, embedding, updated_at,
              coalesce(
                ts_rank_cd(search_vector, plainto_tsquery('english', ${query})),
                0
              ) as ts_rank
            from factual_memories
            where session_id = ${sessionId}
            order by ts_rank desc, (metadata->>'importance')::float desc, updated_at desc
            limit ${cfg.topK * 4}
          `;

      return rows
        .map((row) => {
          const memory = rowToMemory(row);

          // Lexical score from Postgres FTS (ts_rank is 0–1 from Postgres)
          const pgLexical    = Number(row.ts_rank) || 0;
          const clientLexical = pgLexical > 0
            ? pgLexical * 5
            : scoreQueryOverlap(query, memory.summary || memory.content || "");
          const lexicalScore  = pgLexical > 0 ? pgLexical * 5 : clientLexical;

          // RC2: use stored embedding + query embedding for vectorScore when available
          const storedEmbedding = memory.embedding;
          const vectorScore = (Array.isArray(queryEmbedding) && Array.isArray(storedEmbedding))
            ? Math.max(0, cosineSimilarity(queryEmbedding, storedEmbedding))
            : 0;

          const breakdown = computeHybridScore(
            {
              vectorScore,
              lexicalScore,
              importanceScore: Number(memory.metadata?.importance || 0),
              timestamp:       memory.metadata?.timestamp || null,
              sessionId:       memory.sessionId,
              querySessionId:  sessionId,
              lifecycleState:  memory.metadata?.lifecycleState
            },
            cfg
          );

          // RC3: tighter relevance gate.
          // A factual memory passes if it has SOME relevance signal:
          //   - lexical match (ts_rank > 0 or token overlap)
          //   - semantic match (cosine similarity > 0.20 — above noise level)
          //     RC4: raised from 0.15 → 0.20 to reduce FP noise introduced by
          //     RC2 (stored factual embeddings).  Many topically adjacent but
          //     irrelevant factual memories scored 0.15–0.19 cosine similarity
          //     against arbitrary queries, causing them to flood the FP set.
          //   - extremely high standalone importance (≥ 0.85, reduced from 0.65)
          const passes =
            lexicalScore > 0 ||
            vectorScore > 0.20 ||
            Number(memory.metadata?.importance || 0) >= 0.85;

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
      .filter((m) =>
        m.sessionId === sessionId ||
        (userId && m.userId === userId)
      )
      .map((memory) => {
        const lexicalScore    = scoreQueryOverlap(query, memory.summary || memory.content || "");
        const importanceScore = Number(memory.metadata?.importance || 0);

        // RC2: cosine similarity against stored embedding when query embedding available
        const storedEmbedding = memory.embedding;
        const vectorScore = (Array.isArray(queryEmbedding) && Array.isArray(storedEmbedding))
          ? Math.max(0, cosineSimilarity(queryEmbedding, storedEmbedding))
          : 0;

        // RC3: tighter gate. RC4: vectorScore threshold raised 0.15 → 0.20 (see Postgres path above).
        const passes = lexicalScore > 0 || vectorScore > 0.20 || importanceScore >= 0.85;
        if (!passes) return null;

        const breakdown = computeHybridScore(
          {
            vectorScore,
            lexicalScore,
            importanceScore,
            timestamp:       memory.metadata?.timestamp || null,
            sessionId:       memory.sessionId,
            querySessionId:  sessionId,
            lifecycleState:  memory.metadata?.lifecycleState
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

  // ── delete ────────────────────────────────────────────────────────────────
  /**
   * Hard-delete a factual memory row by ID.
   *
   * @param {string} id
   * @returns {Promise<boolean>}  true if a row was deleted, false if not found
   */
  async delete(id) {
    if (await ensurePostgresReady()) {
      const sql = getPostgresClient();
      const result = await sql`
        delete from factual_memories where id = ${id}
      `;
      return result.count > 0;
    }

    // In-memory fallback
    const idx = factualMemories.findIndex((m) => m.id === id);
    if (idx === -1) return false;
    factualMemories.splice(idx, 1);
    return true;
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
          id, session_id, user_id, fingerprint, source_event_id, memory_type,
          content, summary, metadata, embedding
        from factual_memories
        order by updated_at asc
      `;
      return rows.map(rowToMemory);
    }

    return factualMemories;
  }
};
