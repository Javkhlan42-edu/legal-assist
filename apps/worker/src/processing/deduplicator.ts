// ────────────────────────────────────────────────────────────
// Deduplicator — Content-hash based deduplication
// ────────────────────────────────────────────────────────────

import { sha256 } from '@legal-chatbot/shared';
import type { Chunk } from '@legal-chatbot/shared';

/**
 * Deduplicate chunks by content hash.
 * Returns only unique chunks (first occurrence wins).
 */
export function deduplicateChunks(chunks: Chunk[]): Chunk[] {
  const seen = new Set<string>();
  const unique: Chunk[] = [];

  for (const chunk of chunks) {
    if (!seen.has(chunk.contentHash)) {
      seen.add(chunk.contentHash);
      unique.push(chunk);
    }
  }

  return unique;
}

/**
 * Check if a document has changed by comparing content hashes.
 */
export function hasDocumentChanged(newHash: string, existingHash: string | null): boolean {
  if (!existingHash) return true;
  return newHash !== existingHash;
}

/**
 * Compute content hash for a raw document text.
 */
export function computeContentHash(text: string): string {
  return sha256(text);
}
