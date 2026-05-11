// ────────────────────────────────────────────────────────────
// Pipeline Service — Orchestrate offline ingestion pipeline
// ────────────────────────────────────────────────────────────

import type { Chunk as SharedChunk, Document, ParsedDocument } from '@legal-chatbot/shared';
import { nowISO, sha256 } from '@legal-chatbot/shared';
import { ShuukhCrawler } from '../crawlers/shuukh.crawler.js';
import { LegalinfoCrawler } from '../crawlers/legalinfo.crawler.js';
import { chunkingService } from './chunking.service.js';
import { embeddingService } from './embedding.service.js';
import { upsertService } from './upsert.service.js';
import { findWorkspaceRoot } from '../lib/workspace-path.js';
import { createLogger } from '../lib/logger.js';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const logger = createLogger('pipeline');

type IngestionSource = 'shuukh' | 'legalinfo';

interface StageRetryOptions {
  source: IngestionSource;
  url: string;
  stage: string;
  maxRetries: number;
  baseDelayMs: number;
}

class StageProcessingError extends Error {
  constructor(
    readonly stage: string,
    message: string,
    readonly retriable: boolean,
  ) {
    super(message);
    this.name = 'StageProcessingError';
  }
}

interface ProcessDocumentResult {
  fetched: number;
  parsed: number;
  chunks: number;
  embedded: number;
  upserted: number;
  duplicateChunksSkipped: number;
  skipped?: boolean;
  skipReason?: string;
}

export interface PipelineStats {
  source: string;
  startTime: Date;
  endTime: Date;
  durationMs: number;
  documentsDiscovered: number;
  documentsFetched: number;
  documentsParsed: number;
  documentsSkipped: number;
  documentsFailed: number;
  totalChunks: number;
  chunksEmbedded: number;
  chunksUpserted: number;
  duplicateChunksSkipped: number;
  deadLetteredDocuments: number;
  errors: Array<{ stage: string; url: string; error: string }>;
}

export interface PipelineConfig {
  maxDocuments?: number;
  maxConcurrency?: number;
  skipStages?: string[];
  databaseUrl?: string;
  chromaUrl?: string;
  resume?: boolean;
  checkpointDir?: string;
  persistRaw?: boolean;
  persistParsed?: boolean;
  failFast?: boolean;
  maxErrorRate?: number;
  maxConsecutiveFailures?: number;
  maxRetriesPerDocument?: number;
  retryBaseDelayMs?: number;
  minHtmlLength?: number;
  minTextLength?: number;
  deadLetterDir?: string;
}

interface SourceCheckpoint {
  source: IngestionSource;
  discoveredUrls: string[];
  completedUrls: string[];
  failedUrls: string[];
  lastRunAt?: string;
}

/**
 * Offline ingestion orchestrator with resumable, idempotent processing.
 * Coordinates: Discovery → Fetch → Parse → Chunk → Embed → Upsert.
 */
export class PipelineService {
  private readonly shuukhCrawler: ShuukhCrawler;
  private readonly legalinfoCrawler: LegalinfoCrawler;
  private readonly workspaceRoot: string;

  constructor() {
    this.workspaceRoot = findWorkspaceRoot();
    this.shuukhCrawler = new ShuukhCrawler();
    this.legalinfoCrawler = new LegalinfoCrawler();
  }

  private shouldRestrictLegalinfoToMongolianLaw(): boolean {
    const raw = process.env.CRAWL_LEGALINFO_ONLY_MONGOLIAN_LAW ?? 'true';
    return !/^(false|0|no)$/i.test(raw.trim());
  }

