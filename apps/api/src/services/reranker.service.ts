// ────────────────────────────────────────────────────────────
// Reranker Service — Score and reorder retrieved chunks
// ────────────────────────────────────────────────────────────

import { RETRIEVAL_CONFIG } from '@legal-chatbot/shared';
import type { ChromaQueryResult } from '../lib/vector-db.js';
import { extractRetrievalKeywordProfile } from './keyword-extraction.service.js';

/**
 * Interface for the reranker service.
 * Can use cross-encoder, Cohere Rerank, or simple heuristic.
 */
export interface IRerankerService {
  /**
   * Rerank chunks by relevance to the query.
   * Returns top-N chunks with updated scores.
   */
  rerank(query: string, chunks: ChromaQueryResult[], topN?: number): Promise<ChromaQueryResult[]>;
}

/**
 * Reranker Service — Uses heuristic + keyword overlap for reranking.
 * Can be upgraded to cross-encoder in future.
 *
 * Heuristic scoring:
 * - Exact keyword matches (high weight)
 * - Query term overlap in chunk text
 * - Position in original ranking (diversity boost)
 * - Source type (cases + laws ranked higher)
 */
export class RerankerService implements IRerankerService {
  async rerank(
    query: string,
    chunks: ChromaQueryResult[],
    topN: number = RETRIEVAL_CONFIG.TOP_N,
  ): Promise<ChromaQueryResult[]> {
    if (chunks.length === 0) return [];

    console.debug({ queryLen: query.length, chunks: chunks.length }, 'Reranking started');

    // Extract query terms for matching.
    const keywordProfile = extractRetrievalKeywordProfile(query);
    const queryTerms = Array.from(
      new Set([
        ...keywordProfile.topicalTerms,
        ...keywordProfile.phrases.flatMap((phrase) =>
          phrase
            .toLowerCase()
            .replace(/[.,!?;:"'`()\[\]{}]/g, ' ')
            .split(/\s+/)
            .filter((term) => term.length > 1),
        ),
      ]),
    );

    const genericTerms = new Set(['тухай', 'хууль', 'хуульд', 'журам', 'дүрэм', 'заалт', 'зүйл']);
    const signalTerms = queryTerms.filter((term) => !genericTerms.has(term));

    // Score each chunk
    const scored = chunks.map((chunk, originalRank) => {
      let score = chunk.score; // Start with original vector score

      // 1. Keyword overlap scoring
      const chunkText =
        `${String(chunk.metadata?.title ?? chunk.metadata?.documentTitle ?? '')} ${chunk.document ?? ''}`.toLowerCase();
      let keywordMatches = 0;
      let signalMatches = 0;

      for (const term of queryTerms) {
        // Escape special regex characters to prevent "Nothing to repeat" errors
        const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Do not use \b for Cyrillic text; JS word boundaries are ASCII-centric.
        const regex = new RegExp(escapedTerm, 'g');
        const matches = chunkText.match(regex)?.length || 0;
        keywordMatches += matches;

        if (signalTerms.includes(term)) {
          signalMatches += matches;
        }
      }

      // Boost score based on keyword matches with a conservative cap.
      const keywordBoost = Math.min(keywordMatches * 0.03, 0.35);
      score += keywordBoost;

      // If query contains high-signal terms, penalize chunks that only match generic words.
      if (signalTerms.length > 0) {
        if (signalMatches === 0) {
          score *= 0.35;
        } else {
          score += Math.min(signalMatches * 0.08, 0.35);
        }
      }

      // 2. Position diversity boost (penalize if too similar to previous results)
      // Items ranked early are slightly boosted
      const positionBoost = 0.05 * (1 - originalRank / chunks.length);
      score += positionBoost;

      // 3. Source type boost (prioritize formal documents)
      const source = String(chunk.metadata?.source || '');
      if (source === 'legalinfo' || source === 'shuukh') {
        score += 0.05; // Slight boost for official sources
      }

      // Clamp final score to [0, 1]
      return { ...chunk, score: Math.min(Math.max(score, 0), 1) };
    });

    // Sort by reranked score descending
    scored.sort((a, b) => b.score - a.score);

    const avgScore =
      scored.length > 0 ? scored.reduce((sum, c) => sum + c.score, 0) / scored.length : 0;

    // Keep top results and let downstream generation decide how much context is strong enough.
    const safeTopN = Number.isFinite(topN) ? Math.max(1, topN) : RETRIEVAL_CONFIG.TOP_N;
    const finalTopN = Math.max(1, safeTopN);
    const reranked = scored.slice(0, Math.min(finalTopN, scored.length));

    const topDocs = reranked.slice(0, 3).map((c) => ({
      id: c.id,
      score: c.score.toFixed(4),
      source: c.metadata?.source || 'unknown',
    }));

    console.debug(
      {
        originalCount: chunks.length,
        filteredCount: scored.length,
        rerankedCount: reranked.length,
        avgScore: avgScore.toFixed(4),
        minScoreThreshold: 0,
        topDocs,
      },
      'Reranking complete',
    );

    return reranked;
  }
}

export const rerankerService = new RerankerService();
