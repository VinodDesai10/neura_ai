/**
 * app.js
 *
 * Builds and returns the Node.js HTTP request handler.
 * Responsibilities:
 *   - Handle CORS preflight (OPTIONS)
 *   - Dispatch to domain route handlers in order
 *   - Return 404 for unmatched requests
 *
 * No business logic lives here — only wiring.
 */
import { sendJson } from "./middleware/error-handler.js";
import { healthRoutes } from "./routes/health.routes.js";
import { chatRoutes } from "./routes/chat.routes.js";
import { debugRoutes } from "./routes/debug.routes.js";
import { redisRoutes } from "./routes/redis.routes.js";
import { graphRoutes } from "./routes/graph.routes.js";

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
 * @param {import("node:http").ServerResponse} res
 */
export function requestHandler(req, res) {
  if (!req.url || !req.method) {
    sendJson(res, 400, { error: "Invalid request" });
    return;
  }

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const { pathname } = requestUrl;
  const method = req.method;

  for (const handler of routeHandlers) {
    if (handler(method, pathname, req, res)) {
      return;
    }
  }

  sendJson(res, 404, { error: "Not found" });
}
