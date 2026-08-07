import postgres from "postgres";

let sqlClient = null;
let initPromise = null;

function isPostgresEnabled() {
  return Boolean(process.env.POSTGRES_URL);
}

function getSqlClient() {
  if (!isPostgresEnabled()) {
    return null;
  }

  if (!sqlClient) {
    sqlClient = postgres(process.env.POSTGRES_URL, {
      max: Number(process.env.POSTGRES_MAX_CONNECTIONS || 1),
      ssl: process.env.POSTGRES_SSL === "disable" ? false : "require",
      idle_timeout: 20,
      connect_timeout: 15
    });
  }

  return sqlClient;
}

export async function ensurePostgresReady() {
  const sql = getSqlClient();

  if (!sql) {
    return false;
  }

  if (!initPromise) {
    initPromise = (async () => {
      await sql`
        create table if not exists raw_events (
          id uuid primary key,
          session_id text not null,
          role text not null,
          content text not null,
          created_at timestamptz not null default now()
        )
      `;

      await sql`
        create index if not exists raw_events_session_created_idx
        on raw_events (session_id, created_at desc)
      `;

      await sql`
        create table if not exists factual_memories (
          id uuid primary key,
          session_id text not null,
          fingerprint text not null,
          source_event_id uuid,
          memory_type text not null,
          content text not null,
          summary text not null,
          metadata jsonb not null,
          embedding jsonb,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          unique (session_id, fingerprint)
        )
      `;

      await sql`
        create index if not exists factual_memories_session_idx
        on factual_memories (session_id)
      `;
    })().catch((error) => {
      initPromise = null;
      throw error;
    });
  }

  await initPromise;
  return true;
}

export function getPostgresClient() {
  return getSqlClient();
}

export async function getPostgresHealth() {
  if (!isPostgresEnabled()) {
    return {
      configured: false,
      ok: false,
      message: "POSTGRES_URL is not set"
    };
  }

  try {
    await ensurePostgresReady();
    const sql = getPostgresClient();
    await sql`select 1 as ok`;

    return {
      configured: true,
      ok: true,
      message: "reachable"
    };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      message: error instanceof Error ? error.message : "Unknown Postgres error"
    };
  }
}
