// ────────────────────────────────────────────────────────────
// Config Constants — Chunking, retrieval, and system defaults
// ────────────────────────────────────────────────────────────

/** Chunking configuration */
export const CHUNK_CONFIG = {
  /** Target tokens per chunk */
  TARGET_TOKENS: 512,
  /** Overlap tokens between consecutive chunks */
  OVERLAP_TOKENS: 64,
  /** Maximum tokens per chunk (hard limit) */
  MAX_TOKENS: 600,
  /** Minimum tokens per chunk (discard if smaller) */
  MIN_TOKENS: 50,
} as const;

/** Retrieval configuration */
export const RETRIEVAL_CONFIG = {
  /** Number of candidates to retrieve from vector search */
  TOP_K: 30,
  /** Number of chunks after reranking to pass to LLM */
  TOP_N: 5,
  /** Minimum similarity score threshold (0–1) */
  MIN_SCORE: 0.05,
} as const;

/** Generation configuration */
export const GENERATION_CONFIG = {
  /** Maximum tokens for concise, complete Mongolian legal answers */
  MAX_RESPONSE_TOKENS: 1400,
  /** Temperature for LLM (lower = more deterministic, higher = more creative) */
  TEMPERATURE: 0.3,
  /** Maximum conversation history messages to include */
  MAX_HISTORY_MESSAGES: 4,
} as const;

/** Rate limiting defaults */
export const RATE_LIMIT_DEFAULTS = {
  WINDOW_MS: 60_000,
  MAX_REQUESTS: 10,
} as const;

/** API versioning */
export const API_VERSION = 'v1';
export const API_PREFIX = `/v1`;
