/**
 * packages/core/src/prompts/index.js
 *
 * LLM prompt assembly for chat turns.
 *
 * Public exports (re-exported from @neura/core):
 *   - buildContextPrompt
 */

/**
 * Build the system/user prompt that is sent to the LLM for a chat turn.
 *
 * @param {{
 *   userMessage:    string,
 *   activeMemories: object[],
 *   recentContext:  object[]
 * }} params
 * @returns {string}
 */
export function buildContextPrompt({ userMessage, activeMemories, recentContext }) {
  const memoryBlock = activeMemories.length
    ? activeMemories
        .map((m, i) => `${i + 1}. [${m.memoryType}] ${m.summary}`)
        .join("\n")
    : "None";

  const recentBlock = recentContext.length
    ? recentContext.map((e) => `${e.role}: ${e.content}`).join("\n")
    : "None";

  return [
    `You are AiNeura, an intelligent assistant with persistent memory across all conversations.

CRITICAL RULES:
- The memories below are things you already know about the user from past conversations. Treat them as background knowledge — like a friend who remembers things about you.
- NEVER repeat or recite memory content unprompted. Only use it when it is directly relevant to what the user just said.
- If the user says "hi" or "hello", respond naturally and conversationally. Do NOT introduce yourself using their name or dump memory facts at them.
- Only mention something from memory if the user asks about it, or if it genuinely helps answer their current message.
- Never say "Based on my memories..." or "I remember that...". Just respond naturally, the way a knowledgeable friend would.
- Be warm, concise, and helpful.`,
    `What you know about this user (use as silent background context only):\n${memoryBlock}`,
    `Recent conversation:\n${recentBlock}`,
    `User: ${userMessage}`
  ].join("\n\n");
}
