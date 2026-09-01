import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { logger } from "../lib/logger.js";
import { memoryOrchestrator } from "../services/memory-orchestrator.js";
import { redisRuntimeStore } from "../infrastructure/redis-runtime-store.js";

const mcpLog = logger.child({ component: "neura-memory-mcp" });
const sessions = new Map();
const MCP_PATH = "/mcp";

const SERVER_INSTRUCTIONS = [
  "AiNeura provides the memory layer for this ChatGPT app.",
  "Before answering each user message, call neura_retrieve_context with the exact message and use relevant context silently.",
  "After drafting the answer, call neura_record_turn with the exact user message, a unique turnId, and the answer you are about to send so both sides are stored.",
  "Do not invent an independent answer when the memory tools are available."
].join(" ");

const memoryItemSchema = z.object({
  id: z.string(),
  memoryType: z.string(),
  summary: z.string(),
  importance: z.number().nullable(),
  timestamp: z.string().nullable()
});

const recentTurnSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  createdAt: z.string().nullable()
});

const workingMemorySchema = z.object({
  activeMemories: z.array(memoryItemSchema),
  recentContext: z.array(recentTurnSchema),
  retrievalCacheHit: z.boolean(),
  updatedAt: z.string().nullable()
});

const sessionStateSchema = z.object({
  currentTopic: z.string().nullable(),
  lastUserIntent: z.string().nullable(),
  mode: z.string().nullable(),
  assistantTurnCount: z.number().nullable(),
  updatedAt: z.string().nullable()
});

const retrieveOutputSchema = z.object({
  sessionId: z.string(),
  workingMemory: workingMemorySchema,
  sessionState: sessionStateSchema.nullable()
});

const recordOutputSchema = z.object({
  stored: z.boolean(),
  deduplicated: z.boolean(),
  turnId: z.string(),
  sessionId: z.string(),
  userEventId: z.string(),
  assistantEventId: z.string(),
  memoryJobsQueued: z.number().int().nonnegative(),
  workingMemorySummary: z.object({
    activeMemoryCount: z.number().int().nonnegative(),
    recentContextTurns: z.number().int().nonnegative(),
    updatedAt: z.string().nullable()
  }),
  assistantTurnCount: z.number().int().nonnegative()
});

function readPositiveNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getSessionTtlMs() {
  return readPositiveNumber("MCP_SESSION_TTL_SECONDS", 24 * 60 * 60) * 1000;
}

function getRateLimit() {
  return {
    limit: readPositiveNumber("MCP_MEMORY_RATE_LIMIT_MAX_REQUESTS", 120),
    windowSeconds: readPositiveNumber("MCP_MEMORY_RATE_LIMIT_WINDOW_SECONDS", 60)
  };
}

function getCorsOrigin() {
  return process.env.MCP_CORS_ORIGIN || "*";
}

