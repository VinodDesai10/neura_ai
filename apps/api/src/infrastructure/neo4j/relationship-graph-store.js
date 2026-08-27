import neo4j from "neo4j-driver";
import { logger } from "../../lib/logger.js";

const graphLog = logger.child({ component: "relationship-graph-store" });

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
          await tx.run("create constraint session_id if not exists for (s:Session) require s.id is unique");
          await tx.run("create constraint event_id if not exists for (e:RawEvent) require e.id is unique");
          await tx.run("create constraint memory_id if not exists for (m:Memory) require m.id is unique");
          await tx.run("create constraint tag_name if not exists for (t:Tag) require t.name is unique");
          await tx.run("create constraint domain_name if not exists for (d:Domain) require d.name is unique");
          await tx.run("create constraint keyword_text if not exists for (k:Keyword) require k.text is unique");
          await tx.run("create constraint entity_value if not exists for (e:Entity) require e.value is unique");
          await tx.run("create constraint memory_type_name if not exists for (mt:MemoryType) require mt.name is unique");
          await tx.run("create constraint importance_level_name if not exists for (il:ImportanceLevel) require il.name is unique");
          await tx.run("create constraint sentiment_value if not exists for (s:Sentiment) require s.value is unique");
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

// Helper: Convert importance score to categorical level
function getImportanceLevel(score) {
  if (score >= 0.75) return { name: "critical", min: 0.75, max: 1.0 };
  if (score >= 0.5) return { name: "high", min: 0.5, max: 0.75 };
  if (score >= 0.25) return { name: "medium", min: 0.25, max: 0.5 };
  return { name: "low", min: 0, max: 0.25 };
}

