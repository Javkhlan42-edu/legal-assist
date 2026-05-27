# Offline Pipeline Implementation — Complete Guide

## Overview

The **offline pipeline** processes raw HTML documents from legal websites into a searchable vector database. It runs as a background worker and consists of 6 sequential stages.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                 Offline Ingestion Pipeline                  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Stage 1: Discovery           → Find document URLs         │
│  Stage 2: Fetch               → Download HTML pages        │
│  Stage 3: Parse               → Extract structured data    │
│  Stage 4: Clean               → Remove HTML markup         │
│  Stage 5: Chunk               → Split into semantic chunks │
│  Stage 6: Embed               → Generate vector embeddings │
│  Stage 7: Upsert              → Store in ChromaDB          │
│                                                             │
│  Sources: shuukh.mn, legalinfo.mn                          │
│  Output: ChromaDB collection with 1.5k+ legal documents    │
│  Frequency: Daily (scheduled via cron)                     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Stage Details

### Stage 1: Discovery

**Component**: Crawler (`ShuukhCrawler`, `LegalinfoCrawler`)

Discovers document URLs from source websites using:

- Pagination through search/listing pages
- Extraction of document detail URLs
- Rate limiting (1 request/second)

**Shuukh Crawler**:

```typescript
const urls = await shuukhCrawler.discoverUrls(100);
// Returns: ["https://shuukh.mn/decisions/213350", ...]
```

**Legalinfo Crawler**:

```typescript
const urls = await legalinfoCrawler.discoverUrls(100);
// Returns: ["https://legalinfo.mn/document/123", ...]
```

### Stage 2: Fetch

**Component**: Crawler fetch methods

Downloads HTML content for each discovered URL with:

- HTTP timeout (15 seconds)
- Retry logic
- Rate limiting between requests
- Validation of response size

```typescript
const result = await crawler.fetchPage(url);
// Returns: { url, rawHtml, statusCode, fetchedAt }
```

**Error Handling**:

- Timeouts → skip document
- Empty responses → skip document
- Non-200 status → log and continue

### Stage 3: Parse

**Component**: Crawler parse methods

Extracts structured data from raw HTML:

**Shuukh (Court Decisions)**:

- Case ID (pattern: "Хэрэг № 213350")
- Court name (metadata field)
- Decision date (YYYY-MM-DD)
- Full decision text

**Legalinfo (Legal Acts)**:

- Law ID (pattern: "2002/134")
- Enactment date (YYYY-MM-DD)
- Article list ("1 дүгээр зүйл", "2 дугаар зүйл", ...)
- Full law text

```typescript
const parsed = await crawler.parse(crawlResult);
// Returns: {
//   source: 'shuukh' | 'legalinfo',
//   externalId: 'case_213350',
//   title: 'Шүүхийн шийдвэр...',
//   date: '2023-10-15',
//   domain: 'court_decision' | 'legal_act',
//   cleanedText: '...',
//   metadata: { caseId, courtName, ... }
// }
```

### Stage 4: Clean

**Component**: HTML Cleaner (`apps/worker/src/parsers/html-cleaner.ts`)

Removes noise from HTML:

- Remove `<script>` and `<style>` tags
- Remove navigation elements
- Preserve paragraph structure
- Handle Mongolian UTF-8 encoding

```typescript
const cleanText = htmlCleaner.cleanHtml(rawHtml);
// Output: Clean plain text with \n\n separators between paragraphs
```

### Stage 5: Chunk

**Component**: Chunking Service (`apps/worker/src/services/chunking.service.ts`)

Splits documents into overlapping chunks:

- Chunk size: ~4,096 characters (≈1,024 tokens)
- Overlap: ~512 characters (≈128 tokens)
- Paragraph-aware splitting for legal context
- Fallback to sliding window if needed

```typescript
const result = chunkingService.processDocument('doc_id', cleanedText, {
  source: 'shuukh',
  sourceId: '213350',
  title: '...',
  url: '...',
});
// Returns: {
//   documentId: 'doc_id',
//   chunks: [
//     {
//       id: 'doc_id_chunk_0',
//       chunkIndex: 0,
//       text: 'Шүүхийн шийдвэр...',
//       metadata: { source, sourceId, title, url, chunkStartChar, chunkEndChar }
//     },
//     ...
//   ],
//   totalChunks: 12,
//   totalCharacters: 49152,
//   averageChunkSize: 4096
// }
```

