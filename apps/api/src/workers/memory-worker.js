/**
 * workers/memory-worker.js
 *
 * Background worker that dequeues memory jobs from Redis and processes them
 * with full production reliability:
 *   - idempotency  (skip already-completed jobs)
 *   - retries      (exponential backoff + jitter for transient failures)
 *   - dead-letter  (terminate permanently or exhausted jobs to DLQ)
 *   - metrics      (in-process counters + structured log lines)
 *
 * Structured lifecycle events:
 *   worker.started          – process is up and polling
 *   worker.shutdown         – graceful SIGTERM / SIGINT handler fired
 *   worker.crashed          – runWorker() itself threw (fatal, process exits)
 *
 * Per-job events (emitted by queue-reliability.js):
 *   job.claimed             – job pulled from queue
 *   job.attempt_started     – attempt N is beginning
 *   job.attempt_succeeded   – attempt N succeeded
 *   job.attempt_failed      – attempt N failed
 *   job.retry_scheduled     – backoff delay decided; next attempt incoming
 *   job.retry_exhausted     – maxAttempts reached
 *   job.dead_lettered       – moved to DLQ
 *   job.skipped_duplicate   – idempotency hit; already processed
 */

import { loadEnv } from "../utils/load-env.js";
import { logger }  from "../lib/logger.js";
import { redisRuntimeStore }        from "../infrastructure/redis-runtime-store.js";
import { processEventIntoMemories } from "../services/memory-processor.js";
import { attachJobMetadata }        from "../queue/job-metadata.js";
import { runWithReliability }       from "../queue/queue-reliability.js";

loadEnv();

// ── Configuration ─────────────────────────────────────────────────────────────

const idleDelayMs = Number(process.env.MEMORY_WORKER_IDLE_DELAY_MS || 1000);

// Worker-scoped child logger — every line from this process gets component=memory-worker
const workerLog = logger.child({ component: "memory-worker" });

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Core job handler: route to the appropriate memory-processor function.
 *
 * This function is called by runWithReliability and must throw on failure so
 * the retry engine can classify and handle the error.
 *
 * @param {object} job
 * @returns {Promise<{ stored: number, skipped: boolean, reason?: string }>}
 */
async function processJob(job) {
  if (!job?.type && !job?.jobType) {
    const err = new Error("Job missing type field — invalid payload");
    err.permanent = true;
    throw err;
  }

  const jobType = job.jobType || job.type;

  if (jobType === "process-event-into-memories" && !job.event) {
    const err = new Error("process-event-into-memories job missing event payload — invalid payload");
    err.permanent = true;
    throw err;
  }

  const stored = await processEventIntoMemories(job);
  return { stored: stored.length, skipped: false };
}

// ── Main poll loop ────────────────────────────────────────────────────────────

async function runWorker() {
  workerLog.info({ idleDelayMs }, "worker.started");

  while (true) {
    const rawJob = await redisRuntimeStore.claimMemoryJob();

    if (!rawJob) {
      await sleep(idleDelayMs);
      continue;
    }

    // Attach reliability metadata (idempotency key, attempt counter, etc.)
    // Existing metadata fields are preserved if already present.
    const job = attachJobMetadata(rawJob);

    // Build a job-scoped child logger so all lines for this job share its ids
    const jobLog = workerLog.child({
      jobId:     job.jobId,
      jobType:   job.jobType,
      sessionId: job.sessionId ?? undefined,
      eventId:   job.eventId   ?? undefined,
      attempt:   job.attempt,
      maxAttempts: job.maxAttempts
    });

    jobLog.info("job.claimed");

    // Delegate to the reliability wrapper — it handles the full retry loop,
    // DLQ placement, idempotency checking, and metrics.
    await runWithReliability(job, processJob, jobLog);
  }
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function onShutdown(signal) {
  workerLog.info({ signal }, "worker.shutdown");
  process.exit(0);
}

process.on("SIGTERM", () => onShutdown("SIGTERM"));
process.on("SIGINT",  () => onShutdown("SIGINT"));

// ── Start ─────────────────────────────────────────────────────────────────────

runWorker().catch((error) => {
  workerLog.fatal({ err: error }, "worker.crashed");
  process.exitCode = 1;
});
