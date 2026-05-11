// ────────────────────────────────────────────────────────────
// Embedding Service — Generate vector embeddings for chunks
// ────────────────────────────────────────────────────────────

import type { Chunk, EmbeddedChunk } from '@legal-chatbot/shared';
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_DIMENSION } from '@legal-chatbot/shared';
import { nowISO } from '@legal-chatbot/shared';
import { randomUUID } from 'crypto';
import OpenAI from 'openai';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('embedding-service');
const OPENAI_EMBEDDING_NATIVE_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
};
const OPENAI_SAFE_INPUT_CHARS = 3000;

/**
 * Interface for the embedding service.
 */
export interface IEmbeddingService {
  /**
   * Generate embeddings for a batch of chunks.
   * Handles batching to stay within API limits.
   */
  embedChunks(chunks: Chunk[]): Promise<EmbeddedChunk[]>;

  /**
   * Generate a single embedding for a query string (for search).
   */
  embedQuery(query: string): Promise<number[]>;
}

interface EmbeddingServiceConfig {
  model?: string;
  localModel?: string;
  dimensions?: number;
  openaiApiKey?: string;
  embeddingProvider?: 'openai' | 'local';
  batchSize?: number;
  maxBatchTokens?: number;
  maxBatchChars?: number;
  maxRetries?: number;
  retryBaseMs?: number;
}

/**
 * Embedding Service with OpenAI API integration.
 * Handles batching, rate limiting, and fallback to local embeddings.
 */
export class EmbeddingService implements IEmbeddingService {
  private model: string;
  private localModel: string;
  private dimensions: number;
  private openaiClient: OpenAI | null = null;
  private useLocal: boolean;
  private batchSize: number;
  private maxBatchTokens: number;
  private maxBatchChars: number;
  private maxRetries: number;
  private retryBaseMs: number;
  private localDimensionWarningEmitted = false;
  private openAIDimensionWarningEmitted = false;

  constructor(config: EmbeddingServiceConfig = {}) {
    this.model = config.model || DEFAULT_EMBEDDING_MODEL;
    this.localModel = config.localModel || 'Xenova/all-MiniLM-L6-v2';
    this.dimensions = config.dimensions || DEFAULT_EMBEDDING_DIMENSION;
    this.batchSize = config.batchSize ?? 100;
    this.maxBatchTokens = config.maxBatchTokens ?? 280000;
    this.maxBatchChars = config.maxBatchChars ?? 180000;
    this.maxRetries = config.maxRetries ?? 4;
    this.retryBaseMs = config.retryBaseMs ?? 1000;

    const providerPreference = config.embeddingProvider ?? 'openai';
    const hasApiKey = Boolean(config.openaiApiKey);

    this.useLocal = providerPreference === 'local' || !hasApiKey;

    if (!this.useLocal && hasApiKey) {
      this.openaiClient = new OpenAI({ apiKey: config.openaiApiKey });
    } else {
      logger.info(
        {
          reason:
            providerPreference === 'local'
              ? 'EMBEDDING_PROVIDER=local'
              : 'OPENAI_API_KEY not provided',
        },
        'Using local embeddings',
      );
    }
  }

  async embedChunks(chunks: Chunk[]): Promise<EmbeddedChunk[]> {
    if (chunks.length === 0) return [];

    logger.info(
      {
        chunks: chunks.length,
        provider: this.useLocal ? 'local' : 'openai',
        batchSize: this.batchSize,
        maxRetries: this.maxRetries,
      },
      'Embedding chunks',
    );

    const embedded: EmbeddedChunk[] = [];
    const batches = this.createBatches(chunks);

    for (let i = 0; i < batches.length; i += 1) {
      const batch = batches[i];
      const texts = batch.map((c) =>
        this.limitEmbeddingInput(this.prepareEmbeddingInput(c.text, 'document'), `chunk:${c.id}`),
      );

      try {
        const vectors = await this.embedWithRetry(texts, `batch-${i + 1}`);

        for (let j = 0; j < batch.length; j++) {
          embedded.push({
            chunk: batch[j],
            embedding: {
              id: randomUUID(),
              chunkId: batch[j].id,
              vector: vectors[j],
              model: this.getActiveModelName(),
              dimensions: this.dimensions,
              createdAt: nowISO(),
            },
          });
        }

        logger.info({
          batch: i + 1,
          totalBatches: batches.length,
          batchChunks: batch.length,
          estimatedBatchTokens: batch.reduce(
            (total, chunk) => total + this.estimateTokenCount(chunk.text),
            0,
          ),
          embeddedSoFar: embedded.length,
        });
      } catch (err) {
        logger.error({ err }, 'Embedding batch failed');
        throw err;
      }
    }

    return embedded;
  }

  async embedQuery(query: string): Promise<number[]> {
    if (!query.trim()) {
      return new Array(this.dimensions).fill(0);
    }

    try {
      const vectors = await this.embedWithRetry(
        [this.limitEmbeddingInput(this.prepareEmbeddingInput(query, 'query'), 'query')],
        'query',
      );
      return vectors[0];
    } catch (err) {
      logger.error({ err }, 'Query embedding failed');
      throw err;
    }
  }

