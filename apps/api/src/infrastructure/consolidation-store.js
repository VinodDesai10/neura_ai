/**
 * apps/api/src/infrastructure/consolidation-store.js
 *
 * API-layer ConsolidationStore singleton.
 *
 * Wraps the PostgreSQL-backed driver (`pgConsolidationDriver`) with the
 * `createConsolidationStore` factory from @neura/core so all callers in the
 * API process use a durable, process-restart–safe store.
 *
 * When POSTGRES_URL is not set or Postgres is unreachable the driver falls back
 * silently to its internal in-memory Map, so the application continues working
 * in local development without any external services.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *
 *   import { consolidationStore } from "../infrastructure/consolidation-store.js";
 *
 *   // Pass to runConsolidationSweep or enrichWithConsolidations
 *   await runConsolidationSweep(userId, storageRouter, consolidationStore);
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createConsolidationStore } from "@neura/core";
import { pgConsolidationDriver }    from "./postgres/pg-consolidation-driver.js";

/**
 * Postgres-backed ConsolidationStore for the API process.
 *
 * Falls back to the driver's internal in-memory Map when Postgres is
 * unavailable.  The store exposes the full driver contract:
 *
 *   save, get, update, remove,
 *   findByUserId, findBySourceMemoryId, findByTopic, findByStatus
 */
export const consolidationStore = createConsolidationStore(pgConsolidationDriver);
