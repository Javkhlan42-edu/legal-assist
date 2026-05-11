// ────────────────────────────────────────────────────────────
// Upsert Service — Write embeddings + metadata to storage
// ────────────────────────────────────────────────────────────

import type { EmbeddedChunk, Document } from '@legal-chatbot/shared';
import { createLogger } from '../lib/logger.js';
import { createVectorProviderFromEnv, type IVectorProvider } from '../lib/vector-db.js';

const logger = createLogger('upsert-service');

/**
 * Statistics returned after an upsert operation.
 */
export interface UpsertStats {
  documentsProcessed: number;
  chunksUpserted: number;
  vectorsUpserted: number;
  errors: number;
  durationMs: number;
}

/**
 * Interface for the upsert service.
 */
export interface IUpsertService {
  /**
   * Upsert a document and its embedded chunks to Vector DB + Postgres.
   */
  upsertDocument(doc: Document, embeddedChunks: EmbeddedChunk[]): Promise<void>;

  /**
   * Batch upsert multiple documents.
   */
  upsertBatch(
    items: Array<{ doc: Document; embeddedChunks: EmbeddedChunk[] }>,
  ): Promise<UpsertStats>;
}

export class UpsertService implements IUpsertService {
  private vectorProvider: IVectorProvider | null;
  private initialized = false;

  constructor(vectorProvider?: IVectorProvider) {
    this.vectorProvider = vectorProvider ?? null;

    if (this.vectorProvider) {
      logger.info({ provider: this.vectorProvider.name }, 'Upsert service initialized');
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (!this.vectorProvider) {
      this.vectorProvider = createVectorProviderFromEnv(process.env);
      logger.info({ provider: this.vectorProvider.name }, 'Upsert service initialized');
    }

    await this.vectorProvider.initialize();
    this.initialized = true;
  }

  async upsertDocument(doc: Document, embeddedChunks: EmbeddedChunk[]): Promise<void> {
    if (embeddedChunks.length === 0) {
      logger.warn({ docId: doc.id }, 'No chunks to upsert');
      return;
    }

    try {
      await this.ensureInitialized();
      const upserted = await this.vectorProvider!.upsertDocument(doc, embeddedChunks);

      logger.info(
        {
          docId: doc.id,
          provider: this.vectorProvider!.name,
          requestedChunks: embeddedChunks.length,
          upsertedChunks: upserted,
        },
        'Document upserted successfully',
      );
    } catch (err) {
      logger.error({ err, docId: doc.id }, 'Failed to upsert document');
      throw err;
    }
  }

  async upsertBatch(
    items: Array<{ doc: Document; embeddedChunks: EmbeddedChunk[] }>,
  ): Promise<UpsertStats> {
    const start = Date.now();
    let vectorsUpserted = 0;
    let errors = 0;

    logger.info(`Starting batch upsert of ${items.length} documents`);

    for (const { doc, embeddedChunks } of items) {
      try {
        await this.upsertDocument(doc, embeddedChunks);
        vectorsUpserted += embeddedChunks.length;
      } catch (err) {
        logger.error({ err, docId: doc.id }, 'Failed to upsert document');
        errors++;
      }
    }

    const durationMs = Date.now() - start;
    logger.info(
      {
        documentsProcessed: items.length,
        chunksUpserted: vectorsUpserted,
        vectorsUpserted,
        errors,
        durationMs,
        provider: this.vectorProvider?.name,
      },
      'Batch upsert complete',
    );

    return {
      documentsProcessed: items.length,
      chunksUpserted: vectorsUpserted,
      vectorsUpserted,
      errors,
      durationMs,
    };
  }
}

/**
 * Create upsert service from environment.
 */
export function createUpsertService(env: {
  VECTOR_DB_PROVIDER?: string;
  VECTOR_DB_FALLBACK?: boolean | string;
  DATABASE_URL?: string;
  CHROMA_URL?: string;
  CHROMA_COLLECTION?: string;
  EMBEDDING_DIMENSION?: number | string;
}): UpsertService {
  return new UpsertService(createVectorProviderFromEnv(env));
}

export const upsertService = new UpsertService();
