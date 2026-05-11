const http = require('http');

const request = {
  conversationId: 'test-' + Date.now(),
  message: 'Хуулийн зүйл',  // "Law article" - very basic test
  history: [],
};

const options = {
  hostname: 'localhost',
  port: 3001,
  path: '/v1/chat',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    try {
      const response = JSON.parse(data);
      console.log('Query: "Хуулийн зүйл" (Law article)');
      console.log('Status:', res.statusCode);
      console.log('Sources:', response.sourcesUsed);
      console.log('Confidence:', response.confidence);
      console.log('Answer:', response.answer.substring(0, 300));
    } catch (err) {
      console.error('Parse error:', err.message);
    }
  });
});

req.on('error', (e) => console.error('Error:', e.message));
req.write(JSON.stringify(request));
req.end();
