import {
  computeMemoryFingerprint,
  extractMemoryCandidates
} from "../../../../packages/core/src/index.js";
import { factualMemoryStore } from "../infrastructure/factual-memory-store.js";
import { vectorMemoryStore } from "../infrastructure/vector-memory-store.js";
import { linkMemoryRelationships, linkBatchMemoryRelationships } from "../infrastructure/relationship-graph-store.js";
import { openAIAdapter } from "./openai-adapter.js";

// Cache for embeddings to avoid duplicate requests
const embeddingCache = new Map();

export async function processEventIntoMemories(event) {
  const candidates = extractMemoryCandidates(event);
  const stored = [];
  const memoriesToLink = [];

  for (const baseCandidate of candidates) {
    const candidate = {
      id: crypto.randomUUID(),
      sourceEventId: event.id,
      sessionId: event.sessionId,
      memoryType: baseCandidate.memoryType,
      content: baseCandidate.content,
      summary: baseCandidate.summary,
      metadata: baseCandidate.metadata,
      fingerprint: computeMemoryFingerprint(baseCandidate.content),
      embedding: null
    };

    if (candidate.memoryType === "factual") {
      const storedMemory = await factualMemoryStore.upsert(candidate);
      memoriesToLink.push(storedMemory);
      stored.push(storedMemory);
      continue;
    }

    const embeddingKey = `${candidate.memoryType}:${candidate.summary}`;
    if (embeddingCache.has(embeddingKey)) {
      candidate.embedding = embeddingCache.get(embeddingKey);
    } else {
      candidate.embedding = await openAIAdapter.embedText(
        `${candidate.memoryType}: ${candidate.summary}`
      );
      embeddingCache.set(embeddingKey, candidate.embedding);
    }

    const storedMemory = await vectorMemoryStore.upsert(candidate);
    memoriesToLink.push(storedMemory);
    stored.push(storedMemory);
  }

  if (memoriesToLink.length > 0) {
    await linkBatchMemoryRelationships(memoriesToLink);
  }

  return stored.filter(Boolean);
}
