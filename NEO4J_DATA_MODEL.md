# Neo4j Full Data Model - Complete Implementation

## Overview
The improved Neo4j implementation creates a **rich knowledge graph** of memories with metadata nodes and semantic relationships, enabling powerful querying and memory discovery.

## Data Model Architecture

### Node Types

#### 1. **Core Nodes**
- **Session**: User session container
- **RawEvent**: Original user/assistant message
- **Memory**: Processed memory (factual/episodic/semantic)
- **Tag**: User-defined categories

#### 2. **Metadata Nodes** (NEW)
- **Domain**: Semantic domain (identity, engineering, project, personal, etc.)
- **Keyword**: Content keywords extracted from memories
- **Entity**: Named entities - people, emails, URLs, dates
- **MemoryType**: Memory classification (factual/episodic/semantic)
- **ImportanceLevel**: Categorical importance (critical/high/medium/low)
- **Sentiment**: Sentiment classification (positive/neutral/negative)

### Relationship Types

#### Core Relationships
```
Session -[HAS_EVENT]-> RawEvent
RawEvent -[PRODUCED_MEMORY]-> Memory
Session -[HAS_MEMORY]-> Memory
Memory -[TAGGED_WITH]-> Tag
```

#### Metadata Relationships (NEW)
```
Memory -[ABOUT]-> Domain
Memory -[IS_TYPE]-> MemoryType
Memory -[HAS_IMPORTANCE]-> ImportanceLevel
Memory -[HAS_SENTIMENT]-> Sentiment
Memory -[HAS_KEYWORD]-> Keyword  [position: int]
Memory -[MENTIONS]-> Entity
Memory -[COULD_BE_ABOUT]-> Domain  [confidence: float]
```

#### Semantic Discovery Relationships
```
Memory -[SIMILAR_TO]-> Memory  [reason: "shared_keywords|shared_domain|shared_tags", score: float]
Keyword -[RELATED_TO]-> Keyword  [co-occurrence: int]
```

## What's Stored on Each Memory Node

```javascript
Memory {
  // Identity
  id: "uuid",
  type: "factual|episodic|semantic",  // IS_TYPE relationship

  // Content
  summary: "short version of content",
  content: "full memory text",
  fingerprint: "normalized tokens",

  // Scoring
  importance: 0.0-1.0,           // HAS_IMPORTANCE level
  confidence: 0.0-1.0,
  domainConfidence: 0.0-1.0,

  // Detailed metrics
  specificityScore: 0.0-1.0,
  permanenceScore: 0.0-1.0,
  actionabilityScore: 0.0-1.0,
  signalStrength: 0.0-1.0,

  // Context
  domain: "string",              // ABOUT relationship
  sentiment: "positive|neutral|negative",  // HAS_SENTIMENT
  role: "user|assistant",

  // Timestamps
  updatedAt: "ISO8601"
}
```

## Automatic Metadata Extraction

When a memory is stored:

1. **Domain Classification**: Automatically linked to Domain node
   - identity, engineering, memory_system, architecture, project, preference, planning, business, education, personal

2. **Keyword Extraction**: Top 8 keywords extracted and linked with position
   - Enables semantic search and keyword-based discovery

3. **Entity Recognition**: Named entities extracted and linked by type
   - Types: email, url, date, version, name_or_title

4. **Importance Categorization**: Score mapped to levels
   - critical (0.75-1.0), high (0.5-0.75), medium (0.25-0.5), low (0-0.25)

5. **Sentiment Classification**: Positive/Neutral/Negative
   - Enables sentiment-based memory filtering

6. **Similarity Detection**: Automatic linking to similar memories
   - Based on shared keywords (≥2), shared domain, shared tags

## API Endpoints

### 1. Find Memories by Domain
```bash
GET /api/graph/memories/by-domain?sessionId=xxx&domain=engineering&limit=10
```

**Response**:
```json
{
  "domain": "engineering",
  "memories": [
    {
      "id": "uuid",
      "summary": "...",
      "content": "...",
      "importance": 0.85,
      "confidence": 0.90
    }
  ],
  "count": 3
}
```

