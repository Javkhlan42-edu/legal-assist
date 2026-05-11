// ────────────────────────────────────────────────────────────
// Cron Scheduler — Periodic ingestion scheduling
// ────────────────────────────────────────────────────────────

import cron from 'node-cron';
import { runIngestionJob } from '../jobs/ingest.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('scheduler');

/**
 * Start the cron scheduler for periodic ingestion.
 *
 * Schedule:
 * - Every day at 2:00 AM UTC — full ingestion
 * - Can be customized via env vars
 */
export function startScheduler(): void {
  // Daily full ingestion at 2:00 AM
  cron.schedule('0 2 * * *', async () => {
    logger.info('Scheduled ingestion starting');
    try {
      await runIngestionJob({ sources: ['shuukh', 'legalinfo'], limit: 500 });
      logger.info('Scheduled ingestion completed');
    } catch (err) {
      logger.error({ err }, 'Scheduled ingestion failed');
    }
  });

  logger.info('Cron scheduler started. Next run: daily at 02:00 UTC');

  // Keep process alive
  process.on('SIGINT', () => {
    logger.info('Scheduler shutting down');
    process.exit(0);
  });
}
