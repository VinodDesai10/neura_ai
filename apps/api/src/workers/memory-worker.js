/**
 * workers/memory-worker.js
 *
 * Background worker that dequeues memory jobs from Redis and processes them.
 *
 * Structured lifecycle events logged at each stage:
 *   worker.started   – process is up and polling
 *   job.claimed      – job pulled from queue, about to process
 *   job.completed    – job processed successfully (includes durationMs, stored count)
 *   job.failed       – job threw an error (includes durationMs, err serialised)
 *   worker.crashed   – runWorker() itself threw (fatal, process exits)
 *   worker.shutdown  – graceful SIGTERM / SIGINT handler fired
 */

import { loadEnv } from "../utils/load-env.js";
import { logger }  from "../lib/logger.js";
import { redisRuntimeStore }        from "../infrastructure/redis-runtime-store.js";
import { processEventIntoMemories } from "../services/memory-processor.js";

loadEnv();

// ── Configuration ─────────────────────────────────────────────────────────────

const idleDelayMs = Number(process.env.MEMORY_WORKER_IDLE_DELAY_MS || 1000);

// Worker-scoped child logger — every line from this process gets component=memory-worker
const workerLog = logger.child({ component: "memory-worker" });

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Route the job to the appropriate handler in memory-processor.js.
 *
 * @param {object} job
 * @returns {Promise<{ stored: number, skipped: boolean, reason?: string }>}
 */
async function processJob(job) {
  if (!job?.type) {
    return { stored: 0, skipped: true, reason: "Job missing type field" };
  }

  if (job.type === "process-event-into-memories" && !job.event) {
    return { stored: 0, skipped: true, reason: "Job did not include an event payload" };
  }

  const stored = await processEventIntoMemories(job);
  return { stored: stored.length, skipped: false };
}

// ── Main poll loop ────────────────────────────────────────────────────────────

async function runWorker() {
  workerLog.info({ idleDelayMs }, "worker.started");

  while (true) {
    const job = await redisRuntimeStore.claimMemoryJob();

    if (!job) {
      await sleep(idleDelayMs);
      continue;
    }

    // Build a job-scoped child logger so all lines for this job share its ids
    const jobLog = workerLog.child({
      jobId:     job.id,
      jobType:   job.type,
      sessionId: job.sessionId ?? undefined,
      eventId:   job.eventId   ?? undefined
    });

    jobLog.info("job.claimed");

    const startedAt = Date.now();

    try {
      const result = await processJob(job);

      jobLog.info(
        {
          durationMs: Date.now() - startedAt,
          stored:     result.stored,
          skipped:    result.skipped,
          reason:     result.reason ?? undefined
        },
        "job.completed"
      );
    } catch (error) {
      jobLog.error(
        {
          durationMs: Date.now() - startedAt,
          err:        error
        },
        "job.failed"
      );
    }
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