  private async embedWithRetry(texts: string[], context: string): Promise<number[][]> {
    let attempt = 0;

    while (attempt < this.maxRetries) {
      attempt += 1;

      try {
        const vectors = this.useLocal
          ? await this.embedLocal(texts)
          : await this.embedOpenAI(texts);
        this.validateDimensions(vectors);
        return vectors;
      } catch (err) {
        const canRetry = this.isRetryableError(err);
        const isLastAttempt = attempt >= this.maxRetries;

        if (!canRetry || isLastAttempt) {
          throw err;
        }

        const backoff = this.retryBaseMs * Math.pow(2, attempt - 1);
        const jitter = Math.floor(Math.random() * 250);
        const waitMs = backoff + jitter;

        logger.warn(
          {
            context,
            attempt,
            maxRetries: this.maxRetries,
            waitMs,
            error: err instanceof Error ? err.message : String(err),
          },
          'Embedding attempt failed, retrying with backoff',
        );

        await this.sleep(waitMs);
      }
    }

    throw new Error(`Embedding failed after ${this.maxRetries} retries`);
  }

  /**
   * Call OpenAI Embedding API.
   * Returns array of vectors with same length as input texts.
   */
  private async embedOpenAI(texts: string[]): Promise<number[][]> {
    if (!this.openaiClient) {
      throw new Error('OpenAI client not initialized. Provide OPENAI_API_KEY.');
    }

    const requestDimensions = this.getOpenAIRequestDimensions();
    const response = await this.openaiClient.embeddings.create({
      model: this.model,
      input: texts,
      ...(typeof requestDimensions === 'number' ? { dimensions: requestDimensions } : {}),
    });

    return response.data.map((item) => {
      if (!this.openAIDimensionWarningEmitted && item.embedding.length !== this.dimensions) {
        logger.warn(
          {
            model: this.model,
            configuredDimensions: this.dimensions,
            providerDimensions: item.embedding.length,
            requestDimensions: requestDimensions ?? null,
          },
          'OpenAI embedding dimension differs from configured dimension; vectors will be resized',
        );
        this.openAIDimensionWarningEmitted = true;
      }

      return this.resizeVector(item.embedding, this.dimensions);
    });
  }

  private createBatches(chunks: Chunk[]): Chunk[][] {
    const batches: Chunk[][] = [];
    let current: Chunk[] = [];
    let currentTokens = 0;
    let currentChars = 0;

    for (const chunk of chunks) {
      const estimatedTokens = this.estimateTokenCount(chunk.text);
      const estimatedChars = chunk.text.length;
      const wouldExceedBatchSize = current.length >= this.batchSize;
      const wouldExceedTokenBudget =
        current.length > 0 && currentTokens + estimatedTokens > this.maxBatchTokens;
      const wouldExceedCharBudget =
        current.length > 0 && currentChars + estimatedChars > this.maxBatchChars;

      if (wouldExceedBatchSize || wouldExceedTokenBudget || wouldExceedCharBudget) {
        batches.push(current);
        current = [];
        currentTokens = 0;
        currentChars = 0;
      }

      current.push(chunk);
      currentTokens += estimatedTokens;
      currentChars += estimatedChars;
    }

    if (current.length > 0) {
      batches.push(current);
    }

    return batches;
  }

  private estimateTokenCount(text: string): number {
    const normalized = text.trim();
    if (!normalized) {
      return 0;
    }

    return Math.max(1, Math.ceil(normalized.length / 4));
  }

  private getOpenAIRequestDimensions(): number | undefined {
    if (!this.model.startsWith('text-embedding-3')) {
      return undefined;
    }

    const nativeDimensions = OPENAI_EMBEDDING_NATIVE_DIMENSIONS[this.model];
    if (!nativeDimensions) {
      return this.dimensions;
    }

    if (this.dimensions > 0 && this.dimensions <= nativeDimensions) {
      return this.dimensions;
    }

    return undefined;
  }

  /**
   * Fallback: Use local ONNX embeddings via transformers.js.
   * Slower but free and offline.
   */
  private async embedLocal(texts: string[]): Promise<number[][]> {
    try {
      const { pipeline } = await import('@xenova/transformers');
      const extractor = await pipeline('feature-extraction', this.localModel, {
        quantized: true,
      });

      const embeddings: number[][] = [];
      for (const text of texts) {
        const output = await extractor(text, { pooling: 'mean', normalize: true });
        const vector = Array.from(output.data as Float32Array);

        if (!this.localDimensionWarningEmitted && vector.length !== this.dimensions) {
          logger.warn(
            {
              configuredDimensions: this.dimensions,
              localModelDimensions: vector.length,
            },
            'Local embedding dimension differs from configured dimension; vectors will be resized',
          );
          this.localDimensionWarningEmitted = true;
        }

        embeddings.push(this.resizeVector(vector, this.dimensions));
      }

      return embeddings;
    } catch (err) {
      logger.error('Local embedding failed:', err);
      throw err;
    }
  }

