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

loadEnv();

const port = Number(process.env.API_PORT || 4000);
const host = process.env.API_HOST || "127.0.0.1";

// Periodically clean up expired data from local in-memory storage
setInterval(() => {
  redisRuntimeStore.cleanupExpiredData().catch((error) => {
    console.error("Cleanup error:", error instanceof Error ? error.message : error);
  });
}, 30000);

const server = createServer(requestHandler);

server.listen(port, host, () => {
  console.log(`AiNeura API listening on http://${host}:${port}`);
});
