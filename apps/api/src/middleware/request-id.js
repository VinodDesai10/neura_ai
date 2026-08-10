/**
 * middleware/request-id.js
 *
 * Attaches a unique X-Request-Id header to every response.
 * If the client sends an X-Request-Id header it is echoed back unchanged;
 * otherwise a new UUID is generated.
 *
 * Usage in app.js:
 *   import { attachRequestId } from "./middleware/request-id.js";
 *   // call before dispatching to route handlers:
 *   attachRequestId(req, res);
 */

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse}  res
 */
export function attachRequestId(req, res) {
  const requestId =
    (typeof req.headers["x-request-id"] === "string" && req.headers["x-request-id"].trim()) ||
    crypto.randomUUID();

  // Make the id available to downstream handlers via req
  req.requestId = requestId;
  // Set it on the response so clients can correlate logs
  res.setHeader("X-Request-Id", requestId);
}