### 2. Find Memories by Keyword
```bash
GET /api/graph/memories/by-keyword?sessionId=xxx&keyword=database&limit=10
```

**Response**:
```json
{
  "keyword": "database",
  "memories": [...],
  "count": 5
}
```

### 3. Find Memories by Entity
```bash
GET /api/graph/memories/by-entity?sessionId=xxx&entity=postgres&limit=10
```

**Response**:
```json
{
  "entity": "postgres",
  "memories": [
    {
      "id": "uuid",
      "summary": "...",
      "importance": 0.78,
      "entityType": "name_or_title"  // Type of entity found
    }
  ],
  "count": 2
}
```

### 4. Find Similar Memories
```bash
GET /api/graph/memories/similar?memoryId=xxx&limit=5
```

**Response**:
```json
{
  "memoryId": "xxx",
  "similarMemories": [
    {
      "id": "similarity-uuid",
      "summary": "...",
      "importance": 0.82
    }
  ],
  "count": 3
}
```

### 5. Get Memory Graph Statistics
```bash
GET /api/graph/stats?sessionId=xxx
```

**Response**:
```json
{
  "sessionId": "xxx",
  "stats": {
    "totalMemories": 42,
    "domains": 5,
    "keywords": 127,
    "entities": 23
  }
}
```

## Performance Optimizations

### Indexes Created
- `memory_domain`: Fast domain-based queries
- `memory_importance`: Fast importance filtering
- `memory_confidence`: Fast confidence-based queries
- `memory_timestamp`: Fast timeline queries
- `session_updated`: Fast session lookups
- `keyword_frequency`: Fast popular keyword discovery

### Constraints
- Unique: session_id, event_id, memory_id, tag_name
- Unique: domain_name, keyword_text, entity_value, memory_type_name
- Unique: importance_level_name, sentiment_value

## Query Examples

### Find all memories about "engineering" from a session
```cypher
MATCH (s:Session {id: "session-123"})-[:HAS_MEMORY]->(m:Memory)-[:ABOUT]->(d:Domain {name: "engineering"})
RETURN m ORDER BY m.importance DESC
```

### Find memories mentioning specific entities
```cypher
MATCH (m:Memory)-[:MENTIONS]->(e:Entity {value: "postgres", type: "name_or_title"})
RETURN m, e
```

### Find semantic clusters (keywords that appear together)
```cypher
MATCH (m1:Memory)-[:HAS_KEYWORD]->(k:Keyword)<-[:HAS_KEYWORD]-(m2:Memory)
WHERE m1.id < m2.id
RETURN m1, m2, count(k) as sharedKeywords
ORDER BY sharedKeywords DESC
```

### Find high-confidence memories in a domain
```cypher
MATCH (m:Memory)-[:ABOUT]->(d:Domain {name: "identity"})-[:HAS_IMPORTANCE]->(il:ImportanceLevel {name: "critical"})
WHERE m.domainConfidence > 0.8
RETURN m ORDER BY m.updatedAt DESC
```

## Memory Lifecycle Example

### Input Event
```json
{
  "sessionId": "user-123",
  "role": "user",
  "content": "My name is John and I prefer Python for backend engineering. I want to build an API with FastAPI."
}
```

### Extracted Memories
1. **Identity Memory** (Factual)
   - Content: "My name is John"
   - Domain: identity
   - Importance: 0.95 (critical)
   - Entities: [name_or_title: "John"]

2. **Preference Memory** (Factual)
   - Content: "I prefer Python for backend engineering"
   - Domain: preference, engineering
   - Importance: 0.82 (high)
   - Keywords: [python, backend, engineering, preference]
   - Entities: [name_or_title: "Python"]

3. **Project Memory** (Semantic)
   - Content: "I want to build an API with FastAPI"
   - Domain: project, engineering
   - Importance: 0.78 (high)
   - Keywords: [api, fastapi, build, backend]
   - Entities: [name_or_title: "FastAPI"]

