/**
 * controllers/redis.controller.js
 *
 * Reads the request, delegates to redis.service, writes the response.
 * No direct infrastructure access or business logic lives here.
 */

import { memoryOrchestrator } from "../services/memory-orchestrator.js";
import { listSessions, isCleanupAllowed, cleanupByPrefix } from "../services/redis.service.js";
import { readJsonBody, sendJson, withErrorHandler } from "../middleware/error-handler.js";
import { parseQueryParams } from "../middleware/request.js";

export const handleRedisContext = withErrorHandler(
  "Redis context retrieval failed",
  async (req, res) => {
    const sessionId = parseQueryParams(req).get("sessionId") || "demo-session";
    const context   = await memoryOrchestrator.getRedisContext(sessionId);
    sendJson(res, 200, context);
  }
);

export const handleRedisSessions = withErrorHandler(
  "Failed to list sessions",
  async (req, res) => {
    const result = await listSessions();
    sendJson(res, 200, result);
  }
);

export const handleRedisCleanup = withErrorHandler(
  "Cleanup failed",
  async (req, res) => {
    const body   = await readJsonBody(req);
    const { prefix } = body;

    if (!prefix || typeof prefix !== "string" || prefix.trim().length === 0) {
      return sendJson(res, 400, {
        error:   "Invalid prefix",
        message: "Prefix must be a non-empty string"
      });
    }

    if (!isCleanupAllowed(prefix)) {
      return sendJson(res, 403, {
        error:   "Cleanup not allowed",
        message: "Only test/demo prefixes can be cleaned up"
      });
    }

    const result = await cleanupByPrefix(prefix);
    sendJson(res, 200, result);
  }
);
