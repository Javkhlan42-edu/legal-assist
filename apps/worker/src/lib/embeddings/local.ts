// ─────────────────────────────────────────────────────────
// Local embeddings via @xenova/transformers (ONNX runtime)
// Fully offline — no API key needed.
// ─────────────────────────────────────────────────────────

import { pipeline, type FeatureExtractionPipeline } from '@xenova/transformers';

let _pipe: FeatureExtractionPipeline | null = null;

export interface LocalEmbedConfig {
  model: string; // e.g. "Xenova/all-MiniLM-L6-v2"
}

/**
 * Lazily initialise the feature-extraction pipeline.
 * First call downloads/caches the ONNX model (~23 MB for MiniLM).
 */
async function getPipeline(model: string): Promise<FeatureExtractionPipeline> {
  if (!_pipe) {
    console.log(`[local-embed] Loading model "${model}" (first run downloads ~23 MB)…`);
    _pipe = (await pipeline('feature-extraction', model, {
      quantized: true,
    })) as FeatureExtractionPipeline;
    console.log('[local-embed] Model loaded.');
  }
  return _pipe;
}

/**
 * L2-normalise a vector in-place and return it.
 */
function normalise(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  }
  return vec;
}

/**
 * Embed a batch of texts locally.
 * Uses mean-pooling + L2 normalisation (standard for sentence-transformers).
 * Returns one normalised embedding per input text.
 */
export async function embedBatchLocal(
  texts: string[],
  cfg: LocalEmbedConfig,
): Promise<number[][]> {
  const pipe = await getPipeline(cfg.model);
  const results: number[][] = [];

  // Process texts one at a time to keep memory bounded.
  // @xenova/transformers doesn't truly batch on CPU anyway.
  for (const text of texts) {
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    // output.data is a Float32Array; convert to number[] and normalise as safety net
    const vec = Array.from(output.data as Float32Array);
    results.push(normalise(vec));
  }

  return results;
}
