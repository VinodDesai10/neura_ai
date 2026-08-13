/**
 * controllers/metrics.controller.js
 *
 * HTTP handler for GET /metrics — the Prometheus scrape endpoint.
 *
 * Security:
 *   If the METRICS_TOKEN environment variable is set, the request MUST carry
 *   an "Authorization: Bearer <token>" header that matches. Requests without
 *   or with a wrong token receive 401 Unauthorized.
 *
 *   Leave METRICS_TOKEN unset (the default) to allow unauthenticated scraping
 *   — suitable for private networks, Fly.io internal networking, or when the
 *   scraper runs in the same Kubernetes namespace and network policies block
 *   external traffic to the metrics port.
 *
 * Content-Type:
 *   text/plain; version=0.0.4; charset=utf-8
 *   — the format Prometheus expects for the exposition format.
 *
 * Errors:
 *   Any registry serialisation error returns 500 with a plain-text body so
 *   the scraper logs a useful message rather than silently failing.
 */

import { registry } from "../lib/metrics.js";
import { logger }   from "../lib/logger.js";

const metricsLog = logger.child({ component: "metrics-endpoint" });

// Read once at module load; a process restart is required to change it.
const METRICS_TOKEN = process.env.METRICS_TOKEN ?? "";

// ── Auth helper ───────────────────────────────────────────────────────────────

/**
 * Validate the Authorization header when METRICS_TOKEN is configured.
 * Returns true if the request is allowed.
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {boolean}
 */
function isAuthorised(req) {
  if (!METRICS_TOKEN) return true; // no token configured → open access

  const authHeader = req.headers["authorization"] ?? "";
  const [scheme, token] = authHeader.split(" ");

  return scheme === "Bearer" && token === METRICS_TOKEN;
}

// ── Handler ───────────────────────────────────────────────────────────────────

/**
 * GET /metrics
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse}  res
 */
export async function handleMetrics(req, res) {
  if (!isAuthorised(req)) {
    res.writeHead(401, {
      "Content-Type": "text/plain; charset=utf-8",
      "WWW-Authenticate": 'Bearer realm="metrics"'
    });
    res.end("Unauthorized");
    return;
  }

  try {
    const [metrics, contentType] = await Promise.all([
      registry.metrics(),
      Promise.resolve(registry.contentType)
    ]);

    res.writeHead(200, { "Content-Type": contentType });
    res.end(metrics);
  } catch (error) {
    metricsLog.error({ err: error }, "Failed to serialise Prometheus metrics");

    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("# Error collecting metrics\n");
  }
}
