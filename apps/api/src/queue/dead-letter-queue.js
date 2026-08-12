/**
 * queue/dead-letter-queue.js
 *
 * Dead-letter queue (DLQ) service.
 *
 * After a job has exhausted all retry attempts it is moved here instead of
 * being discarded.  Each DLQ record preserves:
 *   - original job payload
 *   - full error details (message, stack, code, status)
 *   - error classification
 *   - total attempt count
 *   - timestamp the job was dead-lettered
 *
 * Storage:
 *   Redis list   key: <prefix>:queue:memory:dlq
 *   Redis hash   key: <prefix>:dlq:job:<jobId>   (for fast lookup by id)
 *   TTL:         QUEUE_DLQ_TTL_SECONDS (default 7 days)
 *
 * Local (no-Redis) fallback:
 *   In-process Map — behaves identically but has no TTL enforcement.
 *
 * Public surface:
 *   deadLetterQueue.push(job, error, errorCategory)  → DLQ record
 *   deadLetterQueue.list(limit)                      → DLQ record[]
 *   deadLetterQueue.inspect(jobId)                   → DLQ record | null
 *   deadLetterQueue.requeue(jobId)                   → original job payload
 *   deadLetterQueue.remove(jobId)                    → boolean
 *   deadLetterQueue.size()                           → number
 */

import { getRedisClient } from "../infrastructure/redis/redis-client.js";
import { serializeError } from "./retry-policy.js";

// ── Config ─────────────────────────────────────────────────────────────────────

function getDlqTtlSeconds() {
  const value = parseInt(process.env.QUEUE_DLQ_TTL_SECONDS, 10);
  return Number.isFinite(value) && value > 0 ? value : 7 * 24 * 60 * 60; // 7 days
}

function getPrefix() {
  return process.env.REDIS_RUNTIME_PREFIX || "neura";
}

function dlqListKey() {
  return `${getPrefix()}:queue:memory:dlq`;
}

function dlqJobKey(jobId) {
  return `${getPrefix()}:dlq:job:${jobId}`;
}

// ── Local fallback ─────────────────────────────────────────────────────────────

/** In-process store used when Redis is unavailable. */
const localDlqList   = [];           // ordered list of jobIds
const localDlqByJob  = new Map();    // jobId → DLQ record

// ── DLQ record builder ─────────────────────────────────────────────────────────

/**
 * Build a DLQ record from a job and the terminal error.
 *
 * @param {object} job
 * @param {Error}  error
 * @param {string} errorCategory  "transient" | "permanent" | "unknown"
 * @returns {object}
 */
function buildDlqRecord(job, error, errorCategory) {
  return {
    jobId:         job.jobId,
    jobType:       job.jobType || job.type,
    sessionId:     job.sessionId,
    idempotencyKey: job.idempotencyKey,
    attempts:      job.attempt || 1,
    maxAttempts:   job.maxAttempts,
    failedAt:      new Date().toISOString(),
    errorCategory,
    error:         serializeError(error),
    originalJob:   job
  };
}

// ── Service ────────────────────────────────────────────────────────────────────

export const deadLetterQueue = {
  /**
   * Move a terminally failed job to the DLQ.
   *
   * @param {object} job
   * @param {Error}  error
   * @param {string} errorCategory
   * @returns {Promise<object>}  the DLQ record
   */
  async push(job, error, errorCategory) {
    const record  = buildDlqRecord(job, error, errorCategory);
    const ttl     = getDlqTtlSeconds();
    const redis   = await getRedisClient();

    if (redis) {
      const jobKey  = dlqJobKey(record.jobId);
      const listKey = dlqListKey();

      await redis.set(jobKey, JSON.stringify(record), { EX: ttl });
      await redis.rPush(listKey, record.jobId);

      // Keep the list bounded by TTL — expire the list key too
      await redis.expire(listKey, ttl);
    } else {
      localDlqByJob.set(record.jobId, record);

      // Only add to list if not already present
      if (!localDlqList.includes(record.jobId)) {
        localDlqList.push(record.jobId);
      }
    }

    return record;
  },

  /**
   * List DLQ records, most-recently-added first (LIFO).
   *
   * @param {number} [limit=50]
   * @returns {Promise<object[]>}
   */
  async list(limit = 50) {
    const redis = await getRedisClient();

    if (redis) {
      const listKey = dlqListKey();
      // LIFO: read from the tail
      const jobIds  = await redis.lRange(listKey, -limit, -1);
      const records = await Promise.all(
        jobIds.reverse().map(async (id) => {
          const raw = await redis.get(dlqJobKey(id));
          return raw ? JSON.parse(raw) : null;
        })
      );
      return records.filter(Boolean);
    }

    return [...localDlqList]
      .reverse()
      .slice(0, limit)
      .map((id) => localDlqByJob.get(id))
      .filter(Boolean);
  },

  /**
   * Retrieve a single DLQ record by jobId.
   *
   * @param {string} jobId
   * @returns {Promise<object|null>}
   */
  async inspect(jobId) {
    const redis = await getRedisClient();

    if (redis) {
      const raw = await redis.get(dlqJobKey(jobId));
      return raw ? JSON.parse(raw) : null;
    }

    return localDlqByJob.get(jobId) || null;
  },

  /**
   * Extract the original job payload for manual requeue.
   *
   * Does NOT remove the DLQ record — callers decide whether to remove after
   * re-enqueuing.
   *
   * @param {string} jobId
   * @returns {Promise<object|null>}  original job payload or null if not found
   */
  async requeue(jobId) {
    const record = await this.inspect(jobId);
    if (!record) return null;

    // Return the original job with attempt reset to 1 so it starts fresh
    return {
      ...record.originalJob,
      attempt:    1,
      retriedAt:  new Date().toISOString(),
      requeuedFromDlq: true
    };
  },

  /**
   * Remove a record from the DLQ (e.g. after successful manual requeue).
   *
   * @param {string} jobId
   * @returns {Promise<boolean>}
   */
  async remove(jobId) {
    const redis = await getRedisClient();

    if (redis) {
      const jobKey  = dlqJobKey(jobId);
      const listKey = dlqListKey();
      const deleted = await redis.del(jobKey);
      await redis.lRem(listKey, 0, jobId);
      return deleted > 0;
    }

    const existed = localDlqByJob.has(jobId);
    localDlqByJob.delete(jobId);
    const idx = localDlqList.indexOf(jobId);
    if (idx !== -1) localDlqList.splice(idx, 1);
    return existed;
  },

  /**
   * Return the number of jobs currently in the DLQ.
   *
   * @returns {Promise<number>}
   */
  async size() {
    const redis = await getRedisClient();

    if (redis) {
      return redis.lLen(dlqListKey());
    }

    return localDlqList.length;
  },

  /** Clear all local state (test helper). */
  _clearLocal() {
    localDlqList.length = 0;
    localDlqByJob.clear();
  }
};
