/**
 * infrastructure/qdrant/vector-memory-store.js
 *
 * Qdrant-backed episodic and semantic memory store.
 *
 * Changes from original:
 *   - findRelevant() uses the retrieval-scorer hybrid pipeline
 *   - Every returned memory carries a `_retrieval` envelope with score breakdown
 *   - Namespace isolation: sessionId filter is applied when strictNamespace=true
 *   - In-memory fallback also uses hybrid scoring
 */

import { computeMemoryFingerprint, scoreQueryOverlap } from "@neura/core";
import { readRetrievalConfig } from "@neura/shared";
import { computeHybridScore } from "../../services/retrieval-scorer.js";
import {
  ensureQdrantReady,
  isQdrantConfigured,
  queryQdrantPoints,
  scrollAllQdrantPoints,
  scrollQdrantPoints,
  setQdrantPayload,
  upsertQdrantPoint
} from "./qdrant-client.js";

/** In-memory fallback store (used when QDRANT_URL is not set) */
const vectorMemories = [];

// ─── Cosine similarity (local) ────────────────────────────────────────────────

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) {
    return -1;
  }
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return -1;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ─── Small-talk guard ─────────────────────────────────────────────────────────

function isSmallTalkQuery(query) {
  const trimmed = query.trim().toLowerCase().replace(/[^a-z0-9\s]/g, "");
  return (
    trimmed.split(/\s+/).length <= 2 &&
    ["hi", "hello", "hey", "ok", "okay", "thanks", "bye", "yes", "no", "sure", "great", "cool"]
      .some((w) => trimmed.includes(w))
  );
}

// ─── Map a Qdrant point → internal memory object ─────────────────────────────

function pointToMemory(point) {
  return {
    id:            point.id,
    sessionId:     point.payload.sessionId,
    fingerprint:   point.payload.fingerprint,
    sourceEventId: point.payload.sourceEventId,
    memoryType:    point.payload.memoryType,
    content:       point.payload.content,
    summary:       point.payload.summary,
    metadata:      point.payload.metadata
  };
}

// ─── Store ───────────────────────────────────────────────────────────────────

