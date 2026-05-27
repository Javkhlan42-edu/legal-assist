# Data Layer and Ingestion Runbook

## 1) Production Architecture

The ingestion stack is now pgvector-first with automatic Chroma fallback.

- Primary vector store: PostgreSQL `chunks.embedding` (`vector(3072)`) + HNSW index
- Fallback vector store: Chroma collection (`mn_legal_rag`)
- Keyword retrieval: PostgreSQL full-text search (`tsvector` + trigram)
- Fusion: RRF in API retrieval flow
- Worker reliability: retries with exponential backoff, dead-letter JSONL output, configurable fail-fast

## 2) Core Schema

Migration files:

- `apps/api/migrations/001_create_documents_table.sql`
- `apps/api/migrations/002_create_chunks_table.sql`
- `apps/api/migrations/003_create_conversations_table.sql`
- `apps/api/migrations/004_pgvector_hybrid_storage.sql`

Highlights in migration `004`:

- Enables `pgcrypto`, `vector`, `pg_trgm`
- Adds `documents.source_type`, `documents.crawl_status`, `documents.crawl_error`
- Adds `chunks.token_count`, `chunks.char_start`, `chunks.char_end`, `chunks.content_hash`
- Adds `chunks.embedding`, `chunks.embedding_model`, `chunks.embedding_dimensions`, `chunks.vector_provider`
- Adds HNSW index: `chunks_embedding_hnsw_idx`
- Adds observability tables: `crawl_logs`, `dead_letter_queue`

## 3) Provider Abstraction

Worker vector abstraction is implemented in:

- `apps/worker/src/lib/vector-db.ts`

Contracts:

- `initialize()`
- `upsertDocument(doc, embeddedChunks)`
- `similaritySearch(queryEmbedding, topK, filters)`
- `close()`

Providers:

- `PgVectorProvider` (primary)
- `ChromaVectorProvider` (fallback/dev)
- `HybridVectorProvider` (automatic fallback on failure)

## 4) Ingestion Reliability Controls

Pipeline orchestration:

- `apps/worker/src/services/pipeline.service.ts`

Reliability behavior:

- Stage-level retries for fetch/embed/upsert with exponential backoff + jitter
- Strict validation gates:
  - Minimum HTML length
  - Minimum parsed text length
  - Required `title` and `externalId`
  - Non-empty chunk result
  - Embedding count must match chunk count
- Duplicate chunk filtering by `contentHash`
- Dead-letter file output per source:
  - `data/processed/dead-letter/shuukh.jsonl`
  - `data/processed/dead-letter/legalinfo.jsonl`
- Fail-fast triggers:
  - Consecutive failures over threshold
  - Error rate over threshold after warmup window

## 5) Hierarchical Chunking Contract

Legalinfo ingestion now uses a law-aware hierarchical chunker instead of plain token windows:

- Article detection: finds `N дугаар/дүгээр зүйл` headings
- Preamble extraction: keeps text before the first article as a separate legal context chunk
- Chapter pre-compute: maps `БҮЛЭГ`, `ДЭД БҮЛЭГ`, and `ХЭСЭГ` headings to later chunks
- Smart split: splits long articles into clause/subclause chunks when useful
- Subsection extract: supports `1.2.3`, local numbered, and alpha labels
- Merge small: merges tiny pieces under 200 characters with adjacent compatible pieces
- Split oversized: splits over ~600 characters on sentence boundaries with overlap to stay inside embedding token limits
- Overlap + dedup: 120-character overlap plus prefix hash deduplication

Metadata stored per chunk:

- `law`, `article`, `articleNo`, `articleTitle`, `chapter`, `subsection`, `headingPath`
- `chunkType`, `references`, `amendments`, `sourceUrl`, `charCount`, `wordCount`, `keywords`

Implementation:

- `apps/worker/src/services/chunking.service.ts`

## 6) Embedding Contract

