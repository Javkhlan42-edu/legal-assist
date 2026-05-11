// ────────────────────────────────────────────────────────────
// Vector DB Client — ChromaDB connection factory
// ────────────────────────────────────────────────────────────

import { ChromaClient, type Collection } from 'chromadb';
import { dbQuery } from './db.js';

// ── Singleton cache ──
let _client: ChromaClient | null = null;
const _collections = new Map<string, Collection>();

/**
 * Get or create the ChromaDB client singleton.
 */
export function getChromaClient(url: string): ChromaClient {
  if (!_client) {
    _client = new ChromaClient({ path: url });
  }
  return _client;
}

/**
 * Get a ChromaDB collection by name (cached).
 */
export async function getCollection(url: string, name: string): Promise<Collection> {
  const key = `${url}::${name}`;
  if (!_collections.has(key)) {
    const client = getChromaClient(url);
    const collection = await client.getCollection({ name } as any);
    _collections.set(key, collection);
  }
  return _collections.get(key)!;
}

// ── Query helpers ───────────────────────────────────────────

export interface ChromaQueryResult {
  id: string;
  document: string;
  metadata: Record<string, unknown>;
  /** Cosine similarity score (0–1). Chroma returns distance; we convert. */
  score: number;
  /** Original evidence score before downstream reranking / boosting. */
  rawScore?: number;
}

interface PgVectorQueryRow {
  id: string;
  document: string;
  metadata: Record<string, unknown>;
  score: number;
}

export interface VectorQueryEnv {
  VECTOR_DB_PROVIDER: 'chroma' | 'pgvector';
  CHROMA_URL: string;
  CHROMA_COLLECTION: string;
  /** pgvector: when > 2000, distance must use halfvec to match HNSW index (migration 005). */
  EMBEDDING_DIMENSION?: number;
}

function assertValidEmbeddingDim(dim: number): number {
  if (!Number.isInteger(dim) || dim < 1 || dim > 16_000) {
    throw new Error(`Invalid EMBEDDING_DIMENSION for pgvector query: ${dim}`);
  }
  return dim;
}

/** Cosine distance expression and ORDER BY for chunks.embedding vs query $1 (vector literal text). */
function pgEmbeddingDistanceSql(dim: number): { scoreExpr: string; orderExpr: string } {
  const d = assertValidEmbeddingDim(dim);
  const distanceExpr =
    d > 2000
      ? `c.embedding::halfvec(${d}) <=> ($1::vector)::halfvec(${d})`
      : `c.embedding <=> $1::vector`;
  return {
    orderExpr: distanceExpr,
    scoreExpr: `GREATEST(0::double precision, LEAST(1::double precision, 1 - (${distanceExpr})))`,
  };
}

/**
 * Query a collection with an embedding vector and optional metadata filter.
 * Returns results sorted by descending similarity.
 */
export async function queryCollection(
  collection: Collection,
  embedding: number[],
  nResults: number,
  whereFilter?: Record<string, unknown>,
): Promise<ChromaQueryResult[]> {
  const queryParams: Parameters<Collection['query']>[0] = {
    queryEmbeddings: [embedding],
    nResults,
  };
  if (whereFilter) {
    queryParams.where = whereFilter;
  }

  const raw = await collection.query(queryParams);

  const ids = raw.ids?.[0] ?? [];
  const documents = raw.documents?.[0] ?? [];
  const metadatas = raw.metadatas?.[0] ?? [];
  const distances = raw.distances?.[0] ?? [];

  const results: ChromaQueryResult[] = [];
  for (let i = 0; i < ids.length; i++) {
    const doc = documents[i];
    if (!doc) continue; // skip null documents

    // Chroma cosine distance = 1 - similarity  →  similarity = 1 - distance
    const distance = distances[i] ?? 1;
    const similarity = Math.max(0, Math.min(1, 1 - distance));

    results.push({
      id: ids[i],
      document: doc,
      metadata: (metadatas[i] as Record<string, unknown>) ?? {},
      score: similarity,
      rawScore: similarity,
    });
  }

  return results.sort((a, b) => b.score - a.score);
}

