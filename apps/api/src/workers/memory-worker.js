import { loadEnv } from "../utils/load-env.js";
import { redisRuntimeStore } from "../storage/redis-runtime-store.js";
import { processEventIntoMemories } from "../services/memory-processor.js";

loadEnv();

const idleDelayMs = Number(process.env.MEMORY_WORKER_IDLE_DELAY_MS || 1000);

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function processJob(job) {
  if (!job?.event) {
    return {
      stored: 0,
      skipped: true,
      reason: "Job did not include an event payload"
    };
  }

  const stored = await processEventIntoMemories(job.event);

  return {
    stored: stored.length,
    skipped: false
  };
}

async function runWorker() {
  console.log("AiNeura memory worker started");

  while (true) {
    const job = await redisRuntimeStore.claimMemoryJob();

    if (!job) {
      await sleep(idleDelayMs);
      continue;
    }

    try {
      const result = await processJob(job);
      console.log(
        JSON.stringify({
          status: "processed",
          jobId: job.id,
          sessionId: job.sessionId,
          eventId: job.eventId,
          ...result
        })
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          status: "failed",
          jobId: job.id,
          sessionId: job.sessionId,
          eventId: job.eventId,
          error: error instanceof Error ? error.message : "Unknown memory worker error"
        })
      );
    }
  }
}

runWorker().catch((error) => {
  console.error(
    "AiNeura memory worker crashed:",
    error instanceof Error ? error.message : "Unknown error"
  );
  process.exitCode = 1;
});
