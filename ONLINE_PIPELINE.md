# Online Pipeline Implementation — Complete Guide

## Overview

The **online pipeline** is the query-time RAG implementation that handles:

1. **Retrieval**: Hybrid search combining vector embeddings + BM25 keyword search
2. **Reranking**: Re-scoring results by relevance signals
3. **Generation**: LLM answer generation with context
4. **Persistence**: Storing conversation history in PostgreSQL

## Architecture

```
User Query
    ↓
[Embedding Service] ← OpenAI/Local
    ↓
[Hybrid Search]
  ├─→ Vector Search (pgvector, Chroma fallback)
    ├─→ BM25 Search (PostgreSQL)
    └─→ RRF Fusion
    ↓
[Reranking Service]
    ↓
[Generation Service] ← OpenAI
    ↓
[Conversation Persistence] → PostgreSQL
    ↓
JSON Response
```

## Database Setup

### 1. Run Migrations

```bash
# Start PostgreSQL via Docker Compose
docker-compose -f docker/docker-compose.yml up postgres -d

# Wait for PostgreSQL to be ready (30 seconds)
sleep 30

# Apply migrations
psql -h localhost -U postgres -d legal_chatbot -f apps/api/migrations/001_create_documents_table.sql
psql -h localhost -U postgres -d legal_chatbot -f apps/api/migrations/002_create_chunks_table.sql
psql -h localhost -U postgres -d legal_chatbot -f apps/api/migrations/003_create_conversations_table.sql
psql -h localhost -U postgres -d legal_chatbot -f apps/api/migrations/004_pgvector_hybrid_storage.sql
```

### 2. Verify Schema

```bash
psql -h localhost -U postgres -d legal_chatbot -c "\dt"
```

Expected tables:

- `conversations` - Conversation metadata
- `messages` - Chat messages
- `documents` - Ingested legal documents
- `chunks` - Text chunks with full-text search + vector indices
- `audit_logs` - Query audit trail
- `crawl_logs` - Ingestion stage-level logs
- `dead_letter_queue` - Failed ingestion records for replay

### 3. Enable Full-Text Search

PostgreSQL FTS is enabled by default. Verify indices:

```bash
psql -h localhost -U postgres -d legal_chatbot -c "\di public.chunks*"
```

Expected indices:

- `chunks_ftsidx` - GIN index for `to_tsvector('simple', text)`
- `chunks_trgm_idx` - Trigram index for Mongolian text similarity
- `chunks_embedding_hnsw_idx` - HNSW vector index for pgvector cosine search

## Service Implementation

### BM25 Keyword Search

**File**: `apps/api/src/services/keyword-search.service.ts`

```typescript
// Search using PostgreSQL full-text search
const results = await keywordSearchService.search(
  'Хөлөслөмж оноож болох эсэх',
  10, // top K results
);

// Returns: KeywordSearchResult[]
// - chunkId: string
// - documentId: string
// - text: string
// - score: number (0-1, normalized)
// - metadata: Record<string, unknown>
```

**SQL Query Generated**:

```sql
SELECT
  c.id as "chunkId",
  c.document_id as "documentId",
  SUBSTRING(c.text, 1, 500) as text,
  ts_rank(to_tsvector('simple', c.text),
          plainto_tsquery('simple', $1::text)) as score,
  c.metadata
FROM chunks c
WHERE to_tsvector('simple', c.text) @@
      plainto_tsquery('simple', $1::text)
ORDER BY score DESC
LIMIT $2;
```

**Key Features**:

- `plainto_tsquery()`: Converts natural language to PostgreSQL query
- `ts_rank()`: Implements BM25-style scoring
- Graceful fallback: Returns empty results if DB unavailable
- Mongolian support: Uses trigram similarity as alternative

### Reciprocal Rank Fusion (RRF)

**File**: `apps/api/src/services/rrf.service.ts`

Combines vector and keyword results using RRF formula:

```typescript
RRF(d) = Σ(1 / (k + rank(d)));
```

Where:

- `k = 60` (constant, prevents rank 1 from dominating)
- `rank(d)` = position in each ranking
- Items in both rankings get combined score

**Example**:

