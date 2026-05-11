# Quick Start Guide — Dockerized pgvector-first System

This guide is aligned with the current production flow that was validated end-to-end:

- dockerized PostgreSQL + pgvector + Chroma + API + worker
- automatic migrations on startup (API and worker ingestion path)
- fail-fast ingestion
- vector verification command
- chat endpoint at /chat and /v1/chat with persisted conversation memory

## Prerequisites

- Node.js 20+
- pnpm 9+
- Docker Desktop (or Docker Engine + Compose)

Install workspace dependencies once:

```bash
pnpm install
```

## 1. Start Full Stack

```bash
docker compose -f docker/docker-compose.yml up -d --build
docker compose -f docker/docker-compose.yml ps
```

Expected status: postgres, chroma, api, and worker are all healthy.

## 2. Verify pgvector Readiness

Run the vector verification CLI from the repository root:

```bash
pnpm verify:vector
```

Expected checks:

- PostgreSQL reachable
- pgvector extension enabled
- HNSW index exists (chunks_embedding_hnsw_idx)
- similarity query succeeds

## 3. Ingest a Small Smoke Batch

Run ingestion in the worker container (uses production-like env from docker-compose):

```bash
docker exec legal-chatbot-worker sh -lc "pnpm exec tsx src/index.ts ingest --source legalinfo --limit 5"
```

Expected result: pipeline completes with errors: 0.

## 3.1 Ingest Priority Core Laws (Civil, Election, Traffic)

Refresh the priority legalinfo seed list, then ingest only those laws:

```bash
pnpm seed:priority:refresh
pnpm ingest:seed-priority
```

This updates:

- `data/seed/legalinfo_priority_urls.txt`
- `data/seed/legalinfo_urls.txt` (merged, deduplicated)

And ingests the priority legalinfo URLs to improve article-level answers for core domains.

## 4. Confirm Embeddings Persisted in pgvector

```bash
docker exec legal-chatbot-postgres psql -U postgres -d legal_chatbot -c "SELECT COUNT(*) AS chunks_total, COUNT(embedding) AS chunks_with_embedding FROM chunks;"
```

Expected: chunks_with_embedding should be greater than 0 after ingestion.

## 5. Chat Smoke Test

PowerShell example:

```powershell
$body = '{"message":"Даатгалын тухай хуулийн зорилго юу вэ?","history":[]}'
Invoke-RestMethod -Method Post -Uri http://localhost:3001/chat -ContentType 'application/json' -Body $body | ConvertTo-Json -Depth 8
```

Expected:

- HTTP 200
- answer returned
- sources and relatedLaws arrays returned
- conversationId returned

## 5.1 Run Chat Regression Suite (10-20 prompts)

```bash
pnpm test:chat-regression
```

Optional custom endpoint:

```bash
CHAT_API_URL=http://localhost:3001/v1/chat pnpm test:chat-regression
```

## 6. Conversation Memory Smoke Test

Send follow-up with the same conversationId and empty history:

```powershell
$body = '{"conversationId":"<conversation-id>","message":"Дэлгэрэнгүй тайлбарла.","history":[]}'
Invoke-RestMethod -Method Post -Uri http://localhost:3001/chat -ContentType 'application/json' -Body $body | ConvertTo-Json -Depth 8
```

Optional DB check:

```bash
docker exec legal-chatbot-postgres psql -U postgres -d legal_chatbot -c "SELECT role, COUNT(*) FROM messages WHERE conversation_id = '<conversation-id>' GROUP BY role ORDER BY role;"
```

Expected: user and assistant messages are persisted.

## 7. Behavior Without OpenAI Key

If OPENAI_API_KEY is empty, the API now returns a grounded Mongolian extractive fallback answer from retrieved context instead of failing the chat request.

To use full LLM generation, set OPENAI_API_KEY and restart API:

```bash
docker compose -f docker/docker-compose.yml up -d --build api
```

## Useful Commands

```bash
pnpm ingest:legalinfo
pnpm ingest:shuukh
pnpm verify:vector
docker compose -f docker/docker-compose.yml logs -f api worker
docker compose -f docker/docker-compose.yml down
```

