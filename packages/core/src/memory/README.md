# Memory Module — Tiered Storage

The memory module implements a **hot / warm / cold tiered storage** system that automatically places memories in the cheapest storage tier that still satisfies their access latency and retention requirements.

---

## Why Three Tiers?

Most memories are created frequently but accessed rarely after the first few days. Keeping every memory in the same fast, expensive store wastes resources. The tiered system solves this by moving memories through progressively cheaper (and slower) storage as they age and lose relevance.

| Tier | Access pattern | Intended backing store | Current implementation |
|------|---------------|----------------------|----------------------|
| **Hot** | Read several times per day | SQLite (local) or Redis (shared) | In-memory `Map` |
| **Warm** | Read occasionally | PostgreSQL | In-memory `Map` |
| **Cold** | Rarely read; kept for completeness | S3 / MinIO / object storage | In-memory `Map` |

---

## Tier Assignment Rules

Rules are evaluated in priority order inside `tierManager.determineTier(memory)`:

```
1. HOT   if  lastAccessedAt  ≤ 7 days ago
              OR  timestamp (created) ≤ 7 days ago
              (whichever is more recent)

2. COLD  if  timestamp > 90 days ago
              AND  importance < 0.4

3. WARM  everything else
         (includes high-importance memories that have cooled off)
```

The `importance` score is a 0–1 composite value computed by `importanceScorer.calculateImportance()` from signal strength, specificity, permanence, actionability, and recency.

---

## File Layout

```
packages/core/src/memory/
  repositories/
    hotRepository.js     ← In-memory Map; future: SQLite / Redis
    warmRepository.js    ← In-memory Map; future: PostgreSQL
    coldRepository.js    ← In-memory Map; future: S3 / MinIO
    index.js             ← Existing interface stubs (unchanged)
  services/
    tierManager.js       ← determineTier, promote, demote, rebalance
    storageRouter.js     ← saveMemory, getMemory, searchUserMemories, …
```

---

## Repository Interface

All three repositories expose the same five async methods:

```js
// Save (upsert) a memory
const saved = await hotRepository.save(memory);   // { id, userId, …, metadata }

// Retrieve by ID
const mem = await hotRepository.get(id);          // memory | undefined

// List all memories for a user
const mems = await hotRepository.listByUser(userId);  // memory[]

// Apply a partial patch
const updated = await hotRepository.update(id, patch);  // memory | null

// Remove
const wasRemoved = await hotRepository.remove(id);  // boolean
```

---

## Promotion / Demotion Flow

```
        NEW MEMORY
             │
     determineTier()
    ┌─────────┼─────────┐
    ▼         ▼         ▼
   HOT       WARM      COLD
   (7d)      (imp≥0.7)  (90d+low)

       ──────── OVER TIME ─────────

   HOT ──demote──▶ WARM ──demote──▶ COLD
                 ◀──────promote──────
```

### `promote(memory, fromRepo)`

Moves the memory into the hot tier from any other tier. Stamps `metadata.tier = "hot"` and `metadata.lastAccessedAt = now`.

```js
import { promote } from "@neura/core";
import { warmRepository } from "@neura/core";

const hotRecord = await promote(oldWarmMemory, warmRepository);
```

### `demote(memory, fromRepo, toRepo)`

Moves the memory from its current tier to a cooler one.

```js
import { demote } from "@neura/core";
import { hotRepository, coldRepository } from "@neura/core";

const coldRecord = await demote(staleHotMemory, hotRepository, coldRepository);
```

---

## Rebalancing

`rebalance(userId)` scans all three tiers for a user and moves any memory whose current tier no longer matches the result of `determineTier()`.

```js
import { rebalance } from "@neura/core";

const result = await rebalance("user-abc");
// → { moved: [{ id, from, to }, …], total: 42, errors: [] }
```

Call this on a schedule (e.g. daily cron) — not on every request.

---

## Storage Router

The `storageRouter` is the single entry point for all memory persistence. Import it instead of touching repositories directly:

```js
import { storageRouter } from "@neura/core";

// Save — tier chosen automatically
const saved = await storageRouter.saveMemory(candidate);

// Read — searches hot → warm → cold; bumps accessCount + lastAccessedAt
const mem = await storageRouter.getMemory(id);

// Search — all tiers, sorted by importance desc
const all = await storageRouter.searchUserMemories(userId);

// Partial update — finds the correct tier automatically
const updated = await storageRouter.updateMemory(id, { content: "…" });

// Remove — scans all tiers
const removed = await storageRouter.removeMemory(id);
```

Named function exports are also available for tree-shaking:

```js
import { saveMemory, getMemory, searchUserMemories } from "@neura/core";
```

---

## Integration with the Memory Processor

The memory processor (`apps/api/src/services/memory-processor.js`) calls `storageRouter.saveMemory()` after every successful upsert to the primary stores (Postgres / Qdrant). The call is **non-blocking** (fire-and-forget with error logging) so it cannot slow down the critical path.

```js
// Inside processEventJob — simplified
const stored = await factualMemoryStore.upsert(candidate);
storageRouter.saveMemory(stored).catch(err => log.warn(err));
```

This means the tiered system is an **eventually-consistent mirror** of the primary stores. In production the tiered layer will replace the primary stores rather than shadow them.

---

## Retention Behaviour

| Scenario | What happens |
|----------|-------------|
| Memory accessed within 7 days | Stays / moves to **hot** on next rebalance |
| Memory not accessed for 7–90 days, importance ≥ 0.7 | Moves to / stays in **warm** |
| Memory not accessed for 7–90 days, importance < 0.7 | Moves to / stays in **warm** |
| Memory older than 90 days, importance < 0.4 | Moves to **cold** |
| Memory older than 90 days, importance ≥ 0.4 | Stays in **warm** (never cold) |

Memories are **never automatically deleted** — the cold tier is an archive, not a dustbin. Explicit deletion requires calling `removeMemory(id)`.

---

## Future Database Adapters

### Hot → Redis

```js
// hotRepository.js — swap _store for Redis calls
import { redis } from "../../../infrastructure/redis/client.js";

const KEY = (id) => `neura:tier:hot:${id}`;
const USER_SET = (uid) => `neura:tier:hot:user:${uid}`;

async save(memory) {
  await redis.set(KEY(memory.id), JSON.stringify(memory), "EX", 7 * 86400);
  await redis.sAdd(USER_SET(memory.userId), memory.id);
  return memory;
}
```

### Warm → PostgreSQL

```js
// warmRepository.js — swap _store for pg queries
import { pool } from "../../../infrastructure/postgres/pool.js";

async save(memory) {
  const sql = `
    INSERT INTO memories_warm (id, user_id, content, metadata)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (id) DO UPDATE SET metadata = $4
    RETURNING *
  `;
  const { rows } = await pool.query(sql, [
    memory.id, memory.userId, memory.content, JSON.stringify(memory.metadata)
  ]);
  return rows[0];
}
```

### Cold → S3 / MinIO

```js
// coldRepository.js — swap _store for S3 operations
import { s3 } from "../../../infrastructure/s3/client.js";

const key = (memory) => `memories/cold/${memory.userId}/${memory.id}.json`;

async save(memory) {
  await s3.putObject({
    Bucket: process.env.S3_COLD_BUCKET,
    Key: key(memory),
    Body: JSON.stringify(memory),
    ContentType: "application/json",
    StorageClass: "STANDARD_IA"
  });
  return memory;
}
```

In every case, the five-method interface stays identical — the router and tier manager require no changes.

---

## Running Tests

```bash
# From the repo root
npm run test:core

# Or directly
cd packages/core
node --test test/tiered-storage.test.js
```
