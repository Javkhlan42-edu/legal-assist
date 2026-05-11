// ─────────────────────────────────────────────────────────
// Chroma persistent client wrapper
// ─────────────────────────────────────────────────────────

import { ChromaClient, type Collection, type Metadata } from 'chromadb';

let _client: ChromaClient | null = null;
let _collection: Collection | null = null;

export interface ChromaConfig {
  /** HTTP URL (e.g. http://localhost:8000) or filesystem path for persistent storage */
  chromaPath: string;
  /** Collection name */
  collectionName: string;
}

/**
 * Initialise Chroma — connects via URL (client/server) or local path.
 */
export async function initChroma(cfg: ChromaConfig): Promise<Collection> {
  _client = new ChromaClient({ path: cfg.chromaPath });
  _collection = await _client.getOrCreateCollection({
    name: cfg.collectionName,
    metadata: { 'hnsw:space': 'cosine' },
  });
  console.log(`[chroma] collection "${cfg.collectionName}" ready (${await collectionCount()} docs)`);
  return _collection;
}

/** Get underlying collection (must call initChroma first). */
export function getCollection(): Collection {
  if (!_collection) throw new Error('[chroma] Not initialised — call initChroma() first');
  return _collection;
}

/** Current document count in the collection. */
export async function collectionCount(): Promise<number> {
  return getCollection().count();
}

/**
 * Check which IDs from a list already exist in the collection.
 * Returns a Set of existing IDs.
 */
export async function existingIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const col = getCollection();
  const result = await col.get({ ids, include: [] });
  return new Set(result.ids);
}

/**
 * Upsert a batch of documents with precomputed embeddings.
 */
export async function upsertBatch(
  ids: string[],
  embeddings: number[][],
  documents: string[],
  metadatas: Metadata[],
): Promise<void> {
  const col = getCollection();
  await col.upsert({ ids, embeddings, documents, metadatas });
}