function setMcpCors(res) {
  res.setHeader("Access-Control-Allow-Origin", getCorsOrigin());
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Mcp-Session-Id, Last-Event-Id, MCP-Protocol-Version"
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

function sendMcpError(res, statusCode, message) {
  if (res.headersSent) {
    return;
  }

  setMcpCors(res);
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

function toolError(message) {
  return {
    isError: true,
    content: [{ type: "text", text: message }]
  };
}

function toNullableString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toNullableNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function serializeWorkingMemory(workingMemory) {
  const activeMemories = Array.isArray(workingMemory?.activeMemories)
    ? workingMemory.activeMemories
    : [];
  const recentContext = Array.isArray(workingMemory?.recentContext)
    ? workingMemory.recentContext
    : [];

  return {
    activeMemories: activeMemories.map((memory, index) => ({
      id: String(memory?.id || "memory-" + index),
      memoryType: String(memory?.memoryType || memory?.type || "unknown"),
      summary: String(memory?.summary || memory?.content || ""),
      importance: toNullableNumber(memory?.metadata?.importance),
      timestamp: toNullableString(
        memory?.metadata?.timestamp || memory?.createdAt
      )
    })),
    recentContext: recentContext.map((turn, index) => ({
      id: String(turn?.id || "turn-" + index),
      role: turn?.role === "user" ? "user" : "assistant",
      content: String(turn?.content || ""),
      createdAt: toNullableString(turn?.createdAt)
    })),
    retrievalCacheHit: workingMemory?.retrievalCache?.hit === true,
    updatedAt: toNullableString(workingMemory?.updatedAt)
  };
}

function serializeSessionState(state) {
  if (!state) {
    return null;
  }

  return {
    currentTopic: toNullableString(state.currentTopic),
    lastUserIntent: toNullableString(state.lastUserIntent),
    mode: toNullableString(state.mode),
    assistantTurnCount: toNullableNumber(state.assistantTurnCount),
    updatedAt: toNullableString(state.updatedAt)
  };
}

function getSessionId(sessionRef) {
  if (!sessionRef.id) {
    throw new Error("MCP session has not finished initialization");
  }

  return sessionRef.id;
}

async function checkMemoryRateLimit(sessionId) {
  const { limit, windowSeconds } = getRateLimit();

  return redisRuntimeStore.checkRateLimit({
    scope: "mcp-memory",
    id: sessionId,
    limit,
    windowSeconds
  });
}

function makeRecordPayload({ sessionId, turnId, recorded, deduplicated }) {
  const workingMemory = recorded.workingMemory || {};

  return {
    stored: true,
    deduplicated,
    turnId,
    sessionId,
    userEventId: recorded.userEventId,
    assistantEventId: recorded.assistantEventId,
    memoryJobsQueued: recorded.memoryJobsQueued,
    workingMemorySummary: {
      activeMemoryCount: Array.isArray(workingMemory.activeMemories)
        ? workingMemory.activeMemories.length
        : 0,
      recentContextTurns: Array.isArray(workingMemory.recentContext)
        ? workingMemory.recentContext.length
        : 0,
      updatedAt: toNullableString(workingMemory.updatedAt)
    },
    assistantTurnCount: Number(recorded.sessionState?.assistantTurnCount) || 0
  };
}

function createNeuraMemoryServer(sessionRef) {
  const server = new McpServer(
    {
      name: process.env.MCP_SERVER_NAME || "neura-memory",
      version: process.env.MCP_SERVER_VERSION || "0.1.0"
    },
    { instructions: SERVER_INSTRUCTIONS }
  );

  server.registerTool(
    "neura_retrieve_context",
    {
      title: "Retrieve Neura memory",
      description:
        "Use this before answering every user message. It retrieves the relevant Neura working memory and recent context for the exact message. Use relevant memory silently as background context; do not expose the entire memory bundle unless the user asks.",
      inputSchema: {
        message: z.string().trim().min(1).max(20000)
      },
      outputSchema: retrieveOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      _meta: {
        securitySchemes: [{ type: "noauth" }],
        "openai/toolInvocation/invoking": "Loading Neura memory",
        "openai/toolInvocation/invoked": "Neura memory loaded"
      }
    },
    async ({ message }) => {
      const sessionId = getSessionId(sessionRef);
      const rateLimit = await checkMemoryRateLimit(sessionId);

      if (!rateLimit.ok) {
        return toolError(
          "Neura memory retrieval is temporarily rate limited. Try again shortly."
        );
      }

      const prepared = await memoryOrchestrator.prepareMemoryContext({
        sessionId,
        userId: null,
        message
      });
      const serializedWorkingMemory = serializeWorkingMemory(
        prepared.workingMemory
      );

      return {
        structuredContent: {
          sessionId,
          workingMemory: serializedWorkingMemory,
          sessionState: serializeSessionState(prepared.sessionState)
        },
        content: [
          {
            type: "text",
            text:
              "Neura loaded " +
              serializedWorkingMemory.activeMemories.length +
              " relevant memories and " +
              serializedWorkingMemory.recentContext.length +
              " recent conversation turns."
          }
        ]
      };
    }
  );

  server.registerTool(
    "neura_record_turn",
    {
      title: "Store Neura conversation turn",
      description:
        "Use this after drafting the answer and before sending it. Store the exact user message and the assistant answer that is about to be sent so Neura can persist both sides and enqueue background memory processing. Reuse the same turnId if the call is retried.",
      inputSchema: {
        userMessage: z.string().trim().min(1).max(20000),
        assistantResponse: z.string().trim().min(1).max(50000),
        turnId: z.string().trim().min(1).max(128).optional()
      },
      outputSchema: recordOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      _meta: {
        securitySchemes: [{ type: "noauth" }],
        "openai/toolInvocation/invoking": "Saving Neura memory",
        "openai/toolInvocation/invoked": "Neura memory saved"
      }
    },
    async ({ userMessage, assistantResponse, turnId }, extra) => {
      const sessionId = getSessionId(sessionRef);
      const resolvedTurnId =
        turnId || "mcp-turn-" + String(extra?.requestId || randomUUID());
      const existing = await redisRuntimeStore.getMcpTurnRecord({
        sessionId,
        turnId: resolvedTurnId
      });

      if (existing) {
        return {
          structuredContent: {
            ...existing,
            deduplicated: true
          },
          content: [
            {
              type: "text",
              text: "This Neura turn was already stored; the retry was deduplicated."
            }
          ]
        };
      }

      const rateLimit = await checkMemoryRateLimit(sessionId);

      if (!rateLimit.ok) {
        return toolError(
          "Neura memory storage is temporarily rate limited. Try again shortly."
        );
      }

      const recorded = await memoryOrchestrator.recordMemoryTurn({
        sessionId,
        userId: null,
        userMessage,
        assistantMessage: assistantResponse
      });
      const payload = makeRecordPayload({
        sessionId,
        turnId: resolvedTurnId,
        recorded,
        deduplicated: false
      });

      await redisRuntimeStore.setMcpTurnRecord({
        sessionId,
        turnId: resolvedTurnId,
        payload
      });

      return {
        structuredContent: payload,
        content: [
          {
            type: "text",
            text:
              "Stored the user message and assistant response in Neura. " +
              recorded.memoryJobsQueued +
              " background memory job(s) queued."
          }
        ]
      };
    }
  );

  return server;
}

function createSession() {
  const sessionRef = { id: null };
  const server = createNeuraMemoryServer(sessionRef);
  const session = {
    server,
    transport: null,
    sessionRef,
    connectionPromise: null,
    lastActivityAt: Date.now()
  };

  session.transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (sessionId) => {
      sessionRef.id = sessionId;
      session.lastActivityAt = Date.now();
      sessions.set(sessionId, session);
    },
    onsessionclosed: async (sessionId) => {
      const current = sessions.get(sessionId);

      if (current === session) {
        sessions.delete(sessionId);
      }
    }
  });

  return session;
}

