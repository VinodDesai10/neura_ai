import {
  computeMemoryFingerprint,
  scoreQueryOverlap
} from "../../../../packages/core/src/index.js";
import {
  ensureQdrantReady,
  isQdrantConfigured,
  queryQdrantPoints,
  scrollAllQdrantPoints,
  scrollQdrantPoints,
  upsertQdrantPoint
} from "./qdrant-client.js";

const vectorMemories = [];

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) {
    return -1;
  }

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    magA += a[index] * a[index];
    magB += b[index] * b[index];
  }

  if (magA === 0 || magB === 0) {
    return -1;
  }

  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export const vectorMemoryStore = {
  async upsert(memory) {
    const withFingerprint = {
      ...memory,
      fingerprint: memory.fingerprint || computeMemoryFingerprint(memory.content)
    };

    if (isQdrantConfigured() && Array.isArray(withFingerprint.embedding)) {
      await ensureQdrantReady(withFingerprint.embedding.length);
      await upsertQdrantPoint({
        id: withFingerprint.id,
        vector: withFingerprint.embedding,
        payload: {
          sessionId: withFingerprint.sessionId,
          fingerprint: withFingerprint.fingerprint,
          sourceEventId: withFingerprint.sourceEventId,
          memoryType: withFingerprint.memoryType,
          content: withFingerprint.content,
          summary: withFingerprint.summary,
          metadata: withFingerprint.metadata
        }
      });

      return withFingerprint;
    }

    const existing = vectorMemories.find(
      (entry) =>
        entry.sessionId === withFingerprint.sessionId &&
        entry.fingerprint === withFingerprint.fingerprint
    );

    if (existing) {
      existing.summary = withFingerprint.summary;
      existing.content = withFingerprint.content;
      existing.embedding = withFingerprint.embedding || existing.embedding;
      existing.metadata.importance = Math.max(
        existing.metadata.importance,
        withFingerprint.metadata.importance
      );
      existing.metadata.timestamp = withFingerprint.metadata.timestamp;
      return existing;
    }

    vectorMemories.push(withFingerprint);
    return withFingerprint;
  },

  async findRelevant({ query, queryEmbedding, sessionId }) {
    if (isQdrantConfigured() && Array.isArray(queryEmbedding)) {
      const points = await queryQdrantPoints({
        vector: queryEmbedding,
        sessionId
      });

      return points
        .map((point) => {
          const memory = {
            id: point.id,
            sessionId: point.payload.sessionId,
            fingerprint: point.payload.fingerprint,
            sourceEventId: point.payload.sourceEventId,
            memoryType: point.payload.memoryType,
            content: point.payload.content,
            summary: point.payload.summary,
            metadata: point.payload.metadata
          };
          const lexicalScore = scoreQueryOverlap(query, memory.summary);

          return {
            memory,
            score:
              (typeof point.score === "number" ? point.score : 0) +
              lexicalScore * 0.18 +
              memory.metadata.importance * 1.8
          };
        })
        .filter((entry) => entry.score > 0.45)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map((entry) => entry.memory);
    }

    // In-memory fallback: search cross-session, require relevance signal
    const trimmedQuery = query.trim().toLowerCase().replace(/[^a-z0-9\s]/g, "");
    const isSmallTalk = trimmedQuery.split(/\s+/).length <= 2 &&
      ["hi","hello","hey","ok","okay","thanks","bye","yes","no","sure","great","cool"].some(w => trimmedQuery.includes(w));

    if (isSmallTalk) return [];

    return vectorMemories
      .map((memory) => {
        const embeddingScore =
          queryEmbedding && memory.embedding
            ? cosineSimilarity(queryEmbedding, memory.embedding)
            : -1;
        const lexicalScore = scoreQueryOverlap(query, memory.summary);
        const isCrossSession = memory.sessionId !== sessionId;
        // Cross-session: require meaningful embedding similarity or lexical overlap
        if (isCrossSession && embeddingScore < 0.5 && lexicalScore === 0) {
          return { memory, score: 0 };
        }
        const sessionBonus = isCrossSession ? 0 : 0.05;
        return {
          memory,
          score:
            (embeddingScore > 0 ? embeddingScore : 0) +
            lexicalScore * 0.18 +
            memory.metadata.importance * 1.8 +
            sessionBonus
        };
      })
      .filter((entry) => entry.score > 0.45)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((entry) => entry.memory);
  },

  async all(sessionId = null) {
    if (isQdrantConfigured()) {
      const points = sessionId
        ? await scrollQdrantPoints(sessionId)
        : await scrollAllQdrantPoints();

      return points.map((point) => ({
        id: point.id,
        sessionId: point.payload.sessionId,
        fingerprint: point.payload.fingerprint,
        sourceEventId: point.payload.sourceEventId,
        memoryType: point.payload.memoryType,
        content: point.payload.content,
        summary: point.payload.summary,
        metadata: point.payload.metadata
      }));
    }

    return vectorMemories;
  }
};
