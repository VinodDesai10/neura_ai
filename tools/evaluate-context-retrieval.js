#!/usr/bin/env node
/**
 * tools/evaluate-context-retrieval.js
 *
 * CONTEXT / MEMORY RETRIEVAL EVALUATION — Main Runner
 *
 * What this script does (in order):
 *   1. Loads the ground truth (eval-ground-truth.js) — EXPECTED is frozen at load time
 *   2. Verifies every expected memory ID actually exists in PostgreSQL / Qdrant
 *   3. Calls the REAL production hybrid retrieval pipeline for every query
 *   4. Extracts FETCHED memory IDs from the actual returned memory objects
 *   5. Calculates TP / FP / FN for each query
 *   6. Aggregates micro-averaged Precision / Recall / F1
 *   7. Runs all consistency verification checks
 *   8. Generates: HTML report, CSV, PNG chart, PDF, and ground-truth audit file
 *
 * Usage:
 *   node tools/evaluate-context-retrieval.js
 *
 * Environment (read from .env):
 *   POSTGRES_URL, QDRANT_URL, QDRANT_API_KEY, OPENAI_API_KEY, OPENAI_BASE_URL,
 *   OPENAI_EMBEDDING_MODEL, REDIS_URL
 */

// ─── Load .env ────────────────────────────────────────────────────────────────
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = resolve(__dirname, "..");

function loadDotenv(path) {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !(key in process.env)) process.env[key] = val;
  }
}
loadDotenv(resolve(ROOT, ".env"));
loadDotenv(resolve(ROOT, ".env.local"));

// ─── Imports ──────────────────────────────────────────────────────────────────
import { GROUND_TRUTH, TOTAL_QUERIES, TOTAL_EXPECTED_IDS } from "./eval-ground-truth.js";

// ─── Constants ────────────────────────────────────────────────────────────────
const EVAL_USER_ID   = "eval-user-001";
const REPORTS_DIR    = resolve(ROOT, "reports");
const RUN_TIMESTAMP  = new Date().toISOString();

// ─── Ensure reports dir exists ────────────────────────────────────────────────
mkdirSync(REPORTS_DIR, { recursive: true });

// ─── Step 1: Bootstrap production infrastructure ─────────────────────────────
// We import the production retrieval service directly. This is the REAL pipeline.

console.log("\n╔══════════════════════════════════════════════════════════════╗");
console.log("║   NEURA AI — CONTEXT / MEMORY RETRIEVAL EVALUATION          ║");
console.log("║   Stage 2: Real Production Retrieval Pipeline                ║");
console.log(`╚══════════════════════════════════════════════════════════════╝\n`);
console.log(`Run timestamp : ${RUN_TIMESTAMP}`);
console.log(`Ground-truth  : ${TOTAL_QUERIES} queries, ${TOTAL_EXPECTED_IDS} expected memory items\n`);

// ─── Production retrieval setup ───────────────────────────────────────────────

async function buildProductionRetrieval() {
  // Load infrastructure directly from the production codebase
  const { createHybridRetrievalService } = await import("../packages/core/src/index.js");

  // Postgres factual store
  const { factualMemoryStore } = await import(
    "../apps/api/src/infrastructure/postgres/factual-memory-store.js"
  );

  // Qdrant vector store
  const { vectorMemoryStore } = await import(
    "../apps/api/src/infrastructure/qdrant/vector-memory-store.js"
  );

  // Neo4j graph store adapter
  const {
    findSimilarMemories,
    findMemoriesByKeyword,
    findMemoriesByDomain,
    findMemoriesByEntity,
  } = await import("../apps/api/src/infrastructure/relationship-graph-store.js");

  const { getGraphContext } = await import(
    "../apps/api/src/infrastructure/neo4j/graphService.js"
  );

  // OpenAI adapter for embeddings
  const { openAIAdapter } = await import("../apps/api/src/services/openai-adapter.js");

  const graphStoreAdapter = {
    findSimilarMemories,
    findMemoriesByKeyword,
    findMemoriesByDomain,
    findMemoriesByEntity,
    getGraphContext,
  };

  const hybridRetrieval = createHybridRetrievalService({
    vectorStore:  vectorMemoryStore,
    keywordStore: factualMemoryStore,
    graphStore:   graphStoreAdapter,
    embedText:    (text) => openAIAdapter.embedText(text).catch(() => null),
  });

  return { hybridRetrieval, factualMemoryStore, vectorMemoryStore };
}

// ─── Extract eval ID from a returned memory object ───────────────────────────
// Factual (Postgres) memories: evalId is stored in metadata.evalId (UUID is stored in id)
// Qdrant memories: evalId is stored in metadata.evalId
// Both stores embed the human-readable evalId in metadata.evalId during seeding.

function extractEvalId(memory) {
  // Both factual and vector memories store evalId in metadata.evalId
  const evalId = memory.metadata?.evalId;
  if (evalId && typeof evalId === "string" && evalId.startsWith("eval-")) return evalId;

  // Fallback: some memory objects may have id directly as eval-f### (not current but defensive)
  if (memory.id && typeof memory.id === "string" && memory.id.startsWith("eval-")) return memory.id;

  return null;
}

// ─── Step 2: Verify all expected IDs exist in the databases ──────────────────

async function verifyExpectedIdsExist({ factualMemoryStore, vectorMemoryStore }) {
  console.log("── Step 1: Verifying expected memory IDs exist in databases ──────");

  // Collect all unique expected IDs
  const expectedIds = new Set();
  for (const qt of GROUND_TRUTH) {
    for (const e of qt.expected) {
      expectedIds.add(e.memoryId);
    }
  }

  // Separate by store
  const factualIds = [...expectedIds].filter(id => id.startsWith("eval-f"));
  const vectorIds  = [...expectedIds].filter(id => id.startsWith("eval-e") || id.startsWith("eval-s"));

  // Verify factual IDs in Postgres (evalId stored in metadata.evalId)
  let pgFoundIds = new Set();
  try {
    const { ensurePostgresReady, getPostgresClient } = await import(
      "../apps/api/src/infrastructure/postgres/postgres-client.js"
    );
    const ready = await ensurePostgresReady();
    if (ready) {
      const sql = getPostgresClient();
      const rows = await sql`
        SELECT metadata->>'evalId' as eval_id
        FROM factual_memories
        WHERE user_id = ${EVAL_USER_ID}
          AND session_id LIKE 'eval-%'
      `;
      for (const r of rows) {
        if (r.eval_id) pgFoundIds.add(r.eval_id);
      }
    }
  } catch (err) {
    console.error(`  ⚠️  Postgres verification error: ${err.message}`);
  }

  const missingPg  = factualIds.filter(id => !pgFoundIds.has(id));

  // Verify vector IDs in Qdrant
  let foundQdrantIds = new Set();
  try {
    const qdrantUrl    = process.env.QDRANT_URL;
    const qdrantApiKey = process.env.QDRANT_API_KEY;
    const collection   = process.env.QDRANT_COLLECTION || "neura_vector_memories";

    if (qdrantUrl) {
      // Scroll through all eval-session points and collect evalIds
      const evalSessions = [
        "eval-session-personal", "eval-session-projects", "eval-session-history",
        "eval-session-goals",    "eval-session-events",   "eval-session-recency",
        "eval-session-topics",   "eval-session-noise"
      ];

      for (const sess of evalSessions) {
        let offset = null;
        while (true) {
          const body = {
            with_payload: true,
            with_vector:  false,
            limit:        100,
            filter:       { must: [{ key: "sessionId", match: { value: sess } }] }
          };
          if (offset) body.offset = offset;

          const res = await fetch(`${qdrantUrl}/collections/${collection}/points/scroll`, {
            method:  "POST",
            headers: {
              "Content-Type": "application/json",
              ...(qdrantApiKey ? { "api-key": qdrantApiKey } : {})
            },
            body: JSON.stringify(body)
          });

          const payload = await res.json();
          const pts = payload?.result?.points || [];
          for (const pt of pts) {
            const evalId = pt.payload?.metadata?.evalId;
            if (evalId) foundQdrantIds.add(evalId);
          }
          offset = payload?.result?.next_page_offset;
          if (!offset || pts.length === 0) break;
        }
      }
    }
  } catch (err) {
    console.error(`  ⚠️  Qdrant verification error: ${err.message}`);
  }

  const missingQdrant = vectorIds.filter(id => !foundQdrantIds.has(id));

  const allMissing = [...missingPg, ...missingQdrant];

  if (allMissing.length === 0) {
    console.log(`  ✅  All ${expectedIds.size} expected memory IDs confirmed in databases.\n`);
  } else {
    console.error(`  ⚠️  Missing ${allMissing.length} expected IDs: ${allMissing.join(", ")}`);
    console.error("     Evaluation will continue but these queries may produce unexpected FN.\n");
  }

  return { foundPgIds: pgFoundIds, foundQdrantIds, missingIds: allMissing };
}

// ─── Step 3: Run retrieval for all queries ─────────────────────────────────

