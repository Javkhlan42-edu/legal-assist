// Regenerate chunks.jsonl from PostgreSQL database with proper encoding
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

const pool = new Pool({
  host: 'localhost',
  port: 5433,
  user: 'postgres',
  password: 'postgres',
  database: 'legal_chatbot',
});

async function regenerateChunksJsonL() {
  try {
    const output = fs.createWriteStream(path.resolve('./data/processed/chunks.jsonl'), {
      encoding: 'utf8',
    });

    // Query all chunks with their document info
    const client = await pool.connect();

    const result = await client.query(`
      SELECT 
        c.id as chunkId,
        c.document_id as docId,
        d.source,
        d.url,
        d.title,
        c.chunk_index as chunkIndex,
        c.text,
        c.metadata
      FROM chunks c
      JOIN documents d ON c.document_id = d.id
      ORDER BY d.id, c.chunk_index
    `);

    client.release();

    let lineCount = 0;

    for (const row of result.rows) {
      const metadata =
        typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata || {};

      const chunk = {
        chunkId: row.chunkId,
        docId: row.docId,
        source: row.source,
        url: row.url,
        title: row.title,
        chunkIndex: row.chunkIndex,
        text: row.text,
        snippet: row.text.substring(0, 200),
        keywords: extractKeywords(row.text),
        ...metadata,
      };

      output.write(JSON.stringify(chunk) + '\n');
      lineCount++;
    }

    output.end();

    console.log(`✅ Regenerated chunks.jsonl with ${lineCount} lines`);
  } catch (err) {
    console.error('Error regenerating chunks:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

function extractKeywords(text: string): string[] {
  // Extract first few Mongolian words as keywords
  const words = text.match(/[\u0400-\u04FF]+/g) || [];
  return words.slice(0, 10);
}

regenerateChunksJsonL();
