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
      (SELECT COUNT(*)::int FROM documents WHERE source::text = 'shuukh') AS shuukh_documents
  `);
  const counts = rows[0] ?? {};
  console.log(
    `Retrieval DB counts: documents=${counts.documents ?? 0}, chunks=${counts.chunks ?? 0}, legalinfo=${counts.legalinfo_documents ?? 0}, shuukh=${counts.shuukh_documents ?? 0}`,
  );

  if (!counts.documents || !counts.chunks) {
    console.warn('Retrieval DB has no documents/chunks. Restore Postgre retrieval data before production QA.');
  }
} finally {
  await client.end();
}