Embedding service is hardened with retries and environment-driven controls. The current production default is OpenAI `text-embedding-3-small`, padded to the existing pgvector `3072` dimension so old `shuukh` vectors remain compatible. Local E5-style models are supported via query/passage prefixes, but should be used only after a full re-embed of all sources into one compatible vector space.

- `apps/worker/src/services/embedding.service.ts`

Controls:

- `EMBEDDING_BATCH_SIZE`
- `EMBEDDING_MAX_RETRIES`
- `EMBEDDING_RETRY_BASE_MS`
- `EMBEDDING_DIMENSION`
- `EMBEDDING_PROVIDER` (`openai` or `local`)
- `OPENAI_EMBEDDING_MODEL`
- `LOCAL_EMBEDDING_MODEL`

## 7) Environment Settings

Worker/API defaults are aligned for pgvector-first behavior:

- `VECTOR_DB_PROVIDER=pgvector`
- `VECTOR_DB_FALLBACK=true`
- `DATABASE_URL=postgresql://postgres:postgres@localhost:5433/legal_chatbot`
- `CHROMA_URL=http://localhost:8000`
- `CHROMA_COLLECTION=mn_legal_rag`

Additional worker reliability settings:

- `PIPELINE_FAIL_FAST=true`
- `PIPELINE_MAX_ERROR_RATE=0.30`
- `PIPELINE_MAX_CONSECUTIVE_FAILURES=5`
- `PIPELINE_MAX_RETRIES_PER_DOC=3`
- `PIPELINE_RETRY_BASE_MS=750`
- `PIPELINE_MIN_HTML_LENGTH=120`
- `PIPELINE_MIN_TEXT_LENGTH=120`
- `PIPELINE_DEAD_LETTER_DIR=data/processed/dead-letter`

## 8) Execution Runbook

### 8.1 Start dependencies

```bash
docker compose -f docker/docker-compose.yml up -d
```

### 8.2 Apply migrations

```bash
psql -h localhost -U postgres -d legal_chatbot -f apps/api/migrations/001_create_documents_table.sql
psql -h localhost -U postgres -d legal_chatbot -f apps/api/migrations/002_create_chunks_table.sql
psql -h localhost -U postgres -d legal_chatbot -f apps/api/migrations/003_create_conversations_table.sql
psql -h localhost -U postgres -d legal_chatbot -f apps/api/migrations/004_pgvector_hybrid_storage.sql
```

### 8.3 Run worker ingestion

```bash
pnpm --filter @legal-chatbot/worker ingest --all --limit 50
```

### 8.3.1 Clean rebuild legalinfo Mongolian laws only

This command discovers exactly `legalinfo.mn` category `27` active Mongolian-law listing pages 1-47, writes `data/seed/legalinfo_mn_law_urls.txt`, deletes only existing `legalinfo` rows, and re-ingests those URLs with hierarchical chunking and embeddings.

```bash
pnpm rebuild:legalinfo:mn-law
```

Safety switches:

- `LEGALINFO_REBUILD_DISCOVER_ONLY=true` discovers and writes the seed file without deleting or ingesting
- `LEGALINFO_REBUILD_SKIP_DELETE=true` ingests without deleting old `legalinfo` rows
- `LEGALINFO_MN_LAW_LIMIT=100` limits the number of discovered URLs for a test run

### 8.4 Run API

```bash
pnpm --filter @legal-chatbot/api dev
```

## 9) Validation Checklist

- `chunks.embedding` populated for new ingested rows
- `chunks_embedding_hnsw_idx` exists
- keyword search still returns results from PostgreSQL
- retrieval returns results with `VECTOR_DB_PROVIDER=pgvector`
- dead-letter JSONL files remain empty in healthy runs

## 10) Test Coverage Added

Implemented tests:

- `apps/worker/tests/processing/chunker.test.ts`
- `apps/worker/tests/processing/normalizer.test.ts`
- `apps/worker/tests/jobs/ingest.test.ts`

Focus:

- Token chunking and overlap contract
- Unicode/cleanup normalization behavior
- Ingestion fail-fast and pipeline wiring behavior