**Why Overlap?**

- Preserves context at chunk boundaries
- Improves retrieval quality
- Example:
  ```
  Chunk 1: [...end of paragraph A | overlap | start of paragraph B]
  Chunk 2: [...end of paragraph B | overlap | start of paragraph C]
  ```

### Stage 6: Embed

**Component**: Embedding Service (`apps/api/src/services/embedding.service.ts`)

Generates vector embeddings for each chunk:

- OpenAI `text-embedding-3-small` (primary, 1536-dim)
- Local fallback: `Xenova/all-MiniLM-L6-v2` (384-dim, no API cost)
- Batch processing (max 100 per batch)
- Automatic retry on rate limit

```typescript
const embeddedChunks = await embeddingService.embedChunks(chunks);
// Returns: [
//   {
//     id: 'chunk_id',
//     text: 'chunk text...',
//     vector: [0.123, -0.456, ...], // 1536 floats
//     metadata: { ... }
//   },
//   ...
// ]
```

### Stage 7: Upsert

**Component**: Upsert Service (`apps/api/src/services/upsert.service.ts`)

Stores vectors in ChromaDB collection:

- Idempotent operation (upsert = update if exists, insert if new)
- Cosine similarity metric
- Full metadata preservation
- Returns statistics

```typescript
const stats = await upsertService.upsertBatch(embeddedChunks);
// Returns: {
//   documentsProcessed: 100,
//   chunksUpserted: 1245,
//   vectorsUpserted: 1245,
//   errors: 3,
//   durationMs: 5420
// }
```

## Running the Pipeline

### 1. Manual Execution

```bash
# Ingest from all sources (max 100 documents each)
npm run --workspace=@legal-chatbot/worker -- ingest --all --limit 100

# Ingest from specific source
npm run --workspace=@legal-chatbot/worker -- ingest --source shuukh --limit 50
npm run --workspace=@legal-chatbot/worker -- ingest --source legalinfo --limit 50
```

### 2. Scheduled Execution

```bash
# Start cron scheduler (runs every 6 hours)
npm run --workspace=@legal-chatbot/worker -- schedule
```

Configured in `apps/worker/src/scheduler/cron.ts`:

```typescript
// Every day at 2 AM, 8 AM, 2 PM, 8 PM
scheduleJob('0 2,8,14,20 * * *', async () => {
  await runIngestionJob({ sources: ['shuukh', 'legalinfo'], limit: 100 });
});
```

### 3. Docker Compose

```bash
# Start worker in background
docker-compose -f docker/docker-compose.yml up worker -d

# View logs
docker-compose logs -f worker

# Run single pipeline execution
docker-compose exec worker npm run ingest -- --all --limit 50
```

## Configuration

### Environment Variables

```bash
# Crawling
CRAWL_DELAY_MS=1000                    # Delay between HTTP requests
CRAWL_MAX_CONCURRENT=5                 # Max parallel downloads
CRAWL_USER_AGENT="Legal Chatbot..."    # User agent for requests

# Embedding
EMBEDDING_PROVIDER=openai              # 'openai' or 'local'
OPENAI_API_KEY=sk-...                  # OpenAI API key
OPENAI_EMBEDDING_MODEL=text-embedding-3-small

# Vector DB
CHROMA_URL=http://localhost:8000       # ChromaDB endpoint
CHROMA_COLLECTION=legal_documents      # Collection name

# Database
DATABASE_URL=postgresql://...          # PostgreSQL for audit logs
```

## Pipeline Statistics

**Processing Speed**:

- Discovery: ~50 URLs/minute (with rate limiting)
- Fetch: ~30-50 documents/minute (1 req/sec)
- Parse: ~100-150 documents/minute
- Chunk: ~200-300 documents/minute
- Embed: ~10-20 chunks/second (depends on OpenAI API)
- Upsert: ~100-200 chunks/second

**Resource Usage**:

- Memory: 512 MB baseline + 100 MB per 100 documents
- CPU: Low (I/O bound)
- Network: ~50 KB/min per active crawler
- Storage (ChromaDB): ~1.5 KB per chunk (~2 MB per 100 documents)

**Cost Estimate** (for 10,000 documents):

- OpenAI embeddings: ~$0.15 USD (1,536-dim model)
- Storage: < $0.01 (local ChromaDB)
- Total: ~$0.20 for full ingestion

## Error Handling

### Graceful Degradation

