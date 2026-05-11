// ────────────────────────────────────────────────────────────
// Worker CLI Entry Point — commander-based CLI
// ────────────────────────────────────────────────────────────

import { Command } from 'commander';
import { config } from 'dotenv';
import { runIngestionJob } from './jobs/ingest.js';
import { startScheduler } from './scheduler/cron.js';
import { createLogger } from './lib/logger.js';

config(); // Load .env

const logger = createLogger('cli');
const program = new Command();

program
  .name('legal-chatbot-worker')
  .description('Mongolian Legal RAG Chatbot — Ingestion Worker')
  .version('0.1.0');

program
  .command('ingest')
  .description('Run the ingestion pipeline')
  .option('--all', 'Ingest from all sources')
  .option('--source <source>', 'Ingest from a specific source (shuukh | legalinfo)')
  .option('--limit <n>', 'Maximum documents to process', '100')
  .option('--fresh', 'Ignore checkpoints and rediscover URLs from scratch')
  .action(async (opts) => {
    const sources: string[] = [];

    if (opts.all) {
      sources.push('shuukh', 'legalinfo');
    } else if (opts.source) {
      sources.push(opts.source);
    } else {
      logger.error('Specify --all or --source <shuukh|legalinfo>');
      process.exit(1);
    }

    const limit = parseInt(opts.limit, 10);
    const resume = !opts.fresh;
    logger.info({ sources, limit, resume }, 'Starting ingestion');

    try {
      await runIngestionJob({ sources, limit, resume });
      logger.info('Ingestion completed successfully');
    } catch (err) {
      logger.error({ err }, 'Ingestion failed');
      process.exit(1);
    }
  });

program
  .command('schedule')
  .description('Start the cron scheduler for periodic ingestion')
  .action(() => {
    logger.info('Starting cron scheduler');
    startScheduler();
  });

program.parse();
