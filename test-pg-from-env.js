require('dotenv').config({ path: '.env' });
const pg = require('pg');

const connectionString =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5433/legal_chatbot';

console.log('Testing PostgreSQL connection...');
console.log('Connection string:', connectionString);

const pool = new pg.Pool({ connectionString });

pool
  .connect()
  .then((client) => {
    console.log('✅ Connected successfully!');
    return client.query('SELECT version()').then((res) => {
      console.log('PostgreSQL Version:', res.rows[0].version);
      client.release();
    });
  })
  .then(() => pool.end())
  .catch((err) => {
    console.error('❌ Connection failed:', err.message);
    console.error('Error code:', err.code);
    process.exit(1);
  });