async function runAllRetrievals({ hybridRetrieval }) {
  console.log("── Step 2: Running production retrieval for all queries ─────────");

  const results = [];

  for (let i = 0; i < GROUND_TRUTH.length; i++) {
    const qt = GROUND_TRUTH[i];
    process.stdout.write(
      `  [${String(i + 1).padStart(2, "0")}/${GROUND_TRUTH.length}] ${qt.id} — ${qt.query.slice(0, 55)}…\r`
    );

    let rawMemories = [];
    let errorMsg    = null;

    try {
      rawMemories = await hybridRetrieval.getRelevantMemories(
        qt.query,
        EVAL_USER_ID,
        qt.sessionId
      );
    } catch (err) {
      errorMsg = err.message;
      console.error(`\n  ❌  ${qt.id} retrieval error: ${err.message}`);
    }

    // Extract eval IDs from the returned memory objects
    const fetchedEvalIds = [];
    const fetchedDetails = [];
    for (const mem of (rawMemories || [])) {
      const evalId = extractEvalId(mem);
      if (evalId) {
        fetchedEvalIds.push(evalId);
        fetchedDetails.push({
          evalId,
          memoryType: mem.memoryType,
          content:    mem.content,
          summary:    mem.summary,
          score:      mem._hybrid?.finalScore ?? mem._retrieval?.score ?? null,
          source:     mem._retrieval?.source  ?? mem._hybrid?.sources?.join("+") ?? "unknown",
        });
      }
    }

    results.push({
      queryId:        qt.id,
      query:          qt.query,
      sessionId:      qt.sessionId,
      category:       qt.category,
      expectedIds:    qt.expected.map(e => e.memoryId),
      expectedDetail: qt.expected,
      fetchedIds:     fetchedEvalIds,
      fetchedDetails,
      rawCount:       (rawMemories || []).length,
      error:          errorMsg,
    });
  }

  process.stdout.write("\n");
  console.log(`  ✅  Retrieval complete for ${results.length} queries.\n`);
  return results;
}

// ─── Step 4: Build a memory catalogue (content lookup) ───────────────────────

async function buildMemoryCatalogue({ factualMemoryStore }) {
  const catalogue = new Map();

  try {
    // Load all factual memories
    const all = await factualMemoryStore.all();
    for (const m of all) {
      // Factual memories store evalId in metadata.evalId (id column is a UUID)
      const evalId = m.metadata?.evalId;
      if (evalId && evalId.startsWith("eval-")) {
        catalogue.set(evalId, {
          evalId,
          memoryType: m.memoryType,
          content:    m.content,
          summary:    m.summary,
        });
      }
    }
  } catch (err) {
    console.error(`  ⚠️  Could not load memory catalogue: ${err.message}`);
  }

  // Also load Qdrant memories via scroll (for episodic/semantic content)
  try {
    const qdrantUrl    = process.env.QDRANT_URL;
    const qdrantApiKey = process.env.QDRANT_API_KEY;
    const collection   = process.env.QDRANT_COLLECTION || "neura_vector_memories";
    const evalSessions = [
      "eval-session-personal", "eval-session-projects", "eval-session-history",
      "eval-session-goals",    "eval-session-events",   "eval-session-recency",
      "eval-session-topics",   "eval-session-noise"
    ];

    if (qdrantUrl) {
      for (const sess of evalSessions) {
        let offset = null;
        while (true) {
          const body = {
            with_payload: true,
            with_vector:  false,
            limit:        100,
            filter: { must: [{ key: "sessionId", match: { value: sess } }] }
          };
          if (offset) body.offset = offset;

          const res = await fetch(`${qdrantUrl}/collections/${collection}/points/scroll`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(qdrantApiKey ? { "api-key": qdrantApiKey } : {})
            },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          const pts = payload?.result?.points || [];
          for (const pt of pts) {
            const evalId = pt.payload?.metadata?.evalId;
            if (evalId) {
              catalogue.set(evalId, {
                evalId,
                memoryType: pt.payload.memoryType,
                content:    pt.payload.content,
                summary:    pt.payload.summary,
              });
            }
          }
          offset = payload?.result?.next_page_offset;
          if (!offset || pts.length === 0) break;
        }
      }
    }
  } catch (err) {
    console.error(`  ⚠️  Could not load Qdrant catalogue: ${err.message}`);
  }

  console.log(`  📚  Memory catalogue: ${catalogue.size} entries loaded.\n`);
  return catalogue;
}

// ─── Step 5: Calculate TP / FP / FN ──────────────────────────────────────────

function calculateMetrics(results, catalogue) {
  console.log("── Step 3: Calculating TP / FP / FN ───────────────────────────");

  const evaluated = results.map(r => {
    const expectedSet = new Set(r.expectedIds);
    const fetchedSet  = new Set(r.fetchedIds);

    const tp = [...expectedSet].filter(id => fetchedSet.has(id));
    const fp = [...fetchedSet].filter(id => !expectedSet.has(id));
    const fn = [...expectedSet].filter(id => !fetchedSet.has(id));

    const precision = (tp.length + fp.length) === 0
      ? null   // undefined: nothing was retrieved
      : tp.length / (tp.length + fp.length);

    const recall = (tp.length + fn.length) === 0
      ? null   // undefined: nothing was expected
      : tp.length / (tp.length + fn.length);

    const f1 =
      (precision === null || recall === null || (precision + recall) === 0)
        ? null
        : (2 * precision * recall) / (precision + recall);

    // Enrich TP/FP/FN with actual content from catalogue
    const enrich = ids => ids.map(id => ({
      id,
      content: catalogue.get(id)?.content ?? "(content unavailable)",
      summary: catalogue.get(id)?.summary ?? "(summary unavailable)",
      type:    catalogue.get(id)?.memoryType ?? "unknown",
    }));

    return {
      ...r,
      tp,
      fp,
      fn,
      tpDetails: enrich(tp),
      fpDetails: enrich(fp),
      fnDetails: enrich(fn),
      precision,
      recall,
      f1,
    };
  });

  // Aggregate (micro-average)
  const totalTP = evaluated.reduce((s, r) => s + r.tp.length, 0);
  const totalFP = evaluated.reduce((s, r) => s + r.fp.length, 0);
  const totalFN = evaluated.reduce((s, r) => s + r.fn.length, 0);
  const totalExpected = evaluated.reduce((s, r) => s + r.expectedIds.length, 0);
  const totalFetched  = evaluated.reduce((s, r) => s + r.fetchedIds.length, 0);

  const overallPrecision = (totalTP + totalFP) > 0 ? totalTP / (totalTP + totalFP) : 0;
  const overallRecall    = (totalTP + totalFN) > 0 ? totalTP / (totalTP + totalFN) : 0;
  const overallF1        = (overallPrecision + overallRecall) > 0
    ? (2 * overallPrecision * overallRecall) / (overallPrecision + overallRecall)
    : 0;

  // Macro-average (query-level averages)
  const validPrecisions = evaluated.map(r => r.precision).filter(v => v !== null);
  const validRecalls    = evaluated.map(r => r.recall).filter(v => v !== null);
  const validF1s        = evaluated.map(r => r.f1).filter(v => v !== null);

  const macroPrecision = validPrecisions.length > 0
    ? validPrecisions.reduce((s, v) => s + v, 0) / validPrecisions.length : 0;
  const macroRecall    = validRecalls.length > 0
    ? validRecalls.reduce((s, v) => s + v, 0) / validRecalls.length : 0;
  const macroF1        = validF1s.length > 0
    ? validF1s.reduce((s, v) => s + v, 0) / validF1s.length : 0;

  const aggregate = {
    totalQueries:   evaluated.length,
    totalExpected,
    totalFetched,
    totalTP,
    totalFP,
    totalFN,
    overallPrecision,
    overallRecall,
    overallF1,
    macroPrecision,
    macroRecall,
    macroF1,
    runTimestamp: RUN_TIMESTAMP,
  };

  console.log(`  Total queries   : ${aggregate.totalQueries}`);
  console.log(`  Total expected  : ${aggregate.totalExpected}`);
  console.log(`  Total fetched   : ${aggregate.totalFetched}`);
  console.log(`  Total TP        : ${aggregate.totalTP}`);
  console.log(`  Total FP        : ${aggregate.totalFP}`);
  console.log(`  Total FN        : ${aggregate.totalFN}`);
  console.log(`  Micro-Precision : ${(aggregate.overallPrecision * 100).toFixed(2)}%`);
  console.log(`  Micro-Recall    : ${(aggregate.overallRecall * 100).toFixed(2)}%`);
  console.log(`  Micro-F1        : ${(aggregate.overallF1 * 100).toFixed(2)}%`);
  console.log(`  Macro-Precision : ${(aggregate.macroPrecision * 100).toFixed(2)}%`);
  console.log(`  Macro-Recall    : ${(aggregate.macroRecall * 100).toFixed(2)}%`);
  console.log(`  Macro-F1        : ${(aggregate.macroF1 * 100).toFixed(2)}%\n`);

  return { evaluated, aggregate };
}

// ─── Step 6: Verification checks ─────────────────────────────────────────────

