/**
 * services/summary-memory.js
 *
 * Conversation summarisation support.
 *
 * After a configurable number of assistant turns (MEMORY_SUMMARY_EVERY_N_TURNS),
 * the orchestrator enqueues a 'summarise-session' job.  The memory worker calls
 * generateSummaryMemory(), which condenses the recent conversation into a compact
 * semantic memory tagged 'summary'.  This summary is stored like any other memory
 * and is retrieved by the hybrid pipeline just as semantic memories are.
 *
 * Why a separate service?
 *   Keeps the orchestrator thin and makes the summarisation logic independently
 *   testable (the LLM call can be stubbed in tests).
 */

import { readRetrievalConfig } from "@neura/shared";
import { computeMemoryFingerprint } from "@neura/core";
import { logger } from "../lib/logger.js";

const summaryLog = logger.child({ component: "summary-memory" });

// ─── Trigger check ────────────────────────────────────────────────────────────

/**
 * Returns true when the current assistant turn count has crossed a
 * summarisation boundary.
 *
 * The caller must track the assistant turn count per session (stored in
 * Redis session state or passed directly from the orchestrator).
 *
 * @param {number} assistantTurnCount  – total assistant turns so far this session
 * @param {object} [cfgOverride]
 * @returns {boolean}
 */
export function shouldSummarise(assistantTurnCount, cfgOverride) {
  const { summaryEveryNTurns } = cfgOverride ?? readRetrievalConfig();
  return (
    Number.isFinite(assistantTurnCount) &&
    assistantTurnCount > 0 &&
    assistantTurnCount % summaryEveryNTurns === 0
  );
}

// ─── Summary generation ───────────────────────────────────────────────────────

/**
 * Build the LLM prompt used for session summarisation.
 *
 * @param {Array<{role: string, content: string}>} turns
 * @returns {string}
 */
function buildSummaryPrompt(turns) {
  const dialogue = turns
    .slice(-40) // Keep the last 40 turns at most to stay within context limits
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n");

  return [
    "You are a memory assistant. Your task is to extract a compact, factual summary of the conversation below.",
    "Focus on: facts about the user, decisions made, ongoing tasks, user preferences, and any entities (names, technologies, projects).",
    "Write 2–5 sentences in the third person. Do NOT include pleasantries or meta-commentary.",
    "",
    "Conversation:",
    dialogue,
    "",
    "Summary:"
  ].join("\n");
}

/**
 * Generate a compact summary memory from recent turns.
 *
 * @param {{
 *   sessionId:        string,
 *   userId?:          string,
 *   recentTurns:      Array<{role: string, content: string, createdAt?: string}>,
 *   openAIAdapter:    { generateResponse(prompt: string): Promise<string> }
 * }} params
 *
 * @returns {Promise<object|null>}  A memory object ready for vectorMemoryStore.upsert(),
 *                                  or null if summarisation is not possible.
 */
export async function generateSummaryMemory({ sessionId, userId, recentTurns, openAIAdapter }) {
  if (!Array.isArray(recentTurns) || recentTurns.length < 4) {
    // Not enough context to summarise
    return null;
  }

  let summaryText;

  try {
    summaryText = await openAIAdapter.generateResponse(buildSummaryPrompt(recentTurns));
  } catch (err) {
    summaryLog.warn({ err }, "Summary generation failed; skipping");
    return null;
  }

  if (!summaryText || summaryText.trim().length < 10) return null;

  const content = summaryText.trim();
  const now = new Date().toISOString();

  return {
    id: crypto.randomUUID(),
    sessionId,
    userId: userId || null,
    memoryType: "semantic",
    content,
    summary: content.length <= 140 ? content : `${content.slice(0, 137)}...`,
    fingerprint: computeMemoryFingerprint(content),
    embedding: null, // orchestrator will embed this before upsert
    metadata: {
      importance:       0.72,  // summaries are moderately important by default
      confidence:       0.85,
      timestamp:        now,
      domain:           "general",
      domainConfidence: 0.7,
      alternateDomains: [],
      tags:             ["summary", "session-summary"],
      role:             "assistant",
      schemaVersion:    3,
      generatedBy:      "summary-memory-v1",
      extractionMethod: "llm-summarisation",
      signalStrength:   0.75,
      specificity:      0.65,
      permanence:       0.55,
      actionability:    0.4,
      sentiment:        "neutral",
      keywords:         [],
      entities:         [],
      source: {
        sessionId,
        segmentIndex: 0,
        isSummary: true
      }
    }
  };
}
