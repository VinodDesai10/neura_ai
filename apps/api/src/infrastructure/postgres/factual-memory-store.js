import { computeMemoryFingerprint, scoreQueryOverlap } from "../../../../../packages/core/src/index.js";
import { ensurePostgresReady, getPostgresClient } from "./postgres-client.js";

const factualMemories = [];

export const factualMemoryStore = {
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
          summary = excluded.summary,
          content = excluded.content,
          source_event_id = excluded.source_event_id,
          updated_at = excluded.updated_at,
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

      const row = rows[0];
      return {
        id: row.id,
        sessionId: row.session_id,
        fingerprint: row.fingerprint,
        sourceEventId: row.source_event_id,
        memoryType: row.memory_type,
        content: row.content,
        summary: row.summary,
        metadata: row.metadata,
        embedding: row.embedding
      };
    }

    const existing = factualMemories.find(
      (entry) =>
        entry.sessionId === withFingerprint.sessionId &&
        entry.fingerprint === withFingerprint.fingerprint
    );

    if (existing) {
      existing.summary = withFingerprint.summary;
      existing.content = withFingerprint.content;
      existing.metadata.importance = Math.max(
        existing.metadata.importance,
        withFingerprint.metadata.importance
      );
      existing.metadata.timestamp = withFingerprint.metadata.timestamp;
      existing.sourceEventId = withFingerprint.sourceEventId;
      return existing;
    }

    factualMemories.push(withFingerprint);
    return withFingerprint;
  },

  async findRelevant(query, sessionId) {
    const trimmed = query.trim().toLowerCase().replace(/[^a-z0-9\s]/g, "");
    const isSmallTalk = trimmed.split(/\s+/).length <= 2 &&
      ["hi","hello","hey","ok","okay","thanks","bye","yes","no","sure","great","cool"].some(w => trimmed.includes(w));

    if (await ensurePostgresReady()) {
      const sql = getPostgresClient();
      const rows = await sql`
        select
          id, session_id, fingerprint, source_event_id, memory_type,
          content, summary, metadata, embedding
        from factual_memories
        where session_id = ${sessionId}
           or (metadata->>'importance')::float >= 0.7
        order by (metadata->>'importance')::float desc
        limit 40
      `;

      return rows
        .map((row) => {
          const lexical = scoreQueryOverlap(query, row.summary);
          const isCrossSession = row.session_id !== sessionId;
          const score = isCrossSession
            ? lexical > 0 ? lexical + row.metadata.importance * 1.5 : 0
            : lexical + row.metadata.importance * 3;
          return {
            memory: {
              id: row.id,
              sessionId: row.session_id,
              fingerprint: row.fingerprint,
              sourceEventId: row.source_event_id,
              memoryType: row.memory_type,
              content: row.content,
              summary: row.summary,
              metadata: row.metadata,
              embedding: row.embedding
            },
            score
          };
        })
        .filter((entry) => !isSmallTalk && entry.score > 0.6)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8)
        .map((entry) => entry.memory);
    }

    const isSmallTalkLocal = query.trim().toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).length <= 2 &&
      ["hi","hello","hey","ok","okay","thanks","bye","yes","no","sure","great","cool"].some(w => query.toLowerCase().includes(w));

    return factualMemories
      .filter((memory) => memory.sessionId === sessionId || memory.metadata.importance >= 0.7)
      .map((memory) => {
        const lexical = scoreQueryOverlap(query, memory.summary);
        const isCrossSession = memory.sessionId !== sessionId;
        const score = isCrossSession
          ? lexical > 0 ? lexical + memory.metadata.importance * 1.5 : 0
          : lexical + memory.metadata.importance * 3;
        return { memory, score };
      })
      .filter((entry) => !isSmallTalkLocal && entry.score > 0.6)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((entry) => entry.memory);
  },

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

      return rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        fingerprint: row.fingerprint,
        sourceEventId: row.source_event_id,
        memoryType: row.memory_type,
        content: row.content,
        summary: row.summary,
        metadata: row.metadata,
        embedding: row.embedding
      }));
    }

    return factualMemories;
  }
};
