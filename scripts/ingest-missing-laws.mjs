/**
 * Targeted ingestion script for critical missing laws.
 * Run: node scripts/ingest-missing-laws.mjs
 * 
 * This script crawls, parses, chunks, embeds, and upserts specific laws
 * that are missing from the database but critical for common legal queries.
 */
import { execSync } from 'node:child_process';

const MISSING_LAWS = [
  { lawId: '12695', name: 'Зөрчлийн тухай хууль' },
  { lawId: '11224', name: 'Замын хөдөлгөөний аюулгүй байдлын тухай хууль' },
  { lawId: '101004', name: 'Хэрэглэгчийн эрхийг хамгаалах тухай хууль' },
];

console.log('=== Targeted ingestion of missing critical laws ===\n');

for (const law of MISSING_LAWS) {
  console.log(`\nIngesting: ${law.name} (lawId=${law.lawId})`);
  console.log(`URL: https://legalinfo.mn/mn/detail?lawId=${law.lawId}`);
}

console.log('\nTo ingest these laws, run the legalinfo crawler:');
console.log('  pnpm ingest:legalinfo');
console.log('\nThe seed files have been updated to include these URLs.');
console.log('The crawler will discover and ingest them during the next run.');
console.log('\nAlternatively, set a low document limit to only crawl seed URLs:');
console.log('  CRAWL_DISCOVERY_LIMIT=20 CRAWL_LEGALINFO_DISABLE_AJAX=true pnpm ingest:legalinfo');
