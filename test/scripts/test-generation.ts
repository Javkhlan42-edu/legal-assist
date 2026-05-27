import { generate } from './apps/api/src/services/generation.service.js';
import { loadEnv } from './apps/api/src/config/env.js';

async function test() {
  const env = loadEnv();

  const mockChunks = [
    {
      id: 'test-1',
      document: 'Иргэний тухай хуулийн 1-р зүйлд...',
      metadata: {
        source: 'legalinfo',
        title: 'Иргэний тухай хууль',
        articleNo: '1',
        url: 'https://legalinfo.mn/detail?lawId=1',
      },
      score: 0.85,
    },
  ];

  try {
    console.log('Testing generation service with mock context...');
    const result = await generate(env, 'Иргэний үзэл гэж юу вэ?', mockChunks, []);
    console.log('Generation result:', result);
  } catch (err) {
    console.error('Generation error:', err);
  }
}

test();
