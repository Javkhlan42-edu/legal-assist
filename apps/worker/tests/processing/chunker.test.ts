// ────────────────────────────────────────────────────────────
// Chunker Tests
// ────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { ChunkingService } from '../../src/services/chunking.service.js';

const chunkingService = new ChunkingService(16, 4);

describe('ChunkingService', () => {
  it('splits text into bounded token chunks with overlap', () => {
    const text = Array.from({ length: 48 }, (_, i) => `token-${i + 1}`).join(' ');

    const result = chunkingService.processDocument('doc-1', text, {
      source: 'legalinfo',
      sourceId: '100',
      title: 'Туршилтын хууль',
      url: 'https://legalinfo.mn/mn/detail?lawId=100',
    });

    expect(result.totalChunks).toBeGreaterThan(1);

    for (const chunk of result.chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(16);
    }

    for (let i = 1; i < result.chunks.length; i++) {
      const previousTokens = result.chunks[i - 1].text.split(/\s+/).filter(Boolean);
      const currentTokens = result.chunks[i].text.split(/\s+/).filter(Boolean);

      expect(currentTokens.slice(0, 4)).toEqual(previousTokens.slice(-4));
    }
  });

  it('preserves legal section headings in chunk metadata', () => {
    const text = [
      '1 дүгээр зүйл',
      'Энэ зүйл нь хууль хэрэгжүүлэх үндсэн зарчмыг тодорхойлно.',
      '',
      '2 дугаар зүйл',
      'Энэ зүйл нь хэрэгжилтийн хяналт, тайлагналыг зохицуулна.',
    ].join('\n');

    const result = chunkingService.processDocument('doc-2', text, {
      source: 'legalinfo',
      sourceId: '101',
      title: 'Бүтэцтэй хууль',
      url: 'https://legalinfo.mn/mn/detail?lawId=101',
    });

    const sections = result.chunks.map((chunk) => chunk.metadata.section).filter(Boolean);
    expect(sections.length).toBeGreaterThan(0);
    expect(sections.some((section) => String(section).includes('1 дүгээр зүйл'))).toBe(true);
  });

  it('splits legal articles into clause-aware chunks when subclauses exist', () => {
    const text = [
      '25 дугаар зүйл. Хүүхэдтэй харилцах эрх',
      '25.1. Эцэг эх тусдаа амьдарч байгаа бол хүүхэдтэйгээ харилцах эрхээ хэрэгжүүлнэ.',
      '25.2. Хүүхдийн ашиг сонирхолд харшлахгүй нөхцөлөөр уулзах, холбоо барих боломжийг хангана.',
      '25.3. Маргаан гарвал шүүх болон эрх бүхий байгууллагаар шийдвэрлүүлж болно.',
    ].join('\n');

    const result = chunkingService.processDocument('doc-clauses', text, {
      source: 'legalinfo',
      sourceId: '104',
      title: 'Гэр бүлийн тухай хууль',
      url: 'https://legalinfo.mn/mn/detail?lawId=104',
    });

    const articleNos = result.chunks.map((chunk) => chunk.metadata.articleNo).filter(Boolean);
    const clauseNos = result.chunks.map((chunk) => chunk.metadata.clauseNo).filter(Boolean);
    const sections = result.chunks.map((chunk) => chunk.metadata.section).filter(Boolean);

    expect(articleNos).toContain('25.1');
    expect(articleNos).toContain('25.2');
    expect(articleNos).toContain('25.3');
    expect(clauseNos).toContain('25.1');
    expect(clauseNos).toContain('25.2');
    expect(sections.some((section) => String(section).includes('25.1'))).toBe(true);
    expect(result.totalChunks).toBeGreaterThanOrEqual(3);
  });

  it('captures lettered labor subclauses with richer metadata', () => {
    const text = [
      '43 дугаар зүйл. Ажилтны эрх',
      '43.1 Ажилтан дараах эрхтэй:',
      'а/ аюулгүй, эрүүл ахуйн шаардлага хангасан ажлын байранд ажиллах;',
      'б/ хөдөлмөрийн үр дүнд тохирсон цалин хөлс авах;',
      '43.2 Ажилтан дараах үүрэгтэй:',
      'а/ хөдөлмөрийн дотоод журам сахих;',
      'б/ ажил олгогчийн хууль ёсны шаардлагыг биелүүлэх.',
    ].join('\n');

    const result = chunkingService.processDocument('doc-labor-subclauses', text, {
      source: 'legalinfo',
      sourceId: '16230709635751',
      title: 'Хөдөлмөрийн тухай хууль',
      url: 'https://legalinfo.mn/mn/detail?lawId=16230709635751',
    });

    const subclauseChunks = result.chunks.filter(
      (chunk) => chunk.metadata.chunkType === 'subclause',
    );

    expect(subclauseChunks.length).toBeGreaterThanOrEqual(4);
    expect(subclauseChunks.some((chunk) => chunk.metadata.subclauseNo === '43.1.а')).toBe(true);
    expect(subclauseChunks.some((chunk) => chunk.metadata.subclauseNo === '43.1.б')).toBe(true);
    expect(subclauseChunks.some((chunk) => chunk.metadata.subclauseNo === '43.2.а')).toBe(true);
    expect(
      subclauseChunks.every((chunk) => String(chunk.metadata.headingPath ?? '').includes('43')),
    ).toBe(true);
  });

  it('is deterministic for repeated processing of the same document', () => {
    const text =
      'Энэ бол ижил баримтын текст. Энэ бол ижил баримтын текст. Энэ бол ижил баримтын текст.';

    const first = chunkingService.processDocument('doc-3', text, {
      source: 'shuukh',
      sourceId: '555001',
      title: 'Шүүхийн шийдвэр',
      url: 'https://shuukh.mn/single_case/555001',
    });

    const second = chunkingService.processDocument('doc-3', text, {
      source: 'shuukh',
      sourceId: '555001',
      title: 'Шүүхийн шийдвэр',
      url: 'https://shuukh.mn/single_case/555001',
    });

    expect(second.chunks.map((chunk) => chunk.id)).toEqual(first.chunks.map((chunk) => chunk.id));
    expect(second.chunks.map((chunk) => chunk.contentHash)).toEqual(
      first.chunks.map((chunk) => chunk.contentHash),
    );
  });

  it('returns zero chunks for empty text', () => {
    const result = chunkingService.processDocument('doc-4', '   ', {
      source: 'legalinfo',
      sourceId: '102',
      title: 'Хоосон',
      url: 'https://legalinfo.mn/mn/detail?lawId=102',
    });

    expect(result.totalChunks).toBe(0);
    expect(result.chunks).toEqual([]);
  });
});
