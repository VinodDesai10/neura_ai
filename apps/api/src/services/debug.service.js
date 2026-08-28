/**
 * services/debug.service.js
 *
 * Business logic for the debug endpoints.
 * Handles session-reset Redis operations so the controller stays thin.
 *
 * All Redis operations go through redisRuntimeStore — no direct client access.
 */

import { redisRuntimeStore } from "../infrastructure/redis-runtime-store.js";

/**
 * Reset all runtime state for a session:
 *   - Deletes the session state and recent-turns keys via redisRuntimeStore
 *   - Clears the memory job queue
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
  await redisRuntimeStore.clearSessionState(sessionId);
  await redisRuntimeStore.clearMemoryQueue();
  redisRuntimeStore.clearLocalStorage();

  return {
    success:             true,
    message:             `Session ${sessionId} reset successfully`,
    queueCleared:        true,
    localStorageCleared: true
  };
}
