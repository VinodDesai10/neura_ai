/**
 * services/debug.service.js
 *
 * Business logic for the debug endpoints.
 * Handles session-reset Redis operations so the controller stays thin.
 */

import { redisRuntimeStore } from "../infrastructure/redis-runtime-store.js";
import { getRedisClient } from "../infrastructure/redis-client.js";

/**
 * Reset all runtime state for a session:
 *   - Deletes the session state and recent-turns keys from Redis (if available)
 *   - Clears the memory job queue from Redis
 *   - Clears the local in-memory fallback storage
 *
 * @param {string} sessionId
 * @returns {Promise<{
 *   success:             boolean,
 *   message:             string,
 *   queueCleared:        boolean,
 *   localStorageCleared: boolean
 * }>}
 */
export async function resetSession(sessionId) {
  const redis = await getRedisClient();

  if (redis) {
    const prefix = process.env.REDIS_RUNTIME_PREFIX || "neura";
    await redis.del(`${prefix}:session:${sessionId}:state`);
    await redis.del(`${prefix}:session:${sessionId}:turns`);
    await redis.del(`${prefix}:queue:memory`);
  }

  redisRuntimeStore.clearLocalStorage();

  return {
    success:             true,
    message:             `Session ${sessionId} reset successfully`,
    queueCleared:        true,
    localStorageCleared: true
  };
}
