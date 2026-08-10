# AiNeura

**AiNeura** is a memory-centric AI chat application that gives a language model a structured, persistent memory — modelled after how human cognition actually works. Most AI chat apps forget everything the moment a session ends. AiNeura doesn't.

---

## The Problem It Solves

Standard LLM chat has no memory beyond the context window. Once the window fills up or the session ends, everything is gone. The model can't remember your name, your preferences, what you were working on last week, or what decisions you made two sessions ago.

This creates three real problems:

1. **Context loss** — users have to re-explain themselves every conversation.
2. **No continuity** — the model can't build on prior work or track ongoing tasks.
3. **No personalisation** — every session starts from zero, regardless of relationship history.

AiNeura solves this with a layered cognitive architecture that captures, classifies, stores, retrieves, and reasons over memory — all without bloating the LLM's prompt with irrelevant history.

---

## How It Works

AiNeura is built around five cognitive layers, inspired by how the human brain separates memory types and attention:

### 1. Raw Event Vault
Every message — user and assistant — is appended to an immutable event log (MongoDB). Nothing is inferred here; this is the source of truth.

### 2. Background Memory Processor
An async worker consumes events from a Redis job queue and extracts memory candidates. Each candidate is:
- **Classified** as factual, episodic, or semantic
- **Scored** for importance, confidence, signal strength, specificity, permanence, and actionability
- **Deduplicated** — two-stage check: exact fingerprint match first, then cosine similarity on embeddings
- **Stored** in the appropriate long-term store

### 3. Long-Term Memory Stores
Four specialised stores, each doing what it's best at:

| Store | What it holds |
|-------|--------------|
| **MongoDB** | Raw event log (append-only) |
| **Postgres** | Factual memories — names, preferences, decisions (full-text search via `tsvector`) |
| **Qdrant** | Episodic and semantic memories — vector embeddings for similarity search |
| **Neo4j** | Relationships between sessions, events, memories, and tags |

### 4. Hybrid Retrieval Pipeline
When a new message arrives, the system retrieves relevant memories using a **weighted hybrid score**:

```
score = (vector_similarity × 0.5)
      + (lexical_overlap   × 0.2)
      + (importance        × 0.2)
      + (recency_decay     × 0.1)
      + session_bonus
```

Recency uses exponential decay with a configurable half-life — recent memories score higher, but old ones never reach zero. All weights are tunable via environment variables.

### 5. Working Memory + Conscious Layer
Only the top-ranked memories are assembled into a compact working memory bundle in Redis. The LLM sees **only this bundle** — not the raw history, not the full database. This keeps prompts focused and prevents hallucination from irrelevant context.

---

## Architecture Diagram

```
User Message
     │
     ▼
┌─────────────┐     raw event     ┌──────────────┐
│  Next.js UI │ ───────────────▶  │  MongoDB     │ (raw vault)
└─────────────┘                   └──────────────┘
     │                                   │
     │ POST /chat                        │ async job queue
     ▼                                   ▼
┌─────────────┐               ┌──────────────────┐
│  Node API   │               │  Memory Worker   │
│  (Express)  │               │  (background)    │
└─────────────┘               └──────────────────┘
     │                                   │
     │ retrieve                    classify + embed
     ▼                                   │
┌─────────────────────────────────────────────────┐
│              Long-Term Memory                   │
│  Postgres (factual)  │  Qdrant (vector)         │
│  Neo4j (graph)       │                          │
└─────────────────────────────────────────────────┘
     │
     │ hybrid score + rerank
     ▼
┌──────────────────┐
│  Redis Working   │  ← only this goes to the LLM
│  Memory Bundle   │
└──────────────────┘
     │
     ▼
┌─────────────┐
│  LLM (via   │  → response
│  OpenAI API │
│  or local)  │
└─────────────┘
```

---

## Key Features

- **Persistent memory across sessions** — the model remembers facts, episodes, and summaries from previous conversations
- **Three memory types** — factual (names, facts), episodic (events, tasks), semantic (concepts, summaries)
- **Near-duplicate suppression** — fingerprint + cosine similarity prevents storing the same memory twice
- **Automatic session summarisation** — after every N assistant turns, the conversation is condensed into a compact semantic memory
- **Hybrid retrieval scoring** — vector similarity, full-text search, importance, and recency decay combined
- **Small-talk detection** — greetings and trivial turns skip retrieval entirely, saving latency and cost
- **Session isolation** — each session's memories are namespaced; cross-session leakage is intentionally gated
- **Redis-first runtime** — recent turns, working memory, session state, job queue, rate limits, and retrieval cache all live in Redis for sub-millisecond access
- **OpenAI-compatible** — works with hosted OpenAI or any local model via LM Studio / Ollama
- **Graceful local fallback** — every cloud store has an in-memory adapter so the app runs without any external services configured

---

## Repository Layout

```
apps/
  api/                     Node/Express API
    src/
      controllers/         Route handlers (chat, debug, health)
      services/
        memory-orchestrator.js   Central coordinator for each chat turn
        memory-processor.js      Async job handler (extract → embed → store)
        retrieval-scorer.js      Hybrid scoring engine (pure, stateless)
        deduplication-service.js Two-stage near-duplicate detection
        summary-memory.js        Session summarisation logic
        openai-adapter.js        LLM + embedding abstraction
      infrastructure/
        mongo/             Raw event vault
        postgres/          Factual memory store (with FTS)
        qdrant/            Vector memory store
        redis/             Working memory, runtime state, job queue
        neo4j/             Relationship graph store
      workers/
        memory-worker.js   Background process consuming the job queue
  web/                     Next.js demo UI
    app/
      page.js              Chat interface
      redis/               Redis runtime dashboard (/redis)

packages/
  core/                    Shared domain logic (memory extraction, scoring, prompts)
  shared/                  Cross-package constants, error types, retrieval config
```

