/**
 * controllers/health.controller.js
 *
 * HTTP handlers for all health and readiness probes.
 *
 * Endpoints:
 *   GET /health          – legacy storage health (backward compatible)
 *   GET /health/storage  – legacy storage health (backward compatible)
 *   GET /healthz         – liveness probe (process is up)
 *   GET /livez           – liveness probe alias
 *   GET /readyz          – readiness probe (all deps reachable)
 *
 * Platform support:
 *   Docker HEALTHCHECK, Kubernetes liveness/readiness probes, Fly.io, Render,
 *   Railway, and any HTTP-based health gate work with these endpoints.
 *
 * HTTP status codes:
 *   /healthz, /livez  → 200 always (process is alive by definition of responding)
 *   /readyz           → 200 when all configured deps are ok/skipped
 *                       503 when any configured dep is down
 */

import { getStorageHealth }  from "../services/storage-health.js";
import { checkReadiness }    from "../services/readiness.service.js";
import { sendJson }          from "../middleware/error-handler.js";

// ─── Existing endpoints (unchanged) ──────────────────────────────────────────

/**
 * GET /health
 * Lightweight legacy check — returns 200 { status: "ok" }.
 */
export function handleHealth(req, res) {
  sendJson(res, 200, { status: "ok" });
}

/**
 * GET /health/storage
 * Full storage health across all configured stores.
 * Returns 503 when any configured store is degraded.
 */
export async function handleStorageHealth(req, res) {
  const health = await getStorageHealth();
  sendJson(res, health.status === "degraded" ? 503 : 200, health);
}

// ─── Kubernetes / container-platform probes ───────────────────────────────────

/**
 * GET /healthz
 * Liveness probe — confirms the Node.js process is running and the event loop
 * is not blocked.  No external dependency checks are performed.
 *
 * Platforms: Kubernetes livenessProbe, Docker HEALTHCHECK, Fly.io, Render, Railway.
 *
 * Always returns HTTP 200.
 */
export function handleLiveness(req, res) {
  sendJson(res, 200, {
    status:    "ok",
    timestamp: new Date().toISOString()
  });
}

/**
 * GET /livez
 * Alias for /healthz — some platforms use this path convention (e.g. GKE).
 */
export const handleLivenessAlias = handleLiveness;

/**
 * GET /readyz
 * Readiness probe — runs dependency checks against Redis, Qdrant, Postgres,
 * Neo4j, and the queue subsystem.
 *
 * Returns HTTP 200 when all configured dependencies are reachable.
 * Returns HTTP 503 when any configured dependency is down.
 *
 * Unconfigured dependencies (no env var) are marked "skipped" and do not
 * affect the overall status — the operator chose not to deploy them.
 */
export async function handleReadiness(req, res) {
  const result     = await checkReadiness();
  const statusCode = result.status === "down" ? 503 : 200;
  sendJson(res, statusCode, result);
}
