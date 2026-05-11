// ────────────────────────────────────────────────────────────
// Ingest Seed Local Files — Process downloaded seed HTML files
// ────────────────────────────────────────────────────────────

import { readdir, readFile } from 'fs/promises';
import { resolve, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { config } from 'dotenv';
import pino from 'pino';
import { LegalinfoCrawler } from '../crawlers/legalinfo.crawler.js';
import { chunkingService } from '../services/chunking.service.js';
import { embeddingService } from '../services/embedding.service.js';
import { upsertService } from '../services/upsert.service.js';
import { initPostgres, saveDocumentWithChunks, closePostgres } from '../lib/postgres.js';
import type { EmbeddedChunk } from '@legal-chatbot/shared';

// Load environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: resolve(__dirname, '../../.env') });

const logger = pino({ name: 'ingest-seed-local' });

async function ingestSeedLocal() {
  const dataDir = resolve(__dirname, '../../../..', 'data/raw');

  logger.info({ dataDir }, 'Starting seed local file ingestion (legalinfo only)');

  // Initialize PostgreSQL connection
  try {
    await initPostgres();
  } catch (err) {
    logger.warn('PostgreSQL initialization failed, continuing with ChromaDB only');
  }

  let totalDocuments = 0;
  let totalChunks = 0;
  let totalEmbedded = 0;
  let totalSavedToDB = 0;
  const batchItems: Array<{ docForDB: any; embeddedChunks: EmbeddedChunk[] }> = [];

  try {
    // Process Legalinfo seed files ONLY (prioritize high-quality legalinfo sources)
    const legalinfoDir = resolve(dataDir, 'legalinfo_seed');
    const legalinfoFiles = await readdir(legalinfoDir);
    const legalinfoHtmlFiles = legalinfoFiles.filter((f) => extname(f).toLowerCase() === '.html');

    logger.info({ count: legalinfoHtmlFiles.length }, 'Found Legalinfo seed HTML files');

    const legalinfoCrawler = new LegalinfoCrawler();
    for (const file of legalinfoHtmlFiles) {
      try {
        const filePath = resolve(legalinfoDir, file);
        const rawHtml = await readFile(filePath, 'utf-8');

        if (!rawHtml || rawHtml.length < 100) {
          logger.warn({ file }, 'Empty or too small HTML file');
          continue;
        }

        // Parse using crawler
        const crawlResult = {
          url: `file://${file}`,
          rawHtml,
          statusCode: 200,
          fetchedAt: new Date().toISOString(),
        };

        const parsed = await legalinfoCrawler.parse(crawlResult);

        if (!parsed || !parsed.cleanedText || parsed.cleanedText.length < 100) {
          logger.warn({ file }, 'Empty or unparseable content');
          continue;
        }

        // Extract law ID from filename (e.g., 102.html -> 102)
        const lawId = file.replace('.html', '');
        const legalinfoUrl = `https://legalinfo.mn/mn/detail?lawId=${lawId}`;

        // Create chunks
        const chunkingResult = await chunkingService.processDocument(
          `legalinfo_${lawId}`,
          parsed.cleanedText,
          {
            source: 'legalinfo',
            sourceId: lawId,
            title: parsed.title || `Хууль ${lawId}`,
            url: legalinfoUrl,
          },
        );

        logger.info({ file, chunks: chunkingResult.chunks.length }, 'Created chunks');

        // Embed chunks
        const embeddedChunks = await embeddingService.embedChunks(chunkingResult.chunks);
        logger.info({ file, embedded: embeddedChunks.length }, 'Embedded chunks');

        // Create Document object for database (plain object with snake_case fields)
        const docForDB = {
          id: `legalinfo_${lawId}`,
          source: 'legalinfo' as const,
          source_id: lawId,
          title: parsed.title || `Хууль ${lawId}`,
          url: legalinfoUrl,
          metadata: {
            sourceId: lawId,
            title: parsed.title || `Хууль ${lawId}`,
            url: legalinfoUrl,
          },
        };

        batchItems.push({ docForDB, embeddedChunks });
        totalDocuments++;
        totalChunks += chunkingResult.chunks.length;
        totalEmbedded += embeddedChunks.length;

        // Batch save every 10 documents
        if (batchItems.length >= 10) {
          for (const item of batchItems) {
            // Convert chunk field names from camelCase to snake_case
            const convertedChunks = item.embeddedChunks.map((ec) => ({
              id: ec.chunk.id,
              chunk_index: ec.chunk.chunkIndex,
              text: ec.chunk.text,
              metadata: ec.chunk.metadata,
            }));
            const savedCount = await saveDocumentWithChunks(item.docForDB, convertedChunks);
            totalSavedToDB += savedCount.documentId ? 1 : 0;
          }
          // Also upsert to Chroma
          const chromaBatchItems = batchItems.map((item) => ({
            doc: {
              id: item.docForDB.id,
              source: item.docForDB.source,
              title: item.docForDB.title,
              url: item.docForDB.url,
              crawledAt: new Date().toISOString(),
            } as any,
            embeddedChunks: item.embeddedChunks,
          }));
          await upsertService.upsertBatch(chromaBatchItems);
          logger.info({ saved: totalSavedToDB, totalChunks }, 'Batch saved to ChromaDB');
          batchItems.length = 0;
        }
      } catch (err) {
        logger.warn(
          { file, err: err instanceof Error ? err.message : String(err) },
          'Failed to process file',
        );
      }
    }

    // Save remaining batch
    if (batchItems.length > 0) {
      for (const item of batchItems) {
        // Convert chunk field names from camelCase to snake_case
        const convertedChunks = item.embeddedChunks.map((ec) => ({
          id: ec.chunk.id,
          chunk_index: ec.chunk.chunkIndex,
          text: ec.chunk.text,
          metadata: ec.chunk.metadata,
        }));
        const savedCount = await saveDocumentWithChunks(item.docForDB, convertedChunks);
        totalSavedToDB += savedCount.documentId ? 1 : 0;
      }
      // Also upsert to Chroma
      const chromaBatchItems = batchItems.map((item) => ({
        doc: {
          id: item.docForDB.id,
          source: item.docForDB.source,
          title: item.docForDB.title,
          url: item.docForDB.url,
          crawledAt: new Date().toISOString(),
        } as any,
        embeddedChunks: item.embeddedChunks,
      }));
      await upsertService.upsertBatch(chromaBatchItems);
      logger.info({ saved: totalSavedToDB, totalChunks }, 'Final batch saved to ChromaDB');
    }

    logger.info(
      {
        totalDocuments,
        totalChunks,
        totalEmbedded,
        totalSavedToDB,
      },
      'Seed local ingestion completed successfully',
    );
  } catch (err) {
    logger.error({ error: err }, 'Fatal error during ingestion');
    process.exit(1);
  } finally {
    await closePostgres();
  }
}

// Run ingestion
ingestSeedLocal().catch((err) => {
  logger.error({ error: err }, 'Unhandled error');
  process.exit(1);
});
