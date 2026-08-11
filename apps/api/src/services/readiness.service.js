/**
 * services/readiness.service.js
 *
 * Performs dependency readiness checks for the /readyz probe.
 *
 * Design decisions:
 *   - Each check is wrapped in a hard timeout (default 1.5 s) so a hung
 *     dependency cannot block the probe indefinitely.
 *   - If a dependency is not configured (env var absent) the check is marked
 *     "skipped" rather than "down" — Kubernetes / Fly.io readiness gates should
 *     not fail for services the operator chose not to deploy.
 *   - Failures are logged at "warn" level with the dependency name and error;
 *     successes are not logged (no noise in happy-path probes).
 *   - Queue readiness is derived from Redis: the queue runs inside Redis, so if
 *     Redis is reachable the queue subsystem is ready.  There is no independent
 *     queue client to check.
 *
 * Exported API:
 *   checkReadiness() → ReadinessResult
 *
 * @typedef {'ok' | 'degraded' | 'down' | 'skipped'} CheckStatus
 *
 * @typedef {{ status: CheckStatus, latencyMs: number, error?: string }} CheckResult
 *
 * @typedef {{
 *   status:    'ok' | 'degraded' | 'down',
 *   checks: {
 *     redis:    CheckResult,
 *     qdrant:   CheckResult,
 *     postgres: CheckResult,
 *     neo4j:    CheckResult,
 *     queue:    CheckResult
 *   },
 *   timestamp: string
 * }} ReadinessResult
 */

import { getRedisHealth }    from "../infrastructure/redis-client.js";
import { getQdrantHealth }   from "../infrastructure/qdrant-client.js";
import { getPostgresHealth } from "../infrastructure/postgres-client.js";
import { getNeo4jHealth }    from "../infrastructure/relationship-graph-store.js";
import { logger }            from "../lib/logger.js";

const readinessLog = logger.child({ component: "readiness-service" });

// Hard timeout per dependency check (ms). Keeps the probe fast even when a
// service is reachable but slow, or when TCP hangs waiting for a timeout.
const CHECK_TIMEOUT_MS = Number(process.env.READINESS_CHECK_TIMEOUT_MS || 1500);

// ─── Timeout helper ──────────────────────────────────────────────────────────

/**
 * Race a promise against a timeout.  On timeout the promise rejects with a
 * descriptive error — the underlying operation continues in the background
 * (we can't cancel it, but for health checks that is acceptable).
 *
 * @param {Promise<unknown>} promise
 * @param {number} ms
 * @param {string} label  – used in the timeout error message
 * @returns {Promise<unknown>}
 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} health check timed out after ${ms} ms`)),
        ms
      )
    )
  ]);
}

// ─── Per-dependency wrappers ──────────────────────────────────────────────────

/**
 * Run a single dependency health function and return a normalised CheckResult.
 * Handles:
 *   - "not configured" → status "skipped"
 *   - success           → status "ok"
 *   - failure / timeout → status "down", logs at warn
 *
 * @param {string}            name   – dependency label used in logs / output
 * @param {() => Promise<{ configured: boolean, ok: boolean, message: string }>} fn
 * @returns {Promise<CheckResult>}
 */
async function runCheck(name, fn) {
  const start = Date.now();

  try {
    const result = await withTimeout(fn(), CHECK_TIMEOUT_MS, name);
    const latencyMs = Date.now() - start;

    if (!result.configured) {
      return { status: "skipped", latencyMs };
    }

    if (result.ok) {
      return { status: "ok", latencyMs };
    }

    // Configured but reported not-ok (e.g., DNS resolved but auth failed)
    readinessLog.warn(
      { dependency: name, latencyMs, error: result.message },
      "readiness.check.failed"
    );
    return { status: "down", latencyMs, error: result.message };

  } catch (error) {
    const latencyMs = Date.now() - start;
    const message   = error instanceof Error ? error.message : "Unknown error";

    readinessLog.warn(
      { dependency: name, latencyMs, error: message },
      "readiness.check.failed"
    );
    return { status: "down", latencyMs, error: message };
  }
}

// ─── Queue check ─────────────────────────────────────────────────────────────

/**
 * The memory job queue lives entirely inside Redis (LPUSH/BRPOP pattern via
 * redis-runtime-store).  There is no independent queue client to ping.
 * If Redis is reachable the queue subsystem is considered ready; if Redis is
 * not configured, the queue falls back to an in-process array (always ready).
 *
 * @param {CheckResult} redisResult – already-computed Redis check result
 * @returns {CheckResult}
 */
function deriveQueueCheck(redisResult) {
  if (redisResult.status === "skipped") {
    // No REDIS_URL → in-process queue, always up
    return { status: "ok", latencyMs: 0 };
  }

  if (redisResult.status === "ok") {
    return { status: "ok", latencyMs: redisResult.latencyMs };
  }

  // Redis is down → queue is also unavailable
  return {
    status:    "down",
    latencyMs: redisResult.latencyMs,
    error:     "Queue unavailable: Redis is unreachable"
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Run all dependency checks concurrently and return a ReadinessResult.
 *
 * Overall status rules:
 *   - "ok"       – every non-skipped check passed
 *   - "degraded" – at least one optional dependency is down but Redis is ok
 *                  (reserved for future non-critical deps; currently all
 *                  configured deps are treated as critical)
 *   - "down"     – Redis is down, or no non-skipped checks passed
 *
 * @returns {Promise<ReadinessResult>}
 */
export async function checkReadiness() {
  // Run the four infrastructure checks in parallel to minimise total wall time.
  const [redis, qdrant, postgres, neo4j] = await Promise.all([
    runCheck("redis",    getRedisHealth),
    runCheck("qdrant",   getQdrantHealth),
    runCheck("postgres", getPostgresHealth),
    runCheck("neo4j",    getNeo4jHealth)
  ]);

  // Queue readiness is derived from the Redis result — no extra network call.
  const queue = deriveQueueCheck(redis);

  const checks = { redis, qdrant, postgres, neo4j, queue };

  // Determine overall status: any "down" result → overall down.
  const statuses = Object.values(checks).map((c) => c.status);
  const hasDown  = statuses.includes("down");

  const overallStatus = hasDown ? "down" : "ok";

  return {
    status:    overallStatus,
    checks,
    timestamp: new Date().toISOString()
  };
}
