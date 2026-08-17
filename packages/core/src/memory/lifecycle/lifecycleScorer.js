/**
 * packages/core/src/memory/lifecycle/lifecycleScorer.js
 *
 * Pure, stateless lifecycle signal computation.
 *
 * Calculates the signals that drive lifecycle state transitions — age,
 * access recency, importance, and confidence — using only the metadata
 * already present on a stored memory.
 *
 * ─── Design principles ────────────────────────────────────────────────────────
 *
 *   • No duplication of importance logic.  `importanceScore` and
 *     `confidenceScore` are read directly from `memory.metadata` — they are
 *     not re-computed here.  `calculateImportance` (importanceScorer.js) runs
 *     at retrieval time with richer context; we only need the stored values
 *     at lifecycle evaluation time.
 *
 *   • Pure functions: no I/O, no side-effects, fully deterministic.
 *
 *   • All returned scores are normalised to [0, 1].
 *
 * ─── Exported functions ──────────────────────────────────────────────────────
 *
 *   computeLifecycleSignals(memory, nowMs?) → LifecycleSignals
 *   shouldMarkStale(signals, memory, config?) → boolean
 *   shouldArchive(signals, memory, config?) → boolean
 */

import { clampScore } from "@neura/shared";
import { readLifecycleConfig } from "./lifecycleTypes.js";

// ─── Internal constants ───────────────────────────────────────────────────────

/** Age at which ageScore reaches its minimum floor (hours). */
const AGE_FLOOR_HOURS = 24 * 365; // 1 year

/** Half-life for age decay (hours). */
const AGE_HALF_LIFE_HOURS = 24 * 60; // 60 days

/** Half-life for access recency decay (hours). */
const ACCESS_HALF_LIFE_HOURS = 24 * 21; // 21 days

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse a date string / Date object to epoch milliseconds.
 * Returns `null` if absent or unparseable.
 *
 * @param {string|Date|null|undefined} value
 * @returns {number|null}
 */
function toMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Exponential decay: score = exp(−λ × age), λ = ln(2) / halfLife.
 *
 * @param {number} ageHours
 * @param {number} halfLifeHours
 * @returns {number}  score in (0, 1]
 */
