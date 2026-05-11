// ────────────────────────────────────────────────────────────
// Environment Configuration — Load and validate env vars
// ────────────────────────────────────────────────────────────

import { config } from 'dotenv';
import { z } from 'zod';

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }

    if (['0', 'false', 'no', 'off', ''].includes(normalized)) {
      return false;
    }
  }

  return value;
}, z.boolean());

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    API_PORT: z.coerce.number().int().positive().default(3001),
    API_HOST: z.string().default('0.0.0.0'),
    CORS_ORIGIN: z
      .string()
      .default(
        'http://localhost:3000,http://127.0.0.1:3000,http://localhost:3002,http://127.0.0.1:3002',
      ),
    DATABASE_URL: z.string().url().optional(),
    VECTOR_DB_PROVIDER: z.enum(['chroma', 'pgvector']).default('pgvector'),
    CHROMA_URL: z.string().default('http://localhost:8000'),
    CHROMA_COLLECTION: z.string().default('mn_legal_rag'),
    EMBEDDING_PROVIDER: z.enum(['openai', 'local']).default('openai'),
    LOCAL_EMBEDDING_MODEL: z.string().default('Xenova/all-MiniLM-L6-v2'),
    EMBEDDING_DIMENSION: z.coerce.number().int().positive().default(3072),
    OPENAI_API_KEY: z.string().default(''),
    OPENAI_CHAT_MODEL: z.string().default('gpt-5.4'),
    OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
    OPENAI_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
    RETRIEVAL_SPEED_MODE: z.enum(['fast', 'balanced', 'quality']).default('fast'),
    INCLUDE_RELATED_CASES: z.enum(['auto', 'always', 'never']).default('auto'),
    RETRIEVAL_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
    GENERATION_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
    RESPONSE_LATENCY_BUDGET_MS: z.coerce.number().int().positive().default(150000),
    USE_CROSS_RERANKER: booleanFromEnv.default(false),
    CROSS_RERANKER_MODEL: z.string().default('BAAI/bge-reranker-v2-m3'),
    CROSS_RERANKER_TOP_N: z.coerce.number().int().positive().default(20),
    JWT_SECRET: z.string().min(16).default('local-dev-jwt-secret-change-me'),
    GOOGLE_CLIENT_ID: z.string().default(''),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
    RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(10),
  })
  .superRefine((data, ctx) => {
    if (data.VECTOR_DB_PROVIDER === 'pgvector' && !data.DATABASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message: 'DATABASE_URL is required when VECTOR_DB_PROVIDER=pgvector',
      });
    }
  });

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(): AppEnv {
  config(); // Load .env file
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('❌ Invalid environment variables:');
    console.error(result.error.format());
    process.exit(1);
  }

  return result.data;
}
