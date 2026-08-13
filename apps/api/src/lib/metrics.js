/**
 * lib/metrics.js
 *
 * Shared Prometheus registry and all metric instruments for the AiNeura API.
 *
 * Design decisions:
 *   - Single Registry instance exported so every module registers against the
 *     same registry and /metrics returns a complete, consistent scrape.
 *   - prom-client's collectDefaultMetrics() is called once here to capture
 *     process-level stats (CPU, memory, event loop lag, GC, file descriptors).
 *   - All metric names use snake_case with a consistent `neura_` prefix so they
 *     are easy to filter in Grafana / PromQL.
 *   - Histograms use Prometheus-idiomatic exponential bucket sets so
 *     percentile estimates (p50, p95, p99) are accurate across the expected
 *     latency ranges.
 *
 * Exported instruments:
 *
 *   registry              – shared prom-client Registry
 *
 *   HTTP
 *     httpRequestsTotal   – Counter  {method, route, status_code}
 *     httpDurationSeconds – Histogram{method, route, status_code}
 *
 *   Queue
 *     jobsProcessedTotal        – Counter  {job_type}
 *     jobsFailedTotal           – Counter  {job_type, error_category}
 *     jobsRetriedTotal          – Counter  {job_type}
 *     jobsDeadLetteredTotal     – Counter  {job_type}
 *     jobsDuplicateSkippedTotal – Counter  {job_type}
 *     jobProcessingDuration     – Histogram{job_type, outcome}
 *
 *   Retrieval
 *     retrievalRequestsTotal  – Counter  {cache_hit}
 *     retrievalResultsCount   – Histogram{cache_hit}
 *     retrievalDuration       – Histogram{cache_hit}
 *     rerankerRequestsTotal   – Counter  {}
 *     rerankerDuration        – Histogram{}
 *
 *   Dependency gauges (set by readiness service)
 *     redisUp    – Gauge (0/1)
 *     qdrantUp   – Gauge (0/1)
 *     postgresUp – Gauge (0/1)
 *     neo4jUp    – Gauge (0/1)
 */

import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from "prom-client";

// ── Shared registry ───────────────────────────────────────────────────────────

export const registry = new Registry();

// Collect default process/runtime metrics (CPU, memory, event loop, GC…)
// Prefix aligns them with the rest of our custom metrics.
collectDefaultMetrics({
  register: registry,
  prefix:   "neura_process_"
});

// ── HTTP metrics ──────────────────────────────────────────────────────────────

/**
 * Total HTTP requests served, labelled by method, normalised route, and
 * HTTP status code.  Use to build request-rate and error-rate dashboards.
 */
export const httpRequestsTotal = new Counter({
  name:    "neura_http_requests_total",
  help:    "Total number of HTTP requests handled",
  labelNames: ["method", "route", "status_code"],
  registers: [registry]
});

/**
 * HTTP request latency histogram.
 *
 * Buckets cover the expected range from sub-millisecond internal probes
 * to multi-second LLM calls:
 *   5ms, 10ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1s, 2.5s, 5s, 10s
 */
export const httpDurationSeconds = new Histogram({
  name:    "neura_http_request_duration_seconds",
  help:    "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets:    [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers:  [registry]
});

// ── Queue metrics ─────────────────────────────────────────────────────────────

export const jobsProcessedTotal = new Counter({
  name:    "neura_jobs_processed_total",
  help:    "Memory jobs completed successfully",
  labelNames: ["job_type"],
  registers:  [registry]
});

export const jobsFailedTotal = new Counter({
  name:    "neura_jobs_failed_total",
  help:    "Memory job attempt failures (includes retriable failures)",
  labelNames: ["job_type", "error_category"],
  registers:  [registry]
});

export const jobsRetriedTotal = new Counter({
  name:    "neura_jobs_retried_total",
  help:    "Memory jobs that were scheduled for retry",
  labelNames: ["job_type"],
  registers:  [registry]
});

