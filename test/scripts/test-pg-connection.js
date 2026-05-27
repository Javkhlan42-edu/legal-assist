const pg = require('pg');

const connectionString =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/legal_chatbot';

console.log('Testing PostgreSQL connection...');
console.log('Connection string:', connectionString);

const pool = new pg.Pool({ connectionString });

pool
  .connect()
  .then((client) => {
    console.log('✅ Connected successfully!');
    client.release();
    pool.end();
  })
  .catch((err) => {
    console.error('❌ Connection failed:', err.message);
    console.error('Full error:', err);
    pool.end();
  });
