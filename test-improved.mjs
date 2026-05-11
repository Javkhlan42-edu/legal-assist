import fetch from 'node-fetch';

const query = {
  message: 'Хүүхэлсүүлэх хүнгүүлэлтүүний нөхцөл',
  conversationId: 'test-improved-001',
};

const response = await fetch('http://localhost:3001/v1/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(query),
});

const result = await response.json();
console.log(JSON.stringify(result, null, 2));
