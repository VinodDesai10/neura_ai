/**
 * packages/core/src/memory/services/importanceScorer.js
 *
 * Storage-intelligence importance scorer.
 *
 * `calculateImportance` is the storage-layer counterpart to
 * `scoreMemoryImportance` (scorer.js).  Where `scoreMemoryImportance` works
 * on a raw content string during extraction, `calculateImportance` works on a
 * fully formed MemoryCandidate plus an optional runtime context object.  This
 * lets it factor in access patterns, explicit user saves, repeated mentions,
 * and content richness — signals that are not available at extraction time.
 *
 * Public exports (re-exported from memory/index.js and @neura/core):
 *   - calculateImportance
 *
 * Design goals:
 *   - Pure function: no side effects, no I/O, deterministic given the same
 *     inputs.
 *   - Transparent: every contribution to the final score is visible in the
 *     returned breakdown.
 *   - Composable: callers can pass only the context fields they have; missing
 *     fields fall back to neutral values.
 *
 * ─── Score composition ────────────────────────────────────────────────────────
 *
 *   base          = metadata.importance   (extraction-time score, 0–1)
 *   recencyScore  = exponential decay on metadata.timestamp (half-life 72 h)
 *   frequencyScore= log-scaled access count (saturates at accessCount ≥ 20)
 *   savedBonus    = flat +0.15 when metadata.savedByUser === true
 *   mentionBonus  = log-scaled repeated-mention count (saturates at 10)
 *   lengthScore   = content richness proxy (characters, saturates at 400)
 *
 *   raw = base × 0.60
 *       + recencyScore  × 0.15
 *       + frequencyScore× 0.10
 *       + savedBonus
 *       + mentionBonus  × 0.08
 *       + lengthScore   × 0.05
 *
 *   final = clampScore(raw)             → [0, 1] rounded to 2 d.p.
 */

import { clampScore } from "@neura/shared";

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Recency half-life in hours.  Score halves every RECENCY_HALF_LIFE_HOURS. */
const RECENCY_HALF_LIFE_HOURS = 72;

/**
 * Maximum age (hours) at which recency decay is applied.  Beyond this the
 * recency contribution reaches a stable floor (prevents scores from going
 * to zero just because something is old).
 */
const RECENCY_MAX_AGE_HOURS = 720; // 30 days

/** Access-count value where the frequency score saturates at 1.0. */
const FREQUENCY_SATURATION = 20;

/** Mention count where the mention bonus saturates at 1.0. */
const MENTION_SATURATION = 10;

/** Content length (chars) at which the length score saturates at 1.0. */
const LENGTH_SATURATION = 400;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Calculate a composite importance score (0–1) for a stored memory.
 *
 * The function blends the extraction-time importance stored in
 * `memory.metadata.importance` with runtime signals from `context`:
 *
 * - **Recency** — how recently the memory was created (timestamp decay).
 * - **Access frequency** — how many times the memory has been retrieved.
 * - **Explicit user save** — whether the user pinned this memory.
 * - **Repeated mentions** — how often the topic reappears across turns.
 * - **Content length** — a proxy for information richness.
 *
 * When `context` is omitted or a field is absent, that signal defaults to
 * a neutral value (neither boosting nor penalising the score).
 *
 * @param {import("../entities/memory-types.js").MemoryCandidate} memory
 *   The fully formed memory candidate to score.  Must have a `metadata`
 *   object; all other fields are optional.
 *
 * @param {{
 *   nowMs?:          number,   // current time as Unix ms (default: Date.now())
 *   accessCount?:    number,   // retrieval hit count (default: metadata.accessCount ?? 0)
 *   savedByUser?:    boolean,  // user pinned the memory (default: metadata.savedByUser ?? false)
 *   mentionCount?:   number,   // repeated-mention count across turns (default: 0)
 * }} [context={}]
 *   Runtime signals.  Every field is optional.
 *
 * @returns {{
 *   score:          number,   // final clamped importance in [0, 1]
 *   base:           number,   // extraction-time importance
 *   recencyScore:   number,   // 0–1 recency contribution
 *   frequencyScore: number,   // 0–1 access-frequency contribution
 *   savedBonus:     number,   // flat bonus for user-saved memories
 *   mentionBonus:   number,   // 0–1 repeated-mention contribution
 *   lengthScore:    number,   // 0–1 content-length richness proxy
 * }}
 */
