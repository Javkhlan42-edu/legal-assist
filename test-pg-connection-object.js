const pg = require('pg');

// Try with object config instead of connection string
const config = {
  user: 'postgres',
  password: 'postgres',
  host: '127.0.0.1',
  port: 5432,
  database: 'legal_chatbot',
};

console.log('Testing PostgreSQL connection with object config...');
console.log('Config:', { ...config, password: '***' });

const pool = new pg.Pool(config);

pool
  .connect()
  .then((client) => {
    console.log('✅ Connected successfully!');
    client.release();
    pool.end();
  })
  .catch((err) => {
    console.error('❌ Connection failed:', err.message);
    console.error('Error code:', err.code);
    pool.end();
  });