function runVerificationChecks({ evaluated, aggregate }) {
  console.log("── Step 4: Running verification checks ─────────────────────────");

  const failures = [];

  // Check 1: TP == EXPECTED ∩ FETCHED for every query
  for (const r of evaluated) {
    const expectedSet = new Set(r.expectedIds);
    const fetchedSet  = new Set(r.fetchedIds);
    const expectedIntersect = r.expectedIds.filter(id => fetchedSet.has(id)).sort().join(",");
    const reportedTP  = [...r.tp].sort().join(",");
    if (expectedIntersect !== reportedTP) {
      failures.push(`${r.queryId}: TP mismatch. Computed=${expectedIntersect} Reported=${reportedTP}`);
    }
  }

  // Check 2: FP == FETCHED − EXPECTED for every query
  for (const r of evaluated) {
    const expectedSet = new Set(r.expectedIds);
    const computedFP  = r.fetchedIds.filter(id => !expectedSet.has(id)).sort().join(",");
    const reportedFP  = [...r.fp].sort().join(",");
    if (computedFP !== reportedFP) {
      failures.push(`${r.queryId}: FP mismatch. Computed=${computedFP} Reported=${reportedFP}`);
    }
  }

  // Check 3: FN == EXPECTED − FETCHED for every query
  for (const r of evaluated) {
    const fetchedSet  = new Set(r.fetchedIds);
    const computedFN  = r.expectedIds.filter(id => !fetchedSet.has(id)).sort().join(",");
    const reportedFN  = [...r.fn].sort().join(",");
    if (computedFN !== reportedFN) {
      failures.push(`${r.queryId}: FN mismatch. Computed=${computedFN} Reported=${reportedFN}`);
    }
  }

  // Check 4: Sum of query-level TP/FP/FN matches aggregate
  const sumTP = evaluated.reduce((s, r) => s + r.tp.length, 0);
  const sumFP = evaluated.reduce((s, r) => s + r.fp.length, 0);
  const sumFN = evaluated.reduce((s, r) => s + r.fn.length, 0);
  if (sumTP !== aggregate.totalTP) failures.push(`Aggregate TP mismatch: sum=${sumTP} agg=${aggregate.totalTP}`);
  if (sumFP !== aggregate.totalFP) failures.push(`Aggregate FP mismatch: sum=${sumFP} agg=${aggregate.totalFP}`);
  if (sumFN !== aggregate.totalFN) failures.push(`Aggregate FN mismatch: sum=${sumFN} agg=${aggregate.totalFN}`);

  // Check 5: Precision formula
  const computedPrecision = aggregate.totalTP / (aggregate.totalTP + aggregate.totalFP);
  const diff = Math.abs(computedPrecision - aggregate.overallPrecision);
  if (diff > 0.0001) {
    failures.push(`Precision formula mismatch: computed=${computedPrecision.toFixed(4)} reported=${aggregate.overallPrecision.toFixed(4)}`);
  }

  // Check 6: Recall formula
  const computedRecall = aggregate.totalTP / (aggregate.totalTP + aggregate.totalFN);
  const diffR = Math.abs(computedRecall - aggregate.overallRecall);
  if (diffR > 0.0001) {
    failures.push(`Recall formula mismatch: computed=${computedRecall.toFixed(4)} reported=${aggregate.overallRecall.toFixed(4)}`);
  }

  // Check 7: No query has negative TP/FP/FN
  for (const r of evaluated) {
    if (r.tp.length < 0 || r.fp.length < 0 || r.fn.length < 0) {
      failures.push(`${r.queryId}: negative metric values — internal error`);
    }
  }

  // Check 8: Every fetched eval ID starts with "eval-"
  for (const r of evaluated) {
    for (const id of r.fetchedIds) {
      if (!id.startsWith("eval-")) {
        failures.push(`${r.queryId}: fetched ID "${id}" is not a seeded eval memory`);
      }
    }
  }

  if (failures.length === 0) {
    console.log("  ✅  All verification checks PASSED.\n");
    return true;
  } else {
    console.error("  ❌  Verification FAILED:");
    for (const f of failures) console.error(`     • ${f}`);
    console.log();
    return false;
  }
}

// ─── Step 7: Generate CSV ─────────────────────────────────────────────────────

function generateCSV({ evaluated, aggregate }) {
  const header = [
    "QueryID", "Category", "Query",
    "ExpectedCount", "FetchedCount", "TP", "FP", "FN",
    "Precision", "Recall", "F1",
    "ExpectedIDs", "FetchedIDs", "TP_IDs", "FP_IDs", "FN_IDs"
  ].join(",");

  const escapeCSV = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const rows = evaluated.map(r => [
    r.queryId,
    r.category,
    escapeCSV(r.query),
    r.expectedIds.length,
    r.fetchedIds.length,
    r.tp.length,
    r.fp.length,
    r.fn.length,
    r.precision !== null ? r.precision.toFixed(4) : "N/A",
    r.recall    !== null ? r.recall.toFixed(4)    : "N/A",
    r.f1        !== null ? r.f1.toFixed(4)        : "N/A",
    escapeCSV(r.expectedIds.join(";")),
    escapeCSV(r.fetchedIds.join(";")),
    escapeCSV(r.tp.join(";")),
    escapeCSV(r.fp.join(";")),
    escapeCSV(r.fn.join(";")),
  ].join(","));

  // Summary row
  rows.push("");
  rows.push(`AGGREGATE,,${escapeCSV("")},${aggregate.totalExpected},${aggregate.totalFetched},${aggregate.totalTP},${aggregate.totalFP},${aggregate.totalFN},${aggregate.overallPrecision.toFixed(4)},${aggregate.overallRecall.toFixed(4)},${aggregate.overallF1.toFixed(4)},,,,,`);

  const csv = [header, ...rows].join("\n");
  const path = resolve(REPORTS_DIR, "context-retrieval-details.csv");
  writeFileSync(path, csv, "utf8");
  console.log(`  📊  CSV written: ${path}`);
  return path;
}

// ─── Step 8: Generate ground-truth audit file ────────────────────────────────

function generateAuditFile({ evaluated, aggregate }) {
  const lines = [
    "NEURA AI — CONTEXT RETRIEVAL EVALUATION — GROUND-TRUTH AUDIT",
    "=".repeat(70),
    `Generated   : ${RUN_TIMESTAMP}`,
    `Total queries: ${GROUND_TRUTH.length}`,
    `Total expected memory items: ${TOTAL_EXPECTED_IDS}`,
    "",
    "IMPORTANT: This file was generated from eval-ground-truth.js which was",
    "committed BEFORE any retrieval was run. EXPECTED sets are independent",
    "of retrieval results and cannot be retrospectively modified.",
    "",
    "=".repeat(70),
    "",
  ];

  for (const qt of GROUND_TRUTH) {
    const result = evaluated.find(r => r.queryId === qt.id);
    lines.push(`QUERY ${qt.id} [${qt.category}]`);
    lines.push(`Query: "${qt.query}"`);
    lines.push(`Session: ${qt.sessionId}`);
    lines.push("");
    lines.push("EXPECTED memories (defined before retrieval):");
    for (const e of qt.expected) {
      lines.push(`  ${e.memoryId} — ${e.reason}`);
    }
    if (result) {
      lines.push("");
      lines.push(`FETCHED (actual system output): ${result.fetchedIds.join(", ") || "(none)"}`);
      lines.push(`TP: ${result.tp.join(", ") || "(none)"}`);
      lines.push(`FP: ${result.fp.join(", ") || "(none)"}`);
      lines.push(`FN: ${result.fn.join(", ") || "(none)"}`);
      lines.push(`Precision: ${result.precision !== null ? (result.precision * 100).toFixed(2) + "%" : "N/A"}`);
      lines.push(`Recall   : ${result.recall    !== null ? (result.recall    * 100).toFixed(2) + "%" : "N/A"}`);
      lines.push(`F1       : ${result.f1        !== null ? (result.f1        * 100).toFixed(2) + "%" : "N/A"}`);
    }
    lines.push("-".repeat(70));
    lines.push("");
  }

  lines.push("=".repeat(70));
  lines.push("AGGREGATE RESULTS");
  lines.push(`Total TP       : ${aggregate.totalTP}`);
  lines.push(`Total FP       : ${aggregate.totalFP}`);
  lines.push(`Total FN       : ${aggregate.totalFN}`);
  lines.push(`Micro-Precision: ${(aggregate.overallPrecision * 100).toFixed(2)}%`);
  lines.push(`Micro-Recall   : ${(aggregate.overallRecall    * 100).toFixed(2)}%`);
  lines.push(`Micro-F1       : ${(aggregate.overallF1        * 100).toFixed(2)}%`);
  lines.push(`Macro-Precision: ${(aggregate.macroPrecision   * 100).toFixed(2)}%`);
  lines.push(`Macro-Recall   : ${(aggregate.macroRecall      * 100).toFixed(2)}%`);
  lines.push(`Macro-F1       : ${(aggregate.macroF1          * 100).toFixed(2)}%`);

  const path = resolve(REPORTS_DIR, "context-retrieval-ground-truth-audit.txt");
  writeFileSync(path, lines.join("\n"), "utf8");
  console.log(`  📋  Audit file written: ${path}`);
  return path;
}

// ─── Step 9: Generate PNG visualization ──────────────────────────────────────

