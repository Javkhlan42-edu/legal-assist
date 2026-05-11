// ─────────────────────────────────────────────────────────
// OpenAI embeddings with retries & batching
// ─────────────────────────────────────────────────────────

import OpenAI from 'openai';

export interface OpenAIEmbedConfig {
  apiKey: string;
  model: string;
  /** Max texts per API call (OpenAI supports up to ~2048) */
  batchSize: number;
  /** Max retries for transient errors (429 / 5xx) */
  maxRetries?: number;
}

let _openai: OpenAI | null = null;

function client(apiKey: string): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey });
  return _openai;
}

/**
 * Sleep helper for exponential backoff.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Embed a batch of texts via OpenAI with exponential backoff.
 * Returns one embedding vector per input text, in the same order.
 */
export async function embedBatchOpenAI(
  texts: string[],
  cfg: OpenAIEmbedConfig,
): Promise<number[][]> {
  const maxRetries = cfg.maxRetries ?? 5;
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await client(cfg.apiKey).embeddings.create({
        model: cfg.model,
        input: texts,
      });

      // OpenAI may return embeddings out of order — sort by index
      const sorted = res.data.sort((a, b) => a.index - b.index);
      return sorted.map((d) => d.embedding);
    } catch (err: unknown) {
      lastErr = err instanceof Error ? err : new Error(String(err));

      // Determine if retryable
      const status = (err as { status?: number }).status;
      const retryable = status === 429 || (status !== undefined && status >= 500);

      if (!retryable || attempt === maxRetries) {
        throw lastErr;
      }

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s
      const delayMs = Math.min(1000 * Math.pow(2, attempt), 30_000);
      console.warn(`[openai] Retry ${attempt + 1}/${maxRetries} after ${delayMs}ms (status=${status})`);
      await sleep(delayMs);
    }
  }

  throw lastErr ?? new Error('[openai] embed failed');
}