---

## Turn-by-Turn Runtime Flow

1. User sends a message from the web app.
2. API acquires a per-session lock (prevents concurrent processing).
3. Raw event is appended to MongoDB and the turn is added to Redis recent context.
4. A memory job is enqueued in Redis.
5. Hybrid retrieval runs — Postgres FTS + Qdrant vector search + retrieval cache check.
6. Top memories are assembled into the Redis working memory bundle.
7. The LLM generates a response from the working memory bundle only.
8. Assistant reply is stored as a raw event and enqueued.
9. **Async** — the memory worker dequeues both jobs, extracts candidates, deduplicates, embeds, and stores them.
10. Every N assistant turns, a summarisation job is enqueued and the conversation is condensed into a semantic memory.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Chat UI | Next.js (App Router) |
| API | Node.js + Express |
| Raw event store | MongoDB |
| Factual memory | PostgreSQL (with FTS) |
| Vector memory | Qdrant |
| Relationship graph | Neo4j |
| Working memory / cache | Redis |
| Embeddings + LLM | OpenAI API or any OpenAI-compatible model |
| Monorepo | npm workspaces |

---

## Getting Started

Requires Node `22.x` (use `nvm use` — the repo includes an `.nvmrc`).

> The project can fail under Node `25.x` with a Next.js dev-runtime error: `localStorage.getItem is not a function`

**1. Install dependencies**

```bash
npm install
```

**2. Configure environment**

Copy `.env.example` to `.env` and fill in your values. You only need to set the variables for the services you want to use — everything else falls back to in-memory adapters.

Minimum config to run locally with a local LLM (LM Studio):

```env
OPENAI_API_KEY=lm-studio
OPENAI_BASE_URL=http://127.0.0.1:1234/v1
OPENAI_MODEL=your-chat-model-name
OPENAI_EMBEDDING_MODEL=your-embedding-model-name
API_PORT=4000
NEXT_PUBLIC_API_BASE_URL=http://localhost:4000
```

**3. Start the API**

```bash
nvm use
npm run dev:api
```

**4. Start the memory worker** (separate terminal)

```bash
nvm use
npm run worker:memory
```

**5. Start the web app** (separate terminal)

```bash
nvm use
npm run dev:web
```

Open `http://localhost:3000` for the chat UI and `http://localhost:3000/redis` for the Redis runtime dashboard.

---

## Cloud Storage Configuration

To use the full cloud-backed stack:

```env
MONGODB_URI=mongodb+srv://user:password@cluster.mongodb.net/?retryWrites=true&w=majority
MONGODB_DATABASE=neura_ai
MONGODB_RAW_EVENTS_COLLECTION=raw_events
POSTGRES_URL=postgres://user:password@host:5432/database?sslmode=require
POSTGRES_SSL=require
REDIS_URL=redis://default:password@host:6379
REDIS_WORKING_MEMORY_PREFIX=neura:working-memory
REDIS_WORKING_MEMORY_MIN_TTL_SECONDS=900
REDIS_WORKING_MEMORY_BASE_TTL_SECONDS=3600
REDIS_WORKING_MEMORY_MAX_TTL_SECONDS=604800
REDIS_RUNTIME_PREFIX=neura
REDIS_EMBEDDING_TTL_SECONDS=604800
REDIS_EMBEDDING_SHORT_TTL_SECONDS=21600
REDIS_EMBEDDING_MEMORY_TTL_SECONDS=2592000
REDIS_RETRIEVAL_MIN_TTL_SECONDS=300
REDIS_RETRIEVAL_MAX_TTL_SECONDS=7200
REDIS_RECENT_TURNS_TTL_SECONDS=604800
REDIS_SESSION_STATE_TTL_SECONDS=86400
REDIS_MEMORY_USAGE_TTL_SECONDS=2592000
CHAT_RATE_LIMIT_MAX_REQUESTS=30
CHAT_RATE_LIMIT_WINDOW_SECONDS=60
QDRANT_URL=https://your-cluster.qdrant.tech
QDRANT_API_KEY=your-qdrant-api-key
QDRANT_COLLECTION=neura_vector_memories
QDRANT_DISTANCE=Cosine
NEO4J_URI=neo4j+s://your-database.databases.neo4j.io
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your-neo4j-password
NEO4J_DATABASE=neo4j
```

All stores bootstrap their own schemas on first run — no manual migrations needed.

### Retrieval Pipeline Tuning

```env
RETRIEVAL_TOP_K=8                    # memories returned per retrieval
RETRIEVAL_VECTOR_WEIGHT=0.5          # weight for Qdrant cosine similarity
RETRIEVAL_LEXICAL_WEIGHT=0.2         # weight for full-text overlap
RETRIEVAL_IMPORTANCE_WEIGHT=0.2      # weight for stored importance score
RETRIEVAL_RECENCY_WEIGHT=0.1         # weight for recency decay factor
RETRIEVAL_RECENCY_HALF_LIFE_HOURS=72 # score halves every N hours
RETRIEVAL_DEDUP_THRESHOLD=0.92       # cosine similarity threshold for dedup
MEMORY_SUMMARY_EVERY_N_TURNS=20      # summarise session every N assistant turns
```

---

## Storage Health Check

```bash
curl http://localhost:4000/health/storage
```

Returns one of:
- `ok` — every configured cloud store is reachable
- `degraded` — at least one cloud store failed
- `local-fallback` — no cloud DB env vars are set; API is using in-memory storage

---

## Environment Variables Reference

See `.env.example` for the full list with defaults. All cloud DB variables are optional — omitting them activates the in-memory fallback.
