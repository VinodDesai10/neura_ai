# AiNeura MVP Architecture

## Goal

Build a demo-ready chat application that proves the AiNeura memory architecture with conversation-only memory.

## MVP Components

### 1. Input Handler

- receives chat messages from the Next.js app
- creates raw user events

### 2. Raw Data Vault

- append-only event store
- backed by MongoDB when configured
- no reasoning happens here

### 3. Background Memory Processor

- normalizes conversation events
- classifies memory into factual, episodic, or semantic
- creates metadata and summaries
- routes memories into specialized stores

Metadata is generated per memory candidate, not per raw event. Current metadata
uses a rule-based scoring engine with:

- dynamic importance based on signal strength, confidence, specificity,
  permanence, actionability, domain confidence, role, and memory type
- dynamic confidence based on role, specificity, uncertainty language, domain
  evidence, tags, factual phrasing, and question penalties
- inferred domain such as identity, memory_system, architecture, project,
  preference, planning, engineering, business, education, or personal
- supporting fields for domain confidence, alternate domains, tags, source
  segment, signal strength, specificity, permanence, actionability, sentiment,
  keywords, and detected entities

### 4. Long-Term Memory Stores

- MongoDB: raw events
- Postgres: factual memory
- Qdrant: episodic and semantic memory
- Neo4j: session, event, memory, and tag relationships

### 5. Memory Brain

- only gateway to long-term memory
- retrieves relevant facts, episodes, and semantic context
- returns ranked memory for runtime assembly

### 6. Working Memory

- Redis-backed active context per session
- holds only the current surfaced memory bundle

### 7. Conscious Layer

- reads only the working memory bundle and recent user message
- generates the response
- does not query databases directly

## Current Scaffold Status

Implemented now:

- Next.js demo chat UI
- Redis Context UI
- Node API skeleton
- cloud-backed MongoDB adapter for raw events
- cloud-backed Postgres adapter for factual memory
- cloud-backed Qdrant adapter for vector memory
- cloud-backed Redis adapter for working memory
- cloud-backed Neo4j adapter for relationship memory
- in-memory fallback adapters for local development
- fallback responder for local development without API keys
- Redis-backed background memory job queue
- dedicated memory worker process

## End-to-End Turn Flow

1. User sends a chat message.
2. API writes the event to the raw vault.
3. API records the turn in Redis recent context and queues a memory job.
4. Memory Brain retrieves relevant indexed memory.
5. Working memory is assembled.
6. Conscious layer produces the answer.
7. Assistant reply is written back as a raw event and queued.
8. The worker consumes queued jobs, extracts memory candidates, and routes them to factual or vector memory.