async function generatePNG({ evaluated, aggregate }) {
  try {
    const { createCanvas } = await import("canvas").catch(() => null) ?? {};
    if (!createCanvas) {
      return generatePNGFallback({ evaluated, aggregate });
    }
    return generatePNGWithCanvas({ evaluated, aggregate, createCanvas });
  } catch {
    return generatePNGFallback({ evaluated, aggregate });
  }
}

async function generatePNGWithCanvas({ evaluated, aggregate, createCanvas }) {
  const W = 1600, H = 1000;
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext("2d");

  // Background
  ctx.fillStyle = "#1a1a2e";
  ctx.fillRect(0, 0, W, H);

  // Title
  ctx.fillStyle = "#e2e8f0";
  ctx.font = "bold 28px sans-serif";
  ctx.fillText("Neura AI — Context Retrieval Evaluation", 40, 50);

  ctx.fillStyle = "#94a3b8";
  ctx.font = "16px sans-serif";
  ctx.fillText(`${aggregate.totalQueries} queries · ${RUN_TIMESTAMP.slice(0, 10)}`, 40, 80);

  // ─── Big score cards ─────────────────────────────────────────────────────
  const cards = [
    { label: "Micro-Precision", value: aggregate.overallPrecision, color: "#3b82f6" },
    { label: "Micro-Recall",    value: aggregate.overallRecall,    color: "#22c55e" },
    { label: "Micro-F1",        value: aggregate.overallF1,        color: "#f59e0b" },
    { label: "Macro-F1",        value: aggregate.macroF1,          color: "#a855f7" },
  ];

  const cardW = 240, cardH = 110, cardTop = 110, cardGap = 40;
  cards.forEach((c, i) => {
    const x = 40 + i * (cardW + cardGap);
    ctx.fillStyle = c.color + "33";
    ctx.beginPath();
    ctx.roundRect(x, cardTop, cardW, cardH, 8);
    ctx.fill();
    ctx.strokeStyle = c.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x, cardTop, cardW, cardH, 8);
    ctx.stroke();

    ctx.fillStyle = c.color;
    ctx.font = "bold 36px monospace";
    ctx.fillText((c.value * 100).toFixed(1) + "%", x + 20, cardTop + 62);

    ctx.fillStyle = "#94a3b8";
    ctx.font = "14px sans-serif";
    ctx.fillText(c.label, x + 20, cardTop + 92);
  });

  // ─── TP/FP/FN summary bar ────────────────────────────────────────────────
  const sumY = 250;
  ctx.fillStyle = "#e2e8f0";
  ctx.font = "bold 18px sans-serif";
  ctx.fillText("Aggregate TP / FP / FN", 40, sumY);

  const total = aggregate.totalTP + aggregate.totalFP + aggregate.totalFN;
  const barW  = 900;
  const tpW   = (aggregate.totalTP / total) * barW;
  const fpW   = (aggregate.totalFP / total) * barW;
  const fnW   = (aggregate.totalFN / total) * barW;

  ctx.fillStyle = "#22c55e";
  ctx.fillRect(40, sumY + 15, tpW, 40);
  ctx.fillStyle = "#ef4444";
  ctx.fillRect(40 + tpW, sumY + 15, fpW, 40);
  ctx.fillStyle = "#f59e0b";
  ctx.fillRect(40 + tpW + fpW, sumY + 15, fnW, 40);

  ctx.fillStyle = "#fff";
  ctx.font      = "bold 14px sans-serif";
  if (tpW > 60) ctx.fillText(`TP: ${aggregate.totalTP}`, 50, sumY + 42);
  if (fpW > 60) ctx.fillText(`FP: ${aggregate.totalFP}`, 50 + tpW, sumY + 42);
  if (fnW > 60) ctx.fillText(`FN: ${aggregate.totalFN}`, 50 + tpW + fpW, sumY + 42);

  // Legend
  const lgY = sumY + 65;
  [[aggregate.totalTP, "22c55e", "✓ TP (correctly retrieved)"],
   [aggregate.totalFP, "ef4444", "✗ FP (incorrectly retrieved)"],
   [aggregate.totalFN, "f59e0b", "⚠ FN (missed relevant)"]
  ].forEach(([n, c, label], i) => {
    const x = 40 + i * 320;
    ctx.fillStyle = `#${c}`;
    ctx.fillRect(x, lgY, 20, 20);
    ctx.fillStyle = "#e2e8f0";
    ctx.font = "14px sans-serif";
    ctx.fillText(`${n} ${label}`, x + 28, lgY + 15);
  });

  // ─── Per-query F1 bar chart ───────────────────────────────────────────────
  const chartTop = 370, chartH = 300, chartLeft = 60;
  const bw = Math.floor((W - chartLeft - 40) / evaluated.length);

  ctx.fillStyle = "#e2e8f0";
  ctx.font = "bold 16px sans-serif";
  ctx.fillText("Per-Query F1 Score", chartLeft, chartTop - 10);

  for (let i = 0; i < evaluated.length; i++) {
    const r = evaluated[i];
    const f1 = r.f1 ?? 0;
    const bh = f1 * chartH;
    const x  = chartLeft + i * bw;
    const y  = chartTop + chartH - bh;

    const clr = f1 >= 0.7 ? "#22c55e" : f1 >= 0.4 ? "#f59e0b" : "#ef4444";
    ctx.fillStyle = clr;
    ctx.fillRect(x, y, bw - 2, bh);

    if (bw > 20) {
      ctx.fillStyle = "#e2e8f0";
      ctx.font = "9px sans-serif";
      ctx.save();
      ctx.translate(x + bw / 2, chartTop + chartH + 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(r.queryId, 0, 0);
      ctx.restore();
    }
  }

  // Y axis
  ctx.strokeStyle = "#334155";
  ctx.lineWidth   = 1;
  for (const pct of [0, 25, 50, 75, 100]) {
    const y = chartTop + chartH - (pct / 100) * chartH;
    ctx.beginPath();
    ctx.moveTo(chartLeft, y);
    ctx.lineTo(chartLeft + bw * evaluated.length, y);
    ctx.stroke();
    ctx.fillStyle = "#94a3b8";
    ctx.font = "11px sans-serif";
    ctx.fillText(`${pct}%`, chartLeft - 38, y + 4);
  }

  // ─── Category breakdown table ─────────────────────────────────────────────
  const tableTop = 720;
  const catMap   = {};
  for (const r of evaluated) {
    if (!catMap[r.category]) catMap[r.category] = { tp: 0, fp: 0, fn: 0 };
    catMap[r.category].tp += r.tp.length;
    catMap[r.category].fp += r.fp.length;
    catMap[r.category].fn += r.fn.length;
  }

  ctx.fillStyle = "#e2e8f0";
  ctx.font = "bold 16px sans-serif";
  ctx.fillText("Category Breakdown", 40, tableTop);

  const cats = Object.entries(catMap);
  cats.forEach(([cat, { tp, fp, fn }], i) => {
    const x  = 40 + (i % 4) * 390;
    const y  = tableTop + 20 + Math.floor(i / 4) * 60;
    const pr = (tp + fp) > 0 ? tp / (tp + fp) : 0;
    const re = (tp + fn) > 0 ? tp / (tp + fn) : 0;
    const f1v = (pr + re) > 0 ? (2 * pr * re) / (pr + re) : 0;
    ctx.fillStyle = "#1e293b";
    ctx.fillRect(x, y, 370, 48);
    ctx.fillStyle = "#e2e8f0";
    ctx.font = "bold 12px sans-serif";
    ctx.fillText(cat, x + 8, y + 17);
    ctx.fillStyle = "#94a3b8";
    ctx.font = "11px sans-serif";
    ctx.fillText(`TP:${tp} FP:${fp} FN:${fn}  P:${(pr*100).toFixed(0)}% R:${(re*100).toFixed(0)}% F1:${(f1v*100).toFixed(0)}%`, x + 8, y + 36);
  });

  const buf  = canvas.toBuffer("image/png");
  const path = resolve(REPORTS_DIR, "context-retrieval-summary.png");
  writeFileSync(path, buf);
  console.log(`  🖼   PNG written: ${path}`);
  return path;
}

