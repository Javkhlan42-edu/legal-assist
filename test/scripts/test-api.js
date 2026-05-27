// Test API endpoint directly
const http = require('http');

const query = 'гэр бүл салалт';

const payload = {
  conversationId: 'test-conv-001',
  message: query,
  history: [],
};

console.log('Request payload:', JSON.stringify(payload, null, 2));

const data = JSON.stringify(payload);

const options = {
  hostname: 'localhost',
  port: 3001,
  path: '/v1/chat',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  },
};

console.log('Options:', options);
console.log('Payload length:', Buffer.byteLength(data));

const req = http.request(options, (res) => {
  console.log(`STATUS: ${res.statusCode}`);
  console.log(`HEADERS:`, res.headers);

  let responseData = '';
  res.on('data', (chunk) => {
    responseData += chunk;
  });

  res.on('end', () => {
    console.log('RESPONSE BODY:');
    try {
      const parsed = JSON.parse(responseData);
      console.log(JSON.stringify(parsed, null, 2));
    } catch (e) {
      console.log(responseData);
    }
  });
});

req.on('error', (e) => {
  console.error(`ERROR: ${e.message}`);
});

req.write(data);
req.end();
