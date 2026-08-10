/**
 * app.js
 *
 * Builds and returns the Node.js HTTP request handler.
 * Responsibilities:
 *   - Apply per-request middleware (request-id, HTTP logging)
 *   - Handle CORS preflight (OPTIONS)
 *   - Dispatch to domain route handlers in order
 *   - Return 404 for unmatched requests
 *
 * No business logic lives here — only wiring.
 */

import pinoHttp from "pino-http";
import { sendJson } from "./middleware/error-handler.js";
import { attachRequestId } from "./middleware/request-id.js";
import { logger } from "./lib/logger.js";
import { healthRoutes } from "./routes/health.routes.js";
import { chatRoutes }   from "./routes/chat.routes.js";
import { debugRoutes }  from "./routes/debug.routes.js";
import { redisRoutes }  from "./routes/redis.routes.js";
import { graphRoutes }  from "./routes/graph.routes.js";

/**
 * pino-http middleware instance (created once, reused per-request).
 *
 * Configuration notes:
 *   - `logger`      – reuse the shared pino instance so transport/level
 *                     config is consistent across the whole process.
 *   - `genReqId`    – pull requestId set by attachRequestId so the HTTP log
 *                     line carries the same id that goes into every other log.
 *   - `customProps` – surfaces session/user identifiers when present.
 *   - `serializers` – keep req/res fields lean; omit noisy headers in prod.
 *   - `autoLogging` – always on; pino-http logs after the response is sent
 *                     so the status code and response time are both available.
 */
const httpLogger = pinoHttp({
  logger,

  // Use the requestId already attached by attachRequestId (echoed via header)
  genReqId(req) {
    return req.requestId;
  },

  // Augment each HTTP log line with session/user identifiers if present
  customProps(req) {
    return {
      sessionId: req.sessionId ?? undefined,
      userId:    req.userId    ?? undefined
    };
  },

  // Serialise only what matters; hide internal headers to keep logs compact
  serializers: {
    req(req) {
      return {
        method:    req.method,
        url:       req.url,
        requestId: req.id          // pino-http assigns req.id from genReqId
      };
    },
    res(res) {
      return {
        statusCode: res.statusCode
      };
    }
  },

  // Use "warn" for 4xx so monitoring alerts on real errors, not client mistakes
  customLogLevel(_req, res, err) {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400)        return "warn";
    return "info";
  },

  // Human-readable message in the HTTP log line
  customSuccessMessage(req, res) {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },
  customErrorMessage(req, res, err) {
    return `${req.method} ${req.url} ${res.statusCode} — ${err.message}`;
  }
});

/**
 * The ordered list of route handlers. Each is tried in sequence; the first
 * one that returns `true` wins. Add new route modules here.
 */
const routeHandlers = [
  healthRoutes,
  chatRoutes,
  debugRoutes,
  redisRoutes,
  graphRoutes
];

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse}  res
 */
export function requestHandler(req, res) {
  if (!req.url || !req.method) {
    sendJson(res, 400, { error: "Invalid request" });
    return;
  }

  // 1. Attach X-Request-Id to every response for client-side log correlation.
  //    Must run before httpLogger so genReqId can read req.requestId.
  attachRequestId(req, res);

  // 2. Attach pino-http request logger.  This wraps the response and emits
  //    one structured log line after res.end() with method, url, statusCode,
  //    responseTime, and requestId.
  httpLogger(req, res);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  const { pathname } = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const method = req.method;

  for (const handler of routeHandlers) {
    if (handler(method, pathname, req, res)) {
      return;
    }
  }

  sendJson(res, 404, { error: "Not found" });
}
