/**
 * routes/health.routes.js
 *
 * Route dispatcher for all health and readiness probes.
 *
 * Endpoints handled:
 *   GET /health          – legacy liveness (backward compatible, unchanged)
 *   GET /health/storage  – legacy storage health (backward compatible, unchanged)
 *   GET /healthz         – Kubernetes / container-platform liveness probe
 *   GET /livez           – liveness probe alias (GKE convention)
 *   GET /readyz          – Kubernetes / container-platform readiness probe
 *
 * Pattern follows the existing route convention: synchronous dispatch function
 * that returns true when it handles a request, false otherwise.
 */

import {
  handleHealth,
  handleStorageHealth,
  handleLiveness,
  handleLivenessAlias,
  handleReadiness
} from "../controllers/health.controller.js";
import { handleMetrics } from "../controllers/metrics.controller.js";

/**
 * @param {string} method
 * @param {string} pathname
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @returns {boolean} true if the route was handled
 */
export function healthRoutes(method, pathname, req, res) {
  if (method !== "GET") {
    return false;
  }

  switch (pathname) {
    // ── Legacy endpoints (unchanged behaviour) ──────────────────────────────
    case "/health":
      handleHealth(req, res);
      return true;

    case "/health/storage":
      handleStorageHealth(req, res);
      return true;

    // ── Container-platform liveness probes ──────────────────────────────────
    case "/healthz":
      handleLiveness(req, res);
      return true;

    case "/livez":
      handleLivenessAlias(req, res);
      return true;

    // ── Container-platform readiness probe ──────────────────────────────────
    case "/readyz":
      handleReadiness(req, res);
      return true;

    // ── Prometheus scrape endpoint ───────────────────────────────────────────
    case "/metrics":
      handleMetrics(req, res);
      return true;

    default:
      return false;
  }
}
