// ────────────────────────────────────────────────────────────
// Ingest From Seed URLs — Process URLs from data/seed/*.txt
// ────────────────────────────────────────────────────────────

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { config } from 'dotenv';
import pino from 'pino';
import { ShuukhCrawler } from '../crawlers/shuukh.crawler.js';
import { LegalinfoCrawler } from '../crawlers/legalinfo.crawler.js';
import { chunkingService } from '../services/chunking.service.js';
import { embeddingService } from '../services/embedding.service.js';
import { upsertService } from '../services/upsert.service.js';
import { initPostgres, saveDocumentWithChunks, closePostgres } from '../lib/postgres.js';
import type { Document, ParsedDocument } from '@legal-chatbot/shared';
import { nowISO, sha256 } from '@legal-chatbot/shared';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: resolve(__dirname, '../../.env') });

const logger = pino({ name: 'ingest-from-seed' });

interface SeedCrawler {
  fetchPage(
    url: string,
  ): Promise<{ url: string; rawHtml: string; statusCode: number; fetchedAt: string }>;
  parse(result: {
    url: string;
    rawHtml: string;
    statusCode: number;
    fetchedAt: string;
  }): Promise<ParsedDocument>;
}

interface SeedIngestionStats {
  source: 'shuukh' | 'legalinfo';
  totalUrls: number;
  processed: number;
  failed: number;
  chunks: number;
  embedded: number;
  savedToDb: number;
}

interface SeedCliOptions {
  legalinfoSeedFile: string;
  shuukhSeedFile: string;
  legalinfoOnly: boolean;
  skipShuukh: boolean;
  limitPerSource: number;
}

function parseCliOptions(argv: string[] = process.argv.slice(2)): SeedCliOptions {
  const options: SeedCliOptions = {
    legalinfoSeedFile: 'legalinfo_urls.txt',
    shuukhSeedFile: 'shuukh_urls.txt',
    legalinfoOnly: false,
    skipShuukh: false,
    limitPerSource: 0,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--legalinfo-seed') {
      const value = argv[i + 1];
      if (value) {
        options.legalinfoSeedFile = value;
        i += 1;
      }
      continue;
    }

    if (arg === '--shuukh-seed') {
      const value = argv[i + 1];
      if (value) {
        options.shuukhSeedFile = value;
        i += 1;
      }
      continue;
    }

    if (arg === '--legalinfo-only') {
      options.legalinfoOnly = true;
      continue;
    }

    if (arg === '--skip-shuukh') {
      options.skipShuukh = true;
      continue;
    }

    if (arg === '--limit') {
      const raw = argv[i + 1];
      const parsed = raw ? Number.parseInt(raw, 10) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) {
        options.limitPerSource = parsed;
      }
      i += 1;
    }
  }

  return options;
}

function applySeedLimit(urls: string[], limitPerSource: number): string[] {
  if (!Number.isFinite(limitPerSource) || limitPerSource <= 0) {
    return urls;
  }

  return urls.slice(0, limitPerSource);
}

function createEmptyStats(source: 'shuukh' | 'legalinfo', totalUrls: number): SeedIngestionStats {
  return {
    source,
    totalUrls,
    processed: 0,
    failed: 0,
    chunks: 0,
    embedded: 0,
    savedToDb: 0,
  };
}

function deterministicUuid(input: string): string {
  const hex = sha256(input).slice(0, 32);
  const variantNibble = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variantNibble}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function readSeedUrls(seedDir: string, fileName: string): Promise<string[]> {
  const filePath = resolve(seedDir, fileName);
  const content = await readFile(filePath, 'utf-8');

  return Array.from(
    new Set(
      content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    ),
  );
}

function buildDocument(source: 'shuukh' | 'legalinfo', parsed: ParsedDocument): Document {
  const id = deterministicUuid(`${source}:${parsed.externalId}:${parsed.url}`);

  return {
    id,
    source,
    externalId: parsed.externalId,
    url: parsed.url,
    title: parsed.title,
    date: parsed.date,
    domain: parsed.domain,
    metadata: parsed.metadata,
    rawContentHash: sha256(parsed.cleanedText),
    crawledAt: nowISO(),
    updatedAt: nowISO(),
    status: parsed.cleanedText.length > 0 ? 'active' : 'error',
  };
}

