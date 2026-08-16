/**
 * packages/core/src/memory/graph/graphTypes.js
 *
 * Canonical entity and relationship type definitions for the Memory Graph.
 *
 * These are the only labels and relationship types that graphService.js,
 * entityExtractor.js, and relationshipExtractor.js may produce.  Keeping
 * them here means a single import is the source of truth.
 *
 * ─── Design notes ──────────────────────────────────────────────────────────
 *
 *   • ENTITY_TYPE values map to Neo4j node labels (:Person, :Project, …)
 *   • REL_TYPE values map to Neo4j relationship types (:WORKS_ON, …)
 *   • Both objects are frozen — mutations are programming errors.
 */

// ─── Entity types ─────────────────────────────────────────────────────────────

/**
 * Supported entity types.  Each value is the canonical string used as the
 * Neo4j node label AND as the `type` field on extracted entity objects.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const ENTITY_TYPE = Object.freeze({
  PERSON:       "person",
  PROJECT:      "project",
  ORGANIZATION: "organization",
  TASK:         "task",
  TOPIC:        "topic",
  DECISION:     "decision",
  PREFERENCE:   "preference",
  EVENT:        "event"
});

/** Set of all valid entity type strings for fast membership checks. */
export const VALID_ENTITY_TYPES = new Set(Object.values(ENTITY_TYPE));

// ─── Relationship types ───────────────────────────────────────────────────────

/**
 * Supported relationship types.  Values are used as Neo4j relationship
 * type labels AND as the `type` field on extracted relationship objects.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const REL_TYPE = Object.freeze({
  WORKS_ON:     "works_on",
  RELATED_TO:   "related_to",
  DEPENDS_ON:   "depends_on",
  DECIDED:      "decided",
  ASSIGNED_TO:  "assigned_to",
  PREFERS:      "prefers",
  MENTIONED_IN: "mentioned_in",
  COMPLETED:    "completed",
  BELONGS_TO:   "belongs_to"
});

/** Set of all valid relationship type strings for fast membership checks. */
export const VALID_REL_TYPES = new Set(Object.values(REL_TYPE));

// ─── JSDoc typedefs ───────────────────────────────────────────────────────────

/**
 * @typedef {object} GraphEntity
 * @property {string} id         - Stable identifier (e.g. "person:alice")
 * @property {string} name       - Canonical display name (e.g. "Alice")
 * @property {string} type       - One of ENTITY_TYPE values
 * @property {object} [props]    - Additional metadata (optional)
 */

/**
 * @typedef {object} GraphRelationship
 * @property {string} fromId     - Entity id of the source node
 * @property {string} toId       - Entity id of the target node
 * @property {string} type       - One of REL_TYPE values
 * @property {number} confidence - Score in [0, 1]
 * @property {object} [props]    - Additional edge metadata (optional)
 */