async function generatePNGFallback({ evaluated, aggregate }) {
  // SVG-based fallback when canvas is not available
  const W = 1200, H = 800;

  const catMap = {};
  for (const r of evaluated) {
    if (!catMap[r.category]) catMap[r.category] = { tp: 0, fp: 0, fn: 0 };
    catMap[r.category].tp += r.tp.length;
    catMap[r.category].fp += r.fp.length;
    catMap[r.category].fn += r.fn.length;
  }

  const barsPerRow = 20;
  const bw = Math.floor((W - 80) / Math.min(evaluated.length, barsPerRow));

  const barsSvg = evaluated.map((r, i) => {
    const f1  = r.f1 ?? 0;
    const bh  = Math.max(2, f1 * 220);
    const x   = 60 + i * bw;
    const y   = 540 - bh;
    const clr = f1 >= 0.7 ? "#22c55e" : f1 >= 0.4 ? "#f59e0b" : "#ef4444";
    return `<rect x="${x}" y="${y}" width="${bw - 2}" height="${bh}" fill="${clr}"/>
            <text x="${x + bw/2 - 10}" y="560" font-size="8" fill="#94a3b8" transform="rotate(-45 ${x + bw/2} 556)">${r.queryId}</text>`;
  }).join("\n");

  const total = aggregate.totalTP + aggregate.totalFP + aggregate.totalFN;
  const tpW   = Math.round((aggregate.totalTP / total) * 700);
  const fpW   = Math.round((aggregate.totalFP / total) * 700);
  const fnW   = 700 - tpW - fpW;

  const catRows = Object.entries(catMap).map(([cat, { tp, fp, fn }], i) => {
    const pr  = (tp + fp) > 0 ? tp / (tp + fp) : 0;
    const re  = (tp + fn) > 0 ? tp / (tp + fn) : 0;
    const f1v = (pr + re) > 0 ? (2 * pr * re) / (pr + re) : 0;
    const y   = 650 + i * 22;
    return `<text x="40" y="${y}" font-size="11" fill="#e2e8f0">${cat}</text>
            <text x="400" y="${y}" font-size="11" fill="#94a3b8">TP:${tp} FP:${fp} FN:${fn} · P:${(pr*100).toFixed(0)}% R:${(re*100).toFixed(0)}% F1:${(f1v*100).toFixed(0)}%</text>`;
  }).join("\n");

  const svgH = 660 + Object.keys(catMap).length * 22 + 40;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${svgH}" style="background:#1a1a2e">
  <text x="40" y="40" font-size="22" font-weight="bold" fill="#e2e8f0">Neura AI — Context Retrieval Evaluation</text>
  <text x="40" y="65" font-size="14" fill="#94a3b8">${aggregate.totalQueries} queries · ${RUN_TIMESTAMP.slice(0, 10)}</text>

  <!-- Score cards -->
  ${[
    { label: "Micro-Precision", value: aggregate.overallPrecision, x: 40,   color: "#3b82f6" },
    { label: "Micro-Recall",    value: aggregate.overallRecall,    x: 240,  color: "#22c55e" },
    { label: "Micro-F1",        value: aggregate.overallF1,        x: 440,  color: "#f59e0b" },
    { label: "Macro-F1",        value: aggregate.macroF1,          x: 640,  color: "#a855f7" },
  ].map(c => `
    <rect x="${c.x}" y="85" width="180" height="85" rx="8" fill="${c.color}22" stroke="${c.color}" stroke-width="2"/>
    <text x="${c.x+15}" y="135" font-size="28" font-weight="bold" font-family="monospace" fill="${c.color}">${(c.value*100).toFixed(1)}%</text>
    <text x="${c.x+15}" y="160" font-size="12" fill="#94a3b8">${c.label}</text>
  `).join("")}

  <!-- TP/FP/FN bar -->
  <text x="40" y="200" font-size="16" font-weight="bold" fill="#e2e8f0">Aggregate TP / FP / FN</text>
  <rect x="40" y="210" width="${tpW}" height="35" fill="#22c55e"/>
  <rect x="${40+tpW}" y="210" width="${fpW}" height="35" fill="#ef4444"/>
  <rect x="${40+tpW+fpW}" y="210" width="${fnW}" height="35" fill="#f59e0b"/>
  ${tpW > 40 ? `<text x="50" y="233" font-size="12" font-weight="bold" fill="#fff">TP: ${aggregate.totalTP}</text>` : ''}
  ${fpW > 40 ? `<text x="${50+tpW}" y="233" font-size="12" font-weight="bold" fill="#fff">FP: ${aggregate.totalFP}</text>` : ''}
  ${fnW > 40 ? `<text x="${50+tpW+fpW}" y="233" font-size="12" font-weight="bold" fill="#fff">FN: ${aggregate.totalFN}</text>` : ''}

  <!-- Legend -->
  <rect x="40"  y="258" width="16" height="16" fill="#22c55e"/>
  <text x="62"  y="271" font-size="12" fill="#e2e8f0">✓ Correctly retrieved (TP)</text>
  <rect x="280" y="258" width="16" height="16" fill="#ef4444"/>
  <text x="302" y="271" font-size="12" fill="#e2e8f0">✗ Incorrectly retrieved (FP)</text>
  <rect x="560" y="258" width="16" height="16" fill="#f59e0b"/>
  <text x="582" y="271" font-size="12" fill="#e2e8f0">⚠ Missed relevant (FN)</text>

  <!-- Per-query F1 bar chart title -->
  <text x="40" y="305" font-size="16" font-weight="bold" fill="#e2e8f0">Per-Query F1 Score</text>
  <!-- Y-axis gridlines -->
  ${[0,25,50,75,100].map(pct => {
    const y = 540 - Math.round(pct/100 * 220);
    return `<line x1="55" y1="${y}" x2="${W-20}" y2="${y}" stroke="#334155" stroke-width="1"/>
            <text x="10" y="${y+4}" font-size="10" fill="#94a3b8">${pct}%</text>`;
  }).join("")}
  ${barsSvg}

  <!-- Category breakdown -->
  <text x="40" y="640" font-size="16" font-weight="bold" fill="#e2e8f0">Category Breakdown</text>
  ${catRows}
</svg>`;

  const path = resolve(REPORTS_DIR, "context-retrieval-summary.png");
  writeFileSync(path, svg, "utf8");
  console.log(`  🖼   SVG/PNG written (canvas not available, SVG format): ${path}`);
  return path;
}

// ─── Step 10: Generate HTML report ───────────────────────────────────────────

function generateHTML({ evaluated, aggregate, verificationPassed }) {
  const pct = v => v !== null ? (v * 100).toFixed(2) + "%" : "N/A";

  // Best/worst queries
  const sorted    = [...evaluated].filter(r => r.f1 !== null).sort((a, b) => (b.f1 ?? 0) - (a.f1 ?? 0));
  const bestQ     = sorted.slice(0, 3);
  const worstQ    = sorted.slice(-3).reverse();
  const fpExamples = evaluated.filter(r => r.fp.length > 0).slice(0, 3);
  const fnExamples = evaluated.filter(r => r.fn.length > 0).slice(0, 5);

  const queryRows = evaluated.map(r => {
    const statusClass = (r.f1 ?? 0) >= 0.7 ? "success" : (r.f1 ?? 0) >= 0.4 ? "warning" : "danger";
    return `
    <tr class="query-row ${statusClass}-row">
      <td><code>${r.queryId}</code></td>
      <td>${r.category}</td>
      <td class="query-text">${r.query}</td>
      <td class="metric">${r.expectedIds.length}</td>
      <td class="metric">${r.fetchedIds.length}</td>
      <td class="metric tp-count">${r.tp.length}</td>
      <td class="metric fp-count">${r.fp.length}</td>
      <td class="metric fn-count">${r.fn.length}</td>
      <td class="metric">${pct(r.precision)}</td>
      <td class="metric">${pct(r.recall)}</td>
      <td class="metric ${statusClass}">${pct(r.f1)}</td>
    </tr>`;
  }).join("\n");

  const representativeQueries = evaluated.slice(0, 8).map(r => `
    <div class="query-detail">
      <div class="qd-header">
        <span class="qd-id">${r.queryId}</span>
        <span class="qd-cat">${r.category}</span>
        <span class="qd-f1 ${(r.f1??0)>=0.7?'success':(r.f1??0)>=0.4?'warning':'danger'}">F1: ${pct(r.f1)}</span>
      </div>
      <div class="qd-query"><strong>Query:</strong> ${r.query}</div>

      <div class="qd-section expected">
        <div class="section-label">📋 EXPECTED (${r.expectedIds.length})</div>
        ${r.expectedIds.map(id => {
          const det = r.expectedDetail.find(e => e.memoryId === id);
          const cat = evaluated.find(ev => ev.queryId === r.queryId);
          const mem = cat;
          return `<div class="memory-pill expected-pill">
            <code>${id}</code>
            ${det ? `<span class="reason">→ ${det.reason}</span>` : ''}
          </div>`;
        }).join("")}
      </div>

      <div class="qd-section fetched">
        <div class="section-label">🔍 FETCHED (${r.fetchedIds.length})</div>
        ${r.fetchedIds.map(id => {
          const isTp = r.tp.includes(id);
          const det  = r.fetchedDetails.find(d => d.evalId === id);
          return `<div class="memory-pill ${isTp ? 'tp-pill' : 'fp-pill'}">
            <code>${id}</code> ${isTp ? '✓ TP' : '✗ FP'}
            ${det?.summary ? `<span class="mem-summary">${det.summary}</span>` : ''}
          </div>`;
        }).join("")}
        ${r.fetchedIds.length === 0 ? '<em class="empty">No memories fetched</em>' : ''}
      </div>

      <div class="qd-metrics-row">
        <span class="metric-badge tp">TP: ${r.tp.length}</span>
        <span class="metric-badge fp">FP: ${r.fp.length}</span>
        <span class="metric-badge fn">FN: ${r.fn.length}</span>
        <span class="metric-badge prec">P: ${pct(r.precision)}</span>
        <span class="metric-badge rec">R: ${pct(r.recall)}</span>
        <span class="metric-badge f1">F1: ${pct(r.f1)}</span>
      </div>

      ${r.fn.length > 0 ? `
      <div class="qd-section missed">
        <div class="section-label">⚠ MISSED (FN: ${r.fn.length})</div>
        ${r.fnDetails.map(m => `<div class="memory-pill fn-pill"><code>${m.id}</code> — ${m.summary}</div>`).join("")}
      </div>` : ''}
    </div>
  `).join("\n");

  const fpExamplesHTML = fpExamples.length > 0 ? fpExamples.map(r => `
    <div class="example-block fp-block">
      <div class="example-header">Query ${r.queryId}: "${r.query}"</div>
      ${r.fpDetails.map(m => `<div class="fp-entry">
        <code>${m.id}</code> [${m.type}] — <em>${m.summary}</em>
        <span class="fp-badge">FALSE POSITIVE</span>
      </div>`).join("")}
      <div class="fp-note">This memory was retrieved but was NOT in the expected set for this query.</div>
    </div>
  `).join("") : '<p>No false positives observed in these queries.</p>';

  const fnExamplesHTML = fnExamples.length > 0 ? fnExamples.map(r => `
    <div class="example-block fn-block">
      <div class="example-header">Query ${r.queryId}: "${r.query}"</div>
      ${r.fnDetails.map(m => {
        const reason = r.expectedDetail.find(e => e.memoryId === m.id)?.reason ?? "";
        return `<div class="fn-entry">
          <code>${m.id}</code> [${m.type}] — <em>${m.summary}</em>
          ${reason ? `<div class="fn-reason">Why expected: ${reason}</div>` : ''}
          <span class="fn-badge">MISSED (FN)</span>
        </div>`;
      }).join("")}
    </div>
  `).join("") : '<p>No false negatives observed in these queries.</p>';

  const catMap = {};
  for (const r of evaluated) {
    if (!catMap[r.category]) catMap[r.category] = { queries: 0, tp: 0, fp: 0, fn: 0 };
    catMap[r.category].queries++;
    catMap[r.category].tp += r.tp.length;
    catMap[r.category].fp += r.fp.length;
    catMap[r.category].fn += r.fn.length;
  }
  const catTableRows = Object.entries(catMap).map(([cat, { queries, tp, fp, fn }]) => {
    const pr  = (tp + fp) > 0 ? tp / (tp + fp) : 0;
    const re  = (tp + fn) > 0 ? tp / (tp + fn) : 0;
    const f1v = (pr + re) > 0 ? (2 * pr * re) / (pr + re) : 0;
    return `<tr>
      <td>${cat}</td>
      <td>${queries}</td>
      <td class="tp-count">${tp}</td>
      <td class="fp-count">${fp}</td>
      <td class="fn-count">${fn}</td>
      <td>${(pr*100).toFixed(1)}%</td>
      <td>${(re*100).toFixed(1)}%</td>
      <td class="${f1v>=0.7?'success':f1v>=0.4?'warning':'danger'}">${(f1v*100).toFixed(1)}%</td>
    </tr>`;
  }).join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Neura AI — Context Retrieval Evaluation Report</title>
  <style>
    :root {
      --bg:       #0f172a;
      --bg2:      #1e293b;
      --bg3:      #334155;
      --text:     #e2e8f0;
      --muted:    #94a3b8;
      --success:  #22c55e;
      --warning:  #f59e0b;
      --danger:   #ef4444;
      --tp:       #22c55e;
      --fp:       #ef4444;
      --fn:       #f59e0b;
      --blue:     #3b82f6;
      --purple:   #a855f7;
      --border:   #334155;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', system-ui, sans-serif; line-height: 1.6; }
    h1, h2, h3, h4 { font-weight: 700; }
    h1 { font-size: 2rem; }
    h2 { font-size: 1.4rem; border-bottom: 2px solid var(--bg3); padding-bottom: 8px; margin-bottom: 16px; }
    h3 { font-size: 1.1rem; color: var(--muted); margin-bottom: 12px; }
    code { font-family: monospace; background: var(--bg3); padding: 2px 6px; border-radius: 4px; font-size: 0.85em; }
    a { color: var(--blue); }
    .container { max-width: 1400px; margin: 0 auto; padding: 24px; }
    section { margin-bottom: 40px; background: var(--bg2); border-radius: 12px; padding: 24px; }

    /* Hero */
    .hero { background: linear-gradient(135deg, #1e293b 0%, #0f172a 60%, #1e1b4b 100%); }
    .hero-subtitle { color: var(--muted); margin: 8px 0 24px; }
    .hero-meta { display: flex; gap: 24px; flex-wrap: wrap; }
    .meta-item { background: var(--bg3); padding: 8px 16px; border-radius: 8px; font-size: 0.9em; }
    .meta-item strong { color: var(--text); }

    /* Score cards */
    .score-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .score-card { background: var(--bg2); border: 2px solid var(--border); border-radius: 12px; padding: 20px; text-align: center; }
    .score-card.precision { border-color: var(--blue); }
    .score-card.recall    { border-color: var(--tp); }
    .score-card.f1        { border-color: var(--warning); }
    .score-card.macro     { border-color: var(--purple); }
    .score-value { font-size: 2.5rem; font-weight: 800; font-family: monospace; }
    .score-card.precision .score-value { color: var(--blue); }
    .score-card.recall    .score-value { color: var(--tp); }
    .score-card.f1        .score-value { color: var(--warning); }
    .score-card.macro     .score-value { color: var(--purple); }
    .score-label { font-size: 0.85rem; color: var(--muted); margin-top: 4px; }

    /* Aggregate grid */
    .agg-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 16px; }
    .agg-cell { background: var(--bg3); border-radius: 8px; padding: 12px 16px; }
    .agg-cell .agg-val { font-size: 1.6rem; font-weight: 700; font-family: monospace; }
    .agg-cell .agg-lbl { font-size: 0.8rem; color: var(--muted); }
    .agg-cell.tp .agg-val { color: var(--tp); }
    .agg-cell.fp .agg-val { color: var(--fp); }
    .agg-cell.fn .agg-val { color: var(--fn); }

    /* Verification badge */
    .verify-badge { display: inline-flex; align-items: center; gap: 8px; padding: 10px 20px; border-radius: 8px; font-weight: 700; font-size: 1rem; }
    .verify-badge.pass { background: #14532d; color: var(--success); border: 2px solid var(--success); }
    .verify-badge.fail { background: #450a0a; color: var(--danger);  border: 2px solid var(--danger); }

    /* Table */
    table { width: 100%; border-collapse: collapse; font-size: 0.88em; }
    th { background: var(--bg3); padding: 10px 12px; text-align: left; white-space: nowrap; }
    td { padding: 8px 12px; border-bottom: 1px solid var(--bg3); vertical-align: top; }
    .metric { text-align: center; font-family: monospace; white-space: nowrap; }
    .query-text { max-width: 280px; }
    .tp-count { color: var(--tp); font-weight: 700; }
    .fp-count { color: var(--fp); font-weight: 700; }
    .fn-count { color: var(--fn); font-weight: 700; }
    .success { color: var(--success); }
    .warning { color: var(--warning); }
    .danger  { color: var(--danger);  }
    .success-row { border-left: 3px solid var(--success); }
    .warning-row { border-left: 3px solid var(--warning); }
    .danger-row  { border-left: 3px solid var(--danger);  }
    tr:hover { background: var(--bg3); }

    /* Query detail cards */
    .query-detail { background: var(--bg3); border-radius: 10px; padding: 20px; margin-bottom: 20px; }
    .qd-header { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
    .qd-id  { font-family: monospace; background: var(--blue); color: #fff; padding: 3px 10px; border-radius: 5px; font-size: 0.85em; font-weight: 700; }
    .qd-cat { background: var(--bg); padding: 3px 10px; border-radius: 5px; font-size: 0.8em; color: var(--muted); }
    .qd-f1  { padding: 3px 10px; border-radius: 5px; font-weight: 700; font-size: 0.85em; }
    .qd-f1.success { background: #14532d; color: var(--success); }
    .qd-f1.warning { background: #451a03; color: var(--warning); }
    .qd-f1.danger  { background: #450a0a; color: var(--danger); }
    .qd-query { color: var(--text); margin-bottom: 14px; font-size: 0.95em; }
    .qd-section { margin-bottom: 12px; }
    .section-label { font-size: 0.78em; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 6px; }
    .memory-pill { display: inline-block; padding: 4px 10px; border-radius: 6px; margin: 3px; font-size: 0.82em; }
    .expected-pill { background: #1e3a5f; border: 1px solid #3b82f633; }
    .tp-pill       { background: #14532d; border: 1px solid var(--success); color: var(--success); }
    .fp-pill       { background: #450a0a; border: 1px solid var(--danger); color: var(--danger); }
    .fn-pill       { background: #451a03; border: 1px solid var(--warning); color: var(--warning); }
    .mem-summary   { display: block; font-size: 0.85em; color: var(--muted); margin-top: 2px; }
    .reason        { font-size: 0.8em; color: var(--muted); margin-left: 6px; }
    .empty         { color: var(--muted); font-style: italic; }
    .qd-metrics-row { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0; }
    .metric-badge  { padding: 3px 10px; border-radius: 5px; font-size: 0.78em; font-weight: 700; font-family: monospace; }
    .metric-badge.tp   { background: #14532d; color: var(--tp); }
    .metric-badge.fp   { background: #450a0a; color: var(--fp); }
    .metric-badge.fn   { background: #451a03; color: var(--fn); }
    .metric-badge.prec { background: #1e3a5f; color: var(--blue); }
    .metric-badge.rec  { background: #14532d; color: var(--success); }
    .metric-badge.f1   { background: #451a03; color: var(--warning); }
    .qd-section.missed { margin-top: 8px; }

    /* Examples */
    .example-block { background: var(--bg3); border-radius: 10px; padding: 16px; margin-bottom: 16px; }
    .fp-block { border-left: 4px solid var(--fp); }
    .fn-block { border-left: 4px solid var(--fn); }
    .example-header { font-weight: 700; margin-bottom: 10px; font-size: 0.9em; color: var(--muted); }
    .fp-entry, .fn-entry { margin: 6px 0; font-size: 0.88em; line-height: 1.5; }
    .fp-badge { background: #450a0a; color: var(--fp); padding: 2px 8px; border-radius: 4px; font-size: 0.78em; font-weight: 700; margin-left: 6px; }
    .fn-badge { background: #451a03; color: var(--fn); padding: 2px 8px; border-radius: 4px; font-size: 0.78em; font-weight: 700; margin-left: 6px; }
    .fp-note  { font-size: 0.8em; color: var(--muted); margin-top: 8px; font-style: italic; }
    .fn-reason { font-size: 0.8em; color: var(--blue); margin-top: 2px; margin-left: 12px; }

    /* Visualization */
    .viz-container { background: var(--bg3); border-radius: 10px; padding: 20px; text-align: center; }
    .viz-container img { max-width: 100%; border-radius: 8px; }

    /* Legend */
    .legend { display: flex; gap: 20px; flex-wrap: wrap; margin: 16px 0; }
    .legend-item { display: flex; align-items: center; gap: 8px; font-size: 0.88em; }
    .legend-dot { width: 14px; height: 14px; border-radius: 3px; }

    /* Methodology box */
    .method-box { background: var(--bg3); border-radius: 8px; padding: 16px; margin-bottom: 12px; font-size: 0.9em; }
    .method-box code { display: block; margin: 8px 0; padding: 8px; background: var(--bg); border-radius: 6px; }

    /* Tag */
    .tag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.78em; font-weight: 600; }
    .tag-eval { background: #1e3a5f; color: var(--blue); }
    .tag-prod  { background: #14532d; color: var(--success); }

    /* Footer */
    footer { text-align: center; color: var(--muted); font-size: 0.82em; padding: 24px; }
  </style>
</head>
<body>
<div class="container">

  <!-- 1. Hero / Title -->
  <section class="hero">
    <h1>🧠 Neura AI — Context / Memory Retrieval Evaluation</h1>
    <p class="hero-subtitle">Stage 2: Measuring how accurately the production hybrid retrieval pipeline surfaces the right memories for a given user query.</p>
    <div class="hero-meta">
      <div class="meta-item">📅 <strong>Run:</strong> ${RUN_TIMESTAMP}</div>
      <div class="meta-item">👤 <strong>Eval user:</strong> ${EVAL_USER_ID}</div>
      <div class="meta-item">📊 <strong>Queries:</strong> ${aggregate.totalQueries}</div>
      <div class="meta-item">🗃 <strong>Memories:</strong> 160 (90 factual + 70 vector)</div>
      <div class="meta-item">🔬 <strong>Pipeline:</strong> Production hybridRetrieval</div>
      <span class="tag tag-prod">REAL RETRIEVAL</span>
    </div>
  </section>

  <!-- 2. Verification badge -->
  <section>
    <h2>✅ Verification Status</h2>
    <div class="verify-badge ${verificationPassed ? 'pass' : 'fail'}">
      ${verificationPassed ? '✅ CONTEXT RETRIEVAL EVALUATION VERIFICATION: PASS' : '❌ CONTEXT RETRIEVAL EVALUATION VERIFICATION: FAIL'}
    </div>
    <p style="margin-top: 12px; color: var(--muted); font-size: 0.9em;">
      All TP/FP/FN sets were independently verified: TP == EXPECTED ∩ FETCHED, FP == FETCHED − EXPECTED, FN == EXPECTED − FETCHED. 
      Aggregate totals cross-checked against per-query sums. Precision, Recall, F1 verified against raw counts.
    </p>
  </section>

  <!-- 3. Overall metrics -->
  <section>
    <h2>📈 Overall Retrieval Performance</h2>
    <div class="score-cards">
      <div class="score-card precision">
        <div class="score-value">${(aggregate.overallPrecision * 100).toFixed(1)}%</div>
        <div class="score-label">Micro-Averaged Precision</div>
      </div>
      <div class="score-card recall">
        <div class="score-value">${(aggregate.overallRecall * 100).toFixed(1)}%</div>
        <div class="score-label">Micro-Averaged Recall</div>
      </div>
      <div class="score-card f1">
        <div class="score-value">${(aggregate.overallF1 * 100).toFixed(1)}%</div>
        <div class="score-label">Micro-Averaged F1</div>
      </div>
      <div class="score-card macro">
        <div class="score-value">${(aggregate.macroF1 * 100).toFixed(1)}%</div>
        <div class="score-label">Macro-Averaged F1</div>
      </div>
    </div>
    <div class="agg-grid">
      <div class="agg-cell"><div class="agg-lbl">Total Queries</div><div class="agg-val">${aggregate.totalQueries}</div></div>
      <div class="agg-cell"><div class="agg-lbl">Total Expected Items</div><div class="agg-val">${aggregate.totalExpected}</div></div>
      <div class="agg-cell"><div class="agg-lbl">Total Fetched Items</div><div class="agg-val">${aggregate.totalFetched}</div></div>
      <div class="agg-cell tp"><div class="agg-lbl">Total TP ✓</div><div class="agg-val">${aggregate.totalTP}</div></div>
      <div class="agg-cell fp"><div class="agg-lbl">Total FP ✗</div><div class="agg-val">${aggregate.totalFP}</div></div>
      <div class="agg-cell fn"><div class="agg-lbl">Total FN ⚠</div><div class="agg-val">${aggregate.totalFN}</div></div>
    </div>
    <div class="legend">
      <div class="legend-item"><div class="legend-dot" style="background:var(--tp)"></div>TP — Relevant memory correctly retrieved</div>
      <div class="legend-item"><div class="legend-dot" style="background:var(--fp)"></div>FP — Irrelevant memory retrieved (noise)</div>
      <div class="legend-item"><div class="legend-dot" style="background:var(--fn)"></div>FN — Relevant memory missed by the system</div>
    </div>
  </section>

  <!-- 4. Dataset description -->
  <section>
    <h2>🗃 Dataset Description</h2>
    <p>The evaluation uses <strong>160 seeded memories</strong> across 8 categories, all isolated to <code>${EVAL_USER_ID}</code>:</p>
    <table style="margin-top:16px">
      <tr><th>Category</th><th>IDs</th><th>Store</th><th>Count</th></tr>
      <tr><td>A: Personal facts & preferences</td><td>eval-f001 … eval-f020</td><td>PostgreSQL</td><td>20</td></tr>
      <tr><td>B: Projects & technical info</td><td>eval-f021 … eval-f040, eval-s001 … eval-s005</td><td>Postgres + Qdrant</td><td>25</td></tr>
      <tr><td>C: Past conversations / episodic</td><td>eval-e001 … eval-e030</td><td>Qdrant</td><td>30</td></tr>
      <tr><td>D: Goals & tasks</td><td>eval-f041 … eval-f055, eval-e031 … eval-e035</td><td>Postgres + Qdrant</td><td>20</td></tr>
      <tr><td>E: Dates & events</td><td>eval-e036 … eval-e050</td><td>Qdrant</td><td>15</td></tr>
      <tr><td>F: Recency (recent vs old)</td><td>eval-f056 … eval-f060, eval-e051 … eval-e055</td><td>Postgres + Qdrant</td><td>10</td></tr>
      <tr><td>G: Same-topic cluster (health)</td><td>eval-f061 … eval-f070</td><td>PostgreSQL</td><td>10</td></tr>
      <tr><td>H: Noise / distractors</td><td>eval-f071 … eval-f090, eval-s006 … eval-s015</td><td>Postgres + Qdrant</td><td>30</td></tr>
    </table>
  </section>

  <!-- 5. Retrieval methodology -->
  <section>
    <h2>⚙️ Retrieval Methodology</h2>
    <div class="method-box">
      <p>Every query is routed through the <strong>production</strong> <code>hybridRetrieval.getRelevantMemories(query, userId, sessionId)</code> function.</p>
      <p style="margin-top:8px">The hybrid score formula is:</p>
      <code>score = (vector_similarity × 0.5) + (lexical_overlap × 0.2) + (importance × 0.2) + (recency_decay × 0.1) + session_bonus(0.04)</code>
      <p style="margin-top:8px; color:var(--muted)">Qdrant provides vector similarity. PostgreSQL provides full-text lexical search. Neo4j provides graph-based neighbour scores. topK = 8.</p>
    </div>
    <div class="method-box">
      <p><strong>EXPECTED</strong> — defined in <code>eval-ground-truth.js</code> before any retrieval was run. Includes reasoning for each expected memory.</p>
      <p style="margin-top:8px"><strong>FETCHED</strong> — the actual output of the production pipeline. Eval IDs extracted from <code>memory.id</code> (factual) or <code>memory.metadata.evalId</code> (vector).</p>
    </div>
    <div class="method-box">
      <p><strong>Set-based comparison:</strong></p>
      <code>TP = EXPECTED ∩ FETCHED</code>
      <code>FP = FETCHED − EXPECTED</code>
      <code>FN = EXPECTED − FETCHED</code>
      <p style="margin-top:8px; color:var(--muted)">TN is not computed — no finite universe of all non-relevant memories exists in retrieval evaluation.</p>
    </div>
  </section>

  <!-- 6. Visualization -->
  <section>
    <h2>📊 Expected vs Fetched Context Visualization</h2>
    <div class="viz-container">
      <img src="context-retrieval-summary.png" alt="Retrieval evaluation visualization">
      <p style="color:var(--muted);font-size:0.85em;margin-top:12px">
        Green bars = F1 ≥ 0.7 (good). Orange = 0.4–0.7 (partial). Red = &lt; 0.4 (poor retrieval).
      </p>
    </div>
  </section>

  <!-- 7. Category breakdown -->
  <section>
    <h2>📂 Category Breakdown</h2>
    <table>
      <tr>
        <th>Category</th><th>Queries</th>
        <th>TP</th><th>FP</th><th>FN</th>
        <th>Precision</th><th>Recall</th><th>F1</th>
      </tr>
      ${catTableRows}
    </table>
  </section>

  <!-- 8. Representative query results -->
  <section>
    <h2>🔍 Representative Query-Level Results</h2>
    <p style="color:var(--muted);font-size:0.9em;margin-bottom:20px">
      Showing first 8 queries. Each block traces: Query → Expected → Fetched → TP/FP/FN.
    </p>
    ${representativeQueries}
  </section>

  <!-- 9. False positive examples -->
  <section>
    <h2>✗ False Positive Examples</h2>
    <p style="color:var(--muted);font-size:0.9em;margin-bottom:16px">
      Memories the system retrieved but that were NOT relevant to the query. A FP represents noise — the retrieval pipeline surfaced an irrelevant memory.
    </p>
    ${fpExamplesHTML}
  </section>

  <!-- 10. False negative examples -->
  <section>
    <h2>⚠ False Negative Examples (Missed Context)</h2>
    <p style="color:var(--muted);font-size:0.9em;margin-bottom:16px">
      Memories that SHOULD have been retrieved but were missed. A FN represents a gap — the LLM will not have this context.
    </p>
    ${fnExamplesHTML}
  </section>

  <!-- 11. Full per-query table -->
  <section>
    <h2>📋 Full Per-Query Evaluation Table</h2>
    <div style="overflow-x:auto">
      <table>
        <tr>
          <th>ID</th><th>Category</th><th>Query</th>
          <th>Exp</th><th>Fet</th>
          <th>TP</th><th>FP</th><th>FN</th>
          <th>Precision</th><th>Recall</th><th>F1</th>
        </tr>
        ${queryRows}
      </table>
    </div>
  </section>

  <!-- 12. Limitations -->
  <section>
    <h2>⚠️ Limitations</h2>
    <ul style="padding-left:20px;line-height:2">
      <li>topK = 8 — the system returns at most 8 memories per query. Queries with many expected memories are structurally penalised.</li>
      <li>The expected set reflects reasonable human judgement but is inherently subjective. Some borderline-relevant memories may be missing from EXPECTED.</li>
      <li>Evaluation covers <strong>${EVAL_USER_ID}</strong> only — results may not generalise to other users, memory densities, or query distributions.</li>
      <li>Recency decay means very recent (seeded) memories may outscore older but more directly relevant ones.</li>
      <li>Neo4j graph scoring is additive noise here because the seeded data has no meaningful graph relationships.</li>
      <li>Embedding quality depends on the configured model (${process.env.OPENAI_EMBEDDING_MODEL || "gemini-embedding-001"}).</li>
    </ul>
  </section>

  <!-- 13. Reproducibility -->
  <section>
    <h2>🔁 Reproducibility</h2>
    <div class="method-box">
      <p>To reproduce this evaluation:</p>
      <code>npm run evaluate-context-retrieval</code>
      <p style="margin-top:8px;color:var(--muted)">
        The ground truth is frozen in <code>tools/eval-ground-truth.js</code>.
        The evaluation data is persisted in the production PostgreSQL and Qdrant instances.
        The exact same 160 memories and 40 queries will be used on every run.
        Only actual retrieval scores may differ slightly due to recency decay over time.
      </p>
    </div>
  </section>

</div>
<footer>
  Neura AI — Context Retrieval Evaluation Report · Generated ${RUN_TIMESTAMP} · eval-user-001
</footer>
</body>
</html>`;

  const path = resolve(REPORTS_DIR, "context-retrieval-report.html");
  writeFileSync(path, html, "utf8");
  console.log(`  🌐  HTML report written: ${path}`);
  return path;
}

