// ────────────────────────────────────────────────────────────
// RRF Service — Reciprocal Rank Fusion for Hybrid RAG
// ────────────────────────────────────────────────────────────

import type { ChromaQueryResult } from '../lib/vector-db.js';
import type { KeywordSearchResult } from './keyword-search.service.js';

export interface RRFResult {
  id: string;
  documentId: string;
  text: string;
  vectorScore: number;
  keywordScore: number;
  rrfScore: number;
  metadata: Record<string, unknown>;
  source: 'vector' | 'keyword' | 'both';
}

/**
 * RRF (Reciprocal Rank Fusion) combines multiple ranking signals.
 * Formula: RRF(d) = Σ(1 / (k + rank(d)))
 * where k is a constant (default 60) and rank is 1-based position.
 *
 * Benefits:
 * - Robust to outliers
 * - No need to normalize scores across different models
 * - Domain: [0, 1] regardless of input
 */
export class RRFService {
  private k: number = 60; // Constant in RRF formula

  /**
   * Fuse vector and keyword search results using RRF.
   */
  fuse(vectorResults: ChromaQueryResult[], keywordResults: KeywordSearchResult[]): RRFResult[] {
    const rrfMap = new Map<string, RRFResult>();

    // 1. Add vector results with RRF scores
    for (let i = 0; i < vectorResults.length; i++) {
      const chunkId = vectorResults[i].id;
      const rrfScore = 1 / (this.k + i + 1);

      rrfMap.set(chunkId, {
        id: chunkId,
        documentId: String(vectorResults[i].metadata?.document_id ?? ''),
        text: vectorResults[i].document || '',
        vectorScore: vectorResults[i].score,
        keywordScore: 0,
        rrfScore,
        metadata: vectorResults[i].metadata,
        source: 'vector',
      });
    }

    // 2. Add keyword results with RRF scores (merge if already in map)
    for (let i = 0; i < keywordResults.length; i++) {
      const chunkId = keywordResults[i].chunkId;
      const rrfScore = 1 / (this.k + i + 1);

      if (rrfMap.has(chunkId)) {
        // Already in map from vector search - merge scores
        const existing = rrfMap.get(chunkId)!;
        existing.keywordScore = keywordResults[i].score;
        existing.rrfScore += rrfScore; // Add RRF contributions
        existing.source = 'both';
      } else {
        // New result from keyword search only
        rrfMap.set(chunkId, {
          id: chunkId,
          documentId: keywordResults[i].documentId,
          text: keywordResults[i].text,
          vectorScore: 0,
          keywordScore: keywordResults[i].score,
          rrfScore,
          metadata: keywordResults[i].metadata,
          source: 'keyword',
        });
      }
    }

    // 3. Sort by combined RRF score and return
    const results = Array.from(rrfMap.values());
    results.sort((a, b) => b.rrfScore - a.rrfScore);

    console.debug(
      {
        vectorCount: vectorResults.length,
        keywordCount: keywordResults.length,
        fusedCount: results.length,
        topScores: results.slice(0, 3).map((r) => ({
          id: r.id,
          rrfScore: r.rrfScore.toFixed(4),
          source: r.source,
        })),
      },
      'RRF fusion complete',
    );

    return results;
  }

  /**
   * Get top-N results from RRF fusion.
   */
  getTopResults(results: RRFResult[], topN: number = 6): RRFResult[] {
    return results.slice(0, topN);
  }

  /**
   * Score distribution in RRF (for debugging/analysis).
   */
  analyzeScores(results: RRFResult[]): {
    min: number;
    max: number;
    mean: number;
    median: number;
  } {
    if (results.length === 0) {
      return { min: 0, max: 0, mean: 0, median: 0 };
    }

    const scores = results.map((r) => r.rrfScore).sort((a, b) => a - b);
    const min = scores[0];
    const max = scores[scores.length - 1];
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const median = scores[Math.floor(scores.length / 2)];

    return { min, max, mean, median };
  }
}

export const rrfService = new RRFService();
