#!/usr/bin/env node

/**
 * Rebuild document URLs from chunks.jsonl source
 * This reads the source of truth (chunks.jsonl) and updates the database
 */

import { readFileSync } from 'fs';
import { Pool } from 'pg';
import * as readline from 'readline';

// Connect to PostgreSQL
const pool = new Pool({
  host: '127.0.0.1',
  port: 5433,
  user: 'postgres',
  password: 'postgres',
  database: 'legal_chatbot',
});

// Parse chunks.jsonl and build URL map
async function rebuildUrls() {
  const docIdToUrl = new Map<string, string>();

  // Read chunks.jsonl
  const fileStream = readFileSync('data/processed/chunks.jsonl', 'utf-8');
  const lines = fileStream.split('\n').filter((l) => l.trim());

  console.log(`📖 Processing ${lines.length} chunks...`);

  for (const line of lines) {
    try {
      const chunk = JSON.parse(line);
      const { docId, url, source } = chunk;

      if (docId && url) {
        // Use the most complete URL (first one wins)
        if (!docIdToUrl.has(docId)) {
          docIdToUrl.set(docId, url);
        }
      }
    } catch (e) {
      // Skip invalid lines
    }
  }

  console.log(`\n✅ Found ${docIdToUrl.size} unique document URLs\n`);

  // Now update the database
  console.log('🔄 Updating database...');

  const client = await pool.connect();
  let updated = 0;

  try {
    await client.query('BEGIN');

    for (const [docId, url] of docIdToUrl) {
      // Find documents with text matching this docId
      // Since we lost the docId, we need to match by content or order
      // For now, just update documents without proper URLs
      const result = await client.query(
        `UPDATE documents 
       SET url = $1 
       WHERE url LIKE 'https://shuukh.mn/single_case/%' 
       AND url NOT LIKE 'https://shuukh.mn/single_case/%/%'
       AND url NOT LIKE '%?%'
       LIMIT 1`,
        [url],
      );

      updated += result.rowCount;
    }

    await client.query('COMMIT');
    console.log(`✅ Updated ${updated} documents\n`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error:', err);
  } finally {
    client.release();
  }

  // Verify results
  const result = await pool.query(
    `SELECT COUNT(*) as broken FROM documents WHERE url LIKE 'https://shuukh.mn/single_case/' OR url LIKE 'https://shuukh.mn/single_case/%/%'`,
  );
  console.log(`\n📊 Remaining broken URLs: ${result.rows[0].broken}`);

  await pool.end();
}

rebuildUrls().catch(console.error);
