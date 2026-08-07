import { getRedisClient } from "./redis-client.js";

const workingMemoryBySession = new Map();

const DEFAULT_MIN_TTL_SECONDS = 60 * 60;
const DEFAULT_MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_BASE_TTL_SECONDS = 2 * 60 * 60;

function getWorkingMemoryKey(sessionId) {
  const prefix = process.env.REDIS_WORKING_MEMORY_PREFIX || "neura:working-memory";
  return `${prefix}:${sessionId}`;
}

function readTtlBoundary(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(values) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function getMemoryScore(memory) {
  const metadata = memory?.metadata || {};
  const importance = Number(metadata.importance || 0);
  const confidence = Number(metadata.confidence || 0);
  const signalStrength = Number(metadata.signalStrength || 0);
  const specificity = Number(metadata.specificity || 0);
  const permanence = Number(metadata.permanence || 0);
  const actionability = Number(metadata.actionability || 0);
  const domainConfidence = Number(metadata.domainConfidence || 0);

  return clamp(
    importance * 0.34 +
      confidence * 0.18 +
      signalStrength * 0.16 +
      permanence * 0.12 +
      specificity * 0.08 +
      actionability * 0.08 +
      domainConfidence * 0.04,
    0,
    1
  );
}

function getRecentContextScore(recentContext) {
  return clamp((recentContext?.length || 0) / 8, 0, 1);
}

function getFreshnessScore(memories) {
  const timestamps = memories
    .map((memory) => Date.parse(memory?.metadata?.timestamp))
    .filter(Number.isFinite);

  if (!timestamps.length) {
    return 0.25;
  }

  const newestAgeMs = Date.now() - Math.max(...timestamps);
  const oneDayMs = 24 * 60 * 60 * 1000;
  return clamp(1 - newestAgeMs / oneDayMs, 0, 1);
}

export function calculateWorkingMemoryTtlSeconds(payload) {
  const minTtl = readTtlBoundary(
    "REDIS_WORKING_MEMORY_MIN_TTL_SECONDS",
    DEFAULT_MIN_TTL_SECONDS
  );
  const maxTtl = readTtlBoundary(
    "REDIS_WORKING_MEMORY_MAX_TTL_SECONDS",
    DEFAULT_MAX_TTL_SECONDS
  );
  const baseTtl = clamp(
    readTtlBoundary(
      "REDIS_WORKING_MEMORY_BASE_TTL_SECONDS",
      DEFAULT_BASE_TTL_SECONDS
    ),
    minTtl,
    Math.max(minTtl, maxTtl)
  );
  const normalizedMaxTtl = Math.max(minTtl, maxTtl);
  const activeMemories = payload.activeMemories || [];

  if (!activeMemories.length && !(payload.recentContext || []).length) {
    return Math.min(minTtl, baseTtl);
  }

  const memoryScores = activeMemories.map(getMemoryScore);
  const topMemoryScore = memoryScores.length ? Math.max(...memoryScores) : 0;
  const averageMemoryScore = average(memoryScores);
  const freshnessScore = getFreshnessScore(activeMemories);
  const recentContextScore = getRecentContextScore(payload.recentContext);
  const relevanceScore = clamp(
    topMemoryScore * 0.45 +
      averageMemoryScore * 0.25 +
      freshnessScore * 0.2 +
      recentContextScore * 0.1,
    0,
    1
  );
  const ttl = baseTtl + (normalizedMaxTtl - baseTtl) * relevanceScore;
  return Math.round(clamp(ttl, minTtl, normalizedMaxTtl));
}

async function scanWorkingMemoryKeys(redis, prefix) {
  const keys = [];
  let cursor = "0";

  do {
    const result = await redis.scan(cursor, {
      MATCH: `${prefix}:*`,
      COUNT: 100
    });

    cursor = String(result.cursor);
    keys.push(...result.keys);
  } while (cursor !== "0");

  return keys;
}

export const workingMemoryStore = {
  async write(sessionId, payload) {
    const ttlSeconds = calculateWorkingMemoryTtlSeconds(payload);
    const nextValue = {
      ...payload,
      ttlSeconds,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      updatedAt: new Date().toISOString()
    };

    const redis = await getRedisClient();

    if (redis) {
      await redis.set(getWorkingMemoryKey(sessionId), JSON.stringify(nextValue), {
        EX: ttlSeconds
      });
      return nextValue;
    }

    workingMemoryBySession.set(sessionId, nextValue);
    return nextValue;
  },

  async read(sessionId) {
    const fallbackValue = {
      activeMemories: [],
      recentContext: [],
      updatedAt: null
    };

    const redis = await getRedisClient();

    if (redis) {
      const payload = await redis.get(getWorkingMemoryKey(sessionId));
      return payload ? JSON.parse(payload) : fallbackValue;
    }

    const payload = workingMemoryBySession.get(sessionId);

    if (!payload) {
      return fallbackValue;
    }

    if (payload.expiresAt && Date.parse(payload.expiresAt) <= Date.now()) {
      workingMemoryBySession.delete(sessionId);
      return fallbackValue;
    }

    return payload;
  },

  async all() {
    const redis = await getRedisClient();

    if (redis) {
      const prefix = process.env.REDIS_WORKING_MEMORY_PREFIX || "neura:working-memory";
      const keys = await scanWorkingMemoryKeys(redis, prefix);

      if (!keys.length) {
        return {};
      }

      const payloads = await redis.mGet(keys);
      return keys.reduce((accumulator, key, index) => {
        const payload = payloads[index];

        if (payload) {
          accumulator[key.replace(`${prefix}:`, "")] = JSON.parse(payload);
        }

        return accumulator;
      }, {});
    }

    const activeEntries = [...workingMemoryBySession.entries()].filter(([, payload]) => {
      if (payload.expiresAt && Date.parse(payload.expiresAt) <= Date.now()) {
        return false;
      }
      return true;
    });

    workingMemoryBySession.clear();

    for (const [sessionId, payload] of activeEntries) {
      workingMemoryBySession.set(sessionId, payload);
    }

    return Object.fromEntries(activeEntries);
  }
};
