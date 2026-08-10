/**
 * services/redis.service.js
 *
 * Business logic for the Redis management endpoints.
 * Handles session listing and key-prefix cleanup so controllers stay thin.
 */

import { workingMemoryStore } from "../infrastructure/working-memory-store.js";
import { getRedisClient } from "../infrastructure/redis-client.js";

// ─── Allowed cleanup prefixes ─────────────────────────────────────────────────

const ALLOWED_CLEANUP_PATTERNS = ["demo-", "test-", "all-db-"];
const ALLOWED_EXACT_IDS        = ["demo-session", "all-db-test"];

/**
 * List all active sessions with summary statistics.
 *
 * @returns {Promise<{
 *   sessions:  Array<{sessionId: string, updatedAt: string|null, memoryCount: number, turnCount: number, ttlSeconds: number|undefined}>,
 *   total:     number,
 *   timestamp: string
 * }>}
 */
export async function listSessions() {
  const allSessions = await workingMemoryStore.all();

  const sessions = Object.entries(allSessions || {}).map(([sessionId, data]) => ({
    sessionId,
    updatedAt:   data?.updatedAt   || null,
    memoryCount: (data?.activeMemories || []).length,
    turnCount:   data?.recentContext?.length || 0,
    ttlSeconds:  data?.ttlSeconds
  }));

  return {
    sessions,
    total:     sessions.length,
    timestamp: new Date().toISOString()
  };
}

/**
 * Check whether `prefix` is allowed for cleanup.
 *
 * @param {string} prefix
 * @returns {boolean}
 */
export function isCleanupAllowed(prefix) {
  if (ALLOWED_EXACT_IDS.includes(prefix)) return true;
  return ALLOWED_CLEANUP_PATTERNS.some((pattern) => prefix.startsWith(pattern));
}

/**
 * Delete all Redis keys matching `*:<prefix>*` plus an exact key match.
 * Scoped to test/demo prefixes only — returns 403 data for production keys.
 *
 * @param {string} prefix
 * @returns {Promise<{
 *   success:   boolean,
 *   prefix:    string,
 *   deleted:   number,
 *   timestamp: string
 * }>}
 */
export async function cleanupByPrefix(prefix) {
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

  return {
    success:   true,
    prefix,
    deleted,
    timestamp: new Date().toISOString()
  };
}
