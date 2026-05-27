import OpenAI from 'openai';
import pg from 'pg';

const { Client } = pg;

const bool = (value) => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());

const model = process.env.OPENAI_CHAT_MODEL || 'gpt-5.4';
const apiKey = process.env.OPENAI_API_KEY?.trim() ?? '';
const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS || 180000);
const openaiKeyLooksUsable =
  apiKey.startsWith('sk-') &&
  apiKey.length >= 40 &&
  !apiKey.includes('your-production-key') &&
  !apiKey.includes('...');

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
  retrievalCacheEnabled: bool(process.env.RETRIEVAL_CACHE_ENABLED ?? 'true'),
  retrievalCacheTtlSeconds: process.env.RETRIEVAL_CACHE_TTL_SECONDS || '',
  retrievalCacheMinQuality: process.env.RETRIEVAL_CACHE_MIN_QUALITY || '',
  retrievalCacheVersion: process.env.RETRIEVAL_CACHE_VERSION || '',
  databaseConfigured: Boolean(process.env.DATABASE_URL),
  openaiKeyConfigured: apiKey.length > 0,
  openaiKeyLooksUsable,
};

console.log('Runtime config summary:');
console.log(JSON.stringify(runtimeSummary, null, 2));

if (!openaiKeyLooksUsable) {
  console.error(
    'OPENAI_API_KEY is missing, too short, or placeholder-like in the runtime container. Production would fall back to deterministic template answers.',
  );
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is missing; retrieval cache table cannot be verified.');
  process.exit(1);
}

const dbClient = new Client({ connectionString: process.env.DATABASE_URL });
try {
  await dbClient.connect();
  const { rows } = await dbClient.query(`
    SELECT to_regclass('public.retrieval_cache') IS NOT NULL AS retrieval_cache_exists
  `);
  const cacheStatus = rows[0] ?? {};
  let retrievalCacheEntries = 0;
  if (cacheStatus.retrieval_cache_exists) {
    const cacheRows = await dbClient.query(`SELECT COUNT(*)::int AS entries FROM retrieval_cache`);
    retrievalCacheEntries = cacheRows.rows[0]?.entries ?? 0;
  }
  console.log('Retrieval cache DB status:');
  console.log(
    JSON.stringify(
      {
        retrieval_cache_exists: cacheStatus.retrieval_cache_exists ?? false,
        retrieval_cache_entries: retrievalCacheEntries,
      },
      null,
      2,
    ),
  );

  if (!cacheStatus.retrieval_cache_exists) {
    console.error(
      'retrieval_cache table is missing. Deploy migration 008_create_retrieval_cache.sql before using production cache.',
    );
    process.exit(1);
  }
} finally {
  await dbClient.end();
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
