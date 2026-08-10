/**
 * lib/logger.js
 *
 * Centralised pino logger for the AiNeura API and memory worker.
 *
 * Behaviour:
 *   - Development (NODE_ENV !== "production"): pretty-printed, human-readable
 *     logs with timestamps and colours via pino-pretty.
 *   - Production (NODE_ENV === "production"): newline-delimited JSON written to
 *     stdout — ready for any structured-log aggregator (Datadog, CloudWatch,
 *     Loki, etc.).
 *
 * Usage:
 *   import { logger } from "../lib/logger.js";
 *   logger.info({ sessionId }, "Chat turn started");
 *   logger.error({ err, requestId }, "Unhandled controller error");
 *
 * Child loggers (request-scoped):
 *   const reqLog = logger.child({ requestId: req.requestId });
 *   reqLog.info({ method, path }, "Request received");
 */

import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

/**
 * Build pino transport config.
 * pino-pretty is used in development only.  In production we rely on pino's
 * default ndjson output (no transport overhead).
 */
const transport = isDev
  ? {
      target: "pino-pretty",
      options: {
        colorize:         true,
        translateTime:    "SYS:HH:MM:ss.l",  // local wall-clock time
        ignore:           "pid,hostname",
        messageFormat:    "{msg}",
        errorLikeObjectKeys: ["err", "error"],
        levelFirst:       false,
        singleLine:       false
      }
    }
  : undefined;

export const logger = pino(
  {
    // "trace" lets us turn on verbose logs via LOG_LEVEL env var without
    // redeploying.  Defaults to "info" in production and "debug" in dev.
    level: process.env.LOG_LEVEL ?? (isDev ? "debug" : "info"),

    // Ensure "err" objects serialise stack traces correctly.
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err   // alias — some code passes { error }
    },

    // In production emit epoch ms for fast log-pipeline ingestion; pino-pretty
    // reformats this in development.
    timestamp: pino.stdTimeFunctions.isoTime,

    // Base fields added to every log line.
    base: {
      service: "neura-api",
      env:     process.env.NODE_ENV ?? "development"
    }
  },
  transport ? pino.transport(transport) : undefined
);