```typescript
// Non-fatal errors don't stop pipeline
try {
  const result = await crawler.fetchPage(url);
  // ... process ...
} catch (err) {
  stats.errors.push({ stage: 'fetch', url, error: err.message });
  // Continue with next document
}
```

### Common Issues

**1. Rate Limited (429)**

```
Error: "OpenAI API rate limit exceeded"
Solution: Reduce CRAWL_DELAY_MS or wait 60 seconds, retry
```

**2. ChromaDB Connection Failed**

```
Error: "Failed to connect to chromadb"
Solution: Check CHROMA_URL is correct, verify Docker container is running
```

**3. Empty Documents**

```
Error: "Extracted text suspiciously short (23 bytes)"
Solution: Document may be dynamically loaded, try fetching with headless browser
```

**4. Unicode/Encoding Issues**

```
Error: "Invalid UTF-8 sequence"
Solution: Use iconv-lite for encoding detection, handle Mongolian Cyrillic
```

## Monitoring

### Log Files

```bash
# View ingestion logs
docker-compose logs worker | grep ingest

# Watch real-time pipeline
docker-compose logs -f worker --tail=50
```

### Metrics

Each pipeline run returns `PipelineStats`:

```typescript
{
  source: 'shuukh',
  startTime: Date,
  endTime: Date,
  durationMs: 12450,
  documentsDiscovered: 100,
  documentsFetched: 97,      // 3 failures
  documentsParsed: 95,       // 2 parse failures
  totalChunks: 1247,
  chunksEmbedded: 1247,
  chunksUpserted: 1245,      // 2 upsert failures
  errors: [
    { stage: 'fetch', url: '...', error: '...' },
    ...
  ]
}
```

### Key Metrics

- **Success Rate**: (totalChunks / documentsFetched) \* 100
- **Average Chunks/Document**: totalChunks / documentsParsed
- **Embedding Quality**: chunksEmbedded / totalChunks
- **Throughput**: documentsFetched / (durationMs / 1000)

## Testing

### Unit Tests

```bash
# Test chunking algorithm
npm test -- chunking.service.test.ts

# Test crawler discovery
npm test -- shuukh.crawler.test.ts

# Test embedding service
npm test -- embedding.service.test.ts
```

### Integration Test

```bash
# Run small pipeline test (10 documents max)
LIMIT=10 npm run test:integration

# Expected output:
# ✅ Discovery: 10 URLs found
# ✅ Fetch: 9/10 successful
# ✅ Parse: 9/9 successful
# ✅ Chunk: 87 chunks created
# ✅ Embed: 87/87 embedded
# ✅ Upsert: 87/87 upserted
```

## Troubleshooting

### Pipeline Hangs

**Check if crawler is rate-limited**:

```bash
tail -f docker-compose logs worker | grep "Fetching page"
# Should see new URL every 1 second
```

**Kill stuck worker**:

```bash
docker-compose kill worker
docker-compose up worker -d
```

### Embedding Quota Exceeded

```
OpenAI Error: "exceeded your current quota"
```

**Solution**:

1. Check OpenAI billing page (https://platform.openai.com/account/billing/overview)
2. Upgrade account or increase quota
3. Switch to local embeddings:
   ```bash
   EMBEDDING_PROVIDER=local npm run ingest -- --all
   ```

### ChromaDB Connection Issues

**Verify ChromaDB is running**:

```bash
curl http://localhost:8000/api/v1/version
# Should return: {"version":"0.4.0",...}
```

**Reset ChromaDB collection**:

```bash
docker-compose exec chroma rm -rf /data/chroma
docker-compose restart chroma
```

## Next Steps

1. ✅ Implement crawlers (DONE)
2. ✅ Implement chunking (DONE)
3. ✅ Implement full pipeline (DONE)
4. ⏳ Create test dataset (50+ Q&A pairs)
5. ⏳ Measure baseline (Vector-only retrieval)
6. ⏳ Evaluate Hybrid RAG (Vector + BM25)
7. ⏳ Document results in thesis

## References

- [Chunking Strategies for RAG](https://api.python.langchain.com/en/latest/text_splitter/langchain.text_splitter.RecursiveCharacterTextSplitter.html)
- [OpenAI Embeddings API](https://platform.openai.com/docs/guides/embeddings)
- [ChromaDB Documentation](https://docs.trychroma.com/)
- [Rate Limiting Best Practices](https://en.wikipedia.org/wiki/Rate_limiting)
