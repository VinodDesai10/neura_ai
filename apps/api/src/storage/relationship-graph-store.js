import neo4j from "neo4j-driver";

let driver = null;
let verifyPromise = null;
const GRAPH_MIN_IMPORTANCE = Number(process.env.NEO4J_MIN_IMPORTANCE || 0.45);
const GRAPH_MIN_CONFIDENCE = Number(process.env.NEO4J_MIN_CONFIDENCE || 0.55);
const GRAPH_MAX_KEYWORDS = Number(process.env.NEO4J_MAX_KEYWORDS || 8);
const GRAPH_MAX_ENTITIES = Number(process.env.NEO4J_MAX_ENTITIES || 6);
const NOISY_ENTITY_TYPES = new Set(["code_block", "file_path", "mentions", "hashtag"]);

function normalizeTerm(value) {
  return String(value || "").trim().toLowerCase();
}

function pickGraphKeywords(keywords = []) {
  const uniqueKeywords = [];
  const seen = new Set();

  for (const keyword of keywords) {
    const normalized = normalizeTerm(keyword);

    if (!normalized || normalized.length < 3 || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    uniqueKeywords.push(normalized);

    if (uniqueKeywords.length >= GRAPH_MAX_KEYWORDS) {
      break;
    }
  }

  return uniqueKeywords;
}

function pickGraphEntities(entities = []) {
  const filtered = [];
  const seen = new Set();

  for (const entity of entities) {
    const type = normalizeTerm(entity?.type);
    const value = String(entity?.value || "").trim();
    const key = `${type}:${value.toLowerCase()}`;

    if (!value || value.length < 3 || NOISY_ENTITY_TYPES.has(type) || seen.has(key)) {
      continue;
    }

    seen.add(key);
    filtered.push({ type, value });

    if (filtered.length >= GRAPH_MAX_ENTITIES) {
      break;
    }
  }

  return filtered;
}

function shouldGraphMemory(memory) {
  if (!memory?.content?.trim()) {
    return false;
  }

  return (
    Number(memory.metadata?.importance || 0) >= GRAPH_MIN_IMPORTANCE &&
    Number(memory.metadata?.confidence || 0) >= GRAPH_MIN_CONFIDENCE
  );
}

function isNeo4jEnabled() {
  return Boolean(process.env.NEO4J_URI);
}

function getDriver() {
  if (!isNeo4jEnabled()) {
    return null;
  }

  if (!driver) {
    driver = neo4j.driver(
      process.env.NEO4J_URI,
      neo4j.auth.basic(
        process.env.NEO4J_USERNAME || "neo4j",
        process.env.NEO4J_PASSWORD || ""
      )
    );
  }

  return driver;
}

async function ensureNeo4jReady() {
  const graphDriver = getDriver();

  if (!graphDriver) {
    return false;
  }

  if (!verifyPromise) {
    verifyPromise = (async () => {
      await graphDriver.verifyConnectivity();
      const session = graphDriver.session({
        database: process.env.NEO4J_DATABASE || "neo4j"
      });

      try {
        await session.executeWrite(async (tx) => {
          // Core constraints
          await tx.run("create constraint session_id if not exists for (s:Session) require s.id is unique");
          await tx.run("create constraint event_id if not exists for (e:RawEvent) require e.id is unique");
          await tx.run("create constraint memory_id if not exists for (m:Memory) require m.id is unique");
          await tx.run("create constraint tag_name if not exists for (t:Tag) require t.name is unique");

          // Metadata node constraints
          await tx.run("create constraint domain_name if not exists for (d:Domain) require d.name is unique");
          await tx.run("create constraint keyword_text if not exists for (k:Keyword) require k.text is unique");
          await tx.run("create constraint entity_value if not exists for (e:Entity) require e.value is unique");
          await tx.run("create constraint memory_type_name if not exists for (mt:MemoryType) require mt.name is unique");
          await tx.run("create constraint importance_level_name if not exists for (il:ImportanceLevel) require il.name is unique");
          await tx.run("create constraint sentiment_value if not exists for (s:Sentiment) require s.value is unique");

          // Indexes for performance
          await tx.run("create index memory_domain if not exists for (m:Memory) on (m.domain)");
          await tx.run("create index memory_importance if not exists for (m:Memory) on (m.importance)");
          await tx.run("create index memory_confidence if not exists for (m:Memory) on (m.confidence)");
          await tx.run("create index memory_timestamp if not exists for (m:Memory) on (m.updatedAt)");
          await tx.run("create index session_updated if not exists for (s:Session) on (s.updatedAt)");
          await tx.run("create index keyword_frequency if not exists for (k:Keyword) on (k.frequency)");
        });
      } finally {
        await session.close();
      }
    })().catch((error) => {
      verifyPromise = null;
      throw error;
    });
  }

  await verifyPromise;
  return true;
}

export async function linkBatchMemoryRelationships(memories) {
  try {
    const curatedMemories = (memories || []).filter(shouldGraphMemory);

    if (!curatedMemories.length) {
      return true;
    }

    if (!(await ensureNeo4jReady())) {
      return false;
    }

    const session = getDriver().session({
      database: process.env.NEO4J_DATABASE || "neo4j"
    });

    try {
      // Process all memories in a single transaction for efficiency
      await session.executeWrite(async (tx) => {
        for (const memory of curatedMemories) {
          const keywords = pickGraphKeywords(memory.metadata.keywords);
          const entities = pickGraphEntities(memory.metadata.entities);

          // Core memory relationships
          await tx.run(
            `
            merge (s:Session {id: $sessionId})
            set s.updatedAt = $timestamp
            merge (e:RawEvent {id: $sourceEventId})
            merge (m:Memory {id: $memoryId})
            set
              m.type = $memoryType,
              m.summary = $summary,
              m.content = $content,
              m.fingerprint = $fingerprint,
              m.importance = $importance,
              m.confidence = $confidence,
              m.domain = $domain,
              m.updatedAt = $timestamp,
              m.specificityScore = $specificity,
              m.permanenceScore = $permanence,
              m.actionabilityScore = $actionability,
              m.signalStrength = $signalStrength,
              m.sentiment = $sentiment,
              m.domainConfidence = $domainConfidence,
              m.role = $role
            merge (s)-[:HAS_MEMORY]->(m)
            merge (e)-[:PRODUCED_MEMORY]->(m)
            `,
            {
              sessionId: memory.sessionId,
              sourceEventId: memory.sourceEventId,
              memoryId: memory.id,
              memoryType: memory.memoryType,
              summary: memory.summary,
              content: memory.content,
              fingerprint: memory.fingerprint,
              importance: memory.metadata.importance,
              confidence: memory.metadata.confidence,
              domain: memory.metadata.domain,
              timestamp: memory.metadata.timestamp,
              specificity: memory.metadata.specificity || 0,
              permanence: memory.metadata.permanence || 0,
              actionability: memory.metadata.actionability || 0,
              signalStrength: memory.metadata.signalStrength || 0,
              sentiment: memory.metadata.sentiment || "neutral",
              domainConfidence: memory.metadata.domainConfidence || 0,
              role: memory.metadata.role || "user"
            }
          );

          // Domain node
          if (memory.metadata.domain) {
            await tx.run(
              `
              match (m:Memory {id: $memoryId})
              merge (d:Domain {name: $domain})
              set d.updatedAt = timestamp()
              merge (m)-[:ABOUT]->(d)
              `,
              {
                memoryId: memory.id,
                domain: memory.metadata.domain
              }
            );
          }

          // Memory type node
          await tx.run(
            `
            match (m:Memory {id: $memoryId})
            merge (mt:MemoryType {name: $memoryType})
            merge (m)-[:IS_TYPE]->(mt)
            `,
            {
              memoryId: memory.id,
              memoryType: memory.memoryType
            }
          );

          // Importance level node
          const importanceLevel = getImportanceLevel(memory.metadata.importance);
          await tx.run(
            `
            match (m:Memory {id: $memoryId})
            merge (il:ImportanceLevel {name: $level})
            set il.minScore = $minScore, il.maxScore = $maxScore
            merge (m)-[:HAS_IMPORTANCE]->(il)
            `,
            {
              memoryId: memory.id,
              level: importanceLevel.name,
              minScore: importanceLevel.min,
              maxScore: importanceLevel.max
            }
          );

          // Sentiment node
          if (memory.metadata.sentiment) {
            await tx.run(
              `
              match (m:Memory {id: $memoryId})
              merge (s:Sentiment {value: $sentiment})
              merge (m)-[:HAS_SENTIMENT]->(s)
              `,
              {
                memoryId: memory.id,
                sentiment: memory.metadata.sentiment
              }
            );
          }

          // Tags
          for (const tag of memory.metadata.tags || []) {
            await tx.run(
              `
              match (m:Memory {id: $memoryId})
              merge (t:Tag {name: $tag})
              merge (m)-[:TAGGED_WITH]->(t)
              `,
              {
                memoryId: memory.id,
                tag
              }
            );
          }

          // Keywords with co-occurrence tracking
          for (let i = 0; i < keywords.length; i++) {
            const keyword = keywords[i];
            await tx.run(
              `
              match (m:Memory {id: $memoryId})
              merge (k:Keyword {text: $keyword})
              on create set k.frequency = 1
              on match set k.frequency = k.frequency + 1
              set k.updatedAt = timestamp()
              merge (m)-[:HAS_KEYWORD {position: $position}]->(k)
              `,
              {
                memoryId: memory.id,
                keyword,
                position: i
              }
            );
          }

          // Entities (people, emails, URLs, dates, etc.)
          for (const entity of entities) {
            await tx.run(
              `
              match (m:Memory {id: $memoryId})
              merge (e:Entity {value: $value, type: $type})
              set e.updatedAt = timestamp(), e.occurrences = coalesce(e.occurrences, 0) + 1
              merge (m)-[:MENTIONS]->(e)
              `,
              {
                memoryId: memory.id,
                value: entity.value,
                type: entity.type
              }
            );
          }

          // Link alternate domains if confidence is lower
          for (const altDomain of memory.metadata.alternateDomains || []) {
            await tx.run(
              `
              match (m:Memory {id: $memoryId})
              merge (d:Domain {name: $domain})
              merge (m)-[:COULD_BE_ABOUT {confidence: $altConfidence}]->(d)
              `,
              {
                memoryId: memory.id,
                domain: altDomain,
                altConfidence: 0.3
              }
            );
          }
        }
      });

      // Link similar memories in separate transaction
      for (const memory of curatedMemories) {
        await linkSimilarMemories(memory);
      }

      return true;
    } finally {
      await session.close();
    }
  } catch (error) {
    console.warn(
      "Neo4j batch relationship write skipped:",
      error instanceof Error ? error.message : "Unknown Neo4j error"
    );
    return false;
  }
}

export async function linkEventToSession(event) {
  try {
    if (!(await ensureNeo4jReady())) {
      return false;
    }

    const session = getDriver().session({
      database: process.env.NEO4J_DATABASE || "neo4j"
    });

    try {
      await session.executeWrite((tx) =>
        tx.run(
          `
          merge (s:Session {id: $sessionId})
          on create set s.createdAt = $createdAt
          set s.updatedAt = $createdAt
          merge (e:RawEvent {id: $eventId})
          set
            e.role = $role,
            e.contentLength = $contentLength,
            e.createdAt = $createdAt
          merge (s)-[:HAS_EVENT]->(e)
          `,
          {
            sessionId: event.sessionId,
            eventId: event.id,
            role: event.role,
            contentLength: event.content?.length || 0,
            createdAt: event.createdAt
          }
        )
      );
      return true;
    } finally {
      await session.close();
    }
  } catch (error) {
    console.warn(
      "Neo4j event relationship write skipped:",
      error instanceof Error ? error.message : "Unknown Neo4j error"
    );
    return false;
  }
}

export async function linkMemoryRelationships(memory) {
  try {
    if (!shouldGraphMemory(memory)) {
      return true;
    }

    if (!(await ensureNeo4jReady())) {
      return false;
    }

    const session = getDriver().session({
      database: process.env.NEO4J_DATABASE || "neo4j"
    });

    try {
      await session.executeWrite(async (tx) => {
        const keywords = pickGraphKeywords(memory.metadata.keywords);
        const entities = pickGraphEntities(memory.metadata.entities);

        // Core memory relationships
        await tx.run(
          `
          merge (s:Session {id: $sessionId})
          set s.updatedAt = $timestamp
          merge (e:RawEvent {id: $sourceEventId})
          merge (m:Memory {id: $memoryId})
          set
            m.type = $memoryType,
            m.summary = $summary,
            m.content = $content,
            m.fingerprint = $fingerprint,
            m.importance = $importance,
            m.confidence = $confidence,
            m.domain = $domain,
            m.updatedAt = $timestamp,
            m.specificityScore = $specificity,
            m.permanenceScore = $permanence,
            m.actionabilityScore = $actionability,
            m.signalStrength = $signalStrength,
            m.sentiment = $sentiment,
            m.domainConfidence = $domainConfidence,
            m.role = $role
          merge (s)-[:HAS_MEMORY]->(m)
          merge (e)-[:PRODUCED_MEMORY]->(m)
          `,
          {
            sessionId: memory.sessionId,
            sourceEventId: memory.sourceEventId,
            memoryId: memory.id,
            memoryType: memory.memoryType,
            summary: memory.summary,
            content: memory.content,
            fingerprint: memory.fingerprint,
            importance: memory.metadata.importance,
            confidence: memory.metadata.confidence,
            domain: memory.metadata.domain,
            timestamp: memory.metadata.timestamp,
            specificity: memory.metadata.specificity || 0,
            permanence: memory.metadata.permanence || 0,
            actionability: memory.metadata.actionability || 0,
            signalStrength: memory.metadata.signalStrength || 0,
            sentiment: memory.metadata.sentiment || "neutral",
            domainConfidence: memory.metadata.domainConfidence || 0,
            role: memory.metadata.role || "user"
          }
        );

        // Domain node
        if (memory.metadata.domain) {
          await tx.run(
            `
            match (m:Memory {id: $memoryId})
            merge (d:Domain {name: $domain})
            set d.updatedAt = timestamp()
            merge (m)-[:ABOUT]->(d)
            `,
            {
              memoryId: memory.id,
              domain: memory.metadata.domain
            }
          );
        }

        // Memory type node
        await tx.run(
          `
          match (m:Memory {id: $memoryId})
          merge (mt:MemoryType {name: $memoryType})
          merge (m)-[:IS_TYPE]->(mt)
          `,
          {
            memoryId: memory.id,
            memoryType: memory.memoryType
          }
        );

        // Importance level node
        const importanceLevel = getImportanceLevel(memory.metadata.importance);
        await tx.run(
          `
          match (m:Memory {id: $memoryId})
          merge (il:ImportanceLevel {name: $level})
          set il.minScore = $minScore, il.maxScore = $maxScore
          merge (m)-[:HAS_IMPORTANCE]->(il)
          `,
          {
            memoryId: memory.id,
            level: importanceLevel.name,
            minScore: importanceLevel.min,
            maxScore: importanceLevel.max
          }
        );

        // Sentiment node
        if (memory.metadata.sentiment) {
          await tx.run(
            `
            match (m:Memory {id: $memoryId})
            merge (s:Sentiment {value: $sentiment})
            merge (m)-[:HAS_SENTIMENT]->(s)
            `,
            {
              memoryId: memory.id,
              sentiment: memory.metadata.sentiment
            }
          );
        }

        // Tags
        for (const tag of memory.metadata.tags || []) {
          await tx.run(
            `
            match (m:Memory {id: $memoryId})
            merge (t:Tag {name: $tag})
            merge (m)-[:TAGGED_WITH]->(t)
            `,
            {
              memoryId: memory.id,
              tag
            }
          );
        }

        // Keywords with co-occurrence tracking
        for (let i = 0; i < keywords.length; i++) {
          const keyword = keywords[i];
          await tx.run(
            `
            match (m:Memory {id: $memoryId})
            merge (k:Keyword {text: $keyword})
            on create set k.frequency = 1
            on match set k.frequency = k.frequency + 1
            set k.updatedAt = timestamp()
            merge (m)-[:HAS_KEYWORD {position: $position}]->(k)
            `,
            {
              memoryId: memory.id,
              keyword,
              position: i
            }
          );
        }

        // Entities (people, emails, URLs, dates, etc.)
        for (const entity of entities) {
          await tx.run(
            `
            match (m:Memory {id: $memoryId})
            merge (e:Entity {value: $value, type: $type})
            set e.updatedAt = timestamp(), e.occurrences = coalesce(e.occurrences, 0) + 1
            merge (m)-[:MENTIONS]->(e)
            `,
            {
              memoryId: memory.id,
              value: entity.value,
              type: entity.type
            }
          );
        }

        // Link alternate domains if confidence is lower
        for (const altDomain of memory.metadata.alternateDomains || []) {
          await tx.run(
            `
            match (m:Memory {id: $memoryId})
            merge (d:Domain {name: $domain})
            merge (m)-[:COULD_BE_ABOUT {confidence: $altConfidence}]->(d)
            `,
            {
              memoryId: memory.id,
              domain: altDomain,
              altConfidence: 0.3
            }
          );
        }
      });

      // Link similar memories (run in separate transaction for better performance)
      await linkSimilarMemories(memory);

      return true;
    } finally {
      await session.close();
    }
  } catch (error) {
    console.warn(
      "Neo4j memory relationship write skipped:",
      error instanceof Error ? error.message : "Unknown Neo4j error"
    );
    return false;
  }
}

// Helper: Convert importance score to categorical level
function getImportanceLevel(score) {
  if (score >= 0.75) return { name: "critical", min: 0.75, max: 1.0 };
  if (score >= 0.5) return { name: "high", min: 0.5, max: 0.75 };
  if (score >= 0.25) return { name: "medium", min: 0.25, max: 0.5 };
  return { name: "low", min: 0, max: 0.25 };
}

// Link semantically similar memories based on shared keywords, tags, and domain
async function linkSimilarMemories(memory) {
  try {
    if (!(await ensureNeo4jReady())) {
      return false;
    }

    const session = getDriver().session({
      database: process.env.NEO4J_DATABASE || "neo4j"
    });

    try {
      await session.executeWrite(async (tx) => {
        // Find memories with shared keywords (at least 2 shared keywords)
        await tx.run(
          `
          match (m:Memory {id: $memoryId})-[:HAS_KEYWORD]->(k:Keyword)<-[:HAS_KEYWORD]-(other:Memory)
          where other.id <> $memoryId and other.updatedAt is not null
          with m, other, count(k) as sharedKeywords
          where sharedKeywords >= 2
          merge (m)-[r:SIMILAR_TO {reason: "shared_keywords", score: sharedKeywords}]->(other)
          `,
          {
            memoryId: memory.id
          }
        );

        // Find memories with same domain
        await tx.run(
          `
          match (m:Memory {id: $memoryId})-[:ABOUT]->(d:Domain)<-[:ABOUT]-(other:Memory)
          where other.id <> $memoryId and other.updatedAt is not null
          merge (m)-[r:SIMILAR_TO {reason: "shared_domain"}]->(other)
          `,
          {
            memoryId: memory.id
          }
        );

        // Find memories with shared tags
        await tx.run(
          `
          match (m:Memory {id: $memoryId})-[:TAGGED_WITH]->(t:Tag)<-[:TAGGED_WITH]-(other:Memory)
          where other.id <> $memoryId and other.updatedAt is not null
          with m, other, count(t) as sharedTags
          where sharedTags >= 2
          merge (m)-[r:SIMILAR_TO {reason: "shared_tags", score: sharedTags}]->(other)
          `,
          {
            memoryId: memory.id
          }
        );

        // NEW: Link co-occurring keywords
        await tx.run(
          `
          match (m:Memory {id: $memoryId})-[:HAS_KEYWORD]->(k1:Keyword),
                (m)-[:HAS_KEYWORD]->(k2:Keyword)
          where k1.text < k2.text
          merge (k1)-[r:CO_OCCURS_WITH]->(k2)
          on create set r.cooccurrences = 1
          on match set r.cooccurrences = coalesce(r.cooccurrences, 0) + 1
          `,
          {
            memoryId: memory.id
          }
        );

        return true;
      });

      return true;
    } finally {
      await session.close();
    }
  } catch (error) {
    console.warn(
      "Neo4j similarity linking skipped:",
      error instanceof Error ? error.message : "Unknown error"
    );
    return false;
  }
}

// Query: Find memories by domain
export async function findMemoriesByDomain(sessionId, domain, limit = 10) {
  try {
    if (!(await ensureNeo4jReady())) {
      return [];
    }

    const session = getDriver().session({
      database: process.env.NEO4J_DATABASE || "neo4j"
    });

    try {
      const result = await session.executeRead((tx) =>
        tx.run(
          `
          match (s:Session {id: $sessionId})-[:HAS_MEMORY]->(m:Memory)-[:ABOUT]->(d:Domain {name: $domain})
          return m.id as id, m.summary as summary, m.content as content, m.importance as importance, m.confidence as confidence
          order by m.importance desc, m.updatedAt desc
          limit $limit
          `,
          {
            sessionId,
            domain,
            limit
          }
        )
      );

      return result.records.map((record) => ({
        id: record.get("id"),
        summary: record.get("summary"),
        content: record.get("content"),
        importance: record.get("importance"),
        confidence: record.get("confidence")
      }));
    } finally {
      await session.close();
    }
  } catch (error) {
    console.warn("Neo4j domain query failed:", error instanceof Error ? error.message : "Unknown error");
    return [];
  }
}

// Query: Find memories by keyword
export async function findMemoriesByKeyword(sessionId, keyword, limit = 10) {
  try {
    if (!(await ensureNeo4jReady())) {
      return [];
    }

    const session = getDriver().session({
      database: process.env.NEO4J_DATABASE || "neo4j"
    });

    try {
      const result = await session.executeRead((tx) =>
        tx.run(
          `
          match (s:Session {id: $sessionId})-[:HAS_MEMORY]->(m:Memory)-[:HAS_KEYWORD]->(k:Keyword {text: $keyword})
          return m.id as id, m.summary as summary, m.content as content, m.importance as importance
          order by m.importance desc, m.updatedAt desc
          limit $limit
          `,
          {
            sessionId,
            keyword,
            limit
          }
        )
      );

      return result.records.map((record) => ({
        id: record.get("id"),
        summary: record.get("summary"),
        content: record.get("content"),
        importance: record.get("importance")
      }));
    } finally {
      await session.close();
    }
  } catch (error) {
    console.warn("Neo4j keyword query failed:", error instanceof Error ? error.message : "Unknown error");
    return [];
  }
}

// Query: Find memories by entity
export async function findMemoriesByEntity(sessionId, entityValue, limit = 10) {
  try {
    if (!(await ensureNeo4jReady())) {
      return [];
    }

    const session = getDriver().session({
      database: process.env.NEO4J_DATABASE || "neo4j"
    });

    try {
      const result = await session.executeRead((tx) =>
        tx.run(
          `
          match (s:Session {id: $sessionId})-[:HAS_MEMORY]->(m:Memory)-[:MENTIONS]->(e:Entity {value: $entityValue})
          return m.id as id, m.summary as summary, m.content as content, m.importance as importance, e.type as entityType
          order by m.importance desc, m.updatedAt desc
          limit $limit
          `,
          {
            sessionId,
            entityValue,
            limit
          }
        )
      );

      return result.records.map((record) => ({
        id: record.get("id"),
        summary: record.get("summary"),
        content: record.get("content"),
        importance: record.get("importance"),
        entityType: record.get("entityType")
      }));
    } finally {
      await session.close();
    }
  } catch (error) {
    console.warn("Neo4j entity query failed:", error instanceof Error ? error.message : "Unknown error");
    return [];
  }
}

// Query: Find similar memories
export async function findSimilarMemories(memoryId, limit = 5) {
  try {
    if (!(await ensureNeo4jReady())) {
      return [];
    }

    const session = getDriver().session({
      database: process.env.NEO4J_DATABASE || "neo4j"
    });

    try {
      const result = await session.executeRead((tx) =>
        tx.run(
          `
          match (m:Memory {id: $memoryId})-[:SIMILAR_TO {reason: $reason}]-(similar:Memory)
          return similar.id as id, similar.summary as summary, similar.importance as importance
          order by similar.importance desc, similar.updatedAt desc
          limit $limit
          `,
          {
            memoryId,
            reason: "shared_keywords",
            limit
          }
        )
      );

      return result.records.map((record) => ({
        id: record.get("id"),
        summary: record.get("summary"),
        importance: record.get("importance")
      }));
    } finally {
      await session.close();
    }
  } catch (error) {
    console.warn("Neo4j similarity query failed:", error instanceof Error ? error.message : "Unknown error");
    return [];
  }
}

// Query: Get memory graph statistics
export async function getMemoryGraphStats(sessionId) {
  try {
    if (!(await ensureNeo4jReady())) {
      return null;
    }

    const session = getDriver().session({
      database: process.env.NEO4J_DATABASE || "neo4j"
    });

    try {
      const result = await session.executeRead((tx) =>
        tx.run(
          `
          match (s:Session {id: $sessionId})-[:HAS_MEMORY]->(m:Memory)
          with count(m) as totalMemories
          match (s:Session {id: $sessionId})-[:HAS_MEMORY]->(m:Memory)-[:ABOUT]->(d:Domain)
          with totalMemories, count(distinct d) as domains
          match (s:Session {id: $sessionId})-[:HAS_MEMORY]->(m:Memory)-[:HAS_KEYWORD]->(k:Keyword)
          with totalMemories, domains, count(distinct k) as keywords
          match (s:Session {id: $sessionId})-[:HAS_MEMORY]->(m:Memory)-[:MENTIONS]->(e:Entity)
          return {
            totalMemories,
            domains,
            keywords,
            entities: count(distinct e)
          } as stats
          `,
          {
            sessionId
          }
        )
      );

      const record = result.records[0];
      return record ? record.get("stats") : null;
    } finally {
      await session.close();
    }
  } catch (error) {
    console.warn("Neo4j stats query failed:", error instanceof Error ? error.message : "Unknown error");
    return null;
  }
}

export async function getNeo4jHealth() {
  if (!isNeo4jEnabled()) {
    return {
      configured: false,
      ok: false,
      message: "NEO4J_URI is not set"
    };
  }

  try {
    await ensureNeo4jReady();

    return {
      configured: true,
      ok: true,
      message: "reachable",
      database: process.env.NEO4J_DATABASE || "neo4j"
    };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      message: error instanceof Error ? error.message : "Unknown Neo4j error"
    };
  }
}