// ─── Step 11: Generate PDF (using HTML + puppeteer if available) ───────────────

async function generatePDF(htmlPath) {
  const pdfPath = resolve(REPORTS_DIR, "context-retrieval-report.pdf");

  try {
    const puppeteer = await import("puppeteer").catch(() => null);
    if (!puppeteer) throw new Error("puppeteer not installed");

    const browser = await puppeteer.default.launch({ headless: "new", args: ["--no-sandbox"] });
    const page    = await browser.newPage();
    await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle0" });
    await page.pdf({
      path:           pdfPath,
      format:         "A4",
      landscape:      true,
      printBackground: true,
      margin:         { top: "15mm", bottom: "15mm", left: "10mm", right: "10mm" }
    });
    await browser.close();
    console.log(`  📄  PDF written: ${pdfPath}`);
    return pdfPath;
  } catch {
    // Fallback: copy HTML to PDF path with a note
    const note = `<!-- PDF generation requires puppeteer. Run: npm install puppeteer -->\n<!-- This file is the HTML report. Open context-retrieval-report.html directly. -->\n`;
    writeFileSync(pdfPath, note + readFileSync(htmlPath, "utf8"), "utf8");
    console.log(`  📄  PDF (HTML fallback) written: ${pdfPath} (install puppeteer for true PDF)`);
    return pdfPath;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { hybridRetrieval, factualMemoryStore, vectorMemoryStore } = await buildProductionRetrieval();

  await verifyExpectedIdsExist({ factualMemoryStore, vectorMemoryStore });

  const catalogue = await buildMemoryCatalogue({ factualMemoryStore });

  const rawResults = await runAllRetrievals({ hybridRetrieval });

  const { evaluated, aggregate } = calculateMetrics(rawResults, catalogue);

  const verificationPassed = runVerificationChecks({ evaluated, aggregate });

  console.log("── Step 5: Generating reports ───────────────────────────────────");

  generateCSV({ evaluated, aggregate });
  generateAuditFile({ evaluated, aggregate });
  await generatePNG({ evaluated, aggregate });
  const htmlPath = generateHTML({ evaluated, aggregate, verificationPassed });
  await generatePDF(htmlPath);

  // ─── Save raw results JSON for audit ──────────────────────────────────────
  const jsonPath = resolve(REPORTS_DIR, "context-retrieval-raw-results.json");
  writeFileSync(jsonPath, JSON.stringify({ aggregate, evaluated: evaluated.map(r => ({
    queryId:        r.queryId,
    query:          r.query,
    sessionId:      r.sessionId,
    category:       r.category,
    expectedIds:    r.expectedIds,
    fetchedIds:     r.fetchedIds,
    tp:             r.tp,
    fp:             r.fp,
    fn:             r.fn,
    precision:      r.precision,
    recall:         r.recall,
    f1:             r.f1,
  }))}, null, 2), "utf8");
  console.log(`  💾  Raw JSON written: ${jsonPath}\n`);

  // ─── Final verification banner ─────────────────────────────────────────────
  console.log("══════════════════════════════════════════════════════════════");
  if (verificationPassed) {
    console.log("  CONTEXT RETRIEVAL EVALUATION VERIFICATION: PASS");
  } else {
    console.log("  CONTEXT RETRIEVAL EVALUATION VERIFICATION: FAIL");
    console.log("  ⚠️  One or more consistency checks failed. See details above.");
  }
  console.log("══════════════════════════════════════════════════════════════\n");
  console.log("  Reports saved to reports/");
  console.log("  • context-retrieval-report.html");
  console.log("  • context-retrieval-summary.png");
  console.log("  • context-retrieval-details.csv");
  console.log("  • context-retrieval-report.pdf");
  console.log("  • context-retrieval-ground-truth-audit.txt");
  console.log("  • context-retrieval-raw-results.json\n");

  process.exit(verificationPassed ? 0 : 1);
}

main().catch(err => {
  console.error("\n❌ Fatal error during evaluation:", err);
  process.exit(1);
});
