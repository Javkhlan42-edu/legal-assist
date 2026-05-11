// ────────────────────────────────────────────────────────────
// Ingest Local Files — Process HTML files from data/raw/
// ────────────────────────────────────────────────────────────

import { readdir, readFile } from 'fs/promises';
import { resolve, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { config } from 'dotenv';
import pino from 'pino';
import { ShuukhCrawler } from '../crawlers/shuukh.crawler.js';
import { LegalinfoCrawler } from '../crawlers/legalinfo.crawler.js';
import { chunkingService } from '../services/chunking.service.js';
import { embeddingService } from '../services/embedding.service.js';
import { upsertService } from '../services/upsert.service.js';
import { initPostgres, saveDocumentWithChunks, closePostgres } from '../lib/postgres.js';
import type { Document, EmbeddedChunk } from '@legal-chatbot/shared';

// Load environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: resolve(__dirname, '../../.env') });

const logger = pino({ name: 'ingest-local' });

async function ingestLocalFiles() {
  const dataDir = resolve(__dirname, '../../../..', 'data/raw');

  logger.info({ dataDir }, 'Starting local file ingestion');

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
  const batchItems: Array<{ doc: Document; embeddedChunks: EmbeddedChunk[] }> = [];

  try {
    // Process Shuukh files
    const shuukhDir = resolve(dataDir, 'shuukh');
    const shuukhFiles = await readdir(shuukhDir);
    const shuukhHtmlFiles = shuukhFiles.filter((f) => extname(f).toLowerCase() === '.html');

    logger.info({ count: shuukhHtmlFiles.length }, 'Found Shuukh HTML files');

    const shuukhCrawler = new ShuukhCrawler();
    for (const file of shuukhHtmlFiles.slice(0, 50)) {
      try {
        const filePath = resolve(shuukhDir, file);
        const rawHtml = await readFile(filePath, 'utf-8');

        if (!rawHtml || rawHtml.length < 100) {
          logger.warn({ file }, 'Empty or too small HTML file');
          continue;
        }

        // Parse using crawler's parse method with proper CrawlResult structure
        const crawlResult = {
          url: `file://${file}`,
          rawHtml,
          statusCode: 200,
          fetchedAt: new Date().toISOString(),
        };

        const parsed = await shuukhCrawler.parse(crawlResult);

        if (parsed && parsed.cleanedText && parsed.cleanedText.length > 100) {
          // Extract case ID from filename or metadata
          const caseIdMatch = file.match(/(\d+)/);
          const caseId = caseIdMatch ? caseIdMatch[1] : file.replace('.html', '');

          // Create chunks
          const shuukhUrl = `https://shuukh.mn/single_case/${caseId}`;
          const chunkingResult = await chunkingService.processDocument(
            `shuukh_${file}`,
            parsed.cleanedText,
            {
              source: 'shuukh',
              sourceId: caseId,
              title: parsed.title || `Шүүхийн шийдвэр ${caseId}`,
              url: shuukhUrl,
            },
          );

          logger.info({ file, chunks: chunkingResult.chunks.length }, 'Created chunks');

          // Embed chunks
          const embeddedChunks = await embeddingService.embedChunks(chunkingResult.chunks);
          logger.info({ file, embedded: embeddedChunks.length }, 'Embedded chunks');

          // Create Document object
          const doc: Document = {
            id: `shuukh_${file}`,
            source: 'shuukh',
            externalId: parsed.metadata?.caseId || caseId,
            url: `https://shuukh.mn/single_case/${caseId}`,
            title: parsed.title || `Case ${caseId}`,
            date: parsed.date || new Date().toISOString(),
            domain: 'other',
            metadata: {
              caseId: parsed.metadata?.caseId || caseId,
              court: parsed.metadata?.court,
            },
            rawContentHash: '',
            crawledAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            status: 'active',
          };

          batchItems.push({ doc, embeddedChunks });
          totalDocuments++;
          totalChunks += chunkingResult.chunks.length;
          totalEmbedded += embeddedChunks.length;
        }
      } catch (err) {
        logger.warn(
          { file, err: err instanceof Error ? err.message : String(err) },
          'Failed to process file',
        );
      }
    }

    // Process Legalinfo files
    const legalinfoDir = resolve(dataDir, 'legalinfo');
    const legalinfoFiles = await readdir(legalinfoDir);
    const legalinfoHtmlFiles = legalinfoFiles.filter((f) => extname(f).toLowerCase() === '.html');

    logger.info({ count: legalinfoHtmlFiles.length }, 'Found Legalinfo HTML files');

    const legalinfoCrawler = new LegalinfoCrawler();
    for (const file of legalinfoHtmlFiles.slice(0, 50)) {
      try {
        const filePath = resolve(legalinfoDir, file);
        const rawHtml = await readFile(filePath, 'utf-8');

        if (!rawHtml || rawHtml.length < 100) {
          logger.warn({ file }, 'Empty or too small HTML file');
          continue;
        }

        // Parse using crawler's parse method with proper CrawlResult structure
        const crawlResult = {
          url: `file://${file}`,
          rawHtml,
          statusCode: 200,
          fetchedAt: new Date().toISOString(),
        };

        const parsed = await legalinfoCrawler.parse(crawlResult);

        if (parsed && parsed.cleanedText && parsed.cleanedText.length > 100) {
          // Extract law ID from filename (e.g., 102.html -> 102)
          const lawId = file.replace('.html', '');
          const legalinfoUrl = `https://legalinfo.mn/mn/detail?lawId=${lawId}`;

          // Create chunks
          const chunkingResult = await chunkingService.processDocument(
            `legalinfo_${file}`,
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

          // Create Document object
          const doc: Document = {
            id: `legalinfo_${file}`,
            source: 'legalinfo',
            externalId: lawId,
            url: legalinfoUrl,
            title: parsed.title || `Law ${lawId}`,
            date: parsed.date || new Date().toISOString(),
            domain: 'other',
            metadata: {
              lawId: lawId,
            },
            rawContentHash: '',
            crawledAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            status: 'active',
          };

          batchItems.push({ doc, embeddedChunks });
          totalDocuments++;
          totalChunks += chunkingResult.chunks.length;
          totalEmbedded += embeddedChunks.length;
        }
      } catch (err) {
        logger.warn(
          { file, err: err instanceof Error ? err.message : String(err) },
          'Failed to process file',
        );
      }
    }

    // Batch upsert all documents
    if (batchItems.length > 0) {
      logger.info({ count: batchItems.length }, 'Upserting batch to ChromaDB and PostgreSQL');

      // Upsert to ChromaDB
      await upsertService.upsertBatch(batchItems);

      // Save to PostgreSQL
      for (const item of batchItems) {
        try {
          const chunks = item.embeddedChunks.map((ec, index) => ({
            id: ec.embedding.chunkId,
            chunk_index: index,
            text: ec.chunk.text,
            metadata: ec.chunk.metadata,
          }));

          await saveDocumentWithChunks(
            {
              id: item.doc.id,
              source: item.doc.source as 'shuukh' | 'legalinfo' | 'other',
              source_id: item.doc.externalId,
              title: item.doc.title,
              url: item.doc.url,
              metadata: item.doc.metadata,
            },
            chunks,
          );
          totalSavedToDB++;
        } catch (err) {
          logger.warn(
            { docId: item.doc.id, err: err instanceof Error ? err.message : String(err) },
            'Failed to save to PostgreSQL',
          );
        }
      }
    }

    logger.info(
      { totalDocuments, totalChunks, totalEmbedded, totalSavedToDB },
      'Local file ingestion completed',
    );

    console.log('\n✅ Ingestion Summary:');
    console.log(`  Documents processed: ${totalDocuments}`);
    console.log(`  Total chunks created: ${totalChunks}`);
    console.log(`  Chunks embedded and upserted: ${totalEmbedded}`);
    console.log(`  Documents saved to PostgreSQL: ${totalSavedToDB}`);
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'Local file ingestion failed',
    );
    await closePostgres();
    process.exit(1);
  }

  // Close PostgreSQL connection
  await closePostgres();
}

ingestLocalFiles().catch((err) => {
  logger.error(err, 'Unexpected error');
  process.exit(1);
});
