import pg from 'pg';

const { Client } = pg;
const client = new Client({
  connectionString: 'postgresql://postgres:postgres@127.0.0.1:5433/legal_chatbot',
});

async function runQueries() {
  try {
    await client.connect();
    console.log('✅ Connected to PostgreSQL\n');

    // Query 1: Document Statistics
    console.log('═══════════════════════════════════════════════════════════');
    console.log('📄 DOCUMENTS TABLE - Statistics');
    console.log('═══════════════════════════════════════════════════════════');
    const docs = await client.query(`
      SELECT 
        source,
        COUNT(*) as total_docs,
        COUNT(CASE WHEN processed_at IS NOT NULL THEN 1 END) as processed_count,
        MAX(created_at) as latest_doc
      FROM documents
      GROUP BY source
      ORDER BY total_docs DESC;
    `);
    console.table(docs.rows);

    // Query 2: Top 10 Documents
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('📚 TOP 10 DOCUMENTS by creation date');
    console.log('═══════════════════════════════════════════════════════════');
    const topDocs = await client.query(`
      SELECT 
        id,
        source,
        source_id,
        title,
        created_at
      FROM documents
      ORDER BY created_at DESC
      LIMIT 10;
    `);
    console.table(topDocs.rows);

    // Query 3: Chunks Statistics
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('✂️  CHUNKS TABLE - Statistics');
    console.log('═══════════════════════════════════════════════════════════');
    const chunks = await client.query(`
      SELECT 
        COUNT(*) as total_chunks,
        COUNT(DISTINCT document_id) as unique_documents,
        ROUND(AVG(length(text))::numeric, 2) as avg_chunk_length,
        MAX(length(text)) as max_chunk_length,
        MIN(length(text)) as min_chunk_length
      FROM chunks;
    `);
    console.table(chunks.rows);

    // Query 4: Chunks per Document
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('📊 TOP 10 DOCUMENTS by chunk count');
    console.log('═══════════════════════════════════════════════════════════');
    const chunksPerDoc = await client.query(`
      SELECT 
        d.title,
        d.source,
        COUNT(c.id) as chunk_count,
        ROUND(AVG(length(c.text))::numeric, 0) as avg_chunk_size
      FROM documents d
      LEFT JOIN chunks c ON d.id = c.document_id
      GROUP BY d.id, d.title, d.source
      ORDER BY chunk_count DESC
      LIMIT 10;
    `);
    console.table(chunksPerDoc.rows);

    // Query 5: Conversations Statistics
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('💬 CONVERSATIONS TABLE - Statistics');
    console.log('═══════════════════════════════════════════════════════════');
    const convStats = await client.query(`
      SELECT 
        COUNT(DISTINCT c.id) as total_conversations,
        COUNT(m.id) as total_messages,
        ROUND(AVG(msg_per_conv)::numeric, 2) as avg_messages_per_conv,
        MAX(msg_per_conv) as max_messages_in_conv
      FROM conversations c
      LEFT JOIN (
        SELECT conversation_id, COUNT(*) as msg_per_conv
        FROM messages
        GROUP BY conversation_id
      ) conv_stats ON c.id = conv_stats.conversation_id
      LEFT JOIN messages m ON c.id = m.conversation_id;
    `);
    console.table(convStats.rows);

    // Query 6: Recent Conversations with Message Count
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('🕐 TOP 10 RECENT CONVERSATIONS');
    console.log('═══════════════════════════════════════════════════════════');
    const recentConvs = await client.query(`
      SELECT 
        c.id,
        c.title,
        COUNT(m.id) as message_count,
        c.created_at,
        c.updated_at
      FROM conversations c
      LEFT JOIN messages m ON c.id = m.conversation_id
      GROUP BY c.id
      ORDER BY c.created_at DESC
      LIMIT 10;
    `);
    console.table(recentConvs.rows);

    // Query 7: Messages by Role
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('👥 MESSAGES by Role');
    console.log('═══════════════════════════════════════════════════════════');
    const msgByRole = await client.query(`
      SELECT 
        role,
        COUNT(*) as message_count,
        ROUND(AVG(length(content))::numeric, 0) as avg_content_length
      FROM messages
      GROUP BY role
      ORDER BY message_count DESC;
    `);
    console.table(msgByRole.rows);

    // Query 8: Top Articles Referenced
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('⚖️  TOP 15 ARTICLES REFERENCED in chunks');
    console.log('═══════════════════════════════════════════════════════════');
    const topArticles = await client.query(`
      SELECT 
        (metadata->>'articleNo') as article_no,
        (metadata->>'lawId') as law_id,
        (metadata->>'title') as law_title,
        COUNT(*) as chunk_count
      FROM chunks
      WHERE metadata->>'articleNo' IS NOT NULL
      GROUP BY article_no, law_id, law_title
      ORDER BY chunk_count DESC
      LIMIT 15;
    `);
    console.table(topArticles.rows);

    // Query 9: Document Metadata Sample
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('🏷️  DOCUMENT METADATA SAMPLES');
    console.log('═══════════════════════════════════════════════════════════');
    const metaSamples = await client.query(`
      SELECT 
        source,
        title,
        metadata as metadata_json
      FROM documents
      WHERE metadata IS NOT NULL AND metadata != '{}'::jsonb
      LIMIT 5;
    `);
    for (const row of metaSamples.rows) {
      console.log(`\n📋 ${row.source.toUpperCase()}: ${row.title}`);
      console.log('   Metadata:', JSON.stringify(row.metadata_json, null, 2));
    }

    // Query 10: Database Size
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('💾 DATABASE STORAGE');
    console.log('═══════════════════════════════════════════════════════════');
    const dbSize = await client.query(`
      SELECT 
        schemaname,
        tablename,
        ROUND(pg_total_relation_size(schemaname||'.'||tablename) / 1024.0 / 1024.0, 2) as size_mb
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
    `);
    console.table(dbSize.rows);

    console.log('\n✅ All queries completed successfully!\n');
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runQueries();