```
Item A: Vector rank 1 (RRF=1/61), Keyword rank 2 (RRF=1/62) → Combined=0.0327
Item B: Vector rank 5 (RRF=1/65), Keyword absent → Score=0.0154
```

Result: Item A ranks higher due to appearing in both rankings.

### Reranking Service

**File**: `apps/api/src/services/reranker.service.ts`

Re-scores results by relevance signals:

```typescript
rawScore = baseScore;

// Keyword overlap: +0.02 per match, capped at 0.3
for (const keyword of keywords) {
  if (chunk.text.includes(keyword)) {
    rawScore += 0.02;
  }
}
rawScore = Math.min(rawScore + 0.3, 1.0);

// Position boost: items ranked high get +0.05
if (originalIndex < 3) {
  rawScore += 0.05;
}

// Source boost: legalinfo/shuukh get +0.05
if (chunk.metadata.source === 'legalinfo' || 'shuukh') {
  rawScore += 0.05;
}

// Final: clamp to [0, 1]
finalScore = Math.min(rawScore, 1.0);
```

### Conversation Persistence

**File**: `apps/api/src/repositories/conversation.repository.ts`

```typescript
// Create new conversation
const convId = randomUUID();
await conversationRepository.createConversation(convId, 'Трудовой кодекс асуулга');

// Add user message
await conversationRepository.addMessage(convId, 'user', 'Хөлөслөмж оноож болох уу?');

// Add assistant response with metadata
await conversationRepository.addMessage(convId, 'assistant', 'Монголын хууль үзэхэд...', {
  confidence: 0.85,
  sourcesUsed: 3,
  laws: 2,
  cases: 1,
  latencyMs: 1250,
});

// Retrieve conversation with full history
const { conversation, messages } = await conversationRepository.getConversation(convId);
```

## REST API Endpoints

### List Conversations

```bash
GET /v1/conversations?limit=50&offset=0

Response:
{
  "conversations": [
    {
      "id": "6f8c54e2-...",
      "title": "Трудовой кодекс",
      "createdAt": "2024-03-24T10:30:00Z",
      "updatedAt": "2024-03-24T11:45:00Z",
      "messageCount": 5
    }
  ],
  "total": 12,
  "limit": 50,
  "offset": 0
}
```

### Create Conversation

```bash
POST /v1/conversations
Content-Type: application/json

{
  "title": "Миний хууль асуулга"
}

Response:
{
  "id": "6f8c54e2-...",
  "title": "Миний хууль асуулга",
  "createdAt": "2024-03-24T10:30:00Z"
}
```

### Get Conversation Details

```bash
GET /v1/conversations/{id}

Response:
{
  "id": "6f8c54e2-...",
  "title": "Миний хууль асуулга",
  "createdAt": "2024-03-24T10:30:00Z",
  "updatedAt": "2024-03-24T11:45:00Z",
  "messages": [
    {
      "role": "user",
      "content": "Хөлөслөмж оноож болох уу?",
      "createdAt": "2024-03-24T10:31:00Z"
    },
    {
      "role": "assistant",
      "content": "Гүйцэтгэлийн хуулиар...",
      "createdAt": "2024-03-24T10:31:05Z"
    }
  ]
}
```

### Delete Conversation

```bash
DELETE /v1/conversations/{id}

Response: 204 No Content
```

### Chat with Persistence

```bash
POST /v1/chat
Content-Type: application/json

{
  "conversationId": "6f8c54e2-...",
  "message": "Энэ яаж ажилладаг вэ?",
  "history": [
    {"role": "user", "content": "Өмнөх асуулга..."},
    {"role": "assistant", "content": "Өмнөх хариулт..."}
  ]
}

Response:
{
  "answer": "Энэ нь...",
  "relatedLaws": [
    {
      "title": "Трудовой кодекс",
      "articleNo": "2.3.1",
      "url": "https://...",
      "score": 0.92
    }
  ],
  "relatedCases": [
    {
      "title": "Хэргийн гарчиг",
      "caseNumber": "2023/1234",
      "url": "https://...",
      "score": 0.87
    }
  ],
  "confidence": 0.85,
  "sourcesUsed": 3
}
```

## Configuration

### Environment Variables

