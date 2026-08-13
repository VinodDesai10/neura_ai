/**
 * middleware/metrics-middleware.js
 *
 * HTTP instrumentation middleware for the AiNeura API.
 *
 * Records per-request counters and duration histograms into the shared
 * Prometheus registry exported from lib/metrics.js.
 *
 * Design:
 *   - Hooks onto `res.end` (same technique used by pino-http) so the final
 *     status code is captured after the response is written — not before.
 *   - Normalises dynamic URL segments to a stable route label so high-
 *     cardinality session IDs don't explode the metric series count.
 *   - Never throws: any instrumentation error is swallowed so it cannot
 *     affect the response the client receives.
 *
 * Route normalisation rules:
 *   /api/chat                      → /api/chat
 *   /health, /healthz, /livez, /readyz, /health/storage → <path as-is>
 *   /metrics                       → /metrics
 *   /debug/state/<sessionId>       → /debug/state/:sessionId
 *   /redis/context/<sessionId>     → /redis/context/:sessionId
 *   /graph/session/<sessionId>/…   → /graph/session/:sessionId/…
 *   anything else                  → <path as-is> (keeps unknown paths visible)
 *
 * Usage (app.js):
 *   import { metricsMiddleware } from "./middleware/metrics-middleware.js";
 *   // call before route dispatch:
 *   metricsMiddleware(req, res);
 */

import { httpRequestsTotal, httpDurationSeconds } from "../lib/metrics.js";

// ── Route normalisation ───────────────────────────────────────────────────────

const DYNAMIC_SEGMENT_PATTERNS = [
  // /debug/state/<sessionId>
  { re: /^\/debug\/state\/[^/]+/, replacement: "/debug/state/:sessionId" },
  // /redis/context/<sessionId>
  { re: /^\/redis\/context\/[^/]+/, replacement: "/redis/context/:sessionId" },
  // /graph/session/<sessionId>/…
  { re: /^\/graph\/session\/[^/]+(\/.*)?$/, replacement: "/graph/session/:sessionId$1" },
];

/**
 * Return a stable route label for a request path.
 * @param {string} pathname
 * @returns {string}
 */
function normaliseRoute(pathname) {
  for (const { re, replacement } of DYNAMIC_SEGMENT_PATTERNS) {
    if (re.test(pathname)) {
      return pathname.replace(re, replacement);
    }
  }
  return pathname;
}

// ── Middleware ────────────────────────────────────────────────────────────────

/**
 * Instrument an incoming HTTP request with Prometheus counters + histograms.
 * Must be called after `attachRequestId` and before route dispatch.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse}  res
 */
export function metricsMiddleware(req, res) {
  const startNs = process.hrtime.bigint();

  const method  = req.method ?? "UNKNOWN";
  const { pathname } = new URL(
    req.url ?? "/",
    `http://${req.headers?.host || "localhost"}`
  );
  const route   = normaliseRoute(pathname);

  // Wrap res.end so we capture the final status code after it is set.
  const originalEnd = res.end.bind(res);

  // res.end can be called with (chunk, encoding, callback) or just (callback)
  // We only need to intercept — arguments are forwarded unchanged.
  res.end = function instrumentedEnd(...args) {
    try {
      const durationSec = Number(process.hrtime.bigint() - startNs) / 1e9;
      const statusCode  = String(res.statusCode ?? 0);

      const labels = { method, route, status_code: statusCode };

      httpRequestsTotal.inc(labels);
      httpDurationSeconds.observe(labels, durationSec);
    } catch {
      // Instrumentation must never disrupt the response
    }

    return originalEnd(...args);
  };
}
