#!/usr/bin/env tsx
// ─────────────────────────────────────────────────────────
// 07_embed_and_index.ts — Main embedding + indexing pipeline
//
// Reads data/processed/chunks.jsonl, sanitises text,
// generates embeddings (OpenAI or local), and indexes
// into a persistent Chroma collection.
//
// Usage:
//   pnpm --filter @legal-chatbot/worker index:embed
// ─────────────────────────────────────────────────────────

import { config } from 'dotenv';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJsonl, type RawChunk } from '../lib/jsonl.js';
import { sanitizeText, buildSnippet } from '../lib/text_sanitize.js';
import { initChroma, existingIds, upsertBatch } from '../lib/chroma.js';
import { embedBatchOpenAI, type OpenAIEmbedConfig } from '../lib/embeddings/openai.js';
import { embedBatchLocal, type LocalEmbedConfig } from '../lib/embeddings/local.js';

// ── Resolve paths relative to this script ──
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from apps/worker/
config({ path: path.resolve(__dirname, '../../.env') });

// ── Configuration from env ──
const CHUNKS_PATH = path.resolve(__dirname, process.env.CHUNKS_PATH ?? '../../../../data/processed/chunks.jsonl');
// Support CHROMA_URL (http://...) for Docker/remote, or VECTOR_DB_DIR for embedded local
const CHROMA_URL = process.env.CHROMA_URL ?? '';
const VECTOR_DB_DIR = CHROMA_URL ? '' : path.resolve(__dirname, process.env.VECTOR_DB_DIR ?? '../../../../data/index/chroma');
const CHROMA_PATH = CHROMA_URL || VECTOR_DB_DIR;
const COLLECTION_NAME = process.env.COLLECTION_NAME ?? 'mn_legal_rag';
const EMBEDDING_PROVIDER = (process.env.EMBEDDING_PROVIDER ?? 'openai') as 'openai' | 'local';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'text-embedding-3-large';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const LOCAL_EMBEDDING_MODEL = process.env.LOCAL_EMBEDDING_MODEL ?? 'Xenova/all-MiniLM-L6-v2';
const MAX_CHARS = Number(process.env.MAX_CHARS_PER_CHUNK ?? '6000');
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? '32');
const RPM = Number(process.env.REQUESTS_PER_MINUTE ?? '60');

// ── Report ──
interface IndexReport {
  startedAt: string;
  finishedAt: string;
  timeMs: number;
  totalRead: number;
  totalValid: number;
  totalIndexed: number;
  totalSkipped: number;
  totalFailed: number;
  embeddingProvider: string;
  embeddingModel: string;
  collectionName: string;
  sampleMetadataKeys: string[];
}

// ── Embed dispatcher ──
async function embedTexts(texts: string[]): Promise<number[][]> {
  if (EMBEDDING_PROVIDER === 'openai') {
    if (!OPENAI_API_KEY || OPENAI_API_KEY === 'YOUR_KEY_HERE') {
      throw new Error('OPENAI_API_KEY is not set. Set it in .env or switch to EMBEDDING_PROVIDER=local');
    }
    const cfg: OpenAIEmbedConfig = {
      apiKey: OPENAI_API_KEY,
      model: EMBEDDING_MODEL,
      batchSize: BATCH_SIZE,
    };
    return embedBatchOpenAI(texts, cfg);
  }

  const cfg: LocalEmbedConfig = { model: LOCAL_EMBEDDING_MODEL };
  return embedBatchLocal(texts, cfg);
}

// ── Rate-limit helper ──
const minIntervalMs = Math.ceil(60_000 / RPM);
let lastRequestAt = 0;

async function rateLimitWait(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestAt;
  if (elapsed < minIntervalMs) {
    await new Promise((r) => setTimeout(r, minIntervalMs - elapsed));
  }
  lastRequestAt = Date.now();
}

