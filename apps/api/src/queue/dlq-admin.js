#!/usr/bin/env node
/**
 * queue/dlq-admin.js
 *
 * Dead-letter queue administration utility.
 *
 * Usage (run from apps/api/):
 *
 *   node src/queue/dlq-admin.js list            [--limit N]
 *   node src/queue/dlq-admin.js inspect <jobId>
 *   node src/queue/dlq-admin.js requeue <jobId>
 *   node src/queue/dlq-admin.js size
 *
 * Options:
 *   --limit N   Maximum number of DLQ records to list (default 20)
 *
 * Commands:
 *
 *   list
 *     Print a summary table of all DLQ records (most recent first).
 *     Columns: jobId (truncated), jobType, sessionId, attempts, failedAt, errorCategory
 *
 *   inspect <jobId>
 *     Print the full DLQ record (JSON) for the given jobId.
 *
 *   requeue <jobId>
 *     Re-enqueue the original job from the DLQ record back onto the memory
 *     queue, then remove the DLQ record.  The job's attempt counter is reset
 *     to 1 so it gets a full set of retry chances.
 *
 *   size
 *     Print the total number of jobs currently in the DLQ.
 */

import { loadEnv }           from "../utils/load-env.js";
import { deadLetterQueue }   from "./dead-letter-queue.js";
import { redisRuntimeStore } from "../infrastructure/redis-runtime-store.js";
import { attachJobMetadata } from "./job-metadata.js";

loadEnv();

// ── Argument parsing ───────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const command = args[0];

function parseLimit(defaultLimit = 20) {
  const idx = args.indexOf("--limit");
  if (idx !== -1 && args[idx + 1]) {
    const n = parseInt(args[idx + 1], 10);
    return Number.isFinite(n) && n > 0 ? n : defaultLimit;
  }
  return defaultLimit;
}

// ── Formatting helpers ─────────────────────────────────────────────────────────

function truncate(str, len = 12) {
  if (!str) return "(none)";
  return str.length > len ? str.slice(0, len) + "…" : str;
}

function padEnd(str, len) {
  return String(str ?? "").padEnd(len);
}

function printTable(records) {
  if (records.length === 0) {
    console.log("(no DLQ records)");
    return;
  }

  const COLS = [
    { label: "jobId",         width: 14, key: (r) => truncate(r.jobId, 13) },
    { label: "jobType",       width: 34, key: (r) => r.jobType || "(unknown)" },
    { label: "sessionId",     width: 14, key: (r) => truncate(r.sessionId, 13) },
    { label: "attempts",      width: 9,  key: (r) => `${r.attempts}/${r.maxAttempts ?? "?"}` },
    { label: "errorCategory", width: 14, key: (r) => r.errorCategory || "(unknown)" },
    { label: "failedAt",      width: 26, key: (r) => r.failedAt || "" }
  ];

  // Header
  console.log(COLS.map((c) => padEnd(c.label, c.width)).join("  "));
  console.log(COLS.map((c) => "-".repeat(c.width)).join("  "));

  // Rows
  for (const r of records) {
    console.log(COLS.map((c) => padEnd(c.key(r), c.width)).join("  "));
  }
}

// ── Commands ───────────────────────────────────────────────────────────────────

async function cmdList() {
  const limit   = parseLimit(20);
  const records = await deadLetterQueue.list(limit);
  console.log(`\nDLQ — ${records.length} record(s) shown (limit ${limit})\n`);
  printTable(records);
  console.log();
}

async function cmdInspect(jobId) {
  if (!jobId) {
    console.error("Error: inspect requires a jobId argument");
    process.exit(1);
  }

  const record = await deadLetterQueue.inspect(jobId);

  if (!record) {
    console.error(`No DLQ record found for jobId: ${jobId}`);
    process.exit(1);
  }

  console.log(JSON.stringify(record, null, 2));
}

async function cmdRequeue(jobId) {
  if (!jobId) {
    console.error("Error: requeue requires a jobId argument");
    process.exit(1);
  }

  const originalJob = await deadLetterQueue.requeue(jobId);

  if (!originalJob) {
    console.error(`No DLQ record found for jobId: ${jobId}`);
    process.exit(1);
  }

  // Attach fresh metadata (new jobId, reset attempt) and enqueue
  const requeuedJob = attachJobMetadata({
    ...originalJob,
    // strip the old jobId so a fresh one is generated — prevents the
    // idempotency key from colliding with the previous (failed) run
    jobId: undefined,
    // reset attempt
    attempt: 1
  });

  await redisRuntimeStore.enqueueMemoryJob(requeuedJob);
  await deadLetterQueue.remove(jobId);

  console.log(`\nRequeued job ${jobId} as new jobId ${requeuedJob.jobId}`);
  console.log(`Original type: ${requeuedJob.jobType}  session: ${requeuedJob.sessionId}\n`);
}

async function cmdSize() {
  const count = await deadLetterQueue.size();
  console.log(`DLQ size: ${count}`);
}

// ── Dispatch ───────────────────────────────────────────────────────────────────

async function main() {
  switch (command) {
    case "list":
      await cmdList();
      break;

    case "inspect":
      await cmdInspect(args[1]);
      break;

    case "requeue":
      await cmdRequeue(args[1]);
      break;

    case "size":
      await cmdSize();
      break;

    default:
      console.error(`Unknown command: ${command || "(none)"}`);
      console.error("");
      console.error("Usage:");
      console.error("  node src/queue/dlq-admin.js list [--limit N]");
      console.error("  node src/queue/dlq-admin.js inspect <jobId>");
      console.error("  node src/queue/dlq-admin.js requeue <jobId>");
      console.error("  node src/queue/dlq-admin.js size");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("dlq-admin fatal error:", err.message || err);
  process.exit(1);
});