  private validateDimensions(vectors: number[][]): void {
    const mismatched = vectors.find((vector) => vector.length !== this.dimensions);
    if (mismatched) {
      throw new Error(
        `Embedding dimension mismatch: expected ${this.dimensions}, got ${mismatched.length}`,
      );
    }
  }

  private limitEmbeddingInput(text: string, context: string): string {
    if (this.useLocal || text.length <= OPENAI_SAFE_INPUT_CHARS) {
      return text;
    }

    const head = text.slice(0, Math.floor(OPENAI_SAFE_INPUT_CHARS * 0.7)).trim();
    const tail = text.slice(-Math.floor(OPENAI_SAFE_INPUT_CHARS * 0.25)).trim();
    const limited = `${head}\n\n[... embedding input truncated for token safety ...]\n\n${tail}`.trim();
    logger.warn(
      {
        context,
        originalChars: text.length,
        limitedChars: limited.length,
        model: this.model,
      },
      'Embedding input truncated before OpenAI request',
    );
    return limited;
  }

  private prepareEmbeddingInput(text: string, kind: 'document' | 'query'): string {
    const normalized = text.replace(/\n/g, ' ').trim();
    const activeModel = this.getActiveModelName();
    if (!/e5/i.test(activeModel)) {
      return normalized;
    }

    return kind === 'query' ? `query: ${normalized}` : `passage: ${normalized}`;
  }

  private getActiveModelName(): string {
    return this.useLocal ? this.localModel : this.model;
  }

  private resizeVector(vector: number[], targetDimensions: number): number[] {
    if (!Number.isFinite(targetDimensions) || targetDimensions <= 0) {
      return vector;
    }

    if (vector.length === targetDimensions) {
      return vector;
    }

    if (vector.length > targetDimensions) {
      return vector.slice(0, targetDimensions);
    }

    const resized = new Array(targetDimensions).fill(0);
    for (let i = 0; i < vector.length; i++) {
      resized[i] = vector[i] ?? 0;
    }
    return resized;
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof OpenAI.APIError) {
      const code = error.status;
      return code === 408 || code === 409 || code === 429 || (code >= 500 && code < 600);
    }

    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return (
      message.includes('rate limit') ||
      message.includes('timeout') ||
      message.includes('temporarily') ||
      message.includes('connection') ||
      message.includes('econnreset') ||
      message.includes('etimedout') ||
      message.includes('socket hang up')
    );
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Create embedding service from environment.
 */
export function createEmbeddingService(env: {
  EMBEDDING_PROVIDER?: 'openai' | 'local';
  EMBEDDING_MODEL?: string;
  LOCAL_EMBEDDING_MODEL?: string;
  EMBEDDING_DIMENSION?: number;
  EMBEDDING_BATCH_SIZE?: number;
  EMBEDDING_MAX_RETRIES?: number;
  EMBEDDING_RETRY_BASE_MS?: number;
  OPENAI_API_KEY?: string;
}): EmbeddingService {
  return new EmbeddingService({
    embeddingProvider: env.EMBEDDING_PROVIDER,
    model: env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL,
    localModel: env.LOCAL_EMBEDDING_MODEL,
    dimensions: env.EMBEDDING_DIMENSION || DEFAULT_EMBEDDING_DIMENSION,
    batchSize: env.EMBEDDING_BATCH_SIZE,
    maxRetries: env.EMBEDDING_MAX_RETRIES,
    retryBaseMs: env.EMBEDDING_RETRY_BASE_MS,
    openaiApiKey: env.OPENAI_API_KEY,
  });
}

let _embeddingService: EmbeddingService | null = null;

function getDefaultEmbeddingService(): EmbeddingService {
  if (_embeddingService) {
    return _embeddingService;
  }

  _embeddingService = createEmbeddingService({
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER as 'openai' | 'local' | undefined,
    EMBEDDING_MODEL: process.env.OPENAI_EMBEDDING_MODEL,
    LOCAL_EMBEDDING_MODEL: process.env.LOCAL_EMBEDDING_MODEL,
    EMBEDDING_DIMENSION: process.env.EMBEDDING_DIMENSION
      ? Number(process.env.EMBEDDING_DIMENSION)
      : undefined,
    EMBEDDING_BATCH_SIZE: process.env.EMBEDDING_BATCH_SIZE
      ? Number(process.env.EMBEDDING_BATCH_SIZE)
      : undefined,
    EMBEDDING_MAX_RETRIES: process.env.EMBEDDING_MAX_RETRIES
      ? Number(process.env.EMBEDDING_MAX_RETRIES)
      : undefined,
    EMBEDDING_RETRY_BASE_MS: process.env.EMBEDDING_RETRY_BASE_MS
      ? Number(process.env.EMBEDDING_RETRY_BASE_MS)
      : undefined,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  });

  return _embeddingService;
}

export const embeddingService: IEmbeddingService = {
  async embedChunks(chunks: Chunk[]): Promise<EmbeddedChunk[]> {
    return getDefaultEmbeddingService().embedChunks(chunks);
  },
  async embedQuery(query: string): Promise<number[]> {
    return getDefaultEmbeddingService().embedQuery(query);
  },
};
