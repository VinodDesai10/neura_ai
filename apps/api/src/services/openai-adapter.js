import { redisRuntimeStore } from "../infrastructure/redis-runtime-store.js";
import { logger } from "../lib/logger.js";

const adapterLog = logger.child({ component: "openai-adapter" });

function buildFallbackReply(prompt) {
  const userLine = prompt
    .split("\n")
    .find((line) => line.startsWith("User message:"));

  return [
    "AiNeura demo response:",
    userLine ? userLine.replace("User message:", "").trim() : "I received your message.",
    "This is currently running with a local fallback responder until the OpenAI integration is wired."
  ].join(" ");
}

function extractResponseText(payload) {
  const output = Array.isArray(payload.output) ? payload.output : [];

  for (const item of output) {
    if (item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }

    const textParts = item.content
      .filter((part) => part.type === "output_text" && typeof part.text === "string")
      .map((part) => part.text.trim())
      .filter(Boolean);

    if (textParts.length) {
      return textParts.join("\n");
    }
  }

  return "";
}

function extractChatCompletionText(payload) {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const content = choice?.message?.content;

  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (part && typeof part.text === "string") {
          return part.text;
        }

        return "";
      })
      .join("\n")
      .trim();
  }

  return "";
}

async function callOpenAI(path, body) {
  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/v1/") ? path.slice(3) : path;
  const response = await fetch(`${baseUrl}${normalizedPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY || "lm-studio"}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${errorText}`);
  }

  return response.json();
}

export const openAIAdapter = {
  async generateResponse(prompt) {
    if (!process.env.OPENAI_API_KEY) {
      if (!process.env.OPENAI_BASE_URL) {
        return buildFallbackReply(prompt);
      }
    }

    const payload = await callOpenAI("/v1/chat/completions", {
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content:
            "You are AiNeura, a memory-centric assistant. Answer naturally using the surfaced context. If the context is insufficient, say what you do and do not know."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.4,
      max_completion_tokens: 1000
    });

    const text = extractChatCompletionText(payload) || extractResponseText(payload);
    return text || buildFallbackReply(prompt);
  },

  async embedText(text) {
    const model = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
    const cached = await redisRuntimeStore.getCachedEmbedding({ model, text });

    if (cached?.embedding) {
      return cached.embedding;
    }

    if (!process.env.OPENAI_API_KEY) {
      if (!process.env.OPENAI_BASE_URL) {
        return null;
      }
    }

    let payload;

    try {
      payload = await callOpenAI("/v1/embeddings", {
        model,
        input: text,
        encoding_format: "float"
      });
    } catch (error) {
      adapterLog.warn(
        { err: error },
        "Embedding request failed; vector memory will be skipped for this turn"
      );
      return null;
    }

    const embedding = payload?.data?.[0]?.embedding ?? null;
    await redisRuntimeStore.setCachedEmbedding({ model, text, embedding });
    return embedding;
  }
};
