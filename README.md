# AiNeura MVP

AiNeura is a memory-centric demo chat application built around a layered cognitive architecture:

- raw event capture
- asynchronous memory processing
- indexed long-term memory
- Redis working memory
- conscious reasoning over surfaced context only

## MVP Scope

This repository is scoped to a demo-first V1 for a capstone review:

- chat app only
- no auth
- conversation memory only
- factual, episodic, and semantic memory
- MongoDB for raw event vault
- Postgres for factual memory
- Qdrant for episodic and semantic retrieval
- Redis for working memory
- Neo4j for session, event, memory, and tag relationships
- OpenAI-compatible local or hosted models for embeddings and response generation

## Repository Layout

```text
apps/
  api/     Node API for chat, ingestion, retrieval, and memory jobs
  web/     Next.js demo UI
packages/
  core/    Shared domain types and prompt-building logic
```

## Planned Runtime Flow

1. User sends a message from the web app.
2. API stores the raw event.
3. API appends the turn to Redis recent context and queues a memory job.
4. API queries the Memory Brain for relevant indexed memories.
5. Working memory is assembled in Redis.
6. Conscious layer generates a response from working memory.
7. New user and assistant events are consumed asynchronously by the memory worker.

## Environment Variables

See `.env.example` for the expected variables.

For the API service, export these variables in your shell or place them in a root `.env` file before starting:

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`
- `OPENAI_EMBEDDING_MODEL`
- `MONGODB_URI`
- `MONGODB_DATABASE`
- `MONGODB_RAW_EVENTS_COLLECTION`
- `POSTGRES_URL`
- `POSTGRES_SSL`
- `REDIS_URL`
- `REDIS_WORKING_MEMORY_PREFIX`
- `REDIS_WORKING_MEMORY_MIN_TTL_SECONDS`
- `REDIS_WORKING_MEMORY_BASE_TTL_SECONDS`
- `REDIS_WORKING_MEMORY_MAX_TTL_SECONDS`
- `REDIS_RUNTIME_PREFIX`
- `REDIS_EMBEDDING_TTL_SECONDS`
- `REDIS_EMBEDDING_SHORT_TTL_SECONDS`
- `REDIS_EMBEDDING_MEMORY_TTL_SECONDS`
- `REDIS_RETRIEVAL_MIN_TTL_SECONDS`
- `REDIS_RETRIEVAL_MAX_TTL_SECONDS`
- `REDIS_RECENT_TURNS_TTL_SECONDS`
- `REDIS_SESSION_STATE_TTL_SECONDS`
- `REDIS_MEMORY_USAGE_TTL_SECONDS`
- `CHAT_RATE_LIMIT_MAX_REQUESTS`
- `CHAT_RATE_LIMIT_WINDOW_SECONDS`
- `QDRANT_URL`
- `QDRANT_API_KEY`
- `QDRANT_COLLECTION`
- `QDRANT_DISTANCE`
- `NEO4J_URI`
- `NEO4J_USERNAME`
- `NEO4J_PASSWORD`
- `NEO4J_DATABASE`
- `API_PORT`
- `NEXT_PUBLIC_API_BASE_URL`
- `RETRIEVAL_TOP_K`
- `RETRIEVAL_VECTOR_WEIGHT`
- `RETRIEVAL_LEXICAL_WEIGHT`
- `RETRIEVAL_IMPORTANCE_WEIGHT`
- `RETRIEVAL_RECENCY_WEIGHT`
- `RETRIEVAL_RECENCY_HALF_LIFE_HOURS`
- `RETRIEVAL_DEDUP_THRESHOLD`
- `MEMORY_SUMMARY_EVERY_N_TURNS`

## Notes

This scaffold now supports cloud-backed memory storage:

- MongoDB stores raw events and bootstraps indexes automatically
- Postgres stores factual memories and bootstraps its table automatically
- Qdrant stores vector memories and creates its collection on the first embedded write
- Redis stores working memory, recent turns, runtime session state, cache entries, rate limits, and memory jobs
- Neo4j stores relationship data between sessions, raw events, memories, and tags

If those variables are omitted, the API still falls back to the in-memory adapters for local development.

You can use either:

- hosted OpenAI by setting `OPENAI_API_KEY`
- LM Studio or another OpenAI-compatible local server by setting `OPENAI_BASE_URL`

Example LM Studio configuration:

```env
OPENAI_API_KEY=lm-studio
OPENAI_BASE_URL=http://127.0.0.1:1234/v1
OPENAI_MODEL=your-chat-model-name
OPENAI_EMBEDDING_MODEL=your-embedding-model-name
API_PORT=4000
NEXT_PUBLIC_API_BASE_URL=http://localhost:4000
```

Example cloud memory configuration:

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
RETRIEVAL_TOP_K=8
RETRIEVAL_VECTOR_WEIGHT=0.5
RETRIEVAL_LEXICAL_WEIGHT=0.2
RETRIEVAL_IMPORTANCE_WEIGHT=0.2
RETRIEVAL_RECENCY_WEIGHT=0.1
RETRIEVAL_RECENCY_HALF_LIFE_HOURS=72
RETRIEVAL_DEDUP_THRESHOLD=0.92
MEMORY_SUMMARY_EVERY_N_TURNS=20
```

## Local Development

Use Node `22.x` for this repository.

This project can fail under Node `25.x` with a Next.js dev-runtime error that looks like:

`localStorage.getItem is not a function`

Recommended startup:

```bash
nvm use
npm run dev:api
```

In another terminal:

```bash
nvm use
npm run worker:memory
```

In another terminal:

```bash
nvm use
npm run dev:web
```

The Redis runtime dashboard is available at `/redis`.

## Storage Health Check

Once the API is running, you can verify the cloud adapters with:

```bash
curl http://localhost:4000/health/storage
```

Response states:

- `ok`: every configured cloud store is reachable
- `degraded`: at least one configured cloud store failed
- `local-fallback`: no cloud DB env vars are set, so the API is using in-memory storage
