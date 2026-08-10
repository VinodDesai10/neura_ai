/**
 * controllers/chat.controller.js
 *
 * Reads the request, delegates to chat.service, writes the response.
 * No business logic lives here.
 */

import { readJsonBody, sendJson } from "../middleware/error-handler.js";
import { runChatTurn } from "../services/chat.service.js";

export const handleChat = async (req, res) => {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON body" });
  }

  try {
    const { statusCode, payload } = await runChatTurn(req, body);
    sendJson(res, statusCode, payload);
  } catch (error) {
    const statusCode = Number(error?.statusCode || 500);
    sendJson(res, statusCode, {
      error: "Chat pipeline failed",
      details: error instanceof Error ? error.message : "Unknown error"
    });
  }
};
