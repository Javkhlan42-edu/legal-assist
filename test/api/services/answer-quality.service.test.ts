import { describe, expect, it } from 'vitest';
import { evaluateAnswerQuality } from '../../../apps/api/src/services/answer-quality.service.ts';

describe('Answer quality metrics', () => {
  it('scores a grounded sourced answer highly', () => {
    const quality = evaluateAnswerQuality({
      query: 'банкнаас зээл авахдаа юуг анхаарах вэ',
      answer:
        'Банкнаас зээл авахдаа гэрээний хүү, нэмэгдүүлсэн хүү, шимтгэл, барьцааны нөхцөлийг бичгээр шалгах хэрэгтэй. Хэрэв ойлгомжгүй нөхцөл байвал гарын үсэг зурахаас өмнө банкнаас тайлбар авна.',
      sources: [
        {
          type: 'legalinfo',
          title: 'Иргэний хууль §451',
          url: 'https://legalinfo.mn/mn/detail?lawId=299&article=451',
          lawId: '299',
          articleNo: '451',
        },
      ],
      relatedLaws: [
        {
          title: 'Иргэний хууль §451',
          articleNo: '451',
          url: 'https://legalinfo.mn/mn/detail?lawId=299&article=451',
          score: 0.9,
        },
      ],
      retrievalQuality: {
        overall: 0.9,
        intentPrecision: 1,
        canonicalCoverage: 1,
        topScore: 0.8,
        qualityBand: 'high',
      },
      latencyMs: 4500,
      latencyBudgetMs: 25000,
      generationMode: 'context',
    });

    expect(quality.overall).toBeGreaterThan(0.85);
    expect(quality.issues).not.toContain('internal_word_leak');
  });

  it('penalizes internal wording, weak citations, and latency overflow', () => {
    const quality = evaluateAnswerQuality({
      query: 'даатгалаас мөнгөө яаж авах вэ',
      answer:
        'Контекстэд давтагдсан source score өндөр тул энэ retrieval result дээр тулгуурлана.',
      sources: [],
      relatedLaws: [],
      latencyMs: 90000,
      latencyBudgetMs: 25000,
      generationMode: 'context',
    });

    expect(quality.overall).toBeLessThan(0.65);
    expect(quality.issues).toContain('internal_word_leak');
    expect(quality.issues).toContain('latency_budget_exceeded');
    expect(quality.issues).toContain('no_citations');
  });
});