function exponentialDecay(ageHours, halfLifeHours) {
  if (ageHours <= 0) return 1.0;
  const cappedAge = Math.min(ageHours, halfLifeHours * 10);
  const lambda    = Math.LN2 / halfLifeHours;
  return Math.exp(-lambda * cappedAge);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Compute the lifecycle signals for a single memory.
 *
 * @param {object} memory
 *   The stored memory object.  Must have a `metadata` sub-object.
 * @param {number} [nowMs=Date.now()]
 *   Current time as Unix milliseconds.  Accepts an override for testing.
 * @returns {import("./lifecycleTypes.js").LifecycleSignals}
 */
export function computeLifecycleSignals(memory, nowMs = Date.now()) {
  const meta = memory?.metadata ?? {};

  // ── Importance and confidence (read from stored metadata directly) ──────────
  const importanceScore = clampScore(
    typeof meta.importance === "number" ? meta.importance : 0.5
  );
  const confidenceScore = clampScore(
    typeof meta.confidence === "number" ? meta.confidence : 0.5
  );

  // ── Age: how old is the memory? ─────────────────────────────────────────────
  const createdMs  = toMs(meta.timestamp);
  const ageMs      = createdMs !== null ? Math.max(0, nowMs - createdMs) : 0;
  const ageHours   = ageMs / (1000 * 60 * 60);
  const ageScore   = createdMs !== null
    ? clampScore(exponentialDecay(ageHours, AGE_HALF_LIFE_HOURS))
    : 0.5; // neutral when no timestamp

  // ── Last access: how recently was this retrieved? ───────────────────────────
  const lastAccessMs    = toMs(meta.lastAccessedAt) ?? createdMs ?? null;
  const lastAccessAgeMs = lastAccessMs !== null ? Math.max(0, nowMs - lastAccessMs) : null;
  const lastAccessHours = lastAccessAgeMs !== null
    ? lastAccessAgeMs / (1000 * 60 * 60)
    : ageHours; // treat unaccessed = as old as the memory itself
  const accessScore = lastAccessMs !== null
    ? clampScore(exponentialDecay(lastAccessHours, ACCESS_HALF_LIFE_HOURS))
    : 0.5; // neutral when we have no access data

  // ── Composite freshness: blend age + access ─────────────────────────────────
  // Access recency carries more weight than pure age — a recently accessed
  // memory is fresher regardless of creation date.
  const freshness = clampScore(ageScore * 0.35 + accessScore * 0.65);

  return {
    ageScore,
    accessScore,
    importanceScore,
    confidenceScore,
    freshness,
    ageHours,
    lastAccessHours
  };
}

/**
 * Decide whether a memory should transition to STALE based on its signals
 * and the active lifecycle configuration.
 *
 * A memory is stale when:
 *   1. It has not been accessed in at least `staleAccessDays` days, AND
 *   2. Its importance is below `staleImportanceMin`.
 *
 * Factual memories with high confidence are treated more leniently —
 * "my name is Alice" doesn't go stale just because it hasn't been retrieved.
 *
 * @param {import("./lifecycleTypes.js").LifecycleSignals} signals
 * @param {object} memory
 * @param {ReturnType<import("./lifecycleTypes.js").readLifecycleConfig>} [config]
 * @returns {boolean}
 */
export function shouldMarkStale(signals, memory, config) {
  const cfg          = config ?? readLifecycleConfig();
  const staleHours   = cfg.staleAccessDays * 24;
  const meta         = memory?.metadata ?? {};
  const memType      = memory?.memoryType ?? "";

  // High-confidence factual memories remain ACTIVE longer.
  const isHighConfidenceFactual =
    memType === "factual" && (meta.confidence ?? 0) >= 0.75;
  const effectiveStaleHours = isHighConfidenceFactual
    ? staleHours * 2
    : staleHours;

  const accessedTooLongAgo = signals.lastAccessHours >= effectiveStaleHours;
  const importanceTooLow   = signals.importanceScore < cfg.staleImportanceMin;

  return accessedTooLongAgo && importanceTooLow;
}

/**
 * Decide whether a memory should be archived.
 *
 * A memory auto-archives when it has been STALE (or just very old and
 * unimportant) for longer than `archiveAccessDays`, provided its importance
 * is still below `archiveImportanceMax`.
 *
 * @param {import("./lifecycleTypes.js").LifecycleSignals} signals
 * @param {object} memory
 * @param {ReturnType<import("./lifecycleTypes.js").readLifecycleConfig>} [config]
 * @returns {boolean}
 */
export function shouldArchive(signals, memory, config) {
  const cfg          = config ?? readLifecycleConfig();
  const archiveHours = cfg.archiveAccessDays * 24;
  const { LifecycleState } = await_import_guard();

  const alreadyStaleOrConflicted =
    memory?.metadata?.lifecycleState === LifecycleState.STALE ||
    memory?.metadata?.lifecycleState === LifecycleState.CONFLICTED;

  const accessedTooLongAgo = signals.lastAccessHours >= archiveHours;
  const importanceLow      = signals.importanceScore < cfg.archiveImportanceMax;

  // Only archive if it's been stale/conflicted a long time AND importance is low.
  return alreadyStaleOrConflicted && accessedTooLongAgo && importanceLow;
}

/**
 * Guard to avoid a circular import between lifecycleScorer and lifecycleTypes.
 * LifecycleState is a plain string enum so we inline the values here.
 *
 * @returns {{ LifecycleState: { STALE: string, CONFLICTED: string } }}
 */
function await_import_guard() {
  return {
    LifecycleState: {
      STALE:      "stale",
      CONFLICTED: "conflicted"
    }
  };
}
