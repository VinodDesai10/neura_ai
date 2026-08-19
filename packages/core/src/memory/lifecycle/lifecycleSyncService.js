/**
 * packages/core/src/memory/lifecycle/lifecycleSyncService.js
 *
 * Reusable synchronization path for lifecycle state changes.
 *
 * When a memory transitions to a new lifecycle state (ACTIVE, STALE,
 * CONFLICTED, or ARCHIVED) the change must be reflected in every storage
 * representation:
 *
 *   • tier repositories (hot/warm/cold in-memory or Redis/Postgres drivers)
 *     — already updated by storageRouter.updateMemory() in lifecycleManager
 *
 *   • PostgreSQL factual_memories table
 *     — updated via factualStore.updateLifecycleState()
 *
 *   • Qdrant vector payload
 *     — updated via vectorStore.updatePayloadMetadata() (partial payload PATCH)
 *
 *   • Neo4j Memory node
 *     — updated via graphStore.updateMemoryLifecycleState()
 *
 * ─── Design goals ─────────────────────────────────────────────────────────────
 *
 *   1. Single source of truth — lifecycleState lives on the memory object;
 *      every backend receives the same value from one call.
 *
 *   2. Reusable — no Postgres/Qdrant/Neo4j logic is duplicated elsewhere.
 *      lifecycleManager calls syncLifecycleState() and nothing else.
 *
 *   3. Partial-failure safe — if one backend fails the others still receive
 *      the update.  Failures are captured and returned; the function never
 *      throws.  The underlying memory in the tier repositories is NOT rolled
 *      back.
 *
 *   4. Pluggable — adapters are injected, making the service fully testable
 *      without real infrastructure.
 *
 * ─── Public API ───────────────────────────────────────────────────────────────
 *
 *   createLifecycleSyncService({ postgresStore?, vectorStore?, graphStore? })
 *     → { syncLifecycleState(memory): Promise<SyncResult> }
 *
 *   LifecycleSyncService.NOOP
 *     A no-op instance (all backends skipped). Used as safe default.
 *
 * ─── SyncResult schema ────────────────────────────────────────────────────────
 *
 *   {
 *     success:  boolean,   // true when every attempted backend succeeded
 *     results: {
 *       postgres: "ok" | "skipped" | "failed",
 *       qdrant:   "ok" | "skipped" | "failed",
 *       neo4j:    "ok" | "skipped" | "failed"
 *     },
 *     failures: Array<{ backend: string, error: string }>
 *   }
 *
 * ─── Adapter contracts ────────────────────────────────────────────────────────
 *
 *   postgresStore  — must implement:
 *     updateLifecycleState(id, lifecycleState, metadata) → Promise<boolean>
 *
 *   vectorStore    — must implement:
 *     updatePayloadMetadata(id, metadata)                → Promise<boolean>
 *
 *   graphStore     — must implement:
 *     updateMemoryLifecycleState(id, lifecycleState, metadata) → Promise<boolean>
 *
 * Each adapter method must NEVER throw — it should resolve with false when the
 * backend is unavailable (e.g. not configured, unreachable).  If the adapter
 * throws anyway, `LifecycleSyncService` catches the error and records it as a
 * failure.
 */

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Safely call an adapter method, catching any thrown error.
 *
 * @param {() => Promise<unknown>} fn
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function safeCall(fn) {
  try {
    const result = await fn();
    // Treat a boolean `false` return as a "skipped / not-found" outcome
    // (e.g. Neo4j disabled, Qdrant not configured, row not in Postgres).
    // This is NOT the same as a hard failure.
    return { ok: result !== false };
  } catch (err) {
    return {
      ok:    false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a `LifecycleSyncService` backed by the supplied store adapters.
 *
 * Any or all adapters may be omitted — omitted adapters are silently skipped
 * and the corresponding result entry is set to "skipped".
 *
 * @param {{
 *   postgresStore?: {
 *     updateLifecycleState(id: string, state: string, metadata: object): Promise<boolean>
 *   },
 *   vectorStore?: {
 *     updatePayloadMetadata(id: string, metadata: object): Promise<boolean>
 *   },
 *   graphStore?: {
 *     updateMemoryLifecycleState(id: string, state: string, metadata: object): Promise<boolean>
 *   }
 * }} adapters
 *
 * @returns {{
 *   syncLifecycleState(memory: object): Promise<import("./lifecycleSyncService.js").SyncResult>
 * }}
 */
export function createLifecycleSyncService({ postgresStore, vectorStore, graphStore } = {}) {
  /**
   * Fan out the lifecycle state of `memory` to every configured backend.
   *
   * The `memory` object must already have its metadata stamped with the
   * new `lifecycleState` (as done by `stateTransitions.withLifecycleState`).
   *
   * @param {object} memory  - Updated memory with new lifecycleState in metadata
   * @returns {Promise<SyncResult>}
   */
  async function syncLifecycleState(memory) {
    const id             = memory?.id;
    const lifecycleState = memory?.metadata?.lifecycleState;
    const metadata       = memory?.metadata ?? {};

    // ── Postgres ──────────────────────────────────────────────────────────────
    let pgStatus    = "skipped";
    const pgFailure = null;
    const pgErrors  = [];

    if (postgresStore?.updateLifecycleState) {
      const pg = await safeCall(() =>
        postgresStore.updateLifecycleState(id, lifecycleState, metadata)
      );
      if (pg.error) {
        pgStatus = "failed";
        pgErrors.push({ backend: "postgres", error: pg.error });
      } else {
        pgStatus = "ok";
      }
    }

    // ── Qdrant ────────────────────────────────────────────────────────────────
    let qdrantStatus = "skipped";
    const qdrantErrors = [];

    if (vectorStore?.updatePayloadMetadata) {
      const qdrant = await safeCall(() =>
        vectorStore.updatePayloadMetadata(id, metadata)
      );
      if (qdrant.error) {
        qdrantStatus = "failed";
        qdrantErrors.push({ backend: "qdrant", error: qdrant.error });
      } else {
        qdrantStatus = "ok";
      }
    }

    // ── Neo4j ─────────────────────────────────────────────────────────────────
    let neo4jStatus = "skipped";
    const neo4jErrors = [];

    if (graphStore?.updateMemoryLifecycleState) {
      const neo4j = await safeCall(() =>
        graphStore.updateMemoryLifecycleState(id, lifecycleState, metadata)
      );
      if (neo4j.error) {
        neo4jStatus = "failed";
        neo4jErrors.push({ backend: "neo4j", error: neo4j.error });
      } else {
        neo4jStatus = "ok";
      }
    }

    // ── Assemble result ───────────────────────────────────────────────────────
    const failures = [...pgErrors, ...qdrantErrors, ...neo4jErrors];
    const success  = failures.length === 0;

    return {
      success,
      results: {
        postgres: pgStatus,
        qdrant:   qdrantStatus,
        neo4j:    neo4jStatus
      },
      failures
    };
  }

  return { syncLifecycleState };
}

// ─── No-op instance ───────────────────────────────────────────────────────────

/**
 * A lifecycle sync service that skips all backends.
 *
 * Used as the safe default when `processUserMemories` is called without an
 * explicit sync service (e.g. in tests that only care about tier behaviour).
 *
 * @type {{ syncLifecycleState(memory: object): Promise<SyncResult> }}
 */
export const NOOP_SYNC_SERVICE = createLifecycleSyncService({});

// ─── JSDoc typedef ────────────────────────────────────────────────────────────

/**
 * @typedef {object} SyncResult
 * @property {boolean} success
 * @property {{ postgres: string, qdrant: string, neo4j: string }} results
 * @property {Array<{ backend: string, error: string }>} failures
 */
