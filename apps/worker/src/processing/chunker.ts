// ────────────────────────────────────────────────────────────
// Chunker — Split text into overlapping chunks
// ────────────────────────────────────────────────────────────

import { CHUNK_CONFIG } from '@legal-chatbot/shared';
import type { Chunk, ChunkMetadata, ParsedDocument } from '@legal-chatbot/shared';
import { sha256, nowISO } from '@legal-chatbot/shared';
import { randomUUID } from 'crypto';

interface ChunkerOptions {
  targetTokens?: number;
  overlapTokens?: number;
  maxTokens?: number;
  minTokens?: number;
}

/**
 * Split a parsed document into overlapping chunks.
 *
 * Strategy:
 * 1. Split text by paragraphs/sentences
 * 2. Accumulate until target token count
 * 3. Create chunk with overlap from previous chunk
 * 4. Respect paragraph/section boundaries where possible
 *
 * NOTE: Token counting uses a rough estimate (chars/4) for MVP.
 * Replace with tiktoken for accurate counts in Step 3.
 */
export function chunkDocument(
  doc: ParsedDocument,
  documentId: string,
  options: ChunkerOptions = {},
): Chunk[] {
  const {
    overlapTokens = CHUNK_CONFIG.OVERLAP_TOKENS,
    maxTokens = CHUNK_CONFIG.MAX_TOKENS,
    minTokens = CHUNK_CONFIG.MIN_TOKENS,
  } = options;

  const text = doc.cleanedText;
  if (!text.trim()) return [];

  // Split by paragraphs (double newline) or single newlines
  const paragraphs = text.split(/\n\n+/).filter((p) => p.trim().length > 0);

  const chunks: Chunk[] = [];
  let currentText = '';
  let currentStart = 0;
  let charPos = 0;
  let chunkIndex = 0;

  const metadata: ChunkMetadata = {
    source: doc.source,
    documentTitle: doc.title,
    documentUrl: doc.url,
    documentDate: doc.date,
    caseId: doc.metadata.caseId,
    lawId: doc.metadata.lawId,
    articleNo: doc.metadata.articleNo,
  };

  for (const paragraph of paragraphs) {
    // If adding this paragraph exceeds max, flush current chunk
    if (estimateTokens(currentText + ' ' + paragraph) > maxTokens && currentText.length > 0) {
      if (estimateTokens(currentText) >= minTokens) {
        chunks.push(
          createChunk(currentText, chunkIndex, documentId, currentStart, charPos, metadata),
        );
        chunkIndex++;
      }

      // Overlap: keep tail of previous chunk
      const overlapText = getOverlapTail(currentText, overlapTokens);
      currentText = overlapText + ' ' + paragraph;
      currentStart = charPos - overlapText.length;
    } else {
      if (currentText.length === 0) {
        currentStart = charPos;
        currentText = paragraph;
      } else {
        currentText += '\n\n' + paragraph;
      }
    }

    charPos += paragraph.length + 2; // +2 for \n\n separator
  }

  // Final chunk
  if (currentText.trim().length > 0 && estimateTokens(currentText) >= minTokens) {
    chunks.push(createChunk(currentText, chunkIndex, documentId, currentStart, charPos, metadata));
  }

  return chunks;
}

function createChunk(
  text: string,
  index: number,
  documentId: string,
  charStart: number,
  charEnd: number,
  metadata: ChunkMetadata,
): Chunk {
  return {
    id: randomUUID(),
    documentId,
    chunkIndex: index,
    text: text.trim(),
    tokenCount: estimateTokens(text),
    charOffset: { start: charStart, end: charEnd },
    metadata,
    contentHash: sha256(text.trim()),
    createdAt: nowISO(),
  };
}

/**
 * Rough token estimate: ~4 characters per token for Mongolian Cyrillic.
 * TODO: Replace with tiktoken in Step 3 for accurate counts.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Get the tail of a text that is approximately `tokens` tokens long.
 */
function getOverlapTail(text: string, tokens: number): string {
  const charCount = tokens * 4;
  if (text.length <= charCount) return text;
  return text.slice(-charCount);
}
