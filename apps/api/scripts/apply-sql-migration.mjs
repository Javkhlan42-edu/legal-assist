import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import pg from 'pg';

const { Client } = pg;

const migrationPath = process.argv[2];

if (!migrationPath) {
  console.error('Usage: node scripts/apply-sql-migration.mjs <migration.sql>');
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required to apply SQL migrations.');
  process.exit(1);
}

const resolvedPath = path.resolve(process.cwd(), migrationPath);
const sql = await fs.readFile(resolvedPath, 'utf8');

const client = new Client({ connectionString: databaseUrl });

try {
  await client.connect();
  await client.query(sql);
  console.log(`Applied SQL migration: ${resolvedPath}`);
} finally {
  await client.end();
}