async function writeMemoryToGraph(tx, memory) {
  const keywords = pickGraphKeywords(memory.metadata.keywords);
  const entities = pickGraphEntities(memory.metadata.entities);

  // ── Query 1: core MERGE (Session + RawEvent + Memory + structural rels) ──
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

  // ── Query 2 (conditional): primary domain ─────────────────────────────────
  if (memory.metadata.domain) {
    await tx.run(
      `
      match (m:Memory {id: $memoryId})
      merge (d:Domain {name: $domain})
      set d.updatedAt = timestamp()
      merge (m)-[:ABOUT]->(d)
      `,
      { memoryId: memory.id, domain: memory.metadata.domain }
    );
  }

  // ── Query 3: MemoryType ────────────────────────────────────────────────────
  await tx.run(
    `
    match (m:Memory {id: $memoryId})
    merge (mt:MemoryType {name: $memoryType})
    merge (m)-[:IS_TYPE]->(mt)
    `,
    { memoryId: memory.id, memoryType: memory.memoryType }
  );

  // ── Query 4: ImportanceLevel ───────────────────────────────────────────────
  const importanceLevel = getImportanceLevel(memory.metadata.importance);
  await tx.run(
    `
    match (m:Memory {id: $memoryId})
    merge (il:ImportanceLevel {name: $level})
    set il.minScore = $minScore, il.maxScore = $maxScore
    merge (m)-[:HAS_IMPORTANCE]->(il)
    `,
    { memoryId: memory.id, level: importanceLevel.name, minScore: importanceLevel.min, maxScore: importanceLevel.max }
  );

  // ── Query 5 (conditional): Sentiment ──────────────────────────────────────
  if (memory.metadata.sentiment) {
    await tx.run(
      `
      match (m:Memory {id: $memoryId})
      merge (s:Sentiment {value: $sentiment})
      merge (m)-[:HAS_SENTIMENT]->(s)
      `,
      { memoryId: memory.id, sentiment: memory.metadata.sentiment }
    );
  }

  // ── Query 6 (batch): Tags — one UNWIND instead of one query per tag ────────
  // Skipped entirely when the array is empty to avoid an unnecessary round-trip.
  const tags = memory.metadata.tags || [];
  if (tags.length > 0) {
    await tx.run(
      `
      match (m:Memory {id: $memoryId})
      unwind $tags as tag
      merge (t:Tag {name: tag})
      merge (m)-[:TAGGED_WITH]->(t)
      `,
      { memoryId: memory.id, tags }
    );
  }

  // ── Query 7 (batch): Keywords — one UNWIND instead of one query per keyword
  // Each element carries { text, position } so the relationship property is
  // preserved exactly as before.
  if (keywords.length > 0) {
    // Build the array of parameter objects expected by the Cypher UNWIND.
    const keywordRows = keywords.map((text, position) => ({ text, position }));
    await tx.run(
      `
      match (m:Memory {id: $memoryId})
      unwind $keywords as kw
      merge (k:Keyword {text: kw.text})
      on create set k.frequency = 1
      on match set k.frequency = k.frequency + 1
      set k.updatedAt = timestamp()
      merge (m)-[:HAS_KEYWORD {position: kw.position}]->(k)
      `,
      { memoryId: memory.id, keywords: keywordRows }
    );
  }

  // ── Query 8 (batch): Entities — one UNWIND instead of one query per entity ─
  if (entities.length > 0) {
    await tx.run(
      `
      match (m:Memory {id: $memoryId})
      unwind $entities as entity
      merge (e:Entity {value: entity.value, type: entity.type})
      set e.updatedAt = timestamp(), e.occurrences = coalesce(e.occurrences, 0) + 1
      merge (m)-[:MENTIONS]->(e)
      `,
      { memoryId: memory.id, entities }
    );
  }

  // ── Query 9 (batch): Alternate domains — one UNWIND instead of one per domain
  const alternateDomains = memory.metadata.alternateDomains || [];
  if (alternateDomains.length > 0) {
    await tx.run(
      `
      match (m:Memory {id: $memoryId})
      unwind $domains as domain
      merge (d:Domain {name: domain})
      merge (m)-[:COULD_BE_ABOUT {confidence: $altConfidence}]->(d)
      `,
      { memoryId: memory.id, domains: alternateDomains, altConfidence: 0.3 }
    );
  }
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
      await session.executeWrite(async (tx) => {
        for (const memory of curatedMemories) {
          await writeMemoryToGraph(tx, memory);
        }
      });

      for (const memory of curatedMemories) {
        await linkSimilarMemories(memory);
      }

      return true;
    } finally {
      await session.close();
    }
  } catch (error) {
    graphLog.warn({ err: error }, "Neo4j batch relationship write skipped");
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
    graphLog.warn({ err: error }, "Neo4j event relationship write skipped");
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
        await writeMemoryToGraph(tx, memory);
      });

      await linkSimilarMemories(memory);
      return true;
    } finally {
      await session.close();
    }
  } catch (error) {
    graphLog.warn({ err: error }, "Neo4j memory relationship write skipped");
    return false;
  }
}

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
        await tx.run(
          `
          match (m:Memory {id: $memoryId})-[:HAS_KEYWORD]->(k:Keyword)<-[:HAS_KEYWORD]-(other:Memory)
          where other.id <> $memoryId and other.updatedAt is not null
          with m, other, count(k) as sharedKeywords
          where sharedKeywords >= 2
          merge (m)-[r:SIMILAR_TO {reason: "shared_keywords", score: sharedKeywords}]->(other)
          `,
          { memoryId: memory.id }
        );

        await tx.run(
          `
          match (m:Memory {id: $memoryId})-[:ABOUT]->(d:Domain)<-[:ABOUT]-(other:Memory)
          where other.id <> $memoryId and other.updatedAt is not null
          merge (m)-[r:SIMILAR_TO {reason: "shared_domain"}]->(other)
          `,
          { memoryId: memory.id }
        );

        await tx.run(
          `
          match (m:Memory {id: $memoryId})-[:TAGGED_WITH]->(t:Tag)<-[:TAGGED_WITH]-(other:Memory)
          where other.id <> $memoryId and other.updatedAt is not null
          with m, other, count(t) as sharedTags
          where sharedTags >= 2
          merge (m)-[r:SIMILAR_TO {reason: "shared_tags", score: sharedTags}]->(other)
          `,
          { memoryId: memory.id }
        );

        await tx.run(
          `
          match (m:Memory {id: $memoryId})-[:HAS_KEYWORD]->(k1:Keyword),
                (m)-[:HAS_KEYWORD]->(k2:Keyword)
          where k1.text < k2.text
          merge (k1)-[r:CO_OCCURS_WITH]->(k2)
          on create set r.cooccurrences = 1
          on match set r.cooccurrences = coalesce(r.cooccurrences, 0) + 1
          `,
          { memoryId: memory.id }
        );
      });

      return true;
    } finally {
      await session.close();
    }
  } catch (error) {
    graphLog.warn({ err: error }, "Neo4j similarity linking skipped");
    return false;
  }
}

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
          return m.id as id, m.summary as summary, m.content as content,
                 m.importance as importance, m.confidence as confidence
          order by m.importance desc, m.updatedAt desc
          limit $limit
          `,
          { sessionId, domain, limit }
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
    graphLog.warn({ err: error }, "Neo4j domain query failed");
    return [];
  }
}

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
          { sessionId, keyword, limit }
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
    graphLog.warn({ err: error }, "Neo4j keyword query failed");
    return [];
  }
}

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
          return m.id as id, m.summary as summary, m.content as content,
                 m.importance as importance, e.type as entityType
          order by m.importance desc, m.updatedAt desc
          limit $limit
          `,
          { sessionId, entityValue, limit }
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
    graphLog.warn({ err: error }, "Neo4j entity query failed");
    return [];
  }
}

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
          { memoryId, reason: "shared_keywords", limit }
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
    graphLog.warn({ err: error }, "Neo4j similarity query failed");
    return [];
  }
}

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
          { sessionId }
        )
      );

      const record = result.records[0];
      return record ? record.get("stats") : null;
    } finally {
      await session.close();
    }
  } catch (error) {
    graphLog.warn({ err: error }, "Neo4j stats query failed");
    return null;
  }
}

