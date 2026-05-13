import OpenAI from 'openai';

const bool = (value) => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());

const model = process.env.OPENAI_CHAT_MODEL || 'gpt-5.4';
const apiKey = process.env.OPENAI_API_KEY?.trim() ?? '';
const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS || 180000);

const runtimeSummary = {
  nodeEnv: process.env.NODE_ENV || '',
  vectorDbProvider: process.env.VECTOR_DB_PROVIDER || '',
  vectorDbFallback: process.env.VECTOR_DB_FALLBACK || '',
  embeddingProvider: process.env.EMBEDDING_PROVIDER || '',
  embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || '',
  embeddingDimension: process.env.EMBEDDING_DIMENSION || '',
  chatModel: model,
  retrievalSpeedMode: process.env.RETRIEVAL_SPEED_MODE || '',
  retrievalTimeoutMs: process.env.RETRIEVAL_TIMEOUT_MS || '',
  generationTimeoutMs: process.env.GENERATION_TIMEOUT_MS || '',
  responseLatencyBudgetMs: process.env.RESPONSE_LATENCY_BUDGET_MS || '',
  openaiKeyConfigured: apiKey.length > 0,
};

console.log('Runtime config summary:');
console.log(JSON.stringify(runtimeSummary, null, 2));

if (!apiKey || apiKey.length < 20) {
  console.error(
    'OPENAI_API_KEY is missing or too short in the runtime container. Production would fall back to deterministic template answers.',
  );
  process.exit(1);
}

if (process.env.OPENAI_DEPLOY_SMOKE_TEST === 'false') {
  console.log('OpenAI chat smoke test skipped because OPENAI_DEPLOY_SMOKE_TEST=false.');
  process.exit(0);
}

const client = new OpenAI({
  apiKey,
  timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 180000,
  maxRetries: 1,
});

const isGpt5Family = /^gpt-5(?:[.-]|$)/i.test(model);

try {
  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content: 'Reply with the single word OK.',
      },
      {
        role: 'user',
        content: 'ping',
      },
    ],
    ...(isGpt5Family ? { max_completion_tokens: 16 } : { max_tokens: 16 }),
  });

  const content = response.choices?.[0]?.message?.content?.trim() ?? '';
  if (!content) {
    throw new Error('OpenAI returned an empty smoke-test response.');
  }

  console.log(`OpenAI chat smoke test: ok model=${model} responseChars=${content.length}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`OpenAI chat smoke test failed for model=${model}: ${message}`);
  process.exit(1);
}
