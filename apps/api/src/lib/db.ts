// ────────────────────────────────────────────────────────────
// Database Client — PostgreSQL connection pool
// ────────────────────────────────────────────────────────────

/**
 * Simple PostgreSQL connection pool using native node-postgres.
 * Handles:
 * - Connection pooling
 * - Graceful shutdown
 * - Query execution
 */

let pool: any = null;

/**
 * Initialize PostgreSQL connection pool from DATABASE_URL.
 * Call this once on app startup.
 */
export async function initDb(databaseUrl: string): Promise<void> {
  try {
    const { Pool } = await import('pg');

    pool = new Pool({
      connectionString: databaseUrl,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    // Test connection
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();

    console.log('✅ PostgreSQL pool initialized');
  } catch (err) {
    console.error('❌ Failed to initialize PostgreSQL:', err);
    throw err;
  }
}

/**
 * Get a client from the pool for executing queries.
 */
export async function dbQuery<T = any>(
  text: string,
  values?: (string | number | null | boolean)[],
): Promise<T[]> {
  if (!pool) {
    throw new Error('Database not initialized. Call initDb() first.');
  }

  try {
    const result = await pool.query(text, values);
    return result.rows;
  } catch (err) {
    console.error('Database query failed:', { text, values, err });
    throw err;
  }
}

/**
 * Execute a transaction with multiple queries.
 */
export async function dbTransaction<T>(
  callback: (query: typeof dbQuery) => Promise<T>,
): Promise<T> {
  if (!pool) {
    throw new Error('Database not initialized');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create a query function that uses this client
    const txQuery = async (text: string, values?: any[]) => {
      return (await client.query(text, values)).rows;
    };

    const result = await callback(txQuery);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Close the pool gracefully on shutdown.
 */
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    console.log('PostgreSQL pool closed');
  }
}

/**
 * Get pool directly (for advanced usage).
 */
export function getPool() {
  if (!pool) {
    throw new Error('Database not initialized');
  }
  return pool;
}