// ─── Internal driver helpers (exported for graphService.js) ──────────────────
// These are prefixed with _ to signal they are infrastructure-internal and
// should not be imported by application services.

/** @internal */
export { isNeo4jEnabled as _isNeo4jEnabled };
/** @internal */
export { getDriver as _getDriver };
/** @internal */
export { ensureNeo4jReady as _ensureNeo4jReady };

/**
 * Update the lifecycle-state properties on an existing Memory node in Neo4j.
 *
 * This is a targeted SET — it only touches `lifecycleState`, `updatedAt`,
 * and optionally `tier` and `conflicts`.  It does NOT alter the node's
 * structural relationships (keywords, tags, sessions etc.).
 *
 * When Neo4j is not configured or the node does not exist the function
 * returns `false` so the caller can record the skip without treating it as
 * a hard failure.
 *
 * @param {string}      id             - Memory ID (neo4j constraint: memory_id)
 * @param {string}      lifecycleState - New LifecycleState value
 * @param {object}      metadata       - Full metadata object from the updated memory.
 *                                       The relevant fields are extracted here.
 * @returns {Promise<boolean>}  true = node updated; false = Neo4j disabled or not found
 */
export async function updateMemoryLifecycleState(id, lifecycleState, metadata) {
  try {
    if (!(await ensureNeo4jReady())) {
      return false;
    }

    const session = getDriver().session({
      database: process.env.NEO4J_DATABASE || "neo4j"
    });

    try {
      const result = await session.executeWrite((tx) =>
        tx.run(
          `
          match (m:Memory {id: $memoryId})
          set
            m.lifecycleState = $lifecycleState,
            m.updatedAt      = $updatedAt,
            m.tier           = $tier
          return m.id as id
          `,
          {
            memoryId:       id,
            lifecycleState,
            updatedAt:      metadata?.updatedAt ?? new Date().toISOString(),
            tier:           metadata?.tier ?? null
          }
        )
      );

      return result.records.length > 0;
    } finally {
      await session.close();
    }
  } catch (error) {
    graphLog.warn({ err: error, memoryId: id }, "Neo4j lifecycle state update skipped");
    return false;
  }
}

/**
 * Delete a Memory node and all its direct relationships from Neo4j.
 *
 * The DETACH DELETE clause removes the node together with every relationship
 * it participates in, preventing dangling edges.  Shared nodes that the
 * Memory pointed to (Domain, Keyword, Tag, Entity, etc.) are intentionally
 * left intact — they may still be referenced by other Memory nodes.
 *
 * When Neo4j is not configured the function returns `false` (skip, not error).
 * When the node does not exist the function returns `false` (idempotent).
 *
 * @param {string} memoryId
 * @returns {Promise<boolean>}  true = node existed and was deleted; false = not found / Neo4j disabled
 */
export async function deleteMemory(memoryId) {
  try {
    if (!(await ensureNeo4jReady())) {
      return false;
    }

    const session = getDriver().session({
      database: process.env.NEO4J_DATABASE || "neo4j"
    });

    try {
      const result = await session.executeWrite((tx) =>
        tx.run(
          `
          match (m:Memory {id: $memoryId})
          detach delete m
          return count(m) as deleted
          `,
          { memoryId }
        )
      );

      const count = result.records[0]?.get("deleted");
      // neo4j-driver returns integers as neo4j.Integer objects
      const deletedCount = typeof count?.toNumber === "function" ? count.toNumber() : Number(count ?? 0);
      return deletedCount > 0;
    } finally {
      await session.close();
    }
  } catch (error) {
    graphLog.warn({ err: error, memoryId }, "Neo4j deleteMemory skipped");
    // Rethrow so the cascade can record this as a partial failure
    throw error;
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
