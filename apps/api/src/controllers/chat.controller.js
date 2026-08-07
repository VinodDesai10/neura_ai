import { memoryOrchestrator } from "../services/memory-orchestrator.js";
import { checkChatRateLimit } from "../middleware/rate-limit.js";
import { readJsonBody, sendJson } from "../middleware/error-handler.js";

export async function handleChat(req, res) {
  try {
    const body = await readJsonBody(req);
    const rateLimit = await checkChatRateLimit(req, body);

    if (!rateLimit.ok) {
      return sendJson(res, 429, { error: "Rate limit exceeded", rateLimit });
    }

    const result = await memoryOrchestrator.handleChatTurn({
      sessionId: body.sessionId || "demo-session",
      message: body.message || ""
    });

    sendJson(res, 200, result);
  } catch (error) {
    const statusCode = Number(error?.statusCode || 500);
    sendJson(res, statusCode, {
      error: "Chat pipeline failed",
      details: error instanceof Error ? error.message : "Unknown error"
    });
  }
}
