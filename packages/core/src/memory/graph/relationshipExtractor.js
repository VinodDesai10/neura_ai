/**
 * packages/core/src/memory/graph/relationshipExtractor.js
 *
 * Infer relationships between extracted entities and the source memory.
 *
 * Takes the entity list produced by `entityExtractor.extractEntities()` and
 * the original memory, then returns a list of `GraphRelationship` candidates
 * with confidence scores.
 *
 * ─── Strategy ─────────────────────────────────────────────────────────────
 *
 *   Relationships are inferred through three complementary passes:
 *
 *   1. Entity-to-memory: every entity is linked to the memory itself via
 *      MENTIONED_IN (low-confidence baseline).
 *
 *   2. Entity-to-entity: pairs of entities are examined and assigned a
 *      typed relationship based on their types and co-occurrence signals
 *      in the memory text.
 *
 *   3. Memory-type signals: the memory's `memoryType` field biases
 *      additional relationship types (e.g. factual memories produce
 *      PREFERS/DECIDED, episodic memories produce COMPLETED/ASSIGNED_TO).
 *
 * ─── Confidence scores ─────────────────────────────────────────────────────
 *
 *   Scores are in [0, 1].  A score < 0.3 should generally be discarded by
 *   the consumer.  The MENTIONED_IN baseline is always 0.5; co-occurrence
 *   evidence raises the score by up to 0.35.
 *
 * ─── Public API ───────────────────────────────────────────────────────────
 *
 *   extractRelationships(memory, entities) → GraphRelationship[]
 */

import { ENTITY_TYPE, REL_TYPE } from "./graphTypes.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_RELATIONSHIPS = 20;

// Minimum confidence to include a relationship in the output
const MIN_CONFIDENCE = 0.3;

// Phrases that suggest "A is assigned to / works on B"
const WORKS_ON_RE = /\b(?:working on|assigned to|in charge of|responsible for|owns|leading|implementing)\b/i;
const DEPENDS_ON_RE = /\b(?:depends on|requires|needs|built on top of|is blocked by|relies on)\b/i;
const COMPLETED_RE = /\b(?:completed|finished|done with|shipped|released|merged)\b/i;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a stable relationship id from the participating entity ids and type.
 *
 * @param {string} fromId
 * @param {string} toId
 * @param {string} type
 * @returns {string}
 */
function relId(fromId, toId, type) {
  return `${fromId}→${type}→${toId}`;
}

/**
 * Clamp a confidence value to [0, 1].
 *
 * @param {number} c
 * @returns {number}
 */
function clamp(c) {
  return Math.max(0, Math.min(1, c));
}

// ─── Pass 1: entity → memory (MENTIONED_IN) ───────────────────────────────────

/**
 * Every entity is weakly linked to the memory node via MENTIONED_IN.
 * This establishes the baseline graph structure even when no richer
 * relationship can be inferred.
 *
 * @param {import("./graphTypes.js").GraphEntity[]} entities
 * @param {string} memoryNodeId  - entity id representing the memory itself
 * @param {Map<string, import("./graphTypes.js").GraphRelationship>} map
 */
function addMentionedInRels(entities, memoryNodeId, map) {
  for (const entity of entities) {
    const id = relId(entity.id, memoryNodeId, REL_TYPE.MENTIONED_IN);
    if (!map.has(id)) {
      map.set(id, {
        fromId:     entity.id,
        toId:       memoryNodeId,
        type:       REL_TYPE.MENTIONED_IN,
        confidence: 0.5,
        props:      { source: "baseline" }
      });
    }
  }
}

// ─── Pass 2: entity-to-entity typed relationships ─────────────────────────────

/**
 * Given a pair of entities (from → to), determine the most appropriate
 * REL_TYPE and a confidence score.  Returns `null` when no strong
 * relationship can be inferred.
 *
 * @param {import("./graphTypes.js").GraphEntity} from
 * @param {import("./graphTypes.js").GraphEntity} to
 * @param {string} text   - combined memory content + summary
 * @returns {{ type: string, confidence: number }|null}
 */