function toPgVectorLiteral(vector: number[]): string {
  const normalized = vector.map((value) => (Number.isFinite(value) ? value : 0));
  return `[${normalized.join(',')}]`;
}

export async function queryPgVector(
  embedding: number[],
  nResults: number,
  whereFilter?: Record<string, unknown>,
  embeddingDimensions = 1536,
): Promise<ChromaQueryResult[]> {
  const { scoreExpr, orderExpr } = pgEmbeddingDistanceSql(embeddingDimensions);
  const values: Array<string | number | null | boolean> = [toPgVectorLiteral(embedding), nResults];
  const whereClauses: string[] = ['c.embedding IS NOT NULL'];

  const source = whereFilter?.source;
  if (typeof source === 'string' && source.length > 0) {
    values.push(source);
    whereClauses.push(`d.source::text = $${values.length}`);
  }

  const sourceId = whereFilter?.sourceId;
  if (typeof sourceId === 'string' && sourceId.length > 0) {
    values.push(sourceId);
    whereClauses.push(`d.source_id = $${values.length}`);
  }

  const lawId = whereFilter?.lawId;
  if (typeof lawId === 'string' && lawId.length > 0) {
    values.push(lawId);
    whereClauses.push(
      `(c.metadata->>'lawId' = $${values.length} OR c.metadata->>'sourceId' = $${values.length})`,
    );
  }

  const caseId = whereFilter?.caseId;
  if (typeof caseId === 'string' && caseId.length > 0) {
    values.push(caseId);
    whereClauses.push(`c.metadata->>'caseId' = $${values.length}`);
  }

  const rows = await dbQuery<PgVectorQueryRow>(
     `SELECT
        c.id,
        c.text AS document,
        c.metadata || jsonb_build_object(
          'title', COALESCE(NULLIF(c.metadata->>'title', ''), NULLIF(c.metadata->>'documentTitle', ''), d.title),
          'documentTitle', COALESCE(NULLIF(c.metadata->>'documentTitle', ''), d.title),
          'url', COALESCE(NULLIF(c.metadata->>'url', ''), NULLIF(c.metadata->>'documentUrl', ''), d.url),
          'documentUrl', COALESCE(NULLIF(c.metadata->>'documentUrl', ''), d.url),
          'source', COALESCE(NULLIF(c.metadata->>'source', ''), d.source::text),
          'sourceId', COALESCE(NULLIF(c.metadata->>'sourceId', ''), d.source_id),
          'caseId', COALESCE(NULLIF(c.metadata->>'caseId', ''), d.metadata->>'caseId', d.source_id),
          'caseNumber', COALESCE(NULLIF(c.metadata->>'caseNumber', ''), d.metadata->>'caseNumber'),
          'court', COALESCE(NULLIF(c.metadata->>'court', ''), d.metadata->>'court'),
          'decisionSummary', COALESCE(NULLIF(c.metadata->>'decisionSummary', ''), d.metadata->>'decisionSummary'),
          'decisionType', COALESCE(NULLIF(c.metadata->>'decisionType', ''), d.metadata->>'decisionType')
        ) AS metadata,
        ${scoreExpr} AS score
      FROM chunks c
     INNER JOIN documents d ON d.id = c.document_id
     WHERE ${whereClauses.join(' AND ')}
     ORDER BY ${orderExpr}
     LIMIT $2`,
    values,
  );

  return rows.map((row) => ({
    id: row.id,
    document: row.document,
    metadata: row.metadata || {},
    score: Number(row.score),
    rawScore: Number(row.score),
  }));
}

export async function queryVectorStore(
  env: VectorQueryEnv,
  embedding: number[],
  nResults: number,
  whereFilter?: Record<string, unknown>,
): Promise<ChromaQueryResult[]> {
  if (env.VECTOR_DB_PROVIDER === 'pgvector') {
    return queryPgVector(embedding, nResults, whereFilter, env.EMBEDDING_DIMENSION ?? 1536);
  }

  const collection = await getCollection(env.CHROMA_URL, env.CHROMA_COLLECTION);
  return queryCollection(collection, embedding, nResults, whereFilter);
}
