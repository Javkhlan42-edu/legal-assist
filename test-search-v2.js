const http = require('http');

const request = {
  conversationId: 'test-' + Date.now(),
  message: 'гэр бүл хүүхдийн ирээдүйн асуудал',
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

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    try {
      const response = JSON.parse(data);
      console.log('API Status:', res.statusCode);
      console.log('\nAnswer:', response.answer);
      console.log('\nConfidence:', response.confidence);
      console.log('Related Laws Count:', response.relatedLaws?.length || 0);
      console.log('Related Cases Count:', response.relatedCases?.length || 0);
      console.log('Sources Used:', response.sourcesUsed);

      if (response.relatedLaws?.length > 0) {
        console.log('\nTop Related Law:');
        const law = response.relatedLaws[0];
        console.log('  Title:', law.title);
        console.log('  URL:', law.url);
        console.log('  Relevance:', law.relevance);
      }
    } catch (err) {
      console.error('Failed to parse response:', err.message);
      console.log('Raw response:', data);
    }
  });
});

req.on('error', (e) => {
  console.error('Request error:', e.message);
});

req.write(JSON.stringify(request));
req.end();

console.log('Testing API search with: "гэр бүл хүүхдийн ирээдүйн асуудал"');
console.log('(Family and children future issues)\n');