async function closeExpiredSessions() {
  const cutoff = Date.now() - getSessionTtlMs();

  for (const [sessionId, session] of sessions.entries()) {
    if (session.lastActivityAt >= cutoff) {
      continue;
    }

    sessions.delete(sessionId);

    try {
      await session.server.close();
    } catch (error) {
      mcpLog.warn(
        { err: error, sessionId },
        "mcp.session.cleanup_failed"
      );
    }
  }
}

const cleanupTimer = setInterval(() => {
  closeExpiredSessions().catch((error) => {
    mcpLog.warn({ err: error }, "mcp.session.cleanup_loop_failed");
  });
}, 60000);

cleanupTimer.unref?.();

export function handleMcpOptions(_req, res) {
  setMcpCors(res);
  res.writeHead(204);
  res.end();
}

export async function handleMcpRequest(req, res) {
  setMcpCors(res);

  const headerValue = req.headers["mcp-session-id"];
  const sessionId = Array.isArray(headerValue) ? headerValue[0] : headerValue;

  if (!sessionId && req.method !== "POST") {
    sendMcpError(
      res,
      400,
      "A Mcp-Session-Id header is required after MCP initialization."
    );
    return;
  }

  let session;

  if (sessionId) {
    session = sessions.get(sessionId);

    if (!session) {
      sendMcpError(res, 404, "Unknown MCP session.");
      return;
    }
  } else {
    session = createSession();
  }

  session.lastActivityAt = Date.now();

  try {
    if (!session.transport) {
      throw new Error("MCP transport was not initialized");
    }

    if (!session.connectionPromise) {
      session.connectionPromise = session.server
        .connect(session.transport)
        .catch((error) => {
          session.connectionPromise = null;
          throw error;
        });
    }

    await session.connectionPromise;
    await session.transport.handleRequest(req, res);
  } catch (error) {
    mcpLog.error(
      { err: error, method: req.method, sessionId: session.sessionRef.id || null },
      "mcp.request_failed"
    );
    sendMcpError(res, 500, "MCP request failed.");
  }
}

export async function closeMcpSessions() {
  clearInterval(cleanupTimer);

  const activeSessions = [...sessions.values()];
  sessions.clear();

  await Promise.all(
    activeSessions.map(async (session) => {
      try {
        await session.server.close();
      } catch (error) {
        mcpLog.warn({ err: error }, "mcp.session.close_failed");
      }
    })
  );
}

export const mcpPath = MCP_PATH;
