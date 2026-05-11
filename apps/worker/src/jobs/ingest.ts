// ────────────────────────────────────────────────────────────
// Ingestion Job — Full pipeline orchestrator
// ────────────────────────────────────────────────────────────

import { pipelineService } from '../services/pipeline.service.js';
import { getWorkerEnv } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import { runMigrations } from '../lib/migrations.js';

const logger = createLogger('ingest');

interface IngestionOptions {
  sources: string[];
  limit: number;
  resume?: boolean;
}

/**
 * Run the full ingestion pipeline using the new pipeline service:
 * discover → fetch → parse → clean → chunk → embed → upsert
 */
export async function runIngestionJob(options: IngestionOptions): Promise<void> {
  const env = getWorkerEnv();

  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for ingestion pipeline execution');
  }

  await runMigrations({
    databaseUrl: env.DATABASE_URL,
    requireVectorIndex: env.VECTOR_DB_PROVIDER === 'pgvector',
  });

  const pipelineConfig = {
    maxDocuments: options.limit,
    resume: options.resume ?? true,
    chromaUrl: env.CHROMA_URL,
    databaseUrl: env.DATABASE_URL,
    skipStages: [],
    failFast: env.PIPELINE_FAIL_FAST,
    maxErrorRate: env.PIPELINE_MAX_ERROR_RATE,
    maxConsecutiveFailures: env.PIPELINE_MAX_CONSECUTIVE_FAILURES,
    maxRetriesPerDocument: env.PIPELINE_MAX_RETRIES_PER_DOC,
    retryBaseDelayMs: env.PIPELINE_RETRY_BASE_MS,
    minHtmlLength: env.PIPELINE_MIN_HTML_LENGTH,
    minTextLength: env.PIPELINE_MIN_TEXT_LENGTH,
    deadLetterDir: env.PIPELINE_DEAD_LETTER_DIR,
  };

  // Run pipeline for specified sources
  for (const source of options.sources) {
    if (source === 'shuukh' || source === 'legalinfo') {
      logger.info(
        { source, limit: options.limit, resume: options.resume ?? true },
        'Starting ingestion pipeline for source',
      );

      try {
        const stats = await pipelineService.runSourcePipeline(
          source as 'shuukh' | 'legalinfo',
          pipelineConfig,
        );

        // Log summary
        logger.info(
          {
            source: stats.source,
            discovered: stats.documentsDiscovered,
            fetched: stats.documentsFetched,
            parsed: stats.documentsParsed,
            chunks: stats.totalChunks,
            embedded: stats.chunksEmbedded,
            upserted: stats.chunksUpserted,
            errors: stats.errors.length,
            durationSeconds: (stats.durationMs / 1000).toFixed(2),
          },
          'Ingestion pipeline completed',
        );

        // Report errors if any
        if (stats.errors.length > 0) {
          logger.warn(
            {
              source: stats.source,
              errorCount: stats.errors.length,
              sampleErrors: stats.errors.slice(0, 3),
              deadLetteredDocuments: stats.deadLetteredDocuments,
            },
            'Pipeline completed with errors',
          );

          if (env.PIPELINE_FAIL_FAST) {
            throw new Error(
              `Fail-fast enabled and ${stats.errors.length} errors occurred while processing ${source}`,
            );
          }
        }
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err), source },
          'Ingestion pipeline failed',
        );
        throw err;
      }
    } else {
      logger.warn({ source }, 'Unknown source, skipping');
    }
  }
}
