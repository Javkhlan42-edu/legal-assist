// ────────────────────────────────────────────────────────────
// API Entry Point — Bootstrap and start Fastify server
// ────────────────────────────────────────────────────────────

import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { initDb } from './lib/db.js';
import { runMigrations } from './lib/migrations.js';

async function main() {
  const env = loadEnv();
  const requiresDatabase = env.VECTOR_DB_PROVIDER === 'pgvector';

  if (requiresDatabase && !env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when VECTOR_DB_PROVIDER=pgvector');
  }

  // Initialize database connection if DATABASE_URL is provided
  if (env.DATABASE_URL) {
    try {
      await runMigrations({
        databaseUrl: env.DATABASE_URL,
        requireVectorIndex: env.VECTOR_DB_PROVIDER === 'pgvector',
      });

      await initDb(env.DATABASE_URL);
    } catch (err) {
      if (requiresDatabase) {
        throw err;
      }

      console.error(
        '⚠️  Failed to initialize PostgreSQL, keyword search will be unavailable:',
        err,
      );
    }
  }

  const app = await buildApp({ env });

  try {
    await app.listen({ port: env.API_PORT, host: env.API_HOST });
    app.log.info(`🚀 API server listening on http://${env.API_HOST}:${env.API_PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
