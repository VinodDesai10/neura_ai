import { redisRuntimeStore } from "../infrastructure/redis-runtime-store.js";
import { readPositiveNumber } from "../config/env.js";

/**
 * Returns the best available client identifier from the request.
 * Prefers userId/sessionId from the parsed body, then X-Forwarded-For,
 * then the socket remote address.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {object} body
 * @returns {string}
 */
export function getClientId(req, body) {
  const forwardedFor = req.headers["x-forwarded-for"];
  const ip = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : forwardedFor?.split(",")[0]?.trim();

  return body.userId || body.sessionId || ip || req.socket.remoteAddress || "anonymous";
}

/**
 * Checks the chat rate limit for the given request/body.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {object} body
 * @returns {Promise<{ok: boolean, count: number, limit: number, windowSeconds: number}>}
 */
export async function checkChatRateLimit(req, body) {
  return redisRuntimeStore.checkRateLimit({
    scope: "chat",
    id: getClientId(req, body),
    limit: readPositiveNumber("CHAT_RATE_LIMIT_MAX_REQUESTS", 30),
    windowSeconds: readPositiveNumber("CHAT_RATE_LIMIT_WINDOW_SECONDS", 60)
  });
}
