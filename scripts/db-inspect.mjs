import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const workspaceRoot = resolve(__dirname, '..');
const apiEnvPath = resolve(workspaceRoot, 'apps/api/.env');

loadEnv({ path: apiEnvPath });

const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5433/legal_chatbot';

const client = new pg.Client({ connectionString });

function usage() {
  console.log(`
Usage:
  node scripts/db-inspect.mjs summary
  node scripts/db-inspect.mjs documents [limit]
  node scripts/db-inspect.mjs search <keyword>
  node scripts/db-inspect.mjs law <source_id>
  node scripts/db-inspect.mjs export

Examples:
  node scripts/db-inspect.mjs summary
  node scripts/db-inspect.mjs documents 50
  node scripts/db-inspect.mjs search "ger bul"
  node scripts/db-inspect.mjs law 299
  node scripts/db-inspect.mjs export
`.trim());
}

async function query(sql, params = []) {
  return client.query(sql, params);
}

async function runSummary() {
  const tables = await query(`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `);

  const docs = await query(`
    SELECT
      source,
      COUNT(*)::int AS total_docs,
      COUNT(*) FILTER (WHERE processed_at IS NOT NULL)::int AS processed_docs,
      MAX(created_at) AS latest_created_at
    FROM documents
    GROUP BY source
    ORDER BY total_docs DESC
  `);

  const chunks = await query(`
    SELECT
      COUNT(*)::int AS total_chunks,
      COUNT(DISTINCT document_id)::int AS unique_documents,
      ROUND(AVG(LENGTH(text))::numeric, 2) AS avg_chunk_length
    FROM chunks
  `);

  console.log(`Connected to: ${connectionString}`);
  console.log('\nTables');
  console.table(tables.rows);
  console.log('\nDocuments');
  console.table(docs.rows);
  console.log('\nChunks');
  console.table(chunks.rows);
}

async function runDocuments(limitRaw) {
  const parsedLimit = Number.parseInt(limitRaw ?? '25', 10);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 25;

  const result = await query(
    `
      SELECT
        d.source_id,
        d.title,
        d.url,
        COUNT(c.id)::int AS chunk_count,
        d.created_at
      FROM documents d
      LEFT JOIN chunks c ON c.document_id = d.id
      GROUP BY d.id
      ORDER BY d.created_at DESC, d.title ASC
      LIMIT $1
    `,
    [limit],
  );

  console.table(result.rows);
}

async function runSearch(termParts) {
  const term = termParts.join(' ').trim();
  if (!term) {
    throw new Error('search command requires a keyword');
  }

  const result = await query(
    `
      SELECT
        d.source_id,
        d.title,
        d.url,
        COUNT(c.id)::int AS chunk_count
      FROM documents d
      LEFT JOIN chunks c ON c.document_id = d.id
      WHERE d.title ILIKE $1
      GROUP BY d.id
      ORDER BY d.title ASC
      LIMIT 100
    `,
    [`%${term}%`],
  );

  console.table(result.rows);
}

async function runLaw(sourceId) {
  if (!sourceId?.trim()) {
    throw new Error('law command requires a source_id');
  }

  const documentResult = await query(
    `
      SELECT
        d.id,
        d.source,
        d.source_id,
        d.title,
        d.url,
        d.metadata,
        COUNT(c.id)::int AS chunk_count
      FROM documents d
      LEFT JOIN chunks c ON c.document_id = d.id
      WHERE d.source_id = $1
      GROUP BY d.id
    `,
    [sourceId.trim()],
  );

  if (documentResult.rows.length === 0) {
    console.log(`No document found for source_id=${sourceId}`);
    return;
  }

  const doc = documentResult.rows[0];
  console.log('Document');
  console.log(JSON.stringify(doc, null, 2));

  const chunkResult = await query(
    `
      SELECT
        chunk_index,
        LEFT(text, 400) AS snippet,
        metadata
      FROM chunks
      WHERE document_id = $1
      ORDER BY chunk_index ASC
      LIMIT 5
    `,
    [doc.id],
  );

  console.log('\nFirst 5 chunks');
  console.log(JSON.stringify(chunkResult.rows, null, 2));
}

function toCsvValue(value) {
  const stringValue =
    value === null || value === undefined
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);

  return `"${stringValue.replace(/"/g, '""')}"`;
}

async function runExport() {
  const result = await query(`
    SELECT
      d.id,
      d.source,
      d.source_id,
      d.title,
      d.url,
      d.processed_at,
      d.created_at,
      d.updated_at,
      d.metadata,
      COUNT(c.id)::int AS chunk_count
    FROM documents d
    LEFT JOIN chunks c ON c.document_id = d.id
    GROUP BY d.id
    ORDER BY d.created_at DESC, d.title ASC
  `);

  const jsonPath = resolve(workspaceRoot, 'db-documents-export.json');
  const csvPath = resolve(workspaceRoot, 'db-documents-export.csv');

  await writeFile(
    jsonPath,
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        connectionString,
        totalDocuments: result.rows.length,
        documents: result.rows,
      },
      null,
      2,
    ),
    'utf-8',
  );

  const headers = [
    'id',
    'source',
    'source_id',
    'title',
    'url',
    'chunk_count',
    'processed_at',
    'created_at',
    'updated_at',
    'metadata',
  ];
  const csvLines = [
    headers.join(','),
    ...result.rows.map((row) =>
      headers.map((header) => toCsvValue(row[header])).join(','),
    ),
  ];
  await writeFile(csvPath, csvLines.join('\n'), 'utf-8');

  console.log(`Exported ${result.rows.length} documents`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`CSV:  ${csvPath}`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h') {
    usage();
    return;
  }

  await client.connect();

  try {
    if (command === 'summary') {
      await runSummary();
      return;
    }

    if (command === 'documents') {
      await runDocuments(args[0]);
      return;
    }

    if (command === 'search') {
      await runSearch(args);
      return;
    }

    if (command === 'law') {
      await runLaw(args[0]);
      return;
    }

    if (command === 'export') {
      await runExport();
      return;
    }

    usage();
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
