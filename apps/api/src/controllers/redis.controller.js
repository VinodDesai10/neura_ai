import { memoryOrchestrator } from "../services/memory-orchestrator.js";
import { workingMemoryStore } from "../infrastructure/working-memory-store.js";
import { getRedisClient } from "../infrastructure/redis-client.js";
import { readJsonBody, sendJson } from "../middleware/error-handler.js";

export async function handleRedisContext(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const sessionId = requestUrl.searchParams.get("sessionId") || "demo-session";
  const context = await memoryOrchestrator.getRedisContext(sessionId);
  sendJson(res, 200, context);
}

export async function handleRedisSessions(req, res) {
  try {
    const allSessions = await workingMemoryStore.all();
    const sessions = Object.entries(allSessions || {}).map(([sessionId, data]) => ({
      sessionId,
      updatedAt: data?.updatedAt || null,
      memoryCount: (data?.activeMemories || []).length,
      turnCount: data?.recentContext?.length || 0,
      ttlSeconds: data?.ttlSeconds
    }));

    sendJson(res, 200, {
      sessions,
      total: sessions.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    sendJson(res, 500, {
      error: "Failed to list sessions",
      details: error instanceof Error ? error.message : "Unknown error"
    });
  }
}

export async function handleRedisCleanup(req, res) {
  try {
    const body = await readJsonBody(req);
    const { prefix } = body;

    if (!prefix || typeof prefix !== "string" || prefix.trim().length === 0) {
      return sendJson(res, 400, {
        error: "Invalid prefix",
        message: "Prefix must be a non-empty string"
      });
    }

    const allowedPatterns = ["demo-", "test-", "all-db-"];
    const isAllowed = allowedPatterns.some((pattern) => prefix.startsWith(pattern));

    if (!isAllowed && prefix !== "demo-session" && prefix !== "all-db-test") {
      return sendJson(res, 403, {
        error: "Cleanup not allowed",
        message: "Only test/demo prefixes can be cleaned up"
      });
    }

    const redis = await getRedisClient();
    let deleted = 0;

    if (redis) {
      let cursor = "0";
      const keysToDelete = [];

      do {
        const result = await redis.scan(cursor, {
          MATCH: `*:${prefix}*`,
          COUNT: 100
        });
        cursor = String(result.cursor);

        const exactMatch = await redis.get(prefix);
        if (exactMatch !== null) {
          keysToDelete.push(prefix);
        }

        if (result.keys && result.keys.length > 0) {
          keysToDelete.push(...result.keys);
        }
      } while (cursor !== "0");

      if (keysToDelete.length > 0) {
        deleted = await redis.del(...keysToDelete);
      }
    }

    sendJson(res, 200, {
      success: true,
      prefix,
      deleted,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    sendJson(res, 500, {
      error: "Cleanup failed",
      details: error instanceof Error ? error.message : "Unknown error"
    });
  }
}
