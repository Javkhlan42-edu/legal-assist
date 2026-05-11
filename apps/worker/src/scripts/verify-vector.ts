// ────────────────────────────────────────────────────────────
// Verify pgvector — connectivity, index, insert, similarity
// ────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { config } from 'dotenv';
import { pgEmbeddingDistanceSql } from '../lib/vector-db.js';

function loadEnv(): void {
  const candidates = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '../../.env'),
    resolve(process.cwd(), '../.env'),
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      config({ path, override: false });
    }
  }
}

function buildVectorLiteral(dimensions: number): string {
  const vector = new Array(dimensions).fill(0);
  vector[0] = 1;
  vector[1] = 0.5;
  vector[2] = 0.25;
  return `[${vector.join(',')}]`;
}

async function verifyVector(): Promise<void> {
  loadEnv();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const dimensions = Number(process.env.EMBEDDING_DIMENSION ?? 3072);
  if (!Number.isFinite(dimensions) || dimensions <= 0 || !Number.isInteger(dimensions)) {
    throw new Error(`Invalid EMBEDDING_DIMENSION: ${process.env.EMBEDDING_DIMENSION ?? ''}`);
  }

  const { similarityExpr, orderExpr } = pgEmbeddingDistanceSql(dimensions);

  const vector = buildVectorLiteral(dimensions);
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 2,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 5000,
  });

  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    console.log('✅ PostgreSQL reachable');

    const extension = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'vector') AS exists`,
    );

    if (!extension.rows[0]?.exists) {
      throw new Error('pgvector extension is missing');
    }
    console.log('✅ pgvector extension enabled');

    const index = await client.query<{ index_name: string | null }>(
      `SELECT to_regclass('public.chunks_embedding_hnsw_idx') AS index_name`,
    );

    if (!index.rows[0]?.index_name) {
      throw new Error('Missing required index: public.chunks_embedding_hnsw_idx');
    }
    console.log(`✅ Vector index found: ${index.rows[0].index_name}`);

    const docId = randomUUID();
    const chunkId = randomUUID();

    await client.query('BEGIN');

    await client.query(
      `INSERT INTO documents (
         id,
         source,
         source_type,
         source_id,
         title,
         url,
         content_hash,
         metadata,
         processed_at,
         updated_at
       ) VALUES (
         $1,
         'legalinfo',
         'legalinfo',
         $2,
         'Vector verification document',
         $3,
         $4,
         $5,
         NOW(),
         NOW()
       )`,
      [
        docId,
        `verify-${Date.now()}`,
        `https://verify.local/vector/${docId}`,
        `hash-${docId}`,
        { purpose: 'verify-vector' },
      ],
    );

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
         vector_provider
       ) VALUES (
         $1,
         $2,
         0,
         'vector verification chunk',
         $3,
         3,
         0,
         25,
         $4,
         $5::vector,
         'verify-model',
         $6,
         'pgvector'
       )`,
      [
        chunkId,
        docId,
        { source: 'legalinfo', sourceId: 'verify' },
        `chunk-hash-${chunkId}`,
        vector,
        dimensions,
      ],
    );

    const similarity = await client.query<{
      id: string;
      similarity: number;
      source_id: string | null;
    }>(
      `SELECT
         c.id,
         ${similarityExpr} AS similarity,
         c.metadata->>'sourceId' AS source_id
       FROM chunks c
       WHERE c.embedding IS NOT NULL
       ORDER BY ${orderExpr}
       LIMIT 3`,
      [vector],
    );

    console.log('✅ Similarity search results:');
    for (const row of similarity.rows) {
      console.log(
        `- chunk=${row.id} similarity=${Number(row.similarity).toFixed(4)} sourceId=${row.source_id ?? '-'}`,
      );
    }

    await client.query('ROLLBACK');
    console.log('✅ verify:vector passed');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

verifyVector().catch((error) => {
  console.error(
    `❌ verify:vector failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
