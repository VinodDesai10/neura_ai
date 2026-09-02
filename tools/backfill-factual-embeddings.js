#!/usr/bin/env node
/**
 * tools/backfill-factual-embeddings.js
 *
 * One-time script: generate and store embeddings for factual memories
 * that have a NULL embedding column in PostgreSQL.
 *
 * This is a production-compatible operation — the embedding column already
 * exists in the schema and is read by factual-memory-store.js findRelevant()
 * for cosine similarity scoring (RC2 fix). Memories stored before the RC2
 * fix was deployed simply never had their embeddings computed.
 *
 * The script uses the same embedding model and Redis cache as production.
 *
 * Usage:
 *   node tools/backfill-factual-embeddings.js
 *   node tools/backfill-factual-embeddings.js --dry-run   (counts, no writes)
 *
 * Safe to re-run: skips rows that already have an embedding.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname }         from "node:path";
import { fileURLToPath }            from "node:url";

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

const DRY_RUN = process.argv.includes("--dry-run");
const BATCH   = 5;           // memories per batch (keeps embedding API happy)
const DELAY   = 2000;        // ms pause between batches

// ─── Embedding function (same model + cache as production) ───────────────────

async function buildEmbedFn() {
  const apiKey  = process.env.OPENAI_API_KEY;
  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model   = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not set — cannot generate embeddings");
  }

  return async function embedText(text) {
    const maxRetries = 5;
    let delay = 3000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const res = await fetch(`${baseUrl}/v1/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({ model, input: text, encoding_format: "float" })
      });

      if (res.ok) {
        const payload = await res.json();
        return payload?.data?.[0]?.embedding ?? null;
      }

      if (res.status === 429) {
        const retryAfter = res.headers.get("retry-after");
        const waitMs = retryAfter ? Number(retryAfter) * 1000 : delay;
        console.warn(`  ⏳  Rate limited, waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt}/${maxRetries})`);
        await new Promise(r => setTimeout(r, waitMs));
        delay = Math.min(delay * 2, 30000);
        continue;
      }

      const body = await res.text();
      throw new Error(`Embedding API ${res.status}: ${body}`);
    }
    throw new Error("Max embedding retries exceeded");
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║   BACKFILL FACTUAL MEMORY EMBEDDINGS                        ║");
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);
  if (DRY_RUN) console.log("  DRY RUN — no writes will be made\n");

  const { default: postgres } = await import("postgres");
  const ssl = process.env.POSTGRES_SSL === "disable" ? false : "require";
  const sql  = postgres(process.env.POSTGRES_URL, {
    max: 3, ssl, idle_timeout: 30, connect_timeout: 15, onnotice: () => {}
  });

  // Count total and missing
  const [counts] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE embedding IS NULL)     AS missing,
      COUNT(*)                                       AS total
    FROM factual_memories
  `;
  console.log(`  Total factual memories : ${counts.total}`);
  console.log(`  Missing embeddings     : ${counts.missing}`);

  if (counts.missing === "0" || counts.missing === 0) {
    console.log("  ✅  All factual memories already have embeddings. Nothing to do.\n");
    await sql.end();
    return;
  }

  if (DRY_RUN) {
    console.log(`\n  Would generate ${counts.missing} embeddings. Re-run without --dry-run to proceed.\n`);
    await sql.end();
    return;
  }

  const embedText = await buildEmbedFn();
  const model     = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
  console.log(`  Embedding model: ${model}\n`);

  // Fetch all rows missing embeddings (id + text to embed)
  const rows = await sql`
    SELECT id, memory_type, summary, content
    FROM factual_memories
    WHERE embedding IS NULL
    ORDER BY updated_at ASC
  `;

  console.log(`  Processing ${rows.length} rows in batches of ${BATCH}...\n`);

  let success = 0, failed = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);

    for (const row of batch) {
      // Use same text format as memory-processor.js for episodic/semantic:
      //   `${memoryType}: ${summary}`
      // For factual memories the summary is the canonical short form.
      const text = `${row.memory_type}: ${row.summary || row.content}`;

      try {
        const embedding = await embedText(text);
        if (!embedding || !Array.isArray(embedding)) {
          console.warn(`  ⚠️  No embedding returned for ${row.id} — skipping`);
          failed++;
          continue;
        }

        await sql`
          UPDATE factual_memories
          SET embedding = ${sql.json(embedding)}
          WHERE id = ${row.id}
        `;
        success++;
      } catch (err) {
        console.error(`  ❌  Failed for ${row.id}: ${err.message}`);
        failed++;
      }
    }

    process.stdout.write(
      `  ⬆  ${success}/${rows.length} embeddings stored${failed > 0 ? ` (${failed} failed)` : ""}  \r`
    );

    if (i + BATCH < rows.length) {
      await new Promise(r => setTimeout(r, DELAY));
    }
  }

  process.stdout.write("\n");
  console.log(`\n  ✅  Done. Stored: ${success}  Failed: ${failed}\n`);
  await sql.end();
}

main().catch(err => {
  console.error("❌ Fatal:", err.message);
  process.exit(1);
});
