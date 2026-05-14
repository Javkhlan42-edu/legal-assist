import process from 'node:process';
import pg from 'pg';

const { Client } = pg;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required to check retrieval DB.');
  process.exit(1);
}

const client = new Client({ connectionString: process.env.DATABASE_URL });

try {
  await client.connect();
  const { rows } = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM documents) AS documents,
      (SELECT COUNT(*)::int FROM chunks) AS chunks,
      (SELECT COUNT(*)::int FROM documents WHERE source::text = 'legalinfo') AS legalinfo_documents,
      (SELECT COUNT(*)::int FROM documents WHERE source::text = 'shuukh') AS shuukh_documents,
      (SELECT to_regclass('public.retrieval_cache') IS NOT NULL) AS retrieval_cache_exists
  `);
  const counts = rows[0] ?? {};
  let retrievalCacheEntries = 0;
  if (counts.retrieval_cache_exists) {
    const cacheRows = await client.query(`SELECT COUNT(*)::int AS entries FROM retrieval_cache`);
    retrievalCacheEntries = cacheRows.rows[0]?.entries ?? 0;
  }
  console.log(
    `Retrieval DB counts: documents=${counts.documents ?? 0}, chunks=${counts.chunks ?? 0}, legalinfo=${counts.legalinfo_documents ?? 0}, shuukh=${counts.shuukh_documents ?? 0}, retrieval_cache_exists=${counts.retrieval_cache_exists ?? false}, retrieval_cache_entries=${retrievalCacheEntries}`,
  );

  if (!counts.documents || !counts.chunks) {
    console.warn('Retrieval DB has no documents/chunks. Restore Postgre retrieval data before production QA.');
  }

  if (!counts.retrieval_cache_exists) {
    console.error(
      'retrieval_cache table is missing. Run migrations/008_create_retrieval_cache.sql before serving production traffic.',
    );
    process.exit(1);
  }
} finally {
  await client.end();
}
