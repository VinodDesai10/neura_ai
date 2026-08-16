/**
 * apps/api/src/services/graphPipeline.js
 *
 * Async graph extraction and persistence helper for the memory pipeline.
 *
 * This module is the single call site where entity/relationship extraction
 * (pure domain logic in @neura/core) meets Neo4j persistence
 * (infrastructure in graphService.js).  It is intentionally kept small —
 * its only job is:
 *
 *   1. Call `extractEntities` and `extractRelationships` from @neura/core
 *   2. Persist the results through `graphService.upsertEntity/upsertRelationship`
 *   3. Never throw — log warnings and return silently on any failure
 *
 * Usage (fire-and-forget from memory-processor.js):
 *
 *   persistMemoryGraph(memory).catch(() => {});  // never awaited
 *
 * ─── Design decisions ─────────────────────────────────────────────────────
 *
 *   • `persistMemoryGraph` is async but callers MUST NOT await it on the
 *     critical path.  Memory storage should never block or fail because the
 *     graph pipeline is slow or Neo4j is unavailable.
 *
 *   • A single memory is processed per call (no batching here) to keep the
 *     function simple.  The caller (processEventJob) can invoke it in a
 *     Promise.allSettled if needed.
 *
 *   • Both extraction functions are synchronous and O(n) on content length —
 *     no LLM, no I/O.  The only async work is the Neo4j upserts.
 */

import { extractEntities, extractRelationships } from "@neura/core";
import {
  upsertEntity,
  upsertRelationship
} from "../infrastructure/neo4j/graphService.js";
import { logger } from "../lib/logger.js";

const pipelineLog = logger.child({ component: "graph-pipeline" });

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract graph entities and relationships from a memory and persist them
 * asynchronously into Neo4j.
 *
 * NEVER awaited on the critical path — failures are logged and swallowed.
 *
 * @param {object} memory  - A stored memory object (needs `.id`, `.content`,
 *                           `.summary`, `.memoryType`, `.metadata`)
 * @returns {Promise<void>}
 */
export async function persistMemoryGraph(memory) {
  if (!memory?.id) return;

  try {
    // ── Pure extraction (synchronous, deterministic) ──────────────────────
    const entities      = extractEntities(memory);
    const relationships = extractRelationships(memory, entities);

    if (entities.length === 0) return;

    // ── Persist entities ──────────────────────────────────────────────────
    await Promise.all(
      entities.map((entity) =>
        upsertEntity(entity).catch((err) =>
          pipelineLog.warn({ err, entityId: entity.id }, "graph-pipeline.entity.failed")
        )
      )
    );

    // ── Persist relationships ─────────────────────────────────────────────
    if (relationships.length > 0) {
      await Promise.all(
        relationships.map((rel) =>
          upsertRelationship(rel).catch((err) =>
            pipelineLog.warn(
              { err, fromId: rel.fromId, toId: rel.toId, type: rel.type },
              "graph-pipeline.relationship.failed"
            )
          )
        )
      );
    }

    pipelineLog.debug(
      {
        memoryId:      memory.id,
        entityCount:   entities.length,
        relCount:      relationships.length
      },
      "graph-pipeline.complete"
    );
  } catch (err) {
    // Catch-all: graph extraction must never surface to callers
    pipelineLog.warn({ err, memoryId: memory?.id }, "graph-pipeline.unexpected-error");
  }
}
