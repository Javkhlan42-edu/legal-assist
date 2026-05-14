import { describe, expect, it } from 'vitest';
import {
  evaluateAnswerFaithfulness,
  evaluateCitationCorrectness,
  evaluateRetrievalAccuracy,
  summarizeLatency,
  type EvaluationCitationSnapshot,
  type RetrievedSourceSnapshot,
} from '../../src/evaluation/rag-eval-metrics.ts';
import type { LegalEvalCase } from '../../src/evaluation/legal-eval-dataset.ts';

const baseCase: LegalEvalCase = {
  id: 'test-001',
  question: 'Ажлаас үндэслэлгүй халсан бол яах вэ?',
  expectedLawTitle: 'Хөдөлмөрийн тухай хууль',
  expectedSourceKeywords: ['ажлаас', 'халах'],
  expectedCitationKeywords: ['Хөдөлмөрийн тухай', '78'],
  expectedAnswerKeywords: ['гомдол'],
  category: 'labor_law',
};

const retrievedSources: RetrievedSourceSnapshot[] = [
  {
    id: 'labor-78',
    title: 'Хөдөлмөрийн тухай хууль',
    articleNo: '78',
    url: 'https://legalinfo.mn/mn/detail?lawId=16230709635751',
    snippet: '78 дугаар зүйл. Хөдөлмөр эрхлэлтийн харилцаа дуусгавар болох үндэслэл.',
    source: 'legalinfo',
  },
  {
    id: 'civil-1',
    title: 'Иргэний хууль',
    articleNo: '1',
    snippet: 'Иргэний эрх зүйн харилцаа.',
    source: 'legalinfo',
  },
];

const citations: EvaluationCitationSnapshot[] = [
  {
    title: 'Хөдөлмөрийн тухай хууль',
    articleNo: '78',
    url: 'https://legalinfo.mn/mn/detail?lawId=16230709635751',
    source: 'legalinfo',
  },
];

describe('RAG evaluation metrics', () => {
  it('calculates retrieval hit and precision at 5 from expected legal keywords', () => {
    const result = evaluateRetrievalAccuracy(baseCase, retrievedSources);

    expect(result.retrievalHit).toBe(true);
    expect(result.hitAt5).toBe(true);
    expect(result.precisionAt5).toBe(0.2);
  });

  it('calculates citation correctness from expected keywords and retrieved source match', () => {
    const result = evaluateCitationCorrectness(baseCase, citations, retrievedSources);

    expect(result.citationCorrect).toBe(true);
    expect(result.citationAccuracy).toBeGreaterThanOrEqual(0.9);
  });

  it('penalizes unsupported law titles and article numbers in faithfulness checks', () => {
    const result = evaluateAnswerFaithfulness({
      answer:
        'Хөдөлмөрийн тухай хууль 78 дугаар зүйлд тулгуурлан тушаал, баримтаа шалгана. Эрүүгийн хууль 17.1 зүйлээр давхар шийднэ.',
      retrievedSources,
      citations,
    });

    expect(result.faithful).toBe(false);
    expect(result.faithfulnessScore).toBeLessThan(0.7);
    expect(result.faithfulnessNotes.some((note) => note.startsWith('unsupported_law_title'))).toBe(
      true,
    );
  });

  it('penalizes legal claims when there is no retrieved context', () => {
    const result = evaluateAnswerFaithfulness({
      answer: 'Иргэний хууль 497 дугаар зүйлээр хохирлоо шаардах боломжтой.',
      retrievedSources: [],
      citations: [],
    });

    expect(result.faithful).toBe(false);
    expect(result.faithfulnessNotes).toContain('legal_claim_without_retrieved_context');
  });

  it('summarizes latency with average, p50, p95, and max', () => {
    const summary = summarizeLatency([
      { totalLatencyMs: 1000 },
      { totalLatencyMs: 3000 },
      { totalLatencyMs: 5000 },
      { totalLatencyMs: 7000 },
      { totalLatencyMs: 9000 },
    ]);

    expect(summary.averageLatencyMs).toBe(5000);
    expect(summary.p50LatencyMs).toBe(5000);
    expect(summary.p95LatencyMs).toBe(9000);
    expect(summary.maxLatencyMs).toBe(9000);
  });
});