### Neo4j Graph Result
```
Session(user-123)
  ├─ HAS_MEMORY → Memory(id-xxx) "My name is John"
  │  ├─ ABOUT → Domain(identity)
  │  ├─ IS_TYPE → MemoryType(factual)
  │  ├─ HAS_IMPORTANCE → ImportanceLevel(critical)
  │  ├─ MENTIONS → Entity(type: name_or_title, value: "John")
  │  └─ HAS_KEYWORD → Keyword(John)
  │
  ├─ HAS_MEMORY → Memory(id-yyy) "I prefer Python..."
  │  ├─ ABOUT → Domain(preference)
  │  ├─ ABOUT → Domain(engineering)
  │  ├─ IS_TYPE → MemoryType(factual)
  │  ├─ HAS_IMPORTANCE → ImportanceLevel(high)
  │  ├─ HAS_SENTIMENT → Sentiment(neutral)
  │  ├─ HAS_KEYWORD → Keyword(python) [pos: 0]
  │  ├─ HAS_KEYWORD → Keyword(backend) [pos: 1]
  │  ├─ HAS_KEYWORD → Keyword(engineering) [pos: 2]
  │  ├─ MENTIONS → Entity(type: name_or_title, value: "Python")
  │  └─ SIMILAR_TO → Memory(id-zzz) [reason: shared_keywords]
  │
  └─ HAS_MEMORY → Memory(id-zzz) "I want to build an API..."
     ├─ ABOUT → Domain(project)
     ├─ ABOUT → Domain(engineering)
     ├─ IS_TYPE → MemoryType(semantic)
     ├─ HAS_IMPORTANCE → ImportanceLevel(high)
     ├─ HAS_SENTIMENT → Sentiment(positive)
     ├─ HAS_KEYWORD → Keyword(api) [pos: 0]
     ├─ HAS_KEYWORD → Keyword(fastapi) [pos: 1]
     ├─ HAS_KEYWORD → Keyword(build) [pos: 2]
     └─ MENTIONS → Entity(type: name_or_title, value: "FastAPI")
```

## Usage Scenarios

### 1. **Memory Discovery by Context**
User asks about engineering - query all "engineering" domain memories

### 2. **Entity-Based Recall**
User mentions "postgres" - find all memories mentioning postgres

### 3. **Semantic Clustering**
Find all memories related to a specific memory by keywords

### 4. **Importance Filtering**
Only show critical/high importance memories in responses

### 5. **Timeline Analysis**
Track how sentiment and topics evolve over time

### 6. **Knowledge Graph Visualization**
Visualize connections between memories, domains, entities, keywords

## Testing the Implementation

```bash
# 1. Start the API server
npm run dev:api

# 2. Send a message with rich content
curl -X POST http://localhost:4000/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "test-neo4j",
    "message": "I love working with React and Node.js. Ive built several projects using these technologies."
  }'

# 3. Query by domain
curl "http://localhost:4000/api/graph/memories/by-domain?sessionId=test-neo4j&domain=engineering"

# 4. Query by keyword
curl "http://localhost:4000/api/graph/memories/by-keyword?sessionId=test-neo4j&keyword=react"

# 5. Get stats
curl "http://localhost:4000/api/graph/stats?sessionId=test-neo4j"
```

## Benefits of This Model

✅ **Rich Semantic Search**: Find memories by domain, keyword, entity, or similarity
✅ **Knowledge Graph**: Visualize connections between memories and concepts
✅ **Automatic Categorization**: Metadata extracted automatically during storage
✅ **Performance**: Indexed queries for fast retrieval
✅ **Scalability**: Works well with 1K-100K+ memories per session
✅ **Discoverability**: Find related memories you didn't explicitly recall
✅ **Analytics**: Track patterns in domains, entities, sentiment
✅ **Future-Ready**: Foundation for advanced features (recommendations, anomaly detection, knowledge synthesis)
