import { AI_SYSTEM_PROMPT } from "./openai-adapter.js";

/**
 * Lightweight token estimate used only for the per-section context display.
 * Provider usage remains the source of truth for the input/output totals.
 */
export function estimateTokenCount(value) {
  const text = String(value ?? "").trim();

  if (!text) {
    return 0;
  }

  return Math.max(1, Math.ceil(text.replace(/\s+/g, " ").length / 4));
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * Build the telemetry rendered by the web app's Context Window card.
 * Section values are estimates because the Gateway returns a total usage
 * count, not token counts for each prompt section.
 */
export function buildContextWindow({
  promptParts,
  activeMemories,
  recentContext,
  generation
}) {
  const breakdown = {
    normalChatContext: estimateTokenCount(promptParts.recentContext),
    workingMemory: estimateTokenCount(promptParts.workingMemory),
    currentMessage: estimateTokenCount(promptParts.currentMessage),
    systemInstructions: sum([
      estimateTokenCount(AI_SYSTEM_PROMPT),
      estimateTokenCount(promptParts.system)
    ])
  };

  const estimatedInputTokens = sum(Object.values(breakdown));
  const providerInputTokens = generation.usage?.inputTokens ?? null;
  const providerOutputTokens = generation.usage?.outputTokens ?? null;

  return {
    provider: generation.provider,
    model: generation.model,
    source: generation.source,
    contentTaken: {
      workingMemoryItems: activeMemories.length,
      recentContextTurns: recentContext.length
    },
    input: {
      totalTokens: providerInputTokens ?? estimatedInputTokens,
      totalIsEstimated: providerInputTokens === null,
      breakdown
    },
    output: {
      totalTokens: providerOutputTokens ?? estimateTokenCount(generation.text),
      totalIsEstimated: providerOutputTokens === null
    },
    updatedAt: new Date().toISOString()
  };
}
