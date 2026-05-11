// ────────────────────────────────────────────────────────────
// PostgreSQL Connection & Utilities
// ────────────────────────────────────────────────────────────

import pg from 'pg';
import pino from 'pino';
import { createHash } from 'crypto';

const logger = pino({ name: 'postgres' });

let pool: pg.Pool | null = null;

/**
 * Initialize PostgreSQL connection pool
 */
export async function initPostgres(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;

  logger.info({ databaseUrl: databaseUrl ? 'configured' : 'not set' }, 'Initializing PostgreSQL');

  if (!databaseUrl) {
    logger.warn('DATABASE_URL not set, skipping PostgreSQL initialization');
    return;
  }

  try {
    logger.debug({ databaseUrl }, 'Creating pg.Pool with DATABASE_URL');
    pool = new pg.Pool({ connectionString: databaseUrl });

    logger.debug('Attempting to connect to PostgreSQL');
    // Test connection
    const client = await pool.connect();
    logger.debug('Client connected successfully, executing SELECT NOW()');
    const result = await client.query('SELECT NOW()');
    logger.info({ timestamp: result.rows[0].now }, 'PostgreSQL connection successful');
    client.release();

    logger.info({ host: 'localhost:5432', database: 'legal_chatbot' }, 'Connected to PostgreSQL');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMessage, databaseUrl }, 'Failed to connect to PostgreSQL');
    throw error;
  }
}

/**
 * Execute a query against PostgreSQL
 */
export async function query<T = any>(
  text: string,
  values?: (string | number | null | boolean | object)[],
): Promise<T[]> {
  if (!pool) {
    logger.warn('PostgreSQL pool not initialized');
    return [];
  }

  try {
    const result = await pool.query(text, values);
    return result.rows as T[];
  } catch (error) {
    logger.error({ error, query: text }, 'PostgreSQL query failed');
    throw error;
  }
}

/**
 * Save document to PostgreSQL
 */
export async function saveDocument(doc: {
  id: string;
  source: 'shuukh' | 'legalinfo' | 'other';
  source_id?: string;
  title: string;
  url?: string;
  metadata?: Record<string, any>;
}): Promise<void> {
  await query(
    `INSERT INTO documents (id, source, source_id, title, url, metadata, processed_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title,
       url = EXCLUDED.url,
       metadata = EXCLUDED.metadata,
       updated_at = NOW()`,
    [
      doc.id,
      doc.source,
      doc.source_id || null,
      doc.title,
      doc.url || null,
      JSON.stringify(doc.metadata || {}),
    ],
  );
}

/**
 * Save chunk to PostgreSQL
 */
export async function saveChunk(chunk: {
  id: string;
  document_id: string;
  chunk_index: number;
  text: string;
  metadata?: Record<string, any>;
}): Promise<void> {
  await query(
    `INSERT INTO chunks (id, document_id, chunk_index, text, metadata)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET
       text = EXCLUDED.text,
       metadata = EXCLUDED.metadata,
       updated_at = NOW()`,
    [
      chunk.id,
      chunk.document_id,
      chunk.chunk_index,
      chunk.text,
      JSON.stringify(chunk.metadata || {}),
    ],
  );
}

/**
 * Save document and all its chunks in a transaction
 */
export async function saveDocumentWithChunks(
  doc: {
    id: string;
    source: 'shuukh' | 'legalinfo' | 'other';
    source_id?: string;
    title: string;
    url?: string;
    metadata?: Record<string, any>;
  },
  chunks: Array<{
    id: string;
    chunk_index: number;
    text: string;
    metadata?: Record<string, any>;
  }>,
): Promise<{ documentId: string }> {
  if (!pool) {
    logger.warn('PostgreSQL pool not initialized');
    return { documentId: doc.id };
  }

  const client = await pool.connect();

  // Keep IDs deterministic for idempotent reruns.
  const docId = isValidUUID(doc.id)
    ? doc.id
    : deterministicUuid(`doc:${doc.source}:${doc.source_id ?? ''}:${doc.url ?? ''}:${doc.title}`);

  try {
    await client.query('BEGIN');

    // Insert document
    await client.query(
      `INSERT INTO documents (id, source, source_id, title, url, metadata, processed_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         url = EXCLUDED.url,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
      [
        docId,
        doc.source,
        doc.source_id || null,
        doc.title,
        doc.url || null,
        JSON.stringify(doc.metadata || {}),
      ],
    );

    // Insert chunks - derive deterministic IDs when caller did not provide UUIDs.
    for (const chunk of chunks) {
      const chunkId = isValidUUID(chunk.id)
        ? chunk.id
        : deterministicUuid(`chunk:${docId}:${chunk.chunk_index}:${chunk.text.slice(0, 200)}`);
      await client.query(
        `INSERT INTO chunks (id, document_id, chunk_index, text, metadata)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           text = EXCLUDED.text,
           metadata = EXCLUDED.metadata,
           updated_at = NOW()`,
        [chunkId, docId, chunk.chunk_index, chunk.text, JSON.stringify(chunk.metadata || {})],
      );
    }

    await client.query('COMMIT');
    logger.info({ docId, chunks: chunks.length }, 'Saved document and chunks to PostgreSQL');
    return { documentId: docId };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error({ error, docId }, 'Failed to save document and chunks to PostgreSQL');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Check if a string is a valid UUID
 */
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

function deterministicUuid(input: string): string {
  const hex = createHash('sha256').update(input, 'utf-8').digest('hex').slice(0, 32);
  const variantNibble = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variantNibble}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Close PostgreSQL connection pool
 */
export async function closePostgres(): Promise<void> {
  if (pool) {
    await pool.end();
    logger.info('PostgreSQL connection pool closed');
  }
}
