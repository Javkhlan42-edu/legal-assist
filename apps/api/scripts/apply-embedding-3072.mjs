/**
 * Applies migration 005: chunks.embedding → vector(3072).
 * Loads apps/api/.env for DATABASE_URL.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.join(__dirname, '..');
dotenv.config({ path: path.join(apiRoot, '.env') });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set (apps/api/.env)');
  process.exit(1);
}

const sqlPath = path.join(apiRoot, 'migrations', '005_embedding_vector_3072.sql');
let sql = fs.readFileSync(sqlPath, 'utf8');
sql = sql.replace(/--[^\r\n]*/g, '');
const statements = sql
  .split(';')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  await client.query('BEGIN');
  for (const st of statements) {
    await client.query(st + ';');
  }
  await client.query('COMMIT');
  console.log('OK: migration 005_embedding_vector_3072 applied (%d statements)', statements.length);
} catch (err) {
  await client.query('ROLLBACK');
  console.error('Migration failed:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
