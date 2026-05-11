// ────────────────────────────────────────────────────────────
// Citation Service — Build Source[] from scored chunks
// ────────────────────────────────────────────────────────────

import type { Source, ScoredChunk } from '@legal-chatbot/shared';
import { truncateText } from '@legal-chatbot/shared';

/**
 * Interface for the citation builder service.
 */
export interface ICitationService {
  /**
   * Build a deduplicated Source array from the chunks used in generation.
   */
  buildSources(chunks: ScoredChunk[]): Source[];
}

/**
 * Builds citation sources from scored chunks, deduplicates by document URL.
 */
export class CitationService implements ICitationService {
  buildSources(chunks: ScoredChunk[]): Source[] {
    const seen = new Set<string>();
    const sources: Source[] = [];

    for (const chunk of chunks) {
      const key = chunk.metadata.documentUrl;
      if (seen.has(key)) continue;
      seen.add(key);

      const source: Source = {
        type: chunk.metadata.source,
        title: chunk.metadata.documentTitle,
        url: chunk.metadata.documentUrl,
        snippet: truncateText(chunk.text, 200),
        date: chunk.metadata.documentDate,
      };

      // Add source-specific fields
      if (chunk.metadata.caseId) {
        source.caseId = chunk.metadata.caseId;
      }
      if (chunk.metadata.lawId) {
        source.lawId = chunk.metadata.lawId;
      }
      if (chunk.metadata.articleNo) {
        source.articleNo = chunk.metadata.articleNo;
      }

      sources.push(source);
    }

    return sources;
  }
}

export const citationService = new CitationService();
