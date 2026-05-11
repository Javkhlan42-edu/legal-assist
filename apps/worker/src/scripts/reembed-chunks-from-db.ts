#!/usr/bin/env tsx
// ────────────────────────────────────────────────────────────
// Re-embed chunks already in Postgres (no crawl).
// Updates only embedding, embedding_model, embedding_dimensions, vector_provider.
//
// Usage:
//   pnpm --filter @legal-chatbot/worker reembed:db
//   pnpm --filter @legal-chatbot/worker reembed:db -- --all
//   pnpm --filter @legal-chatbot/worker reembed:db -- --limit 500
//   pnpm --filter @legal-chatbot/worker reembed:db -- --source legalinfo
// ────────────────────────────────────────────────────────────

import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Chunk, ChunkMetadata } from '@legal-chatbot/shared';
import { nowISO } from '@legal-chatbot/shared';
import { embeddingService } from '../services/embedding.service.js';
import { createLogger } from '../lib/logger.js';
import { sanitizeText } from '../lib/text_sanitize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../../.env') });

const logger = createLogger('reembed-db');
const MAX_CHARS_PER_CHUNK = Number(process.env.MAX_CHARS_PER_CHUNK ?? 6000);

function parseArgs(argv: string[]): {
  all: boolean;
  limit: number | null;
  source: 'legalinfo' | 'shuukh' | null;
  pageSize: number;
} {
  let all = false;
  let limit: number | null = null;
  let source: 'legalinfo' | 'shuukh' | null = null;
  let pageSize = Number(process.env.REEMBED_PAGE_SIZE ?? 200);
  if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = 200;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') all = true;
    else if (a === '--limit' && argv[i + 1]) {
      limit = parseInt(argv[++i], 10);
      if (!Number.isFinite(limit) || limit < 1) limit = null;
    } else if (a === '--source' && argv[i + 1]) {
      const s = argv[++i].toLowerCase();
      if (s === 'legalinfo' || s === 'shuukh') source = s;
    } else if (a === '--page-size' && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      if (Number.isFinite(n) && n > 0) pageSize = n;
    }
  }
  return { all, limit, source, pageSize };
}

function toPgVectorLiteral(vector: number[]): string {
  const normalized = vector.map((value) => (Number.isFinite(value) ? value : 0));
  return `[${normalized.join(',')}]`;
}

interface ChunkRow {
  id: string;
  document_id: string;
  chunk_index: number;
  text: string;
  metadata: Record<string, unknown>;
  token_count: number | null;
  char_start: number | null;
  char_end: number | null;
  content_hash: string | null;
  created_at: Date | null;
}

function rowToChunk(row: ChunkRow): Chunk {
  const text = row.text ?? '';
  return {
    id: row.id,
    documentId: row.document_id,
    chunkIndex: row.chunk_index,
    text,
    tokenCount: row.token_count ?? 0,
    charOffset: {
      start: row.char_start ?? 0,
      end: row.char_end ?? text.length,
    },
    metadata: row.metadata as unknown as ChunkMetadata,
    contentHash: row.content_hash ?? '',
    createdAt: row.created_at ? row.created_at.toISOString() : nowISO(),
  };
}

function prepareChunkForEmbedding(chunk: Chunk): Chunk {
  const cleaned = sanitizeText(chunk.text ?? '', MAX_CHARS_PER_CHUNK);
  const safeText =
    cleaned.trim() ||
    (chunk.text.length <= MAX_CHARS_PER_CHUNK
      ? chunk.text.trim()
      : chunk.text.slice(0, MAX_CHARS_PER_CHUNK).trim());

  if (safeText === chunk.text) {
    return chunk;
  }

  return {
    ...chunk,
    text: safeText,
  };
}

async function main(): Promise<void> {
  const { all, limit, source, pageSize } = parseArgs(process.argv.slice(2));

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  if ((process.env.EMBEDDING_PROVIDER ?? 'openai') === 'openai' && !process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai');
  }

  logger.info(
    { all, limit, source, pageSize, onlyNull: !all },
    'Starting DB re-embed (no crawl)',
  );

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  /** Only used when --all (stable page); with NULL-only filter, always fetch from start. */
  let offset = 0;
  let totalUpdated = 0;

  try {
    while (true) {
      if (limit !== null && totalUpdated >= limit) break;

      const remaining = limit === null ? pageSize : Math.min(pageSize, limit - totalUpdated);
      if (remaining <= 0) break;

      const nullClause = all ? '' : 'AND c.embedding IS NULL';
      let join = '';
      let sourceClause = '';
      const params: unknown[] = [remaining];
      let sqlLimitOffset = 'LIMIT $1';

      if (all) {
        params.push(offset);
        sqlLimitOffset = 'LIMIT $1 OFFSET $2';
      }

      if (source) {
        join = 'INNER JOIN documents d ON d.id = c.document_id';
        const p = params.length + 1;
        sourceClause = `AND d.source::text = $${p}`;
        params.push(source);
      }

      const sql = `
        SELECT
          c.id,
          c.document_id,
          c.chunk_index,
          c.text,
          c.metadata,
          c.token_count,
          c.char_start,
          c.char_end,
          c.content_hash,
          c.created_at
        FROM chunks c
        ${join}
        WHERE length(trim(c.text)) > 0
          ${nullClause}
          ${sourceClause}
        ORDER BY c.id
        ${sqlLimitOffset}
      `;

      const { rows } = await pool.query<ChunkRow>(sql, params);
      if (rows.length === 0) {
        logger.info({ totalUpdated }, 'No more chunks to process');
        break;
      }

      const chunks = rows.map(rowToChunk);
      const chunksForEmbedding = chunks.map(prepareChunkForEmbedding);
      const adjustedCount = chunksForEmbedding.filter((chunk, index) => chunk.text !== chunks[index]?.text)
        .length;

      if (adjustedCount > 0) {
        logger.warn(
          {
            batch: rows.length,
            adjustedCount,
            maxCharsPerChunk: MAX_CHARS_PER_CHUNK,
          },
          'Sanitized or truncated chunk text before embedding',
        );
      }

      const embedded = await embeddingService.embedChunks(chunksForEmbedding);

      if (embedded.length !== chunksForEmbedding.length) {
        throw new Error(`Embed count mismatch: ${embedded.length} != ${chunksForEmbedding.length}`);
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const item of embedded) {
          await client.query(
            `UPDATE chunks SET
               embedding = $1::vector,
               embedding_model = $2,
               embedding_dimensions = $3,
               vector_provider = 'pgvector',
               updated_at = NOW()
             WHERE id = $4`,
            [
              toPgVectorLiteral(item.embedding.vector),
              item.embedding.model,
              item.embedding.dimensions,
              item.chunk.id,
            ],
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }

      totalUpdated += rows.length;
      if (all) {
        offset += rows.length;
      }

      logger.info(
        { batch: rows.length, totalUpdated, offset: all ? offset : 0 },
        'Batch embedded + updated',
      );
    }

    logger.info({ totalUpdated }, 'Re-embed finished');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, 'reembed-db failed');
  process.exit(1);
});