export function calculateImportance(memory, context = {}) {
  const metadata = memory?.metadata ?? {};

  // ── 1. Base score ───────────────────────────────────────────────────────────
  // Use the extraction-time importance; fall back to a neutral 0.5.
  const base = typeof metadata.importance === "number"
    ? clampScore(metadata.importance)
    : 0.5;

  // ── 2. Recency score ────────────────────────────────────────────────────────
  // Exponential decay: score = exp(−λ × ageHours), λ = ln(2) / half-life.
  // Factual memories (names, preferences, decisions) do not decay with age —
  // "my name is Alice" is as true today as it was six months ago.  Only
  // episodic memories carry an intrinsic time-bound relevance.
  const nowMs     = typeof context.nowMs === "number" ? context.nowMs : Date.now();
  const timestamp = metadata.timestamp ?? null;
  const memType   = memory?.memoryType ?? "";
  let recencyScore = 0.5; // neutral when no timestamp

  if (timestamp && memType !== "factual") {
    const ageMs    = Math.max(0, nowMs - new Date(timestamp).getTime());
    const ageHours = Math.min(ageMs / (1000 * 60 * 60), RECENCY_MAX_AGE_HOURS);
    const lambda   = Math.LN2 / RECENCY_HALF_LIFE_HOURS;
    recencyScore   = Math.exp(-lambda * ageHours);
  } else if (timestamp && memType === "factual") {
    // Factual memories stay fresh — full recency score.
    recencyScore = 1.0;
  }

  // ── 3. Frequency score ──────────────────────────────────────────────────────
  // Log-scaled so that the 1st hit already contributes meaningfully, but
  // there are diminishing returns above FREQUENCY_SATURATION.
  const rawAccessCount = context.accessCount ?? metadata.accessCount ?? 0;
  const accessCount    = Math.max(0, Number(rawAccessCount) || 0);
  const frequencyScore = accessCount === 0
    ? 0
    : Math.min(1, Math.log1p(accessCount) / Math.log1p(FREQUENCY_SATURATION));

  // ── 4. Saved bonus ──────────────────────────────────────────────────────────
  // A flat +0.15 when the user has explicitly pinned this memory.
  const isSaved    = context.savedByUser ?? metadata.savedByUser ?? false;
  const savedBonus = isSaved ? 0.15 : 0;

  // ── 5. Mention bonus ────────────────────────────────────────────────────────
  // Repeated mentions signal that a topic is relevant across turns.
  const rawMentionCount = context.mentionCount ?? 0;
  const mentionCount    = Math.max(0, Number(rawMentionCount) || 0);
  const mentionBonus    = mentionCount === 0
    ? 0
    : Math.min(1, Math.log1p(mentionCount) / Math.log1p(MENTION_SATURATION));

  // ── 6. Content length score ─────────────────────────────────────────────────
  // Longer content is a rough proxy for information richness.  Short snippets
  // get a lower score; long, detailed memories get a higher one.
  const contentLen  = typeof memory?.content === "string" ? memory.content.length : 0;
  const lengthScore = Math.min(1, contentLen / LENGTH_SATURATION);

  // ── 7. Weighted combination ─────────────────────────────────────────────────
  //
  // Weight design rationale:
  //   base (0.60)  — extraction-time importance is the primary signal; runtime
  //                  signals refine it rather than replace it.
  //   recency (0.15) — recent memories are more actionable.
  //   frequency (0.10) — retrieval history signals value.
  //   savedBonus (flat 0.15) — explicit user save is the strongest runtime signal.
  //   mention (0.08) — repeated mentions indicate ongoing relevance.
  //   length (0.05) — content richness as a tiebreaker.
  const raw =
    base           * 0.60 +
    recencyScore   * 0.15 +
    frequencyScore * 0.10 +
    savedBonus           +       // flat contribution (already bounded to 0.15)
    mentionBonus   * 0.08 +
    lengthScore    * 0.05;

  return {
    score:          clampScore(raw),
    base,
    recencyScore:   clampScore(recencyScore),
    frequencyScore: clampScore(frequencyScore),
    savedBonus,
    mentionBonus:   clampScore(mentionBonus),
    lengthScore:    clampScore(lengthScore)
  };
}