  private inferLegalinfoActType(parsed: ParsedDocument): string {
    const header = `${parsed.title}\n${parsed.cleanedText.slice(0, 1200)}`.toUpperCase();

    if (header.includes('МОНГОЛ УЛСЫН ХУУЛЬ')) {
      return 'mongolian_law';
    }
    if (header.includes('МОНГОЛ УЛСЫН ҮНДСЭН ХУУЛЬ')) {
      return 'constitution';
    }
    if (header.includes('МОНГОЛ УЛСЫН ИХ ХУРЛЫН ТОГТООЛ')) {
      return 'parliament_resolution';
    }
    if (header.includes('МОНГОЛ УЛСЫН ОЛОН УЛСЫН ГЭРЭЭ')) {
      return 'international_treaty';
    }
    if (header.includes('МОНГОЛ УЛСЫН ЕРӨНХИЙЛӨГЧИЙН ЗАРЛИГ')) {
      return 'presidential_decree';
    }
    if (header.includes('ЗАСГИЙН ГАЗРЫН ТОГТООЛ')) {
      return 'government_resolution';
    }
    if (header.includes('САЙДЫН ТУШААЛ')) {
      return 'ministerial_order';
    }
    if (header.includes('ҮНДСЭН ХУУЛИЙН ЦЭЦИЙН')) {
      return 'constitutional_court_decision';
    }
    if (header.includes('УЛСЫН ДЭЭД ШҮҮХИЙН')) {
      return 'supreme_court_resolution';
    }

    return 'unknown';
  }

