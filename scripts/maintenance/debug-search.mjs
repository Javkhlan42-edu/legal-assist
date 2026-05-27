// ────────────────────────────────────────────────────────────
// Debug Search Script — Test the retrieval pipeline
// ────────────────────────────────────────────────────────────

import { loadEnv } from '../../apps/api/src/config/env.js';
import { search } from '../../apps/api/src/services/retrieval.service.js';

const env = loadEnv();

const testQueries = [
  `1.1.Энэ хуулийн зорилт нь хуулийн этгээдийг шинээр үүсгэн байгуулах`,
  'зээлийн гэрээ',
  'иргэний тухай хууль',
];

async function main() {
  console.log('🔍 Starting debug search...\n');

  for (const query of testQueries) {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`Query: "${query.slice(0, 50)}..."`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    try {
      const result = await search(env, query);

      console.log('✅ Search result:');
      console.log(`  Context chunks: ${result.contextChunks.length}`);
      console.log(`  Related laws: ${result.relatedLaws.length}`);
      console.log(`  Related cases: ${result.relatedCases.length}`);
      console.log(`  Sources used: ${result.sourcesUsed}`);

      if (result.contextChunks.length > 0) {
        console.log('\n  Top chunks:');
        result.contextChunks.slice(0, 3).forEach((chunk, i) => {
          console.log(`    [${i + 1}] Score: ${chunk.score.toFixed(4)}`);
          console.log(`        Text: ${chunk.document.slice(0, 80)}...`);
        });
      }
    } catch (err) {
      console.error('❌ Error:', err instanceof Error ? err.message : String(err));
    }
  }

  process.exit(0);
}

main();