// ── Build metadata record from a chunk ──
// Chroma Metadata accepts string | number | boolean per key.
// Arrays (e.g. keywords) are joined as comma-separated strings.
function buildMetadata(chunk: RawChunk, snippet: string): Record<string, string> {
  const meta: Record<string, string> = {
    source: chunk.source,
    url: chunk.url,
    title: chunk.title,
    snippet,
    docId: chunk.docId,
  };

  // Copy all optional string fields
  const optionalKeys = [
    'section', 'date', 'court', 'decisionType',
    'caseId', 'caseNumber', 'lawId', 'articleNo',
  ] as const;

  for (const key of optionalKeys) {
    const val = chunk[key];
    if (typeof val === 'string' && val.trim()) {
      meta[key] = val.trim();
    }
  }

  if (Array.isArray(chunk.keywords) && chunk.keywords.length > 0) {
    meta.keywords = chunk.keywords.join(', ');
  }

  return meta;
}

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════
async function main(): Promise<void> {
  const startedAt = new Date();
  console.log('═══════════════════════════════════════════════════════');
  console.log(' Embedding + Indexing Pipeline');
  console.log(`  Provider : ${EMBEDDING_PROVIDER}`);
  console.log(`  Model    : ${EMBEDDING_PROVIDER === 'openai' ? EMBEDDING_MODEL : LOCAL_EMBEDDING_MODEL}`);
  console.log(`  Chunks   : ${CHUNKS_PATH}`);
  console.log(`  Chroma   : ${CHROMA_PATH}`);
  console.log(`  Collection: ${COLLECTION_NAME}`);
  console.log(`  Batch    : ${BATCH_SIZE}  |  RPM limit: ${RPM}`);
  console.log('═══════════════════════════════════════════════════════\n');

  // ── Preflight checks ──
  if (!existsSync(CHUNKS_PATH)) {
    throw new Error(`chunks.jsonl not found at: ${CHUNKS_PATH}\nPaste your file there first.`);
  }

  // Ensure Chroma directory exists (skip for remote URL)
  if (VECTOR_DB_DIR) {
    mkdirSync(VECTOR_DB_DIR, { recursive: true });
  }

  // Quick scan: at least 3 valid records
  let preflightCount = 0;
  for await (const line of readJsonl(CHUNKS_PATH)) {
    if (line.chunk) preflightCount++;
    if (preflightCount >= 3) break;
  }
  if (preflightCount < 3) {
    throw new Error(`Preflight failed: only ${preflightCount} valid records found (need ≥ 3).`);
  }
  console.log('[preflight] ✓ File readable, ≥ 3 valid records.\n');

  // ── Init Chroma ──
  await initChroma({ chromaPath: CHROMA_PATH, collectionName: COLLECTION_NAME });

  // ── Counters ──
  let totalRead = 0;
  let totalValid = 0;
  let totalIndexed = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  let sampleMetaKeys: string[] = [];

  // ── Accumulate batches ──
  let batchIds: string[] = [];
  let batchTexts: string[] = [];
  let batchMetas: Record<string, string>[] = [];

  async function flushBatch(): Promise<void> {
    if (batchIds.length === 0) return;

    const ids = [...batchIds];
    const texts = [...batchTexts];
    const metas = [...batchMetas];
    batchIds = [];
    batchTexts = [];
    batchMetas = [];

    try {
      await rateLimitWait();
      const embeddings = await embedTexts(texts);
      await upsertBatch(ids, embeddings, texts, metas);
      totalIndexed += ids.length;
      process.stdout.write(`  ✓ indexed batch of ${ids.length} (total: ${totalIndexed})\n`);
    } catch (err) {
      totalFailed += ids.length;
      console.error(`  ✗ batch failed (${ids.length} items):`, err instanceof Error ? err.message : err);
    }
  }

  // ── Stream chunks ──
  console.log('[indexing] Processing chunks…\n');

  for await (const line of readJsonl(CHUNKS_PATH)) {
    totalRead++;

    if (line.error || !line.chunk) {
      totalFailed++;
      if (line.error) console.warn(`  ⚠ ${line.error}`);
      continue;
    }

    totalValid++;
    const chunk = line.chunk;

    // Skip already-indexed
    const existing = await existingIds([chunk.chunkId]);
    if (existing.has(chunk.chunkId)) {
      totalSkipped++;
      continue;
    }

    // Sanitise
    const cleanText = sanitizeText(chunk.text, MAX_CHARS);
    if (cleanText.length < 10) {
      totalFailed++;
      console.warn(`  ⚠ Chunk ${chunk.chunkId} too short after sanitisation, skipping.`);
      continue;
    }

    const snippet = chunk.snippet ?? buildSnippet(cleanText);
    const meta = buildMetadata(chunk, snippet);

    if (sampleMetaKeys.length === 0) {
      sampleMetaKeys = Object.keys(meta);
    }

    batchIds.push(chunk.chunkId);
    batchTexts.push(cleanText);
    batchMetas.push(meta);

    if (batchIds.length >= BATCH_SIZE) {
      await flushBatch();
    }
  }

  // Flush remaining
  await flushBatch();

  // ── Write report ──
  const finishedAt = new Date();
  const report: IndexReport = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    timeMs: finishedAt.getTime() - startedAt.getTime(),
    totalRead,
    totalValid,
    totalIndexed,
    totalSkipped,
    totalFailed,
    embeddingProvider: EMBEDDING_PROVIDER,
    embeddingModel: EMBEDDING_PROVIDER === 'openai' ? EMBEDDING_MODEL : LOCAL_EMBEDDING_MODEL,
    collectionName: COLLECTION_NAME,
    sampleMetadataKeys: sampleMetaKeys,
  };

  const reportDir = path.resolve(CHUNKS_PATH, '..');
  const reportPath = path.join(reportDir, 'index_report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(' DONE');
  console.log(`  Read     : ${totalRead}`);
  console.log(`  Valid    : ${totalValid}`);
  console.log(`  Indexed  : ${totalIndexed}`);
  console.log(`  Skipped  : ${totalSkipped} (already in collection)`);
  console.log(`  Failed   : ${totalFailed}`);
  console.log(`  Time     : ${(report.timeMs / 1000).toFixed(1)}s`);
  console.log(`  Report   : ${reportPath}`);
  console.log('═══════════════════════════════════════════════════════');
}

main().catch((err) => {
  console.error('\n❌ Pipeline failed:', err);
  process.exit(1);
});
