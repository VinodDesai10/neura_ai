/**
 * services/chat.service.js
 *
 * Business logic for the chat endpoint.
 * The controller reads the request, calls this service, and writes the response.
 */

import { memoryOrchestrator } from "./memory-orchestrator.js";
import { checkChatRateLimit } from "../middleware/rate-limit.js";

/**
 * Run a full chat turn: rate-limit check → memory pipeline → LLM response.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {{ sessionId?: string, userId?: string, message?: string }} body
 * @returns {Promise<{
 *   ok:          boolean,
 *   statusCode:  number,
 *   payload:     object
 * }>}
 */
export async function runChatTurn(req, body) {
  // Validate required fields before hitting the rate limiter or orchestrator
  if (body.message !== undefined && typeof body.message !== "string") {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "Validation error", details: "message must be a string" }
    };
  }

  if (body.sessionId !== undefined && typeof body.sessionId !== "string") {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "Validation error", details: "sessionId must be a string" }
    };
  }

  const rateLimit = await checkChatRateLimit(req, body);

  if (!rateLimit.ok) {
    return {
      ok: false,
      statusCode: 429,
      payload: { error: "Rate limit exceeded", rateLimit }
    };
  }

  const result = await memoryOrchestrator.handleChatTurn({
    sessionId: body.sessionId || "demo-session",
    userId:    body.userId    || null,
    message:   body.message   || ""
  });

  return { ok: true, statusCode: 200, payload: result };
}
