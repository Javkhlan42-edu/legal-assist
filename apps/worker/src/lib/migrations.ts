// ────────────────────────────────────────────────────────────
// Worker Migration Runner — Ensure DB schema before ingestion
// ────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATION_FILE_PATTERN = /^\d+.*\.sql$/;
const MIGRATION_LOCK_KEY = 921003;

interface RunMigrationsOptions {
  databaseUrl: string;
  requireVectorIndex?: boolean;
}

function resolveMigrationDirectory(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));

  const candidates = [
    resolve(process.cwd(), 'apps/api/migrations'),
    resolve(process.cwd(), '../api/migrations'),
    resolve(process.cwd(), 'migrations'),
    resolve(currentDir, '../../../api/migrations'),
    resolve(currentDir, '../../migrations'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Migration directory not found. Checked: ${candidates.join(', ')}`);
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

export async function runMigrations(options: RunMigrationsOptions): Promise<void> {
  const migrationDir = resolveMigrationDirectory();
  const pool = new pg.Pool({
    connectionString: options.databaseUrl,
    max: 2,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 5000,
  });

  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const applied = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const appliedByName = new Map(applied.rows.map((row) => [row.name, row.checksum]));

    const files = (await readdir(migrationDir))
      .filter((fileName) => MIGRATION_FILE_PATTERN.test(fileName))
      .sort((a, b) => a.localeCompare(b));

    for (const fileName of files) {
      const filePath = resolve(migrationDir, fileName);
      const sql = await readFile(filePath, 'utf-8');
      const checksum = sha256(sql);
      const existing = appliedByName.get(fileName);

      if (existing) {
        if (existing !== checksum) {
          throw new Error(
            `Migration checksum mismatch for ${fileName}. Existing checksum differs from file content.`,
          );
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations (name, checksum, applied_at)
           VALUES ($1, $2, NOW())`,
          [fileName, checksum],
        );
        await client.query('COMMIT');
        console.log(`✅ Applied migration: ${fileName}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    if (options.requireVectorIndex) {
      const extension = await client.query<{ exists: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'vector') AS exists`,
      );

      if (!extension.rows[0]?.exists) {
        throw new Error('pgvector extension is not enabled');
      }

      const indexCheck = await client.query<{ index_name: string | null }>(
        `SELECT to_regclass('public.chunks_embedding_hnsw_idx') AS index_name`,
      );

      if (!indexCheck.rows[0]?.index_name) {
        throw new Error('Required vector index not found: public.chunks_embedding_hnsw_idx');
      }
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    } catch {
      // no-op
    }

    client.release();
    await pool.end();
  }
}
