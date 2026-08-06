# Neo4j Full Data Model - Quick Start & Testing

## Installation

No new dependencies needed - uses existing neo4j-driver package.

## Configuration

Ensure Neo4j environment variables are set:
```bash
NEO4J_URI=bolt://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=password
NEO4J_DATABASE=neo4j
```

## Start Services

```bash
# Terminal 1: API
cd /Users/vinoddesai/iCloud\ Drive\ \(Archive\)/Desktop/neura_ai
npm run dev:api

# Terminal 2: Memory Worker
npm run worker:memory

# Terminal 3: Web UI (optional)
npm run dev:web
```

## Test Scenarios

### Test 1: Basic Domain Query

**Send a chat message**:
```bash
curl -X POST http://localhost:4000/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "test-engineering",
    "message": "I love building with React, Node.js, and TypeScript. These are my go-to technologies for full-stack development."
  }'
```

**Query by domain**:
```bash
curl "http://localhost:4000/api/graph/memories/by-domain?sessionId=test-engineering&domain=engineering&limit=10"
```

**Expected**: Returns the memory with importance ~0.85+ (engineering-related, specific, positive)

---

### Test 2: Keyword Discovery

**Query by keyword**:
```bash
curl "http://localhost:4000/api/graph/memories/by-keyword?sessionId=test-engineering&keyword=react&limit=10"
```

**Expected**: Returns the memory (React was one of top 8 keywords)

**Query another keyword**:
```bash
curl "http://localhost:4000/api/graph/memories/by-keyword?sessionId=test-engineering&keyword=fullstack&limit=10"
```

**Expected**: Empty or returns memory if "fullstack" is in keywords

---

### Test 3: Entity Recognition

**Query by entity**:
```bash
curl "http://localhost:4000/api/graph/memories/by-entity?sessionId=test-engineering&entity=React&limit=10"
```

**Expected**: Returns the memory (React recognized as entity)

**Try other entities**:
```bash
curl "http://localhost:4000/api/graph/memories/by-entity?sessionId=test-engineering&entity=TypeScript&limit=10"
```

---

### Test 4: Similarity Detection

**Send a related message**:
```bash
curl -X POST http://localhost:4000/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "test-engineering",
    "message": "My preferred tech stack is React on the frontend and Node.js on the backend."
  }'
```

**Wait 2-3 seconds, then find the first memory's ID from earlier query**

**Get similar memories**:
```bash
# Replace MEMORY_ID_1 with ID from first message
curl "http://localhost:4000/api/graph/memories/similar?memoryId=MEMORY_ID_1&limit=5"
```

**Expected**: Returns the second memory (shared keywords: react, node.js, backend, etc.)

---

### Test 5: Graph Statistics

**Get overview**:
```bash
curl "http://localhost:4000/api/graph/stats?sessionId=test-engineering"
```

**Expected response**:
```json
{
  "sessionId": "test-engineering",
  "stats": {
    "totalMemories": 2,
    "domains": 2,      // engineering, preference
    "keywords": 15+,   // react, node.js, typescript, fullstack, etc.
    "entities": 3+     // React, Node.js, TypeScript
  }
}
```

---

### Test 6: Domain Variety

**Send messages covering different domains**:

```bash
# Identity domain
curl -X POST http://localhost:4000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"test-multi","message":"My name is Alice and I am a software engineer."}'

# Project domain
curl -X POST http://localhost:4000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"test-multi","message":"I am building an AI assistant for my capstone project."}'

# Preference domain
curl -X POST http://localhost:4000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"test-multi","message":"I prefer working in the morning when I am most productive."}'

# Planning domain
curl -X POST http://localhost:4000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"test-multi","message":"Next steps: implement the Redis integration by tomorrow."}'
```

**Query each domain**:
```bash
curl "http://localhost:4000/api/graph/memories/by-domain?sessionId=test-multi&domain=identity"
curl "http://localhost:4000/api/graph/memories/by-domain?sessionId=test-multi&domain=project"
curl "http://localhost:4000/api/graph/memories/by-domain?sessionId=test-multi&domain=preference"
curl "http://localhost:4000/api/graph/memories/by-domain?sessionId=test-multi&domain=planning"
```

**Check stats**:
```bash
curl "http://localhost:4000/api/graph/stats?sessionId=test-multi"
```

**Expected**: 4 different domains, 4 memories, 30+ keywords, 8+ entities

---

### Test 7: Importance Filtering

**Query and check importance levels**:
```bash
curl "http://localhost:4000/api/graph/memories/by-domain?sessionId=test-multi&domain=identity"
```

**Check response**: Identity memories should have importance ~0.9 (very high for factual identity info)

---

## Debugging

