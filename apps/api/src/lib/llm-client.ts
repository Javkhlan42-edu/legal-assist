// ────────────────────────────────────────────────────────────
// LLM Client — OpenAI API client wrapper
// ────────────────────────────────────────────────────────────

import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

// ── Singleton cache ──
const _clients = new Map<string, OpenAI>();
const _embeddingCache = new Map<string, number[]>();
const MAX_EMBEDDING_CACHE_SIZE = 512;
const OPENAI_EMBEDDING_NATIVE_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
};

function normalizeEmbeddingText(text: string): string {
  return text.replace(/\n/g, ' ').trim();
}

function prepareLocalEmbeddingText(model: string, text: string, kind: 'query' | 'document' = 'query'): string {
  const normalized = normalizeEmbeddingText(text);
  if (!/e5/i.test(model)) {
    return normalized;
  }

  return kind === 'query' ? `query: ${normalized}` : `passage: ${normalized}`;
}

function buildEmbeddingCacheKey(provider: 'openai' | 'local', model: string, dimensions: number, text: string): string {
  return `${provider}:${model}:${dimensions}:${text}`;
}

function getCachedEmbedding(key: string): number[] | undefined {
  const cached = _embeddingCache.get(key);
  return cached ? [...cached] : undefined;
}

function setCachedEmbedding(key: string, embedding: number[]): void {
  if (_embeddingCache.size >= MAX_EMBEDDING_CACHE_SIZE) {
    const firstKey = _embeddingCache.keys().next().value;
    if (typeof firstKey === 'string') {
      _embeddingCache.delete(firstKey);
    }
  }

  _embeddingCache.set(key, [...embedding]);
}

/**
 * Get or create the OpenAI client singleton.
 */
export function getOpenAIClient(apiKey: string, timeoutMs = 120_000): OpenAI {
  const cacheKey = `${apiKey}:${timeoutMs}`;
  const cached = _clients.get(cacheKey);
  if (cached) {
    return cached;
  }

  const client = new OpenAI({ apiKey, maxRetries: 2, timeout: timeoutMs });
  _clients.set(cacheKey, client);
  return client;
}

// ── Embeddings ──────────────────────────────────────────────

/**
 * Embed a single text string via OpenAI. Returns a float vector.
 */
export async function embedQueryOpenAI(
  client: OpenAI,
  model: string,
  dimensions: number,
  text: string,
): Promise<number[]> {
  const normalizedText = prepareLocalEmbeddingText(model, text, 'query');
  const cacheKey = buildEmbeddingCacheKey('openai', model, dimensions, normalizedText);
  const cached = getCachedEmbedding(cacheKey);
  if (cached) {
    return cached;
  }

  const requestDimensions = getOpenAIRequestDimensions(model, dimensions);
  const res = await client.embeddings.create({
    model,
    input: normalizedText,
    ...(typeof requestDimensions === 'number' ? { dimensions: requestDimensions } : {}),
  });
  const embedding = resizeVector(res.data[0].embedding, dimensions);
  setCachedEmbedding(cacheKey, embedding);
  return embedding;
}

export async function embedQueriesOpenAI(
  client: OpenAI,
  model: string,
  dimensions: number,
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  const normalizedTexts = texts.map(normalizeEmbeddingText);
  const requestDimensions = getOpenAIRequestDimensions(model, dimensions);
  const results = new Array<number[] | undefined>(normalizedTexts.length);
  const missingEntries: Array<{ key: string; text: string }> = [];
  const missingIndexByKey = new Map<string, number>();

  normalizedTexts.forEach((text, index) => {
    const key = buildEmbeddingCacheKey('openai', model, dimensions, text);
    const cached = getCachedEmbedding(key);
    if (cached) {
      results[index] = cached;
      return;
    }

    if (!missingIndexByKey.has(key)) {
      missingIndexByKey.set(key, missingEntries.length);
      missingEntries.push({ key, text });
    }
  });

  if (missingEntries.length > 0) {
    const res = await client.embeddings.create({
      model,
      input: missingEntries.map((entry) => entry.text),
      ...(typeof requestDimensions === 'number' ? { dimensions: requestDimensions } : {}),
    });

    missingEntries.forEach((entry, index) => {
      const embedding = resizeVector(res.data[index]?.embedding ?? [], dimensions);
      setCachedEmbedding(entry.key, embedding);
    });
  }

  return normalizedTexts.map((text, index) => {
    const existing = results[index];
    if (existing) {
      return existing;
    }

    const key = buildEmbeddingCacheKey('openai', model, dimensions, text);
    return getCachedEmbedding(key) ?? [];
  });
}

function getOpenAIRequestDimensions(model: string, dimensions: number): number | undefined {
  if (!model.startsWith('text-embedding-3')) {
    return undefined;
  }

  const nativeDimensions = OPENAI_EMBEDDING_NATIVE_DIMENSIONS[model];
  if (!nativeDimensions) {
    return dimensions;
  }

  if (dimensions > 0 && dimensions <= nativeDimensions) {
    return dimensions;
  }

  return undefined;
}

