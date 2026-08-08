import { computeMemoryFingerprint, extractMemoryCandidates } from "@neura/core";
import { memoryOrchestrator } from "../services/memory-orchestrator.js";
import { redisRuntimeStore } from "../infrastructure/redis-runtime-store.js";
import { getRedisClient } from "../infrastructure/redis-client.js";
import { readJsonBody, sendJson } from "../middleware/error-handler.js";

function getMemoryRoute(memoryType) {
  if (memoryType === "factual") {
    return {
      store: "Postgres",
      reason: "Factual memories are stored as durable structured facts."
    };
  }

  return {
    store: "Qdrant",
    reason: "Episodic and semantic memories are routed to vector retrieval."
  };
}

export async function handleDebugState(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const debugSessionId = requestUrl.searchParams.get("sessionId") || undefined;
  const debugState = await memoryOrchestrator.getDebugState(debugSessionId);
  sendJson(res, 200, debugState);
}

export async function handleMetadataPreview(req, res) {
  try {
    const body = await readJsonBody(req);
    const event = {
      id: crypto.randomUUID(),
      sessionId: body.sessionId || "metadata-preview",
      role: body.role === "assistant" ? "assistant" : "user",
      content: body.message || "",
      createdAt: new Date().toISOString()
    };
    const candidates = extractMemoryCandidates(event).map((candidate) => ({
      ...candidate,
      fingerprint: computeMemoryFingerprint(candidate.content),
      route: getMemoryRoute(candidate.memoryType)
    }));

    sendJson(res, 200, { event, candidates });
  } catch (error) {
    sendJson(res, 500, {
      error: "Metadata preview failed",
      details: error instanceof Error ? error.message : "Unknown error"
    });
  }
}

export async function handleResetSession(req, res) {
  try {
    const body = await readJsonBody(req);
    const sessionId = body.sessionId || "demo-session";

    const redis = await getRedisClient();
    if (redis) {
      const prefix = process.env.REDIS_RUNTIME_PREFIX || "neura";
      await redis.del(`${prefix}:session:${sessionId}:state`);
      await redis.del(`${prefix}:session:${sessionId}:turns`);
      await redis.del(`${prefix}:queue:memory`);
    }

    redisRuntimeStore.clearLocalStorage();

    sendJson(res, 200, {
      success: true,
      message: `Session ${sessionId} reset successfully`,
      queueCleared: true,
      localStorageCleared: true
    });
  } catch (error) {
    sendJson(res, 500, {
      error: "Reset failed",
      details: error instanceof Error ? error.message : "Unknown error"
    });
  }
}