function inferPairRel(from, to, text) {
  const fType = from.type;
  const tType = to.type;

  // person → project  ─────────────────────────────────────────────────────
  if (fType === ENTITY_TYPE.PERSON && tType === ENTITY_TYPE.PROJECT) {
    let confidence = 0.55;
    if (WORKS_ON_RE.test(text)) confidence += 0.25;
    return { type: REL_TYPE.WORKS_ON, confidence: clamp(confidence) };
  }

  // person → task ─────────────────────────────────────────────────────────
  if (fType === ENTITY_TYPE.PERSON && tType === ENTITY_TYPE.TASK) {
    let confidence = 0.55;
    if (WORKS_ON_RE.test(text))  confidence += 0.20;
    if (COMPLETED_RE.test(text)) return { type: REL_TYPE.COMPLETED, confidence: clamp(confidence + 0.10) };
    return { type: REL_TYPE.ASSIGNED_TO, confidence: clamp(confidence) };
  }

  // person → organization ─────────────────────────────────────────────────
  if (fType === ENTITY_TYPE.PERSON && tType === ENTITY_TYPE.ORGANIZATION) {
    return { type: REL_TYPE.BELONGS_TO, confidence: 0.60 };
  }

  // person → preference ───────────────────────────────────────────────────
  if (fType === ENTITY_TYPE.PERSON && tType === ENTITY_TYPE.PREFERENCE) {
    return { type: REL_TYPE.PREFERS, confidence: 0.70 };
  }

  // person → decision ─────────────────────────────────────────────────────
  if (fType === ENTITY_TYPE.PERSON && tType === ENTITY_TYPE.DECISION) {
    return { type: REL_TYPE.DECIDED, confidence: 0.65 };
  }

  // project → project / project → task ────────────────────────────────────
  if (fType === ENTITY_TYPE.PROJECT && tType === ENTITY_TYPE.TASK) {
    let confidence = 0.55;
    if (DEPENDS_ON_RE.test(text)) return { type: REL_TYPE.DEPENDS_ON, confidence: clamp(confidence + 0.15) };
    return { type: REL_TYPE.RELATED_TO, confidence: confidence };
  }

  if (fType === ENTITY_TYPE.PROJECT && tType === ENTITY_TYPE.PROJECT) {
    let confidence = 0.45;
    if (DEPENDS_ON_RE.test(text)) return { type: REL_TYPE.DEPENDS_ON, confidence: clamp(confidence + 0.25) };
    return { type: REL_TYPE.RELATED_TO, confidence: confidence };
  }

  // task → task ────────────────────────────────────────────────────────────
  if (fType === ENTITY_TYPE.TASK && tType === ENTITY_TYPE.TASK) {
    let confidence = 0.40;
    if (DEPENDS_ON_RE.test(text)) return { type: REL_TYPE.DEPENDS_ON, confidence: clamp(confidence + 0.30) };
    return { type: REL_TYPE.RELATED_TO, confidence: confidence };
  }

  // topic → anything ───────────────────────────────────────────────────────
  if (fType === ENTITY_TYPE.TOPIC || tType === ENTITY_TYPE.TOPIC) {
    return { type: REL_TYPE.RELATED_TO, confidence: 0.40 };
  }

  // fallback: generic related_to ───────────────────────────────────────────
  return { type: REL_TYPE.RELATED_TO, confidence: 0.35 };
}

/**
 * Enumerate all ordered pairs of entities and infer typed relationships.
 *
 * @param {import("./graphTypes.js").GraphEntity[]} entities
 * @param {string} text
 * @param {Map<string, import("./graphTypes.js").GraphRelationship>} map
 */
function addEntityPairRels(entities, text, map) {
  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const from = entities[i];
      const to   = entities[j];

      const inference = inferPairRel(from, to, text);
      if (!inference || inference.confidence < MIN_CONFIDENCE) continue;

      const id = relId(from.id, to.id, inference.type);
      if (!map.has(id)) {
        map.set(id, {
          fromId:     from.id,
          toId:       to.id,
          type:       inference.type,
          confidence: inference.confidence,
          props:      { source: "entity_pair" }
        });
      }
    }
  }
}

// ─── Pass 3: memory-type signal boosts ───────────────────────────────────────

/**
 * Boost relationship confidence using the memory's memoryType.
 *
 * - "factual"  → raises confidence of PREFERS / DECIDED relationships
 * - "episodic" → raises confidence of COMPLETED / ASSIGNED_TO relationships
 *
 * @param {string} memoryType
 * @param {Map<string, import("./graphTypes.js").GraphRelationship>} map
 */
function applyMemoryTypeBoosts(memoryType, map) {
  const FACTUAL_BOOST  = new Set([REL_TYPE.PREFERS, REL_TYPE.DECIDED]);
  const EPISODIC_BOOST = new Set([REL_TYPE.COMPLETED, REL_TYPE.ASSIGNED_TO]);

  const boostSet = memoryType === "factual"
    ? FACTUAL_BOOST
    : memoryType === "episodic"
      ? EPISODIC_BOOST
      : null;

  if (!boostSet) return;

  for (const rel of map.values()) {
    if (boostSet.has(rel.type)) {
      rel.confidence = clamp(rel.confidence + 0.10);
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Infer graph relationships between extracted entities and the memory.
 *
 * @param {object}   memory    - Memory object (needs `.id`, `.content`, `.summary`, `.memoryType`)
 * @param {import("./graphTypes.js").GraphEntity[]} entities - Result of `extractEntities(memory)`
 * @returns {import("./graphTypes.js").GraphRelationship[]}
 */
export function extractRelationships(memory, entities) {
  if (!memory || !Array.isArray(entities) || entities.length === 0) return [];

  const text = [memory.content, memory.summary].filter(Boolean).join(" ");

  // The memory node itself is referenced as a virtual entity for MENTIONED_IN
  const memoryNodeId = `memory:${memory.id}`;

  const map = new Map();

  addMentionedInRels(entities, memoryNodeId, map);
  addEntityPairRels(entities, text, map);
  applyMemoryTypeBoosts(memory.memoryType || "", map);

  // Sort by descending confidence, then cap total
  return [...map.values()]
    .filter((r) => r.confidence >= MIN_CONFIDENCE)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_RELATIONSHIPS);
}
