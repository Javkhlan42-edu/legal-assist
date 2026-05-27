const pg = require('pg');

// Try with SSL disabled
const config = {
  user: 'postgres',
  password: 'postgres',
  host: '127.0.0.1',
  port: 5432,
  database: 'legal_chatbot',
  ssl: false,
  application_name: 'node-pg-test',
};

console.log('Testing PostgreSQL connection with SSL disabled...');
console.log('Config:', { ...config, password: '***' });

const pool = new pg.Pool(config);

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
    pool.end();
  });
