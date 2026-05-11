// ────────────────────────────────────────────────────────────
// Vector DB Providers — pgvector primary with Chroma fallback
// ────────────────────────────────────────────────────────────

import type { Document, EmbeddedChunk, SourceType } from '@legal-chatbot/shared';
import { ChromaClient, type Collection, type Metadata } from 'chromadb';
import pg from 'pg';
import { createLogger } from './logger.js';

const logger = createLogger('vector-db');

export type VectorProviderName = 'pgvector' | 'chroma';

export interface VectorSearchFilters {
  source?: SourceType;
  sourceId?: string;
  lawId?: string;
  caseId?: string;
}

export interface VectorSearchResult {
  id: string;
  document: string;
  metadata: Record<string, unknown>;
  score: number;
}

/** Cosine score + ORDER BY for pgvector; dim > 2000 uses halfvec to match HNSW index. */
export function pgEmbeddingDistanceSql(dim: number): {
  scoreExpr: string;
  orderExpr: string;
  similarityExpr: string;
} {
  if (!Number.isInteger(dim) || dim < 1 || dim > 16_000) {
    throw new Error(`Invalid embedding dimension: ${dim}`);
  }
  const distanceExpr =
    dim > 2000
      ? `c.embedding::halfvec(${dim}) <=> ($1::vector)::halfvec(${dim})`
      : `c.embedding <=> $1::vector`;
  return {
    orderExpr: distanceExpr,
    similarityExpr: `1 - (${distanceExpr})`,
    scoreExpr: `GREATEST(0::double precision, LEAST(1::double precision, 1 - (${distanceExpr})))`,
  };
}

export interface IVectorProvider {
  readonly name: VectorProviderName;
  initialize(): Promise<void>;
  upsertDocument(doc: Document, embeddedChunks: EmbeddedChunk[]): Promise<number>;
  similaritySearch(
    queryEmbedding: number[],
    topK: number,
    filters?: VectorSearchFilters,
  ): Promise<VectorSearchResult[]>;
  close(): Promise<void>;
}

interface PgVectorConfig {
  databaseUrl: string;
  embeddingDimensions: number;
}

class PgVectorProvider implements IVectorProvider {
  readonly name: VectorProviderName = 'pgvector';

  private pool: pg.Pool | null = null;

  constructor(private readonly config: PgVectorConfig) {}

