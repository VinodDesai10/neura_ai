import { createServer } from "node:http";
import { computeMemoryFingerprint, extractMemoryCandidates } from "../../../packages/core/src/index.js";
import { memoryOrchestrator } from "./services/memory-orchestrator.js";
import { getStorageHealth } from "./services/storage-health.js";
import { redisRuntimeStore } from "./storage/redis-runtime-store.js";
import { workingMemoryStore } from "./storage/working-memory-store.js";
import { getRedisClient } from "./storage/redis-client.js";
import {
  findMemoriesByDomain,
  findMemoriesByKeyword,
  findMemoriesByEntity,
  findSimilarMemories,
  getMemoryGraphStats
} from "./storage/relationship-graph-store.js";
import { loadEnv } from "./utils/load-env.js";

loadEnv();

const port = Number(process.env.API_PORT || 4000);
const host = process.env.API_HOST || "127.0.0.1";

// Periodically clean up expired data from local storage
setInterval(() => {
  redisRuntimeStore.cleanupExpiredData().catch((error) => {
    console.error("Cleanup error:", error instanceof Error ? error.message : error);
  });
}, 30000); // Run every 30 seconds

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(payload));
}

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

async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function getClientId(req, body) {
  const forwardedFor = req.headers["x-forwarded-for"];
  const ip = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : forwardedFor?.split(",")[0]?.trim();

  return body.userId || body.sessionId || ip || req.socket.remoteAddress || "anonymous";
}

