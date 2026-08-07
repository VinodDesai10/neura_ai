import { createHash, randomUUID } from "node:crypto";
import { getRedisClient } from "./redis-client.js";

const localJsonStore = new Map();
const localLists = new Map();
const localLocks = new Map();
const localCounters = new Map();

function getPrefix() {
  return process.env.REDIS_RUNTIME_PREFIX || "neura";
}

function hashValue(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readPositiveNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function now() {
  return Date.now();
}

function pruneExpiredMap(map) {
  for (const [key, entry] of map.entries()) {
    if (entry.expiresAt && entry.expiresAt <= now()) {
      map.delete(key);
    }
  }
}

function clearLocalStorage() {
  localJsonStore.clear();
  localLists.clear();
  localLocks.clear();
  localCounters.clear();
}

function getLocalJson(key) {
  pruneExpiredMap(localJsonStore);
  return localJsonStore.get(key)?.value ?? null;
}

function setLocalJson(key, value, ttlSeconds) {
  localJsonStore.set(key, {
    value,
    expiresAt: ttlSeconds ? now() + ttlSeconds * 1000 : null
  });
}

async function getJson(key) {
  const redis = await getRedisClient();

  if (redis) {
    const value = await redis.get(key);
    return value ? JSON.parse(value) : null;
  }

  return getLocalJson(key);
}

async function setJson(key, value, ttlSeconds) {
  const redis = await getRedisClient();
  const payload = JSON.stringify(value);

  if (redis) {
    if (ttlSeconds) {
      await redis.set(key, payload, { EX: ttlSeconds });
      return;
    }

    await redis.set(key, payload);
    return;
  }

  setLocalJson(key, value, ttlSeconds);
}

function getEmbeddingTtlSeconds(text) {
  const lower = text.toLowerCase();

  if (lower.length < 24) {
    return readPositiveNumber("REDIS_EMBEDDING_SHORT_TTL_SECONDS", 6 * 60 * 60);
  }

  if (lower.includes("factual:") || lower.includes("semantic:") || lower.includes("episodic:")) {
    return readPositiveNumber("REDIS_EMBEDDING_MEMORY_TTL_SECONDS", 30 * 24 * 60 * 60);
  }

  return readPositiveNumber("REDIS_EMBEDDING_TTL_SECONDS", 7 * 24 * 60 * 60);
}

function getRetrievalTtlSeconds(activeMemories) {
  const topImportance = Math.max(
    0,
    ...activeMemories.map((memory) => Number(memory?.metadata?.importance || 0))
  );
  const minTtl = readPositiveNumber("REDIS_RETRIEVAL_MIN_TTL_SECONDS", 5 * 60);
  const maxTtl = readPositiveNumber("REDIS_RETRIEVAL_MAX_TTL_SECONDS", 2 * 60 * 60);
  return Math.round(minTtl + (maxTtl - minTtl) * Math.min(1, topImportance));
}

function getRecentTurnsTtlSeconds() {
  return readPositiveNumber("REDIS_RECENT_TURNS_TTL_SECONDS", 7 * 24 * 60 * 60);
}

function getSessionStateTtlSeconds() {
  return readPositiveNumber("REDIS_SESSION_STATE_TTL_SECONDS", 24 * 60 * 60);
}

function getMemoryUsageTtlSeconds() {
  return readPositiveNumber("REDIS_MEMORY_USAGE_TTL_SECONDS", 30 * 24 * 60 * 60);
}

function getSessionKey(sessionId, suffix) {
  return `${getPrefix()}:session:${sessionId}:${suffix}`;
}

export const redisRuntimeStore = {
  getEmbeddingKey({ model, text }) {
    return `${getPrefix()}:embedding:${model}:${hashValue(text)}`;
  },

  async getCachedEmbedding({ model, text }) {
    return getJson(this.getEmbeddingKey({ model, text }));
  },

  async setCachedEmbedding({ model, text, embedding }) {
    if (!Array.isArray(embedding)) {
      return;
    }

    await setJson(
      this.getEmbeddingKey({ model, text }),
      {
        embedding,
        model,
        textHash: hashValue(text),
        createdAt: new Date().toISOString()
      },
      getEmbeddingTtlSeconds(text)
    );
  },

  getRetrievalKey({ sessionId, message }) {
    const normalized = message.toLowerCase().trim().replace(/\s+/g, " ");
    return getSessionKey(sessionId, `retrieval:${hashValue(normalized)}`);
  },

  async getCachedRetrieval({ sessionId, message }) {
    return getJson(this.getRetrievalKey({ sessionId, message }));
  },

  async setCachedRetrieval({ sessionId, message, activeMemories }) {
    await setJson(
      this.getRetrievalKey({ sessionId, message }),
      {
        activeMemories,
        queryHash: hashValue(message.toLowerCase().trim().replace(/\s+/g, " ")),
        createdAt: new Date().toISOString()
      },
      getRetrievalTtlSeconds(activeMemories)
    );
  },

  async appendRecentTurn(sessionId, turn, limit = 12) {
    const key = getSessionKey(sessionId, "turns");
    const entry = JSON.stringify({
      ...turn,
      createdAt: turn.createdAt || new Date().toISOString()
    });
    const redis = await getRedisClient();

    if (redis) {
      await redis.rPush(key, entry);
      await redis.lTrim(key, -limit, -1);
      await redis.expire(key, getRecentTurnsTtlSeconds());
      return;
    }

    const turns = localLists.get(key) || [];
    turns.push(JSON.parse(entry));
    localLists.set(key, turns.slice(-limit));
  },

  async getRecentTurns(sessionId, limit = 12) {
    const key = getSessionKey(sessionId, "turns");
    const redis = await getRedisClient();

    if (redis) {
      const values = await redis.lRange(key, -limit, -1);
      return values.map((value) => JSON.parse(value));
    }

    return (localLists.get(key) || []).slice(-limit);
  },

  async setSessionState(sessionId, state) {
    const stateKey = getSessionKey(sessionId, "state");
    const previous = (await getJson(stateKey)) || {};
    const nextState = {
      ...previous,
      ...state,
      updatedAt: new Date().toISOString()
    };

    await setJson(stateKey, nextState, getSessionStateTtlSeconds());
    return nextState;
  },

  async getSessionState(sessionId) {
    const stateKey = getSessionKey(sessionId, "state");
    const state = await getJson(stateKey);

    if (!state && localJsonStore.has(stateKey)) {
      const entry = localJsonStore.get(stateKey);
      if (entry.expiresAt && entry.expiresAt <= now()) {
        localJsonStore.delete(stateKey);
        return null;
      }
    }

    return state;
  },

  async acquireSessionLock(sessionId, ttlSeconds = 15) {
    const key = getSessionKey(sessionId, "lock");
    const token = randomUUID();
    const redis = await getRedisClient();

    if (redis) {
      const result = await redis.set(key, token, {
        NX: true,
        EX: ttlSeconds
      });

      return result === "OK" ? token : null;
    }

    pruneExpiredMap(localLocks);

    if (localLocks.has(key)) {
      return null;
    }

    localLocks.set(key, {
      value: token,
      expiresAt: now() + ttlSeconds * 1000
    });
    return token;
  },

  async releaseSessionLock(sessionId, token) {
    const key = getSessionKey(sessionId, "lock");
    const redis = await getRedisClient();

    if (redis) {
      const currentToken = await redis.get(key);

      if (currentToken === token) {
        await redis.del(key);
      }

      return;
    }

    if (localLocks.get(key)?.value === token) {
      localLocks.delete(key);
    }
  },

  async checkRateLimit({ scope, id, limit = 30, windowSeconds = 60 }) {
    const key = `${getPrefix()}:rate:${scope}:${id}`;
    const redis = await getRedisClient();

    if (redis) {
      const count = await redis.incr(key);

      if (count === 1) {
        await redis.expire(key, windowSeconds);
      }

      return {
        ok: count <= limit,
        count,
        limit,
        windowSeconds
      };
    }

    pruneExpiredMap(localCounters);

    const entry = localCounters.get(key) || {
      value: 0,
      expiresAt: now() + windowSeconds * 1000
    };
    entry.value += 1;
    localCounters.set(key, entry);

    return {
      ok: entry.value <= limit,
      count: entry.value,
      limit,
      windowSeconds
    };
  },

  async enqueueMemoryJob(job) {
    const key = `${getPrefix()}:queue:memory`;
    const payload = {
      ...job,
      id: job.id || randomUUID(),
      enqueuedAt: new Date().toISOString()
    };
    const redis = await getRedisClient();

    if (redis) {
      await redis.rPush(key, JSON.stringify(payload));
      return payload;
    }

    const queue = localLists.get(key) || [];
    if (queue.length >= 1000) {
      queue.shift();
    }
    queue.push(payload);
    localLists.set(key, queue);
    return payload;
  },

  async claimMemoryJob() {
    const key = `${getPrefix()}:queue:memory`;
    const redis = await getRedisClient();

    if (redis) {
      const payload = await redis.lPop(key);
      return payload ? JSON.parse(payload) : null;
    }

    const queue = localLists.get(key) || [];
    if (queue.length === 0) {
      return null;
    }
    const payload = queue.shift();
    localLists.set(key, queue);
    return payload || null;
  },

  async getMemoryQueueSnapshot(limit = 20) {
    const key = `${getPrefix()}:queue:memory`;
    const redis = await getRedisClient();

    if (redis) {
      const values = await redis.lRange(key, 0, limit - 1);
      return values.map((value) => JSON.parse(value));
    }

    const queue = localLists.get(key) || [];
    return queue.slice(0, limit);
  },

  async clearMemoryQueue() {
    const key = `${getPrefix()}:queue:memory`;
    const redis = await getRedisClient();

    if (redis) {
      await redis.del(key);
      return;
    }

    localLists.delete(key);
  },

  async markMemoryHits(memories) {
    await Promise.all(
      memories.map(async (memory) => {
        const memoryId = memory.id || memory.fingerprint;

        if (!memoryId) {
          return;
        }

        const key = `${getPrefix()}:memory:usage:${memoryId}`;
        const current = (await getJson(key)) || {
          hits: 0,
          firstUsedAt: new Date().toISOString()
        };

        await setJson(
          key,
          {
            ...current,
            hits: current.hits + 1,
            lastUsedAt: new Date().toISOString(),
            lastImportance: memory.metadata?.importance ?? null,
            memoryType: memory.memoryType ?? null
          },
          getMemoryUsageTtlSeconds()
        );
      })
    );
  },

  clearLocalStorage() {
    clearLocalStorage();
  },

  async cleanupExpiredData() {
    pruneExpiredMap(localJsonStore);
    pruneExpiredMap(localLocks);
    pruneExpiredMap(localCounters);
  }
};
