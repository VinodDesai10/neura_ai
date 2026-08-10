/**
 * middleware/error-handler.js
 *
 * HTTP response helpers and centralised error handling.
 *
 * Exports:
 *   sendJson         – write a JSON response with standard CORS headers
 *   withErrorHandler – wrap a controller function in a standard try/catch
 *
 * readJsonBody and parseQueryParams have been moved to middleware/request.js.
 * They are re-exported here for backward compatibility so existing controllers
 * that import from error-handler.js continue to work without changes.
 */

import { logger } from "../lib/logger.js";

export { readJsonBody, parseQueryParams } from "./request.js";

const isDev = process.env.NODE_ENV !== "production";

/**
 * Writes a JSON response with CORS headers.
 *
 * @param {import("node:http").ServerResponse} res
 * @param {number} statusCode
 * @param {unknown} payload
 */
export function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Request-Id"
  });
  res.end(JSON.stringify(payload));
}

/**
 * Wraps an async controller function with a standard try/catch.
 * On error it:
 *   1. Logs a structured error entry including requestId, statusCode, message,
 *      and (in development) the full stack trace.
 *   2. Writes a JSON error response — the shape and status codes are unchanged.
 *
 * Usage:
 *   export const handleFoo = withErrorHandler("Foo failed", async (req, res) => {
 *     // controller body – throw on error, sendJson on success
 *   });
 *
 * @param {string}   errorMessage  – human-readable label for the 500 response
 * @param {function} fn            – async (req, res) => void
 * @returns {function}             – async (req, res) => void
 */
export function withErrorHandler(errorMessage, fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      const statusCode = Number(error?.statusCode || 500);

      // Build the structured log payload.
      // req.log is attached by pino-http when available; fall back to the
      // module-level logger so errors caught before pino-http initialises are
      // still captured.
      const log = req.log ?? logger;

      log.error(
        {
          requestId:  req.requestId,
          statusCode,
          err:        error,                        // serialised by pino's err serialiser
          // stack only in non-production to keep log aggregators clean
          ...(isDev && error instanceof Error && { stack: error.stack })
        },
        errorMessage
      );

      sendJson(res, statusCode, {
        error:   errorMessage,
        details: error instanceof Error ? error.message : "Unknown error"
      });
    }
  };
}