```bash
# PostgreSQL
DATABASE_URL=postgresql://postgres:password@localhost:5432/legal_chatbot

# ChromaDB
CHROMA_URL=http://localhost:8000
CHROMA_COLLECTION=legal_documents

# OpenAI
OPENAI_API_KEY=sk-...
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_GENERATION_MODEL=gpt-4o-mini

# Embedding
EMBEDDING_PROVIDER=openai  # or 'local'
LOCAL_EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2

# API
PORT=3001
DATABASE_URL=postgresql://...
```

### Enable Hybrid Search

In `apps/api/src/services/retrieval.service.ts`:

```typescript
const ENABLE_HYBRID_SEARCH = true; // Enable BM25 + Vector fusion
```

## Testing the Pipeline

### 1. Start Services

```bash
# Start PostgreSQL and ChromaDB
docker-compose -f docker/docker-compose.yml up -d postgres chroma

# Start API server
cd apps/api
npm run dev
```

### 2. Create Test Conversation

```bash
curl -X POST http://localhost:3001/v1/conversations \
  -H "Content-Type: application/json" \
  -d '{"title": "Миний асуулга"}'
```

### 3. Send Chat Query

```bash
curl -X POST http://localhost:3001/v1/chat \
  -H "Content-Type: application/json" \
  -d '{
    "conversationId": "YOUR_CONV_ID",
    "message": "Хөлөслөмж оноож болох уу?",
    "history": []
  }'
```

### 4. Verify Message Persistence

```bash
psql -h localhost -U postgres -d legal_chatbot \
  -c "SELECT role, content, created_at FROM messages ORDER BY created_at DESC LIMIT 5;"
```

## Performance Metrics

Expected latencies:

- Vector search: 50-100ms (ChromaDB)
- BM25 search: 20-50ms (PostgreSQL FTS)
- RRF fusion: 5-10ms
- Reranking: 10-30ms
- LLM generation: 1-3 seconds
- **Total**: 1.2-3.5 seconds

## Troubleshooting

### PostgreSQL Connection Failed

```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

**Solution**:

```bash
# Check PostgreSQL is running
docker-compose ps postgres

# Wait for it to be ready
docker-compose logs postgres | tail -20

# Verify connection
psql -h localhost -U postgres -d legal_chatbot -c "SELECT 1"
```

### BM25 Search Returns Empty Results

**Check FTS index**:

```bash
psql -h localhost -U postgres -d legal_chatbot -c "
  SELECT c.id, c.text,
         ts_rank(to_tsvector('simple', c.text),
                 plainto_tsquery('simple', 'хөлөслөмж')) as score
  FROM chunks c
  WHERE to_tsvector('simple', c.text) @@ plainto_tsquery('simple', 'хөлөслөмж')
  LIMIT 5;
"
```

If no results:

1. Verify chunks table is populated: `SELECT COUNT(*) FROM chunks;`
2. Check full-text search indices: `\di chunks*`
3. Rebuild FTS index: `REINDEX INDEX chunks_ftsidx;`

### Conversation Messages Not Saved

**Check PostgreSQL connectivity**:

```typescript
// In chat.route.ts
if (conversationId && app.db) {
  // DB connection must be available
  // Check app.db is initialized in app.ts
}
```

**Verify tables exist**:

```bash
psql -h localhost -U postgres -d legal_chatbot -c "
  SELECT table_name FROM information_schema.tables
  WHERE table_schema='public' AND table_name IN ('conversations', 'messages');
"
```

## Next Steps

1. ✅ Database connection pool (DONE)
2. ✅ Conversation CRUD repository (DONE)
3. ✅ Conversation API routes (DONE)
4. ✅ Chat route integration (DONE)
5. ✅ BM25 implementation (DONE)
6. ⏳ SSE streaming implementation
7. ⏳ Test dataset creation (50+ Q&A pairs)
8. ⏳ Evaluation metrics (MRR, NDCG, F1)

## References

- [PostgreSQL Full-Text Search](https://www.postgresql.org/docs/current/textsearch.html)
- [ChromaDB Python Client](https://docs.trychroma.com/)
- [OpenAI Embeddings API](https://platform.openai.com/docs/guides/embeddings)
- [Reciprocal Rank Fusion](https://arxiv.org/abs/1809.05427)