### Check ChromaDB Health

```bash
curl http://localhost:8000/api/v1/heartbeat
# Should respond: 200 OK

curl http://localhost:8000/api/v1/collections
# Lists all collections with vector counts
```

## Troubleshooting

### PostgreSQL Connection Refused

```bash
# Check PostgreSQL is running
docker-compose ps postgres

# Wait for it to be healthy
docker-compose logs postgres | tail -20

# Restart if needed
docker-compose restart postgres
sleep 30
```

### ChromaDB Connection Failed

```bash
# Check ChromaDB is running
docker-compose ps chroma

# Restart if needed
docker-compose restart chroma
sleep 10
```

### OpenAI API Errors

```bash
# Check API key is valid
echo $OPENAI_API_KEY

# If "exceeded quota":
# 1. Go to https://platform.openai.com/account/billing
# 2. Check usage and add payment method
# 3. Or use local embeddings: EMBEDDING_PROVIDER=local
```

### Empty Conversation Responses

```bash
# Check documents actually ingested
psql -h localhost -U postgres -d legal_chatbot \
  -c "SELECT COUNT(*) FROM chunks; SELECT COUNT(*) FROM documents;"

# If count is 0:
# 1. Run ingest command again
# 2. Check crawler logs for errors
# 3. Verify source websites are accessible
```

## Advanced Usage

### Scheduled Pipeline (Runs every 6 hours)

```bash
npm run --workspace=@legal-chatbot/worker -- schedule

# Logs will show:
# [CRON] Scheduled: 0 2,8,14,20 * * * (2 AM, 8 AM, 2 PM, 8 PM)
# Waits for scheduled times to run pipeline automatically
```

### Skip Embedding (Use Local Model)

```bash
EMBEDDING_PROVIDER=local \
npm run --workspace=@legal-chatbot/worker -- ingest --all

# Uses Xenova/all-MiniLM-L6-v2 (384-dim, no API cost)
# Slower but free
```

### High-Volume Ingestion

```bash
# Ingest 500 documents in parallel
npm run --workspace=@legal-chatbot/worker -- ingest --all --limit 500

# Estimated time: 30-40 minutes
# Ingests from both shuukh.mn and legalinfo.mn
# Creates ~6,500 chunks
```

## System Architecture Verification

```bash
# View complete architecture
cat SYSTEM_STATUS.md

# View online pipeline details
cat ONLINE_PIPELINE.md

# View offline pipeline details
cat OFFLINE_PIPELINE.md
```

## Cleanup & Reset

### Remove Test Data

```bash
# Clear all conversations
psql -h localhost -U postgres -d legal_chatbot \
  -c "TRUNCATE TABLE conversations CASCADE;"

# Clear all chunks and documents
psql -h localhost -U postgres -d legal_chatbot << EOF
TRUNCATE TABLE chunks CASCADE;
TRUNCATE TABLE documents CASCADE;
DELETE FROM conversations;
EOF
```

### Restart Services

```bash
# Stop all services
docker-compose down

# Remove data (fresh start)
docker-compose down -v

# Restart
docker-compose up -d
```

## Success Criteria

✅ **System is working correctly when**:

1. PostgreSQL tables created (4 tables + triggers)
2. Offline pipeline ingests 50+ documents
3. ChromaDB contains 500+ vectors
4. Chat endpoint responds with related laws/cases
5. Conversation persists multiturns
6. Query latency is 1.2-3.5 seconds
7. No errors in logs

---

## Next Steps

1. **✅ Test both pipelines** (30 min - you are here)
2. ⏳ Create test dataset (4-6 hours)
   - 50+ Mongolian legal Q&A pairs
   - Based on ingested documents
3. ⏳ Run evaluation (2-3 hours)
   - Vector-only baseline
   - Hybrid RAG (Vector + BM25)
   - Measure MRR, NDCG, F1
4. ⏳ Document results in thesis

---

**Questions?** Check logs:

```bash
docker-compose logs -f worker
docker-compose logs -f postgres
npm run dev 2>&1 | grep -i error
```
