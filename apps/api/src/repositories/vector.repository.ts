// ────────────────────────────────────────────────────────────
// Vector Repository — Client for Vector DB operations
// ────────────────────────────────────────────────────────────

import type { ScoredChunk, Chunk } from '@legal-chatbot/shared';

/**
 * Abstract interface for vector database operations.
 * Implementations: ChromaVectorRepository, PgVectorRepository
 */
export interface IVectorRepository {
  /** Search for similar chunks by query embedding */
  search(queryEmbedding: number[], topK: number): Promise<ScoredChunk[]>;

  /** Upsert chunks with their embeddings */
  upsert(chunks: Array<{ chunk: Chunk; embedding: number[] }>): Promise<void>;

  /** Delete all chunks for a document */
  deleteByDocumentId(documentId: string): Promise<void>;

  /** Get total count of stored vectors */
  count(): Promise<number>;
}

/**
 * Stub implementation — no-op.
 * Replace with ChromaDB client or pgvector queries in Step 3/4.
 */
export class VectorRepository implements IVectorRepository {
  async search(_queryEmbedding: number[], _topK: number): Promise<ScoredChunk[]> {
    console.warn('[VectorRepository] Stub — no real vector search');
    return [];
  }

  async upsert(_chunks: Array<{ chunk: Chunk; embedding: number[] }>): Promise<void> {
    console.warn('[VectorRepository] Stub — no real upsert');
  }

  async deleteByDocumentId(_documentId: string): Promise<void> {
    console.warn('[VectorRepository] Stub — no real delete');
  }

  async count(): Promise<number> {
    return 0;
  }
}

export const vectorRepository = new VectorRepository();