function readPositiveNumber(name, fallback) {
  const value = Number(process.env[name]);

  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const server = createServer(async (req, res) => {
  if (!req.url || !req.method) {
    sendJson(res, 400, { error: "Invalid request" });
    return;
  }

  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && requestUrl.pathname === "/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/health/storage") {
    const health = await getStorageHealth();
    sendJson(res, health.status === "degraded" ? 503 : 200, health);
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/debug/state") {
    const debugSessionId = requestUrl.searchParams.get("sessionId") || undefined;
    const debugState = await memoryOrchestrator.getDebugState(debugSessionId);
    sendJson(res, 200, debugState);
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/redis/context") {
    const sessionId = requestUrl.searchParams.get("sessionId") || "demo-session";
    const context = await memoryOrchestrator.getRedisContext(sessionId);
    sendJson(res, 200, context);
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/chat") {
    try {
      const body = await readJsonBody(req);
      const rateLimit = await redisRuntimeStore.checkRateLimit({
        scope: "chat",
        id: getClientId(req, body),
        limit: readPositiveNumber("CHAT_RATE_LIMIT_MAX_REQUESTS", 30),
        windowSeconds: readPositiveNumber("CHAT_RATE_LIMIT_WINDOW_SECONDS", 60)
      });

      if (!rateLimit.ok) {
        sendJson(res, 429, {
          error: "Rate limit exceeded",
          rateLimit
        });
        return;
      }

      const result = await memoryOrchestrator.handleChatTurn({
        sessionId: body.sessionId || "demo-session",
        message: body.message || ""
      });

      sendJson(res, 200, result);
      return;
    } catch (error) {
      const statusCode = Number(error?.statusCode || 500);
      sendJson(res, statusCode, {
        error: "Chat pipeline failed",
        details: error instanceof Error ? error.message : "Unknown error"
      });
      return;
    }
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/debug/metadata-preview") {
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

      sendJson(res, 200, {
        event,
        candidates
      });
      return;
    } catch (error) {
      sendJson(res, 500, {
        error: "Metadata preview failed",
        details: error instanceof Error ? error.message : "Unknown error"
      });
      return;
    }
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/debug/reset-session") {
    try {
      const body = await readJsonBody(req);
      const sessionId = body.sessionId || "demo-session";

      // Clear session state and recent turns from Redis
      const redis = await getRedisClient();
      if (redis) {
        const prefix = process.env.REDIS_RUNTIME_PREFIX || "neura";
        await redis.del(`${prefix}:session:${sessionId}:state`);
        await redis.del(`${prefix}:session:${sessionId}:turns`);
        await redis.del(`${prefix}:queue:memory`);
      }

      // Clear local storage
      redisRuntimeStore.clearLocalStorage();

      sendJson(res, 200, {
        success: true,
        message: `Session ${sessionId} reset successfully`,
        queueCleared: true,
        localStorageCleared: true
      });
      return;
    } catch (error) {
      sendJson(res, 500, {
        error: "Reset failed",
        details: error instanceof Error ? error.message : "Unknown error"
      });
      return;
    }
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/redis/sessions") {
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
      return;
    } catch (error) {
      sendJson(res, 500, {
        error: "Failed to list sessions",
        details: error instanceof Error ? error.message : "Unknown error"
      });
      return;
    }
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/redis/cleanup") {
    try {
      const body = await readJsonBody(req);
      const { prefix } = body;

      if (!prefix || typeof prefix !== "string" || prefix.trim().length === 0) {
        sendJson(res, 400, {
          error: "Invalid prefix",
          message: "Prefix must be a non-empty string"
        });
        return;
      }

      // Safety checks - only allow cleanup of test/demo patterns
      const allowedPatterns = ["demo-", "test-", "all-db-"];
      const isAllowed = allowedPatterns.some(pattern => prefix.startsWith(pattern));

      if (!isAllowed && prefix !== "demo-session" && prefix !== "all-db-test") {
        sendJson(res, 403, {
          error: "Cleanup not allowed",
          message: "Only test/demo prefixes can be cleaned up"
        });
        return;
      }

      const redis = await getRedisClient();
      let deleted = 0;

      if (redis) {
        // Scan and delete all keys matching the pattern
        let cursor = "0";
        const keysToDelete = [];

        do {
          const result = await redis.scan(cursor, {
            MATCH: `*:${prefix}*`,
            COUNT: 100
          });
          cursor = String(result.cursor);

          // Also check for exact key matches
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
      return;
    } catch (error) {
      sendJson(res, 500, {
        error: "Cleanup failed",
        details: error instanceof Error ? error.message : "Unknown error"
      });
      return;
    }
  }

  // Neo4j graph queries
  if (req.method === "GET" && requestUrl.pathname === "/api/graph/memories/by-domain") {
    try {
      const sessionId = requestUrl.searchParams.get("sessionId");
      const domain = requestUrl.searchParams.get("domain");
      const limit = Number(requestUrl.searchParams.get("limit") || "10");

      if (!sessionId || !domain) {
        sendJson(res, 400, {
          error: "Missing parameters",
          message: "sessionId and domain are required"
        });
        return;
      }

      const memories = await findMemoriesByDomain(sessionId, domain, limit);
      sendJson(res, 200, {
        domain,
        memories,
        count: memories.length,
        timestamp: new Date().toISOString()
      });
      return;
    } catch (error) {
      sendJson(res, 500, {
        error: "Graph query failed",
        details: error instanceof Error ? error.message : "Unknown error"
      });
      return;
    }
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/graph/memories/by-keyword") {
    try {
      const sessionId = requestUrl.searchParams.get("sessionId");
      const keyword = requestUrl.searchParams.get("keyword");
      const limit = Number(requestUrl.searchParams.get("limit") || "10");

      if (!sessionId || !keyword) {
        sendJson(res, 400, {
          error: "Missing parameters",
          message: "sessionId and keyword are required"
        });
        return;
      }

      const memories = await findMemoriesByKeyword(sessionId, keyword, limit);
      sendJson(res, 200, {
        keyword,
        memories,
        count: memories.length,
        timestamp: new Date().toISOString()
      });
      return;
    } catch (error) {
      sendJson(res, 500, {
        error: "Graph query failed",
        details: error instanceof Error ? error.message : "Unknown error"
      });
      return;
    }
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/graph/memories/by-entity") {
    try {
      const sessionId = requestUrl.searchParams.get("sessionId");
      const entityValue = requestUrl.searchParams.get("entity");
      const limit = Number(requestUrl.searchParams.get("limit") || "10");

      if (!sessionId || !entityValue) {
        sendJson(res, 400, {
          error: "Missing parameters",
          message: "sessionId and entity are required"
        });
        return;
      }

      const memories = await findMemoriesByEntity(sessionId, entityValue, limit);
      sendJson(res, 200, {
        entity: entityValue,
        memories,
        count: memories.length,
        timestamp: new Date().toISOString()
      });
      return;
    } catch (error) {
      sendJson(res, 500, {
        error: "Graph query failed",
        details: error instanceof Error ? error.message : "Unknown error"
      });
      return;
    }
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/graph/memories/similar") {
    try {
      const memoryId = requestUrl.searchParams.get("memoryId");
      const limit = Number(requestUrl.searchParams.get("limit") || "5");

      if (!memoryId) {
        sendJson(res, 400, {
          error: "Missing parameters",
          message: "memoryId is required"
        });
        return;
      }

      const memories = await findSimilarMemories(memoryId, limit);
      sendJson(res, 200, {
        memoryId,
        similarMemories: memories,
        count: memories.length,
        timestamp: new Date().toISOString()
      });
      return;
    } catch (error) {
      sendJson(res, 500, {
        error: "Graph query failed",
        details: error instanceof Error ? error.message : "Unknown error"
      });
      return;
    }
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/graph/stats") {
    try {
      const sessionId = requestUrl.searchParams.get("sessionId");

      if (!sessionId) {
        sendJson(res, 400, {
          error: "Missing parameters",
          message: "sessionId is required"
        });
        return;
      }

      const stats = await getMemoryGraphStats(sessionId);
      sendJson(res, 200, {
        sessionId,
        stats,
        timestamp: new Date().toISOString()
      });
      return;
    } catch (error) {
      sendJson(res, 500, {
        error: "Graph query failed",
        details: error instanceof Error ? error.message : "Unknown error"
      });
      return;
    }
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(port, host, () => {
  console.log(`AiNeura API listening on http://${host}:${port}`);
});
