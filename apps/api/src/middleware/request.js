/**
 * middleware/request.js
 *
 * Request-parsing helpers used by controllers.
 * Separated from error-handler.js so each file has a single responsibility.
 */

/**
 * Reads the full request body, parses it as JSON, and returns the result.
 * Returns an empty object if the body is absent or empty.
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<object>}
 */
export async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Parse query-string parameters from an incoming request URL.
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {URLSearchParams}
 */
export function parseQueryParams(req) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  return url.searchParams;
}
