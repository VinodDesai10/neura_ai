import { createClient } from "redis";
import { logger } from "../../lib/logger.js";

const redisLog = logger.child({ component: "redis-client" });

let redisClient = null;
let connectPromise = null;
let lastConnectionFailureAt = 0;

const REDIS_RETRY_COOLDOWN_MS = 30 * 1000;

function isRedisEnabled() {
  return Boolean(process.env.REDIS_URL);
}

export async function getRedisClient({ throwOnError = false } = {}) {
  if (!isRedisEnabled()) {
    return null;
  }

  if (
    !throwOnError &&
    lastConnectionFailureAt &&
    Date.now() - lastConnectionFailureAt < REDIS_RETRY_COOLDOWN_MS
  ) {
    return null;
  }

  if (!redisClient) {
    redisClient = createClient({
      url: process.env.REDIS_URL,
      socket: {
        connectTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 3000),
        reconnectStrategy: false
      }
    });

    redisClient.on("error", (error) => {
      redisLog.error({ err: error }, "Redis client error");
    });
  }

  if (!connectPromise) {
    connectPromise = redisClient.connect().catch((error) => {
      connectPromise = null;
      redisClient = null;
      lastConnectionFailureAt = Date.now();
      throw error;
    });
  }

  try {
    await connectPromise;
    return redisClient;
  } catch (error) {
    if (throwOnError) {
      throw error;
    }

    return null;
  }
}

export async function getRedisHealth() {
  if (!isRedisEnabled()) {
    return {
      configured: false,
      ok: false,
      message: "REDIS_URL is not set"
    };
  }

  try {
    const client = await getRedisClient({ throwOnError: true });
    const pong = await client.ping();

    return {
      configured: true,
      ok: pong === "PONG",
      message: pong === "PONG" ? "reachable" : `Unexpected Redis ping response: ${pong}`
    };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      message: error instanceof Error ? error.message : "Unknown Redis error"
    };
  }
}