  async initialize(): Promise<void> {
    if (this.pool) {
      return;
    }

    this.pool = new pg.Pool({
      connectionString: this.config.databaseUrl,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    const client = await this.pool.connect();
    try {
      await client.query('SELECT 1');
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    } finally {
      client.release();
    }
  }

  async upsertDocument(doc: Document, embeddedChunks: EmbeddedChunk[]): Promise<number> {
    if (embeddedChunks.length === 0) {
      return 0;
    }

    if (!this.pool) {
      throw new Error('pgvector provider not initialized');
    }

    const dimensions = embeddedChunks[0]?.embedding.vector.length ?? 0;
    if (dimensions !== this.config.embeddingDimensions) {
      throw new Error(
        `Embedding dimension mismatch for pgvector: expected ${this.config.embeddingDimensions}, got ${dimensions}`,
      );
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const persistedDoc = await client.query<{ id: string }>(
        `INSERT INTO documents (id, source, source_id, title, url, content_hash, metadata, processed_at, updated_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
         ON CONFLICT (source, source_id) DO UPDATE SET
           id = documents.id,
					 source = EXCLUDED.source,
					 source_id = EXCLUDED.source_id,
					 title = EXCLUDED.title,
					 url = EXCLUDED.url,
					 content_hash = EXCLUDED.content_hash,
					 metadata = EXCLUDED.metadata,
					 processed_at = NOW(),
           updated_at = NOW()
         RETURNING id`,
        [
          doc.id,
          doc.source,
          doc.externalId || null,
          doc.title,
          doc.url || null,
          doc.rawContentHash,
          doc.metadata,
        ],
      );

      const documentId = persistedDoc.rows[0]?.id ?? doc.id;

      await client.query('DELETE FROM chunks WHERE document_id = $1', [documentId]);

      for (const embeddedChunk of embeddedChunks) {
        const chunk = embeddedChunk.chunk;
        const embedding = embeddedChunk.embedding;

        await client.query(
          `INSERT INTO chunks (
						 id,
						 document_id,
						 chunk_index,
						 text,
						 metadata,
						 token_count,
						 char_start,
						 char_end,
						 content_hash,
						 embedding,
						 embedding_model,
						 embedding_dimensions,
						 vector_provider,
						 updated_at
					 )
					 VALUES (
						 $1,
						 $2,
						 $3,
						 $4,
						 $5,
						 $6,
						 $7,
						 $8,
						 $9,
						 $10::vector,
						 $11,
						 $12,
						 'pgvector',
						 NOW()
					 )
           ON CONFLICT (document_id, chunk_index) DO UPDATE SET
						 text = EXCLUDED.text,
						 metadata = EXCLUDED.metadata,
						 token_count = EXCLUDED.token_count,
						 char_start = EXCLUDED.char_start,
						 char_end = EXCLUDED.char_end,
						 content_hash = EXCLUDED.content_hash,
						 embedding = EXCLUDED.embedding,
						 embedding_model = EXCLUDED.embedding_model,
						 embedding_dimensions = EXCLUDED.embedding_dimensions,
						 vector_provider = EXCLUDED.vector_provider,
						 updated_at = NOW()`,
          [
            chunk.id,
            documentId,
            chunk.chunkIndex,
            chunk.text,
            chunk.metadata,
            chunk.tokenCount,
            chunk.charOffset.start,
            chunk.charOffset.end,
            chunk.contentHash,
            this.toPgVectorLiteral(embedding.vector),
            embedding.model,
            embedding.dimensions,
          ],
        );
      }

      await client.query('COMMIT');
      return embeddedChunks.length;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async similaritySearch(
    queryEmbedding: number[],
    topK: number,
    filters?: VectorSearchFilters,
  ): Promise<VectorSearchResult[]> {
    if (!this.pool) {
      throw new Error('pgvector provider not initialized');
    }

    const values: Array<string | number> = [this.toPgVectorLiteral(queryEmbedding), topK];
    const whereClauses: string[] = ['c.embedding IS NOT NULL'];

    if (filters?.source) {
      values.push(filters.source);
      whereClauses.push(`d.source::text = $${values.length}`);
    }

    if (filters?.sourceId) {
      values.push(filters.sourceId);
      whereClauses.push(`d.source_id = $${values.length}`);
    }

    if (filters?.lawId) {
      values.push(filters.lawId);
      whereClauses.push(
        `(c.metadata->>'lawId' = $${values.length} OR c.metadata->>'sourceId' = $${values.length})`,
      );
    }

    if (filters?.caseId) {
      values.push(filters.caseId);
      whereClauses.push(`c.metadata->>'caseId' = $${values.length}`);
    }

    const { scoreExpr, orderExpr } = pgEmbeddingDistanceSql(this.config.embeddingDimensions);

    const rows = await this.pool.query<{
      id: string;
      document: string;
      metadata: Record<string, unknown>;
      score: number;
    }>(
      `SELECT
				 c.id,
				 c.text AS document,
				 c.metadata,
				 ${scoreExpr} AS score
			 FROM chunks c
			 INNER JOIN documents d ON d.id = c.document_id
			 WHERE ${whereClauses.join(' AND ')}
			 ORDER BY ${orderExpr}
			 LIMIT $2`,
      values,
    );

    return rows.rows.map((row) => ({
      id: row.id,
      document: row.document,
      metadata: row.metadata || {},
      score: Number(row.score),
    }));
  }

  async close(): Promise<void> {
    if (!this.pool) {
      return;
    }

    await this.pool.end();
    this.pool = null;
  }

  private toPgVectorLiteral(values: number[]): string {
    const normalized = values.map((value) => (Number.isFinite(value) ? value : 0));
    return `[${normalized.join(',')}]`;
  }
}

interface ChromaConfig {
  chromaUrl: string;
  collectionName: string;
}

class ChromaVectorProvider implements IVectorProvider {
  readonly name: VectorProviderName = 'chroma';

  private client: ChromaClient | null = null;
  private collection: Collection | null = null;

  constructor(private readonly config: ChromaConfig) {}

  async initialize(): Promise<void> {
    if (this.collection) {
      return;
    }

    this.client = new ChromaClient({ path: this.config.chromaUrl });
    this.collection = await this.client.getOrCreateCollection({
      name: this.config.collectionName,
      metadata: { 'hnsw:space': 'cosine' },
    });
  }

  async upsertDocument(doc: Document, embeddedChunks: EmbeddedChunk[]): Promise<number> {
    if (!this.collection) {
      throw new Error('chroma provider not initialized');
    }

    if (embeddedChunks.length === 0) {
      return 0;
    }

    const ids = embeddedChunks.map((item) => item.chunk.id);
    const embeddings = embeddedChunks.map((item) => item.embedding.vector);
    const documents = embeddedChunks.map((item) => item.chunk.text.slice(0, 50000));
    const metadatas = embeddedChunks.map<Metadata>((item) => ({
      source: doc.source,
      sourceId: doc.externalId,
      title: doc.title,
      ...(doc.url ? { url: doc.url } : {}),
      ...(doc.date ? { date: doc.date } : {}),
      ...(item.chunk.metadata.lawId ? { lawId: item.chunk.metadata.lawId } : {}),
      ...(item.chunk.metadata.caseId ? { caseId: item.chunk.metadata.caseId } : {}),
      ...(item.chunk.metadata.articleNo ? { articleNo: item.chunk.metadata.articleNo } : {}),
      ...(item.chunk.metadata.clauseNo ? { clauseNo: item.chunk.metadata.clauseNo } : {}),
      ...(item.chunk.metadata.subclauseNo
        ? { subclauseNo: item.chunk.metadata.subclauseNo }
        : {}),
      ...(item.chunk.metadata.articleTitle
        ? { articleTitle: item.chunk.metadata.articleTitle }
        : {}),
      ...(item.chunk.metadata.section ? { section: item.chunk.metadata.section } : {}),
      ...(item.chunk.metadata.headingPath
        ? { headingPath: item.chunk.metadata.headingPath }
        : {}),
      ...(item.chunk.metadata.chunkType ? { chunkType: item.chunk.metadata.chunkType } : {}),
      document_id: doc.id,
      chunk_index: item.chunk.chunkIndex,
      vector_provider: 'chroma',
    }));

    await this.collection.upsert({
      ids,
      embeddings,
      documents,
      metadatas,
    });

    return embeddedChunks.length;
  }

  async similaritySearch(
    queryEmbedding: number[],
    topK: number,
    filters?: VectorSearchFilters,
  ): Promise<VectorSearchResult[]> {
    if (!this.collection) {
      throw new Error('chroma provider not initialized');
    }

    const whereFilter: Record<string, unknown> = {};
    if (filters?.source) whereFilter.source = filters.source;
    if (filters?.sourceId) whereFilter.sourceId = filters.sourceId;
    if (filters?.lawId) whereFilter.lawId = filters.lawId;
    if (filters?.caseId) whereFilter.caseId = filters.caseId;

    const queryResult = await this.collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: topK,
      where: Object.keys(whereFilter).length > 0 ? whereFilter : undefined,
    });

    const ids = queryResult.ids?.[0] ?? [];
    const documents = queryResult.documents?.[0] ?? [];
    const metadatas = queryResult.metadatas?.[0] ?? [];
    const distances = queryResult.distances?.[0] ?? [];

    const results: VectorSearchResult[] = [];
    for (let i = 0; i < ids.length; i++) {
      const document = documents[i];
      if (!document) {
        continue;
      }

      const distance = Number(distances[i] ?? 1);
      const score = Math.max(0, Math.min(1, 1 - distance));

      results.push({
        id: ids[i],
        document,
        metadata: (metadatas[i] as Record<string, unknown>) || {},
        score,
      });
    }

    return results.sort((a, b) => b.score - a.score);
  }

  async close(): Promise<void> {
    this.collection = null;
    this.client = null;
  }
}

class HybridVectorProvider implements IVectorProvider {
  readonly name: VectorProviderName;

  private primaryReady = false;
  private fallbackReady = false;

  constructor(
    private readonly primary: IVectorProvider,
    private readonly fallback?: IVectorProvider,
  ) {
    this.name = primary.name;
  }

  async initialize(): Promise<void> {
    try {
      await this.primary.initialize();
      this.primaryReady = true;
      logger.info({ provider: this.primary.name }, 'Primary vector provider initialized');
    } catch (error) {
      this.primaryReady = false;

      if (!this.fallback) {
        throw error;
      }

      logger.warn(
        {
          provider: this.primary.name,
          error: error instanceof Error ? error.message : String(error),
        },
        'Primary vector provider failed during initialization; fallback will be used',
      );
    }

    if (this.fallback) {
      try {
        await this.fallback.initialize();
        this.fallbackReady = true;
        logger.info({ provider: this.fallback.name }, 'Fallback vector provider initialized');
      } catch (error) {
        this.fallbackReady = false;
        logger.warn(
          {
            provider: this.fallback.name,
            error: error instanceof Error ? error.message : String(error),
          },
          'Fallback vector provider failed to initialize',
        );
      }
    }

    if (!this.primaryReady && !this.fallbackReady) {
      throw new Error('No available vector provider could be initialized');
    }
  }

  async upsertDocument(doc: Document, embeddedChunks: EmbeddedChunk[]): Promise<number> {
    return this.runWithFallback(
      () => this.primary.upsertDocument(doc, embeddedChunks),
      async () => this.fallback?.upsertDocument(doc, embeddedChunks),
      'upsertDocument',
    );
  }

  async similaritySearch(
    queryEmbedding: number[],
    topK: number,
    filters?: VectorSearchFilters,
  ): Promise<VectorSearchResult[]> {
    return this.runWithFallback(
      () => this.primary.similaritySearch(queryEmbedding, topK, filters),
      async () => this.fallback?.similaritySearch(queryEmbedding, topK, filters),
      'similaritySearch',
    );
  }

  async close(): Promise<void> {
    await this.primary.close();
    if (this.fallback) {
      await this.fallback.close();
    }
  }

  private async runWithFallback<T>(
    runPrimary: () => Promise<T>,
    runFallback: () => Promise<T | undefined>,
    operation: string,
  ): Promise<T> {
    if (this.primaryReady) {
      try {
        return await runPrimary();
      } catch (error) {
        logger.warn(
          {
            provider: this.primary.name,
            operation,
            error: error instanceof Error ? error.message : String(error),
          },
          'Primary vector provider operation failed',
        );
      }
    }

    if (this.fallbackReady) {
      try {
        const fallbackResult = await runFallback();
        if (fallbackResult !== undefined) {
          return fallbackResult;
        }
      } catch (fallbackError) {
        logger.warn(
          {
            provider: 'fallback',
            operation,
            error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          },
          'Fallback vector provider also failed',
        );
      }
    }

    throw new Error(`No vector provider available for operation: ${operation}`);
  }
}

export interface VectorProviderConfig {
  provider: VectorProviderName;
  databaseUrl?: string;
  chromaUrl: string;
  collectionName: string;
  embeddingDimensions: number;
  enableFallback: boolean;
}

export function createVectorProvider(config: VectorProviderConfig): IVectorProvider {
  const chromaProvider = new ChromaVectorProvider({
    chromaUrl: config.chromaUrl,
    collectionName: config.collectionName,
  });

  if (config.provider === 'chroma') {
    return chromaProvider;
  }

  if (!config.databaseUrl) {
    if (config.enableFallback) {
      logger.warn('DATABASE_URL missing for pgvector provider, defaulting to Chroma fallback');
      return chromaProvider;
    }

    throw new Error('DATABASE_URL is required when VECTOR_DB_PROVIDER=pgvector');
  }

  const pgProvider = new PgVectorProvider({
    databaseUrl: config.databaseUrl,
    embeddingDimensions: config.embeddingDimensions,
  });

  return new HybridVectorProvider(pgProvider, config.enableFallback ? chromaProvider : undefined);
}

export function createVectorProviderFromEnv(
  env: Partial<Record<string, string | number | boolean | undefined>>,
): IVectorProvider {
  const providerValue = env.VECTOR_DB_PROVIDER;
  const provider: VectorProviderName = providerValue === 'chroma' ? 'chroma' : 'pgvector';

  const databaseUrl = typeof env.DATABASE_URL === 'string' ? env.DATABASE_URL : undefined;
  const chromaUrl = typeof env.CHROMA_URL === 'string' ? env.CHROMA_URL : 'http://localhost:8000';
  const collectionName =
    typeof env.CHROMA_COLLECTION === 'string' ? env.CHROMA_COLLECTION : 'mn_legal_rag';

  const fallback =
    typeof env.VECTOR_DB_FALLBACK === 'boolean'
      ? env.VECTOR_DB_FALLBACK
      : String(env.VECTOR_DB_FALLBACK ?? 'true').toLowerCase() === 'true';

  const dimensionsRaw = Number(env.EMBEDDING_DIMENSION ?? 3072);
  const embeddingDimensions =
    Number.isFinite(dimensionsRaw) && dimensionsRaw > 0 ? dimensionsRaw : 3072;

  return createVectorProvider({
    provider,
    databaseUrl,
    chromaUrl,
    collectionName,
    embeddingDimensions,
    enableFallback: fallback,
  });
}