export const jobsDeadLetteredTotal = new Counter({
  name:    "neura_jobs_dead_lettered_total",
  help:    "Memory jobs moved to the dead-letter queue after exhausting retries",
  labelNames: ["job_type"],
  registers:  [registry]
});

export const jobsDuplicateSkippedTotal = new Counter({
  name:    "neura_jobs_duplicate_skipped_total",
  help:    "Memory jobs skipped due to idempotency (already processed)",
  labelNames: ["job_type"],
  registers:  [registry]
});

/**
 * End-to-end job processing time from claim to outcome.
 * Buckets: 10ms → 30s to cover fast dedup hits and slow embedding calls.
 */
export const jobProcessingDuration = new Histogram({
  name:    "neura_queue_processing_duration_seconds",
  help:    "End-to-end memory job processing duration in seconds",
  labelNames: ["job_type", "outcome"],
  buckets:    [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers:  [registry]
});

// ── Retrieval metrics ─────────────────────────────────────────────────────────

export const retrievalRequestsTotal = new Counter({
  name:    "neura_retrieval_requests_total",
  help:    "Total hybrid retrieval pipeline invocations",
  labelNames: ["cache_hit"],
  registers:  [registry]
});

/**
 * Number of memories returned by a retrieval call.
 * Tells you whether the scorer is consistently returning topK results.
 */
export const retrievalResultsCount = new Histogram({
  name:    "neura_retrieval_results_count",
  help:    "Number of memories returned per retrieval request",
  labelNames: ["cache_hit"],
  buckets:    [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16],
  registers:  [registry]
});

/**
 * Wall-clock time of full retrieval (vector + lexical + dedup + rerank).
 * Buckets: 1ms → 5s.
 */
export const retrievalDurationSeconds = new Histogram({
  name:    "neura_retrieval_duration_seconds",
  help:    "Hybrid retrieval pipeline duration in seconds",
  labelNames: ["cache_hit"],
  buckets:    [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers:  [registry]
});

export const rerankerRequestsTotal = new Counter({
  name:    "neura_reranker_requests_total",
  help:    "Total deduplicateAndRerank() invocations",
  registers:  [registry]
});

export const rerankerDurationSeconds = new Histogram({
  name:    "neura_reranker_duration_seconds",
  help:    "deduplicateAndRerank() duration in seconds",
  buckets:    [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1],
  registers:  [registry]
});

/**
 * Incremented each time a topical relevance penalty multiplier < 1 is applied
 * inside applyTopicalRelevancePenalty().  Use this to monitor how aggressively
 * the penalty is firing in production and to tune threshold / factor values.
 */
export const topicalPenaltyAppliedTotal = new Counter({
  name:    "neura_retrieval_topical_penalty_applied_total",
  help:    "Total number of times a topical relevance penalty multiplier < 1 was applied",
  registers:  [registry]
});

// ── Dependency health gauges ──────────────────────────────────────────────────
// Set to 1 when the dependency is up, 0 when down, -1 when skipped/unconfigured.

export const redisUp = new Gauge({
  name:    "neura_redis_up",
  help:    "Redis reachability (1=up, 0=down, -1=skipped/not configured)",
  registers:  [registry]
});

export const qdrantUp = new Gauge({
  name:    "neura_qdrant_up",
  help:    "Qdrant reachability (1=up, 0=down, -1=skipped/not configured)",
  registers:  [registry]
});

export const postgresUp = new Gauge({
  name:    "neura_postgres_up",
  help:    "PostgreSQL reachability (1=up, 0=down, -1=skipped/not configured)",
  registers:  [registry]
});

export const neo4jUp = new Gauge({
  name:    "neura_neo4j_up",
  help:    "Neo4j reachability (1=up, 0=down, -1=skipped/not configured)",
  registers:  [registry]
});

// ── Gauge value helpers ───────────────────────────────────────────────────────

/**
 * Convert a readiness check status string to a gauge value.
 * @param {'ok'|'down'|'skipped'|'degraded'} status
 * @returns {number}
 */
export function statusToGauge(status) {
  if (status === "ok")      return 1;
  if (status === "down")    return 0;
  return -1; // skipped / degraded / unknown
}