// ── Local Embeddings (Xenova/transformers ONNX) ─────────────

type LocalEmbeddingPipeline = (
  text: string,
  opts: Record<string, unknown>,
) => Promise<{ data: Float32Array }>;

let _localPipe: LocalEmbeddingPipeline | null = null;
let _localPipePromise: Promise<LocalEmbeddingPipeline> | null = null;
let _localPipeModel: string | null = null;

async function getLocalEmbeddingPipeline(model: string): Promise<LocalEmbeddingPipeline> {
  if (_localPipe && _localPipeModel === model) {
    return _localPipe;
  }

  if (!_localPipePromise || _localPipeModel !== model) {
    _localPipeModel = model;
    _localPipePromise = (async () => {
      const { pipeline } = await import('@xenova/transformers');
      const loaded = (await pipeline('feature-extraction', model, {
        quantized: true,
      })) as LocalEmbeddingPipeline;
      console.log(`[local-embed] Model "${model}" loaded.`);
      _localPipe = loaded;
      return loaded;
    })().catch((error) => {
      _localPipePromise = null;
      _localPipe = null;
      throw error;
    });
  }

  return _localPipePromise;
}

function normalise(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

/**
 * Embed a single text string using a local ONNX model.
 * First call downloads/caches the model (~23 MB for MiniLM).
 */
export async function embedQueryLocal(
  model: string,
  dimensions: number,
  text: string,
): Promise<number[]> {
  const normalizedText = normalizeEmbeddingText(text);
  const cacheKey = buildEmbeddingCacheKey('local', model, dimensions, normalizedText);
  const cached = getCachedEmbedding(cacheKey);
  if (cached) {
    return cached;
  }

  const pipe = await getLocalEmbeddingPipeline(model);
  const output = await pipe(normalizedText, { pooling: 'mean', normalize: true });
  const embedding = resizeVector(normalise(Array.from(output.data)), dimensions);
  setCachedEmbedding(cacheKey, embedding);
  return embedding;
}

function resizeVector(vector: number[], dimensions: number): number[] {
  if (!Number.isFinite(dimensions) || dimensions <= 0) {
    return vector;
  }

  if (vector.length === dimensions) {
    return vector;
  }

  if (vector.length > dimensions) {
    return vector.slice(0, dimensions);
  }

  const resized = new Array(dimensions).fill(0);
  for (let i = 0; i < vector.length; i++) {
    resized[i] = vector[i] ?? 0;
  }
  return resized;
}

// ── Chat Completion ─────────────────────────────────────────

export interface ChatCompletionOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatCompletionStreamOptions extends ChatCompletionOptions {
  onDelta?: (delta: string, snapshotText: string) => Promise<void> | void;
}

function usesMaxCompletionTokens(model: string): boolean {
  return /^gpt-5(\.|-|$)/i.test(model.trim());
}

/**
 * Call chat completions and return the assistant text.
 */
export async function chatCompletion(
  client: OpenAI,
  messages: ChatCompletionMessageParam[],
  opts: ChatCompletionOptions,
): Promise<{ text: string; promptTokens: number; completionTokens: number }> {
  const tokenLimit = opts.maxTokens ?? 2048;
  const response = await client.chat.completions.create({
    model: opts.model,
    messages,
    temperature: opts.temperature ?? 0.2,
    ...(usesMaxCompletionTokens(opts.model)
      ? { max_completion_tokens: tokenLimit }
      : { max_tokens: tokenLimit }),
  });

  const choice = response.choices[0];
  const text = choice?.message?.content?.trim() ?? '';

  return {
    text,
    promptTokens: response.usage?.prompt_tokens ?? 0,
    completionTokens: response.usage?.completion_tokens ?? 0,
  };
}

export async function streamChatCompletion(
  client: OpenAI,
  messages: ChatCompletionMessageParam[],
  opts: ChatCompletionStreamOptions,
): Promise<{ text: string; promptTokens: number; completionTokens: number }> {
  const tokenLimit = opts.maxTokens ?? 2048;
  const stream = await client.chat.completions.create({
    model: opts.model,
    messages,
    temperature: opts.temperature ?? 0.2,
    stream: true,
    stream_options: { include_usage: true },
    ...(usesMaxCompletionTokens(opts.model)
      ? { max_completion_tokens: tokenLimit }
      : { max_tokens: tokenLimit }),
  });

  let text = '';
  let promptTokens = 0;
  let completionTokens = 0;

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content ?? '';
    if (delta) {
      text += delta;
      await opts.onDelta?.(delta, text);
    }

    if (chunk.usage) {
      promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
      completionTokens = chunk.usage.completion_tokens ?? completionTokens;
    }
  }

  return {
    text,
    promptTokens,
    completionTokens,
  };
}