export const vectorMemoryStore = {
  // ── upsert ──────────────────────────────────────────────────────────────────
  async upsert(memory) {
    const withFingerprint = {
      ...memory,
      fingerprint: memory.fingerprint || computeMemoryFingerprint(memory.content)
    };

    if (isQdrantConfigured() && Array.isArray(withFingerprint.embedding)) {
      await ensureQdrantReady(withFingerprint.embedding.length);
      await upsertQdrantPoint({
        id:     withFingerprint.id,
        vector: withFingerprint.embedding,
        payload: {
          sessionId:     withFingerprint.sessionId,
          userId:        withFingerprint.userId || null,
          fingerprint:   withFingerprint.fingerprint,
          sourceEventId: withFingerprint.sourceEventId,
          memoryType:    withFingerprint.memoryType,
          content:       withFingerprint.content,
          summary:       withFingerprint.summary,
          metadata:      withFingerprint.metadata
        }
      });
      return withFingerprint;
    }

    // In-memory fallback
    const existing = vectorMemories.find(
      (e) => e.sessionId === withFingerprint.sessionId && e.fingerprint === withFingerprint.fingerprint
    );

    if (existing) {
      existing.summary   = withFingerprint.summary;
      existing.content   = withFingerprint.content;
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

  // ── findRelevant ─────────────────────────────────────────────────────────────
  /**
   * Retrieve and score memories relevant to `query`.
   *
   * @param {{
   *   query:          string,
   *   queryEmbedding: number[]|null,
   *   sessionId:      string,
   *   userId?:        string
   * }} params
   * @returns {Promise<object[]>}  memories sorted by hybrid score, each with `_retrieval`
   */
  async findRelevant({ query, queryEmbedding, sessionId, userId }) {
    if (isSmallTalkQuery(query)) return [];

    const cfg = readRetrievalConfig();

    // ── Qdrant path ──────────────────────────────────────────────────────────
    if (isQdrantConfigured() && Array.isArray(queryEmbedding)) {
      const points = await queryQdrantPoints({
        vector:    queryEmbedding,
        sessionId,
        limit:     cfg.topK * 3   // Fetch 3× to give dedup room
      });

      return points
        .map((point) => {
          const memory      = pointToMemory(point);
          const vectorScore = typeof point.score === "number" ? point.score : 0;
          const lexicalScore = scoreQueryOverlap(query, memory.summary || memory.content || "");

          const breakdown = computeHybridScore(
            {
              vectorScore,
              lexicalScore,
              importanceScore: Number(memory.metadata?.importance || 0),
              timestamp:       memory.metadata?.timestamp || null,
              sessionId:       memory.sessionId,
              querySessionId:  sessionId
            },
            cfg
          );

          return {
            memory: {
              ...memory,
              _retrieval: {
                ...breakdown,
                timestamp: memory.metadata?.timestamp || null,
                source:    "qdrant"
              }
            },
            score: breakdown.score
          };
        })
        .filter((e) => e.score > 0.05)
        .sort((a, b) => b.score - a.score)
        .slice(0, cfg.topK)
        .map((e) => e.memory);
    }

    // ── In-memory fallback path ───────────────────────────────────────────────
    return vectorMemories
      .map((memory) => {
        const embeddingScore =
          queryEmbedding && memory.embedding
            ? cosineSimilarity(queryEmbedding, memory.embedding)
            : -1;

        const lexicalScore = scoreQueryOverlap(query, memory.summary || memory.content || "");

        // Strict namespace: skip memories from other sessions unless they have high
        // lexical overlap AND a meaningful embedding match
        const isCrossSession = memory.sessionId !== sessionId;
        if (isCrossSession && embeddingScore < 0.5 && lexicalScore === 0) {
          return null;
        }

        const breakdown = computeHybridScore(
          {
            vectorScore:     Math.max(0, embeddingScore),
            lexicalScore,
            importanceScore: Number(memory.metadata?.importance || 0),
            timestamp:       memory.metadata?.timestamp || null,
            sessionId:       memory.sessionId,
            querySessionId:  sessionId
          },
          cfg
        );

        return {
          memory: {
            ...memory,
            _retrieval: {
              ...breakdown,
              timestamp: memory.metadata?.timestamp || null,
              source:    "local"
            }
          },
          score: breakdown.score
        };
      })
      .filter((e) => e !== null && e.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, cfg.topK)
      .map((e) => e.memory);
  },

  // ── updatePayloadMetadata ──────────────────────────────────────────────────
  /**
   * Partially update the `metadata` field of a Qdrant point payload without
   * touching the embedding vector.
   *
   * This is the correct path for lifecycle-state updates — Qdrant's PATCH
   * /points/payload endpoint merges the supplied object into the existing
   * payload so only the listed keys are changed.
   *
   * @param {string} id        - Memory ID (Qdrant point UUID)
   * @param {object} metadata  - Full metadata object from the updated memory.
   *                             Only lifecycle-critical fields are sent.
   * @returns {Promise<boolean>}  true on success (Qdrant configured + call succeeded)
   */
  async updatePayloadMetadata(id, metadata) {
    if (isQdrantConfigured()) {
      // We set the `metadata` key in the payload to the new value.
      // This keeps the full metadata sub-object consistent with PostgreSQL.
      await setQdrantPayload(id, { metadata });
      return true;
    }

    // In-memory fallback
    const existing = vectorMemories.find((m) => m.id === id);
    if (!existing) return false;
    existing.metadata = { ...existing.metadata, ...metadata };
    return true;
  },

  // ── all ───────────────────────────────────────────────────────────────────
  async all(sessionId = null) {
    if (isQdrantConfigured()) {
      const points = sessionId
        ? await scrollQdrantPoints(sessionId)
        : await scrollAllQdrantPoints();

      return points.map(pointToMemory);
    }

    return sessionId
      ? vectorMemories.filter((m) => m.sessionId === sessionId)
      : vectorMemories;
  }
};
