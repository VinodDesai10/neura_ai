import { getMongoHealth } from "../infrastructure/mongo-client.js";
import { getNeo4jHealth } from "../infrastructure/relationship-graph-store.js";
import { getPostgresHealth } from "../infrastructure/postgres-client.js";
import { getQdrantHealth } from "../infrastructure/qdrant-client.js";
import { getRedisHealth } from "../infrastructure/redis-client.js";

export async function getStorageHealth() {
  const [mongo, postgres, qdrant, redis, neo4j] = await Promise.all([
    getMongoHealth(),
    getPostgresHealth(),
    getQdrantHealth(),
    getRedisHealth(),
    getNeo4jHealth()
  ]);

  const services = [mongo, postgres, qdrant, redis, neo4j];
  const configuredCount = services.filter((service) => service.configured).length;
  const okCount = services.filter((service) => service.ok).length;

  return {
    status:
      configuredCount === 0
        ? "local-fallback"
        : okCount === services.length
          ? "ok"
          : "degraded",
    storage: {
      mongo,
      postgres,
      qdrant,
      redis,
      neo4j
    }
  };
}
