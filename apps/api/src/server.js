/**
 * server.js
 *
 * Entry point — loads environment variables, creates the HTTP server,
 * and starts listening. No routing or business logic lives here.
 */
import { createServer } from "node:http";
import { loadEnv } from "./config/env.js";
import { requestHandler } from "./app.js";
import { redisRuntimeStore } from "./infrastructure/redis-runtime-store.js";
import { logger } from "./lib/logger.js";

loadEnv();

const port = Number(process.env.API_PORT || 4000);
const host = process.env.API_HOST || "127.0.0.1";

// ── Periodic in-memory cleanup ────────────────────────────────────────────────

setInterval(() => {
  redisRuntimeStore.cleanupExpiredData().catch((error) => {
    logger.error(
      { err: error, component: "cleanup-interval" },
      "In-memory store cleanup failed"
    );
  });
}, 30000);

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = createServer(requestHandler);

server.listen(port, host, () => {
  logger.info(
    {
      host,
      port,
      env:     process.env.NODE_ENV ?? "development",
      nodeVersion: process.version
    },
    "server.started"
  );
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown(signal) {
  logger.info({ signal }, "server.shutdown — closing HTTP server");

  server.close((err) => {
    if (err) {
      logger.error({ err }, "server.shutdown — error closing HTTP server");
      process.exitCode = 1;
    } else {
      logger.info({ signal }, "server.shutdown — HTTP server closed cleanly");
    }
    process.exit(process.exitCode ?? 0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

// Catch any uncaught promise rejections / exceptions and log before crashing
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "server.uncaughtException — exiting");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason instanceof Error ? reason : new Error(String(reason)) },
    "server.unhandledRejection — exiting");
  process.exit(1);
});
