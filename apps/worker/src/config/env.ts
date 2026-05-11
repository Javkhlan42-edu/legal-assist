// ────────────────────────────────────────────────────────────
// Worker Environment Configuration
// ────────────────────────────────────────────────────────────

import { z } from 'zod';

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }

  return value;
}, z.boolean());

const workerEnvSchema = z
  .object({
    DATABASE_URL: z.string().optional(),
    VECTOR_DB_PROVIDER: z.enum(['chroma', 'pgvector']).default('pgvector'),
    VECTOR_DB_FALLBACK: booleanFromEnv.default(true),
    CHROMA_URL: z.string().default('http://localhost:8000'),
    CHROMA_COLLECTION: z.string().default('mn_legal_rag'),

    EMBEDDING_PROVIDER: z.enum(['openai', 'local']).default('openai'),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
    LOCAL_EMBEDDING_MODEL: z.string().default('Xenova/all-MiniLM-L6-v2'),
    EMBEDDING_DIMENSION: z.coerce.number().int().positive().default(3072),
    EMBEDDING_BATCH_SIZE: z.coerce.number().int().positive().max(512).default(100),
    EMBEDDING_MAX_RETRIES: z.coerce.number().int().min(1).max(10).default(4),
    EMBEDDING_RETRY_BASE_MS: z.coerce.number().int().positive().default(1000),

    CHUNK_SIZE_TOKENS: z.coerce.number().int().positive().default(512),
    CHUNK_OVERLAP_TOKENS: z.coerce.number().int().nonnegative().default(64),

    CRAWL_DELAY_MS: z.coerce.number().int().positive().default(2000),
    CRAWL_MAX_CONCURRENT: z.coerce.number().int().positive().default(1),
    CRAWL_CACHE_DIR: z.string().default('./data/cache'),
    CRAWL_USER_AGENT: z.string().default('LegalRAGBot/0.1'),

    PIPELINE_FAIL_FAST: booleanFromEnv.default(true),
    PIPELINE_MAX_ERROR_RATE: z.coerce.number().min(0).max(1).default(0.3),
    PIPELINE_MAX_CONSECUTIVE_FAILURES: z.coerce.number().int().positive().default(5),
    PIPELINE_MAX_RETRIES_PER_DOC: z.coerce.number().int().min(1).max(10).default(3),
    PIPELINE_RETRY_BASE_MS: z.coerce.number().int().positive().default(750),
    PIPELINE_MIN_HTML_LENGTH: z.coerce.number().int().positive().default(120),
    PIPELINE_MIN_TEXT_LENGTH: z.coerce.number().int().positive().default(120),
    PIPELINE_DEAD_LETTER_DIR: z.string().default('data/processed/dead-letter'),

    LOG_LEVEL: z.string().default('info'),
  })
  .superRefine((data, ctx) => {
    if (data.EMBEDDING_PROVIDER === 'openai' && !data.OPENAI_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPENAI_API_KEY'],
        message: 'OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai',
      });
    }

    if (data.CHUNK_OVERLAP_TOKENS >= data.CHUNK_SIZE_TOKENS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CHUNK_OVERLAP_TOKENS'],
        message: 'CHUNK_OVERLAP_TOKENS must be smaller than CHUNK_SIZE_TOKENS',
      });
    }

    if (data.VECTOR_DB_PROVIDER === 'pgvector' && !data.DATABASE_URL && !data.VECTOR_DB_FALLBACK) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message:
          'DATABASE_URL is required when VECTOR_DB_PROVIDER=pgvector and fallback is disabled',
      });
    }
  });

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

let _env: WorkerEnv | null = null;

export function getWorkerEnv(): WorkerEnv {
  if (_env) return _env;

  const result = workerEnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Invalid worker environment variables:');
    console.error(result.error.format());
    process.exit(1);
  }

  _env = result.data;
  return _env;
}
