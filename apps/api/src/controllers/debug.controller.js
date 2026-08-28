/**
 * controllers/debug.controller.js
 *
 * Reads the request, delegates to services, writes the response.
 * No direct infrastructure access or business logic lives here.
 */

import { computeMemoryFingerprint, extractMemoryCandidates } from "@neura/core";
import { memoryOrchestrator } from "../services/memory-orchestrator.js";
import { resetSession } from "../services/debug.service.js";
import { readJsonBody, sendJson, withErrorHandler } from "../middleware/error-handler.js";
import { parseQueryParams } from "../middleware/request.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getMemoryRoute(memoryType) {
  if (memoryType === "factual") {
    return {
      store:  "Postgres",
      reason: "Factual memories are stored as durable structured facts."
    };
  }
  return {
    store:  "Qdrant",
    reason: "Episodic and semantic memories are routed to vector retrieval."
  };
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export const handleDebugState = withErrorHandler(
  "Debug state retrieval failed",
  async (req, res) => {
    const sessionId = parseQueryParams(req).get("sessionId") || undefined;
    const debugState = await memoryOrchestrator.getDebugState(sessionId);
    sendJson(res, 200, debugState);
  }
);

export const handleMetadataPreview = withErrorHandler(
  "Metadata preview failed",
  async (req, res) => {
    const body = await readJsonBody(req);

    if (body.message !== undefined && typeof body.message !== "string") {
      return sendJson(res, 400, {
        error:   "Validation error",
        details: "message must be a string"
      });
    }

    const event = {
      id:        crypto.randomUUID(),
      sessionId: body.sessionId || "metadata-preview",
      role:      body.role === "assistant" ? "assistant" : "user",
      content:   body.message || "",
      createdAt: new Date().toISOString()
    };

    const candidates = extractMemoryCandidates(event).map((candidate) => ({
      ...candidate,
      fingerprint: computeMemoryFingerprint(candidate.content),
      route:       getMemoryRoute(candidate.memoryType)
    }));

    sendJson(res, 200, { event, candidates });
  }
);

export const handleResetSession = withErrorHandler(
  "Reset failed",
  async (req, res) => {
    const body      = await readJsonBody(req);
    const sessionId = body.sessionId || "demo-session";
    const result    = await resetSession(sessionId);
    sendJson(res, 200, result);
  }
);
