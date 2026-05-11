import fetch from 'node-fetch';

const tests = [
  'Хуулийн тухай',
  'Монголын дээд шүүх',
  'Хэргийн үйл явц',
  '2001/75 хуулийн эхний зүйл',
];

for (const message of tests) {
  console.log(`\n\n=== Testing: "${message}" ===`);
  const response = await fetch('http://localhost:3001/v1/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      conversationId: `test-${Date.now()}`,
    }),
  });

  const result = await response.json();
  console.log(`Related Laws: ${result.relatedLaws?.length || 0}`);
  console.log(`Related Cases: ${result.relatedCases?.length || 0}`);

  if (result.relatedLaws?.length > 0) {
    console.log('Laws:');
    result.relatedLaws.forEach((law) => {
      console.log(`  - ${law.title} (score: ${law.score.toFixed(2)})`);
    });
  }

  if (result.relatedCases?.length > 0) {
    console.log('Cases:');
    result.relatedCases.forEach((c) => {
      console.log(`  - Case ${c.caseNumber} (score: ${c.score.toFixed(2)})`);
    });
  }
}