async function processSeedSource(
  source: 'shuukh' | 'legalinfo',
  urls: string[],
  crawler: SeedCrawler,
): Promise<SeedIngestionStats> {
  const stats: SeedIngestionStats = {
    source,
    totalUrls: urls.length,
    processed: 0,
    failed: 0,
    chunks: 0,
    embedded: 0,
    savedToDb: 0,
  };

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];

    try {
      const fetched = await crawler.fetchPage(url);
      if (!fetched.rawHtml || fetched.statusCode < 200 || fetched.statusCode >= 300) {
        throw new Error(`Fetch failed with status ${fetched.statusCode}`);
      }

      const parsed = await crawler.parse(fetched);
      if (!parsed.cleanedText || parsed.cleanedText.length < 120) {
        throw new Error('Parsed text is empty or too short');
      }

      const doc = buildDocument(source, parsed);
      const chunkingResult = chunkingService.processDocument(doc.id, parsed.cleanedText, {
        source,
        sourceId: parsed.externalId,
        title: parsed.title,
        url: parsed.url,
        date: parsed.date,
        caseId: parsed.metadata.caseId,
        lawId: parsed.metadata.lawId,
        articleNo: parsed.metadata.articleNo,
      });

      const embeddedChunks = await embeddingService.embedChunks(chunkingResult.chunks);

      await upsertService.upsertDocument(doc, embeddedChunks);

      const dbDoc = {
        id: doc.id,
        source: doc.source as 'shuukh' | 'legalinfo' | 'other',
        source_id: doc.externalId,
        title: doc.title,
        url: doc.url,
        metadata: doc.metadata,
      };

      const dbChunks = embeddedChunks.map((embedded) => ({
        id: embedded.chunk.id,
        chunk_index: embedded.chunk.chunkIndex,
        text: embedded.chunk.text,
        metadata: embedded.chunk.metadata,
      }));

      const dbResult = await saveDocumentWithChunks(dbDoc, dbChunks);

      stats.processed++;
      stats.chunks += chunkingResult.totalChunks;
      stats.embedded += embeddedChunks.length;
      stats.savedToDb += dbResult.documentId ? 1 : 0;

      if ((i + 1) % 5 === 0) {
        logger.info(
          {
            source,
            processed: i + 1,
            total: urls.length,
            chunks: stats.chunks,
            embedded: stats.embedded,
          },
          'Seed ingestion progress',
        );
      }

      await new Promise((resolvePromise) => setTimeout(resolvePromise, 800));
    } catch (err) {
      stats.failed++;
      logger.warn(
        {
          source,
          url,
          err: err instanceof Error ? err.message : String(err),
        },
        'Failed to ingest seed URL',
      );
    }
  }

  return stats;
}

async function ingestFromSeedUrls(): Promise<void> {
  const options = parseCliOptions();
  const seedDir = resolve(__dirname, '../../../..', 'data/seed');

  logger.info({ seedDir, options }, 'Starting seed URL ingestion');

  try {
    await initPostgres();
  } catch {
    logger.warn('PostgreSQL initialization failed, continuing with ChromaDB only');
  }

  try {
    const legalinfoUrls = applySeedLimit(
      await readSeedUrls(seedDir, options.legalinfoSeedFile),
      options.limitPerSource,
    );

    const shouldReadShuukh = !options.legalinfoOnly && !options.skipShuukh;
    const shuukhUrls = shouldReadShuukh
      ? applySeedLimit(await readSeedUrls(seedDir, options.shuukhSeedFile), options.limitPerSource)
      : [];

    logger.info(
      {
        legalinfo: legalinfoUrls.length,
        shuukh: shuukhUrls.length,
        legalinfoSeedFile: options.legalinfoSeedFile,
        shuukhSeedFile: options.shuukhSeedFile,
      },
      'Loaded seed URL lists',
    );

    const legalinfoCrawler = new LegalinfoCrawler();
    const shuukhCrawler = new ShuukhCrawler();

    const legalinfoStats =
      legalinfoUrls.length > 0
        ? await processSeedSource('legalinfo', legalinfoUrls, legalinfoCrawler)
        : createEmptyStats('legalinfo', 0);

    const shuukhStats =
      shuukhUrls.length > 0
        ? await processSeedSource('shuukh', shuukhUrls, shuukhCrawler)
        : createEmptyStats('shuukh', 0);

    const totalDocs = legalinfoStats.processed + shuukhStats.processed;
    const totalFailed = legalinfoStats.failed + shuukhStats.failed;
    const totalChunks = legalinfoStats.chunks + shuukhStats.chunks;

    logger.info(
      {
        totalDocs,
        totalFailed,
        totalChunks,
        legalinfo: legalinfoStats,
        shuukh: shuukhStats,
      },
      'Seed URL ingestion completed',
    );

    console.log('\n✅ Seed ingestion summary:');
    console.log(`  Processed documents: ${totalDocs}`);
    console.log(`  Failed documents: ${totalFailed}`);
    console.log(`  Total chunks: ${totalChunks}`);
  } finally {
    await closePostgres();
  }
}

ingestFromSeedUrls().catch((err) => {
  logger.error(
    { err: err instanceof Error ? err.message : String(err) },
    'Unhandled seed ingestion error',
  );
  process.exit(1);
});
