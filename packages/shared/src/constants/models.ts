// ────────────────────────────────────────────────────────────
// Model Constants — LLM and embedding model configuration
// ────────────────────────────────────────────────────────────

/** Available chat models */
export const CHAT_MODELS = {
  GPT_4O_MINI: 'gpt-4o-mini',
  GPT_4O: 'gpt-4o',
} as const;

/** Available embedding models */
export const EMBEDDING_MODELS = {
  TEXT_EMBEDDING_3_SMALL: 'text-embedding-3-small',
  TEXT_EMBEDDING_3_LARGE: 'text-embedding-3-large',
} as const;

/** Embedding dimensions per model */
export const EMBEDDING_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
};

/**
 * Default model selections.
 * We keep the stored vector size at 3072 for pgvector compatibility and
 * zero-pad smaller OpenAI embedding outputs where needed.
 */
export const DEFAULT_CHAT_MODEL = CHAT_MODELS.GPT_4O_MINI;
export const DEFAULT_EMBEDDING_MODEL = EMBEDDING_MODELS.TEXT_EMBEDDING_3_SMALL;
export const DEFAULT_EMBEDDING_DIMENSION = 3072;