### Check Neo4j Connection
```bash
curl http://localhost:4000/health/storage
```

Should show:
```json
{
  "neo4j": {
    "configured": true,
    "ok": true,
    "message": "reachable"
  }
}
```

### Query Neo4j Browser
Navigate to: `http://localhost:7474/`

**Check all nodes**:
```cypher
MATCH (n) RETURN n LIMIT 50
```

**Check memory relationships**:
```cypher
MATCH (m:Memory)-[r]->(n) RETURN m, r, n LIMIT 50
```

**Check domains**:
```cypher
MATCH (d:Domain) RETURN d, count(*)
```

**Check keywords**:
```cypher
MATCH (k:Keyword) RETURN k.text, k.frequency ORDER BY k.frequency DESC LIMIT 20
```

**Check entities**:
```cypher
MATCH (e:Entity) RETURN e.type, e.value, e.occurrences ORDER BY e.occurrences DESC LIMIT 20
```

---

## Expected Behavior

### Good Signs ✅
- ✅ Queries return memories quickly
- ✅ Domains are correctly classified
- ✅ Keywords match memory content
- ✅ Entities are properly extracted
- ✅ Similarity detection links related memories
- ✅ Importance scores are high for significant memories
- ✅ Stats show growing numbers as more memories are added

### Issues to Watch ⚠️
- ❌ Empty results from queries (check if memories have correct metadata)
- ❌ Slow queries (check indexes are created)
- ❌ Wrong domain classification (check domain rules in core/src/index.js)
- ❌ Missing keywords (check keyword extraction logic)
- ❌ No similarity links (check if 2+ shared keywords exist)

---

## Advanced Queries (Via Neo4j Browser)

### Find memories with high importance in engineering
```cypher
MATCH (m:Memory)-[:ABOUT]->(d:Domain {name: "engineering"})-[:HAS_IMPORTANCE]->(il:ImportanceLevel {name: "high"})
WHERE m.domainConfidence > 0.7
RETURN m.summary, m.importance, m.confidence
ORDER BY m.importance DESC
```

### Find semantic clusters (keywords appearing together)
```cypher
MATCH (m1:Memory)-[:HAS_KEYWORD]->(k:Keyword)<-[:HAS_KEYWORD]-(m2:Memory)
WHERE m1.id < m2.id
RETURN k.text, count(distinct m1) + count(distinct m2) as memoryCount
ORDER BY memoryCount DESC
LIMIT 10
```

### Find most mentioned entities
```cypher
MATCH (e:Entity)<-[:MENTIONS]-(m:Memory)
RETURN e.value, e.type, count(m) as mentionCount
ORDER BY mentionCount DESC
LIMIT 20
```

### Find entity co-occurrence (entities appearing in same memories)
```cypher
MATCH (e1:Entity)<-[:MENTIONS]-(m:Memory)-[:MENTIONS]->(e2:Entity)
WHERE e1.value < e2.value
RETURN e1.value, e2.value, count(m) as coOccurrences
ORDER BY coOccurrences DESC
LIMIT 15
```

### Find all memories related to a specific entity
```cypher
MATCH (e:Entity {value: "React"})<-[:MENTIONS]-(m:Memory)-[:SIMILAR_TO]-(similar:Memory)
RETURN m, similar
```

---

## Performance Monitoring

### Check query execution times
Neo4j Browser shows execution time for each query

### Monitor index usage
```cypher
CALL db.indexes() YIELD indexName, state, populationPercent
RETURN indexName, state, populationPercent
```

### Check constraint compliance
```cypher
CALL db.constraints() YIELD name, type
RETURN name, type
```

---

## Troubleshooting

### "Graph query failed" Error
1. Check if Neo4j is running: `docker ps | grep neo4j`
2. Check NEO4J_URI environment variable
3. Check Neo4j logs for connection issues

### No memories returned from queries
1. Verify memories were created: `MATCH (m:Memory) RETURN count(m)`
2. Check if memory relationships were linked: `MATCH (m:Memory)-[r]-(n) RETURN type(r), count(*)`
3. Verify memory has expected metadata nodes

### Similarity links not appearing
1. Check if memories have shared keywords:
   ```cypher
   MATCH (m1:Memory)-[:HAS_KEYWORD]->(k:Keyword)<-[:HAS_KEYWORD]-(m2:Memory)
   WHERE m1.id <> m2.id RETURN count(*)
   ```
2. Need at least 2 shared keywords for similarity link

### Slow queries
1. Check if indexes are created: `CALL db.indexes()`
2. Run index rebuild: `CALL db.indexes() YIELD indexName CALL db.index.fulltext.drop(indexName)`
3. Verify memory count: too many memories per session slows queries