  private deterministicUuid(input: string): string {
    const hex = sha256(input).slice(0, 32);
    const variantNibble = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);

    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variantNibble}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }

  private getCheckpointPath(source: IngestionSource, config: PipelineConfig): string {
    const checkpointDir = config.checkpointDir ?? 'data/processed/checkpoints';
    return resolve(this.workspaceRoot, checkpointDir, `${source}.state.json`);
  }

  private getDeadLetterPath(source: IngestionSource, config: PipelineConfig): string {
    const deadLetterDir = config.deadLetterDir ?? 'data/processed/dead-letter';
    return resolve(this.workspaceRoot, deadLetterDir, `${source}.jsonl`);
  }

  private async loadCheckpoint(
    source: IngestionSource,
    config: PipelineConfig,
  ): Promise<SourceCheckpoint> {
    const defaultState: SourceCheckpoint = {
      source,
      discoveredUrls: [],
      completedUrls: [],
      failedUrls: [],
    };

    const checkpointPath = this.getCheckpointPath(source, config);

    try {
      const content = await readFile(checkpointPath, 'utf-8');
      const parsed = JSON.parse(content) as Partial<SourceCheckpoint>;

      return {
        source,
        discoveredUrls: Array.isArray(parsed.discoveredUrls) ? parsed.discoveredUrls : [],
        completedUrls: Array.isArray(parsed.completedUrls) ? parsed.completedUrls : [],
        failedUrls: Array.isArray(parsed.failedUrls) ? parsed.failedUrls : [],
        lastRunAt: parsed.lastRunAt,
      };
    } catch {
      return defaultState;
    }
  }

  private async saveCheckpoint(state: SourceCheckpoint, config: PipelineConfig): Promise<void> {
    const checkpointPath = this.getCheckpointPath(state.source, config);
    await mkdir(dirname(checkpointPath), { recursive: true });
    await writeFile(checkpointPath, JSON.stringify(state, null, 2), 'utf-8');
  }

  private async appendJsonl(path: string, payload: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(payload)}\n`, 'utf-8');
  }

  private async appendDeadLetter(
    source: IngestionSource,
    config: PipelineConfig,
    payload: {
      url: string;
      stage: string;
      error: string;
      retriable: boolean;
      attempt: number;
      details?: Record<string, unknown>;
    },
  ): Promise<void> {
    const deadLetterPath = this.getDeadLetterPath(source, config);
    await this.appendJsonl(deadLetterPath, {
      source,
      createdAt: nowISO(),
      ...payload,
    });
  }

  private toDocumentRecord(parsed: ParsedDocument): Document {
    const documentId = this.deterministicUuid(
      `${parsed.source}:${parsed.externalId}:${parsed.url}`,
    );

    return {
      id: documentId,
      source: parsed.source,
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

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private getErrorStage(error: unknown): string {
    if (error instanceof StageProcessingError) {
      return error.stage;
    }

    return 'process';
  }

  private isRetriableError(error: unknown): boolean {
    if (error instanceof StageProcessingError) {
      return error.retriable;
    }

    const message = this.getErrorMessage(error).toLowerCase();
    return (
      message.includes('rate limit') ||
      message.includes('timeout') ||
      message.includes('temporarily') ||
      message.includes('connection') ||
      message.includes('econnreset') ||
      message.includes('etimedout') ||
      message.includes('socket hang up') ||
      message.includes('503') ||
      message.includes('502') ||
      message.includes('429')
    );
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
  }

  private async withRetry<T>(operation: () => Promise<T>, options: StageRetryOptions): Promise<T> {
    const maxRetries = Math.max(1, options.maxRetries);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        const retriable = this.isRetriableError(error);
        if (!retriable || attempt >= maxRetries) {
          throw new StageProcessingError(options.stage, this.getErrorMessage(error), retriable);
        }

        const backoff = options.baseDelayMs * Math.pow(2, attempt - 1);
        const jitter = Math.floor(Math.random() * 250);
        const waitMs = backoff + jitter;

        logger.warn(
          {
            source: options.source,
            url: options.url,
            stage: options.stage,
            attempt,
            maxRetries,
            waitMs,
            error: this.getErrorMessage(error),
          },
          'Transient stage error, retrying',
        );

        await this.sleep(waitMs);
      }
    }

    throw new StageProcessingError(options.stage, 'Retry loop exhausted', false);
  }

  private dedupeChunks(chunks: SharedChunk[]): {
    deduped: SharedChunk[];
    duplicatesSkipped: number;
  } {
    const seenHashes = new Set<string>();
    const deduped: SharedChunk[] = [];
    let duplicatesSkipped = 0;

    for (const chunk of chunks) {
      if (seenHashes.has(chunk.contentHash)) {
        duplicatesSkipped++;
        continue;
      }

      seenHashes.add(chunk.contentHash);
      deduped.push(chunk);
    }

    return { deduped, duplicatesSkipped };
  }

  private failFastReason(
    stats: PipelineStats,
    processedAttempts: number,
    consecutiveFailures: number,
    config: PipelineConfig,
  ): string | null {
    const failFastEnabled = config.failFast ?? true;
    if (!failFastEnabled) {
      return null;
    }

    const maxConsecutiveFailures = config.maxConsecutiveFailures ?? 5;
    if (consecutiveFailures >= maxConsecutiveFailures) {
      return `Consecutive failure threshold reached (${consecutiveFailures}/${maxConsecutiveFailures})`;
    }

    const maxErrorRate = config.maxErrorRate ?? 0.3;
    if (processedAttempts >= 10) {
      const errorRate = stats.documentsFailed / processedAttempts;
      if (errorRate > maxErrorRate) {
        return `Error rate threshold reached (${errorRate.toFixed(2)} > ${maxErrorRate.toFixed(2)})`;
      }
    }

    return null;
  }

  private async processDocument(
    source: IngestionSource,
    url: string,
    crawler: ShuukhCrawler | LegalinfoCrawler,
    config: PipelineConfig,
    rawOutputPath: string,
    parsedOutputPath: string,
  ): Promise<ProcessDocumentResult> {
    const maxRetries = config.maxRetriesPerDocument ?? 3;
    const retryBaseDelayMs = config.retryBaseDelayMs ?? 750;
    const minHtmlLength = config.minHtmlLength ?? 120;
    const minTextLength = config.minTextLength ?? 120;

    const fetched = await this.withRetry(() => crawler.fetchPage(url), {
      source,
      url,
      stage: 'fetch',
      maxRetries,
      baseDelayMs: retryBaseDelayMs,
    });

    if (!fetched.rawHtml || fetched.rawHtml.length < minHtmlLength) {
      throw new StageProcessingError(
        'fetch-validate',
        `HTML response too short (${fetched.rawHtml?.length ?? 0} < ${minHtmlLength})`,
        false,
      );
    }

    if (fetched.statusCode < 200 || fetched.statusCode >= 300) {
      throw new StageProcessingError(
        'fetch-validate',
        `Unexpected HTTP status code: ${fetched.statusCode}`,
        true,
      );
    }

    if (config.persistRaw ?? true) {
      await this.appendJsonl(rawOutputPath, {
        source,
        url: fetched.url,
        fetchedAt: fetched.fetchedAt,
        statusCode: fetched.statusCode,
        rawHtml: fetched.rawHtml,
      });
    }

    const parsed = await this.withRetry(() => crawler.parse(fetched), {
      source,
      url,
      stage: 'parse',
      maxRetries: 1,
      baseDelayMs: retryBaseDelayMs,
    });

    if (!parsed.cleanedText || parsed.cleanedText.length < minTextLength) {
      throw new StageProcessingError(
        'parse-validate',
        `Parsed text too short (${parsed.cleanedText?.length ?? 0} < ${minTextLength})`,
        false,
      );
    }

    if (!parsed.title || parsed.title.trim().length < 3) {
      throw new StageProcessingError('parse-validate', 'Missing parsed title', false);
    }

    if (!parsed.externalId || parsed.externalId.trim().length === 0) {
      throw new StageProcessingError('parse-validate', 'Missing parsed externalId', false);
    }

    if (source === 'legalinfo' && this.shouldRestrictLegalinfoToMongolianLaw()) {
      const actType = this.inferLegalinfoActType(parsed);
      if (actType !== 'mongolian_law') {
        return {
          fetched: 1,
          parsed: 1,
          chunks: 0,
          embedded: 0,
          upserted: 0,
          duplicateChunksSkipped: 0,
          skipped: true,
          skipReason: `Filtered legalinfo act type: ${actType}`,
        };
      }
    }

    if (config.persistParsed ?? true) {
      await this.appendJsonl(parsedOutputPath, {
        source,
        url: parsed.url,
        externalId: parsed.externalId,
        title: parsed.title,
        date: parsed.date,
        domain: parsed.domain,
        metadata: parsed.metadata,
        structured: parsed.structured ?? {},
        cleanedText: parsed.cleanedText,
      });
    }

    const docRecord = this.toDocumentRecord(parsed);
    const chunking = chunkingService.processDocument(docRecord.id, parsed.cleanedText, {
      source: parsed.source,
      sourceId: parsed.externalId,
      title: parsed.title,
      url: parsed.url,
      date: parsed.date,
      caseId: parsed.metadata.caseId,
      lawId: parsed.metadata.lawId,
      articleNo: parsed.metadata.articleNo,
    });

    if (chunking.totalChunks === 0) {
      throw new StageProcessingError('chunk', 'Chunking produced zero chunks', false);
    }

    const { deduped, duplicatesSkipped } = this.dedupeChunks(chunking.chunks);
    if (deduped.length === 0) {
      throw new StageProcessingError('chunk', 'All chunks were dropped as duplicates', false);
    }

    const skipEmbed = config.skipStages?.includes('embed') ?? false;
    const skipUpsert = config.skipStages?.includes('upsert') ?? false;

    if (skipEmbed && !skipUpsert) {
      throw new StageProcessingError(
        'config',
        'Invalid config: upsert cannot run when embed stage is skipped',
        false,
      );
    }

    let embeddedCount = 0;
    let upsertedCount = 0;

    if (!skipEmbed) {
      const embedded = await this.withRetry(() => embeddingService.embedChunks(deduped), {
        source,
        url,
        stage: 'embed',
        maxRetries,
        baseDelayMs: retryBaseDelayMs,
      });

      if (embedded.length !== deduped.length) {
        throw new StageProcessingError(
          'embed-validate',
          `Embedded chunk count mismatch (${embedded.length} != ${deduped.length})`,
          false,
        );
      }

      embeddedCount = embedded.length;

      if (!skipUpsert) {
        await this.withRetry(() => upsertService.upsertDocument(docRecord, embedded), {
          source,
          url,
          stage: 'upsert',
          maxRetries,
          baseDelayMs: retryBaseDelayMs,
        });

        upsertedCount = embedded.length;
      }
    }

    return {
      fetched: 1,
      parsed: 1,
      chunks: deduped.length,
      embedded: embeddedCount,
      upserted: upsertedCount,
      duplicateChunksSkipped: duplicatesSkipped,
    };
  }

  /**
   * Run complete pipeline for a single source (shuukh or legalinfo).
   */
  async runSourcePipeline(
    source: IngestionSource,
    config: PipelineConfig = {},
  ): Promise<PipelineStats> {
    const startTime = new Date();
    const stats: PipelineStats = {
      source,
      startTime,
      endTime: new Date(),
      durationMs: 0,
      documentsDiscovered: 0,
      documentsFetched: 0,
      documentsParsed: 0,
      documentsSkipped: 0,
      documentsFailed: 0,
      totalChunks: 0,
      chunksEmbedded: 0,
      chunksUpserted: 0,
      duplicateChunksSkipped: 0,
      deadLetteredDocuments: 0,
      errors: [],
    };

    const crawler = source === 'shuukh' ? this.shuukhCrawler : this.legalinfoCrawler;
    const maxDocs = config.maxDocuments ?? 100;
    const shouldResume = config.resume ?? true;
    const failFastEnabled = config.failFast ?? true;

    const checkpoint = await this.loadCheckpoint(source, config);

    try {
      logger.info(
        {
          source,
          maxDocuments: maxDocs,
          resume: shouldResume,
          failFast: failFastEnabled,
        },
        'Starting offline pipeline for source',
      );

      logger.info({ source }, 'Stage 1: Discovering URLs');
      let discoveredUrls: string[];

      if (shouldResume && checkpoint.discoveredUrls.length > 0) {
        if (checkpoint.discoveredUrls.length >= maxDocs) {
          discoveredUrls = checkpoint.discoveredUrls.slice(0, maxDocs);
          logger.info({ source, discovered: discoveredUrls.length }, 'Using URLs from checkpoint');
        } else {
          logger.info(
            {
              source,
              checkpointDiscovered: checkpoint.discoveredUrls.length,
              requestedMaxDocuments: maxDocs,
            },
            'Checkpoint URL set is smaller than requested maxDocuments; refreshing discovery',
          );
          discoveredUrls = await crawler.discoverUrls(maxDocs);
          checkpoint.discoveredUrls = discoveredUrls;
        }
      } else {
        discoveredUrls = await crawler.discoverUrls(maxDocs);
        checkpoint.discoveredUrls = discoveredUrls;
      }

      stats.documentsDiscovered = discoveredUrls.length;

      if (discoveredUrls.length === 0) {
        logger.warn({ source }, 'No URLs discovered');
        stats.endTime = new Date();
        stats.durationMs = stats.endTime.getTime() - startTime.getTime();
        return stats;
      }

      const completedSet = new Set(shouldResume ? checkpoint.completedUrls : []);
      const failedSet = new Set(checkpoint.failedUrls);
      const pendingUrls = discoveredUrls.filter((url) => !completedSet.has(url));
      stats.documentsSkipped = discoveredUrls.length - pendingUrls.length;

      const rawOutputPath = resolve(this.workspaceRoot, 'data/processed/raw', `${source}.jsonl`);
      const parsedOutputPath = resolve(
        this.workspaceRoot,
        'data/processed/parsed',
        `${source}.jsonl`,
      );

      logger.info(
        {
          source,
          total: discoveredUrls.length,
          pending: pendingUrls.length,
          skipped: stats.documentsSkipped,
        },
        'Prepared resumable processing queue',
      );

      let consecutiveFailures = 0;

      for (let i = 0; i < pendingUrls.length; i++) {
        const url = pendingUrls[i];

        try {
          const result = await this.processDocument(
            source,
            url,
            crawler,
            config,
            rawOutputPath,
            parsedOutputPath,
          );

          stats.documentsFetched += result.fetched;
          stats.documentsParsed += result.parsed;

          if (result.skipped) {
            stats.documentsSkipped++;

            completedSet.add(url);
            failedSet.delete(url);
            consecutiveFailures = 0;

            checkpoint.completedUrls = Array.from(completedSet);
            checkpoint.failedUrls = Array.from(failedSet);
            checkpoint.lastRunAt = nowISO();
            await this.saveCheckpoint(checkpoint, config);

            logger.info(
              {
                source,
                url,
                reason: result.skipReason ?? 'filtered',
              },
              'Document skipped by pipeline filter',
            );

            continue;
          }

          stats.totalChunks += result.chunks;
          stats.chunksEmbedded += result.embedded;
          stats.chunksUpserted += result.upserted;
          stats.duplicateChunksSkipped += result.duplicateChunksSkipped;

          completedSet.add(url);
          failedSet.delete(url);
          consecutiveFailures = 0;

          checkpoint.completedUrls = Array.from(completedSet);
          checkpoint.failedUrls = Array.from(failedSet);
          checkpoint.lastRunAt = nowISO();
          await this.saveCheckpoint(checkpoint, config);

          if ((i + 1) % 5 === 0) {
            logger.info(
              {
                source,
                processed: i + 1,
                total: pendingUrls.length,
                fetched: stats.documentsFetched,
                parsed: stats.documentsParsed,
                chunks: stats.totalChunks,
                embedded: stats.chunksEmbedded,
                upserted: stats.chunksUpserted,
                duplicateChunksSkipped: stats.duplicateChunksSkipped,
              },
              'Pipeline progress',
            );
          }
        } catch (error) {
          const stage = this.getErrorStage(error);
          const errorMessage = this.getErrorMessage(error);
          const retriable = this.isRetriableError(error);

          stats.documentsFailed++;
          stats.errors.push({
            stage,
            url,
            error: errorMessage,
          });

          failedSet.add(url);
          consecutiveFailures++;

          await this.appendDeadLetter(source, config, {
            url,
            stage,
            error: errorMessage,
            retriable,
            attempt: config.maxRetriesPerDocument ?? 3,
          });
          stats.deadLetteredDocuments++;

          checkpoint.failedUrls = Array.from(failedSet);
          checkpoint.lastRunAt = nowISO();
          await this.saveCheckpoint(checkpoint, config);

          logger.warn(
            {
              source,
              url,
              stage,
              retriable,
              err: errorMessage,
            },
            'Document processing failed',
          );

          const processedAttempts = i + 1;
          const failReason = this.failFastReason(
            stats,
            processedAttempts,
            consecutiveFailures,
            config,
          );
          if (failReason) {
            throw new Error(`Fail-fast triggered for ${source}: ${failReason}`);
          }
        }
      }

      checkpoint.completedUrls = Array.from(completedSet);
      checkpoint.failedUrls = Array.from(failedSet);
      checkpoint.lastRunAt = nowISO();
      await this.saveCheckpoint(checkpoint, config);

      stats.endTime = new Date();
      stats.durationMs = stats.endTime.getTime() - startTime.getTime();

      logger.info(
        {
          source,
          discovered: stats.documentsDiscovered,
          skipped: stats.documentsSkipped,
          fetched: stats.documentsFetched,
          parsed: stats.documentsParsed,
          failed: stats.documentsFailed,
          chunks: stats.totalChunks,
          embedded: stats.chunksEmbedded,
          upserted: stats.chunksUpserted,
          duplicateChunksSkipped: stats.duplicateChunksSkipped,
          deadLetteredDocuments: stats.deadLetteredDocuments,
          durationSeconds: (stats.durationMs / 1000).toFixed(2),
          errors: stats.errors.length,
        },
        'Pipeline complete',
      );

      return stats;
    } catch (error) {
      logger.error(
        {
          source,
          err: this.getErrorMessage(error),
        },
        'Pipeline failed',
      );

      stats.errors.push({
        stage: 'pipeline',
        url: source,
        error: this.getErrorMessage(error),
      });

      stats.endTime = new Date();
      stats.durationMs = stats.endTime.getTime() - startTime.getTime();

      if (failFastEnabled) {
        throw error;
      }

      return stats;
    }
  }

  /**
   * Run full offline pipeline for all sources.
   */
  async runFullPipeline(config: PipelineConfig = {}): Promise<PipelineStats[]> {
    logger.info('Starting full offline pipeline');

    const results: PipelineStats[] = [];

    if (!config.skipStages?.includes('shuukh')) {
      const shuukhStats = await this.runSourcePipeline('shuukh', config);
      results.push(shuukhStats);

      await this.sleep(4000);
    }

    if (!config.skipStages?.includes('legalinfo')) {
      const legalinfoStats = await this.runSourcePipeline('legalinfo', config);
      results.push(legalinfoStats);
    }

    const totalDocs = results.reduce((sum, result) => sum + result.documentsFetched, 0);
    const totalChunks = results.reduce((sum, result) => sum + result.totalChunks, 0);
    const totalErrors = results.reduce((sum, result) => sum + result.errors.length, 0);

    logger.info(
      {
        totalDocuments: totalDocs,
        totalChunks,
        totalErrors,
        sources: results
          .map(
            (result) => `${result.source}:${result.documentsFetched}/${result.documentsDiscovered}`,
          )
          .join(', '),
      },
      'Full pipeline complete',
    );

    return results;
  }
}

export const pipelineService = new PipelineService();
