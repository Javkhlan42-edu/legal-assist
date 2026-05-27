import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rerankMock, chatCompletionMock, getOpenAIClientMock } = vi.hoisted(() => ({
  rerankMock: vi.fn(),
  chatCompletionMock: vi.fn(),
  getOpenAIClientMock: vi.fn(() => ({})),
}));

vi.mock('../../../apps/api/src/services/reranker.service.js', () => ({
  rerankerService: {
    rerank: rerankMock,
  },
}));

vi.mock('../../../apps/api/src/lib/llm-client.js', () => ({
  getOpenAIClient: getOpenAIClientMock,
  chatCompletion: chatCompletionMock,
}));

import {
  generate,
  NO_INFO_RESPONSE,
  SYSTEM_PROMPT,
  cleanupAnswerStructure,
  stripOcrLeakage,
  cleanChunkDocumentForPrompt,
  validateQaAnswerQuality,
} from '../../../apps/api/src/services/generation.service.ts';

function expectQaContract(answer: string) {
  const report = validateQaAnswerQuality(answer);
  expect(report.ok, `QA contract failed: ${report.issues.join(', ')}`).toBe(true);
  expect(report.metrics.adviceSentences).toBeGreaterThanOrEqual(2);
  expect(report.metrics.actionSteps).toBeGreaterThanOrEqual(5);
  expect(report.metrics.lawExplanationSentences).toBeGreaterThanOrEqual(5);
  expect(report.metrics.riskSentences).toBeGreaterThanOrEqual(2);
  expect(report.metrics.practicalTips).toBeGreaterThanOrEqual(4);
  expect(answer).not.toMatch(/Хууль\s*:/i);
  expect(answer).not.toMatch(/Зүйл\s*:/i);
  expect(answer).not.toMatch(/Хуулийн\s+заалт\s*[:：]/i);
  expect(answer).not.toContain('**Хуулийн үндэслэл**');
}

function makeLegalChunk(
  overrides: Partial<{
    id: string;
    document: string;
    metadata: Record<string, unknown>;
    score: number;
  }> = {},
) {
  return {
    id: 'chunk-1',
    document:
      '43 дугаар зүйл. Ажилтны эрх\n43.1 Ажилтан нь аюулгүй ажлын байр, шударга цалин хөлс, амралт авах эрхтэй.',
    metadata: {
      source: 'legalinfo',
      sourceId: '16230709635751',
      lawId: '16230709635751',
      title: 'Хөдөлмөрийн тухай хууль',
      url: 'https://legalinfo.mn/mn/detail?lawId=16230709635751',
      articleNo: '43.1',
      chunkType: 'clause',
    },
    score: 0.62,
    ...overrides,
    };
}

function makeLaborDismissalChunk(
  overrides: Partial<{
    id: string;
    document: string;
    metadata: Record<string, unknown>;
    score: number;
  }> = {},
) {
  return makeLegalChunk({
    id: 'labor-dismissal-78',
    document:
      '78 дугаар зүйл. Хөдөлмөр эрхлэлтийн харилцаа дуусгавар болох үндэслэл. Ажил олгогч хөдөлмөр эрхлэлтийн харилцааг хуульд заасан үндэслэл, журам, баримтжуулалтын дагуу дуусгавар болгоно.',
    metadata: {
      source: 'legalinfo',
      sourceId: '16230709635751',
      lawId: '16230709635751',
      title: 'Хөдөлмөрийн тухай хууль',
      url: 'https://legalinfo.mn/mn/detail?lawId=16230709635751',
      articleNo: '78',
      chunkType: 'article',
    },
    score: 0.87,
    ...overrides,
  });
}

function makeTrafficChunk(
  overrides: Partial<{
    id: string;
    document: string;
    metadata: Record<string, unknown>;
    score: number;
  }> = {},
) {
  return {
    id: 'traffic-chunk-1',
    document:
      '5 дугаар зүйл. Жолоочийн үүрэг\n5.1 Жолооч замын хөдөлгөөнд аюулгүй оролцож, осол гарсан үед ослын газар ба нотолгоог хадгалан замын цагдаад мэдэгдэх үүрэгтэй.',
    metadata: {
      source: 'legalinfo',
      sourceId: '11224',
      lawId: '11224',
      title: 'Замын хөдөлгөөний аюулгүй байдлын тухай хууль',
      url: 'https://legalinfo.mn/mn/detail?lawId=11224',
      articleNo: '5.1',
      chunkType: 'clause',
    },
    score: 0.78,
    ...overrides,
  };
}

describe('GenerationService', () => {
  beforeEach(() => {
    rerankMock.mockReset();
    chatCompletionMock.mockReset();
    getOpenAIClientMock.mockClear();
  });

  it('uses a concise grounded system prompt without corrupted few-shot examples', () => {
    expect(SYSTEM_PROMPT).toContain('Зөвхөн өгөгдсөн контекст');
    expect(SYSTEM_PROMPT).toContain('Яг одоо хийх алхам');
    expect(SYSTEM_PROMPT).not.toContain('Хулгайглаж, авалцалаж болно');
    expect(SYSTEM_PROMPT).not.toContain('Утtas');
  });

  it('returns a detailed labor fallback for broad worker-rights queries with weak canonical context', async () => {
    const weakLaborChunk = makeLegalChunk({ score: 0.2 });
    rerankMock.mockResolvedValue([weakLaborChunk]);

    const result = await generate(
      { OPENAI_API_KEY: '', OPENAI_CHAT_MODEL: 'test-model' } as any,
      'ажилтны эрх, үүргийн талаар дэлгэрэнгүй мэдээ өгнө үү',
      [weakLaborChunk],
      [],
    );

    expect(result.answer).not.toBe(NO_INFO_RESPONSE);
    expect(result.answer).toContain('Практик зөвлөгөө');
    expect(result.mode).toBe('fallback-general');
    expect(result.suggestedQuestions.length).toBeGreaterThan(0);
  });

  it('replaces LLM no-info output with labor fallback guidance for broad overview queries', async () => {
    const strongLaborChunk = makeLegalChunk({ score: 0.72 });
    rerankMock.mockResolvedValue([strongLaborChunk]);
    chatCompletionMock.mockResolvedValue({
      text: `${NO_INFO_RESPONSE}\nCONFIDENCE: 0.00`,
      promptTokens: 111,
      completionTokens: 9,
    });

    const result = await generate(
      { OPENAI_API_KEY: 'test-key', OPENAI_CHAT_MODEL: 'test-model' } as any,
      'ажилтны эрх, үүргийн талаар дэлгэрэнгүй мэдээ өгнө үү',
      [strongLaborChunk],
      [],
    );

    expect(result.answer).not.toBe(NO_INFO_RESPONSE);
    expect(result.answer).toContain('Практик зөвлөгөө');
    expect(result.mode).toBe('fallback-general');
    expect(result.promptTokens).toBeGreaterThanOrEqual(0);
    expect(result.completionTokens).toBeGreaterThanOrEqual(0);
  });

  it('answers labor dismissal evidence follow-ups with a concrete document checklist', async () => {
    const laborDismissalChunk = makeLaborDismissalChunk();
    rerankMock.mockResolvedValue([laborDismissalChunk]);

    const result = await generate(
      { OPENAI_API_KEY: '', OPENAI_CHAT_MODEL: 'test-model' } as any,
      'Ямар баримт бүрдүүлэх хэрэгтэй вэ?',
      [laborDismissalChunk],
      [
        {
          role: 'user',
          content: 'Ажлаас үндэслэлгүй халагдсан бол яаж шийдвэрлэх вэ?',
        },
        {
          role: 'assistant',
          content: 'Хөдөлмөрийн маргаанд тушаал, гэрээ, цалингийн баримт чухал.',
        },
      ],
    );

    expect(result.answer).not.toBe(NO_INFO_RESPONSE);
    expect(result.answer).toContain('Ажлаас халсан тушаал');
    expect(result.answer).toContain('Хөдөлмөрийн гэрээ');
    expect(result.answer).toContain('Цалингийн баримт');
    expect(result.answer).toContain('тайлбар авсан эсэх');
    expect(result.answer).toContain('Практик зөвлөгөө');
    expect(result.mode).toBe('context');
    expectQaContract(result.answer);
  });

  it('answers same-topic follow-ups in freeform mode without forcing the QA contract', async () => {
    const bankLoanChunk = makeLegalChunk({
      id: 'bank-loan-452',
      document:
        '452 дугаар зүйл. Банк, зээлийн үйл ажиллагаа эрхлэх эрх бүхий этгээдээс олгох зээлийн хүү. Зээлдэгч хугацаандаа төлөөгүй бол гэрээнд заасан нөхцөлөөр нэмэгдүүлсэн хүү тооцож болно.',
      metadata: {
        source: 'legalinfo',
        sourceId: '299',
        lawId: '299',
        title: 'Иргэний хууль',
        url: 'https://legalinfo.mn/mn/detail?lawId=299',
        articleNo: '452',
        chunkType: 'article',
      },
      score: 0.94,
    });
    chatCompletionMock.mockResolvedValue({
      text:
        'Банкны зээлийн төлбөр 3 сар хоцорсон асуудлын хувьд хамгийн түрүүнд зээлийн гэрээ, эргэн төлөлтийн хуваарь, хугацаа хэтэрсэн үлдэгдлийн задаргаа, банкнаас ирсэн мэдэгдлүүдийг цуглуулна. Мөн нэмэгдүүлсэн хүү тооцсон бол гэрээний аль заалтаар хэдэн төгрөг тооцсон тухай банкны бичгэн тайлбарыг ав. Эдгээр баримт нь банкны шаардлага гэрээ болон Иргэний хуулийн зээлийн хүүгийн зохицуулалттай нийцэж байгаа эсэхийг шалгахад хэрэгтэй.\nCONFIDENCE: 0.76\nSUGGESTED_QUESTIONS:\n- Нэмэгдүүлсэн хүүг яаж шалгах вэ?\n- Банканд төлбөрийн хуваарь өөрчлөх хүсэлт яаж бичих вэ?\n- Банкны тооцоо буруу байвал яаж маргах вэ?',
      promptTokens: 220,
      completionTokens: 80,
    });

    const result = await generate(
      { OPENAI_API_KEY: 'test-key', OPENAI_CHAT_MODEL: 'test-model' } as any,
      'ямар ямар баримт бичиг цуглуулах шаардлагатай вэ',
      [bankLoanChunk],
      [
        {
          role: 'user',
          content: 'Банкнаас зээл аваад сүүлийн 3 сар төлбөрийг төлсөнгүй ямар арга хэмжээ авах вэ',
        },
        {
          role: 'assistant',
          content: 'Зээлийн гэрээ, хүү, нэмэгдүүлсэн хүү болон банкны тооцоог бичгээр шалгах хэрэгтэй.',
        },
      ],
      [],
      { alreadyReranked: true, detailSubIntent: 'documents', answerStyle: 'follow_up_freeform' },
    );

    expect(result.answer).toContain('зээлийн гэрээ');
    expect(result.answer).toContain('нэмэгдүүлсэн хүү');
    expect(result.answer).not.toContain('**Яг одоо хийх алхам**');
    expect(result.answer).not.toContain('**Практик зөвлөгөө**');
    expect(result.answer).toContain('хуульчийн албан ёсны зөвлөгөөг орлохгүй');
    expect(chatCompletionMock).toHaveBeenCalledTimes(1);
  });

  it('adds the legal-information disclaimer once to substantive QA answers', async () => {
    const result = await generate(
      { OPENAI_API_KEY: 'test-key', OPENAI_CHAT_MODEL: 'test-model' } as any,
      'Банкнаас авсан зээл 2 сар төлөөгүй байгаа',
      [],
      [],
    );

    const disclaimerMatches = result.answer.match(/хуульчийн албан ёсны зөвлөгөөг орлохгүй/g) ?? [];
    expect(disclaimerMatches).toHaveLength(1);
    expectQaContract(result.answer);
  });

  it('keeps generic unscoped liability questions as no-info', async () => {
    const result = await generate(
      { OPENAI_API_KEY: '', OPENAI_CHAT_MODEL: 'test-model' } as any,
      'ямар хуулийн хариуцлага хүлээх вэ',
      [],
      [],
    );

    expect(result.answer).toBe(NO_INFO_RESPONSE);
    expect(result.mode).toBe('no-info');
    expect(rerankMock).not.toHaveBeenCalled();
  });

  it('answers bank loan overdue follow-ups with a useful fast fallback when retrieval has no context', async () => {
    const result = await generate(
      { OPENAI_API_KEY: 'test-key', OPENAI_CHAT_MODEL: 'test-model' } as any,
      'Зээлийн гэрээнд заасан хугацаанд зээлдэгч зээлээ барагдуулахгүй бол юу болох вэ? банкнаас авсан зээл 2 сар төлөөгүй байгаа',
      [],
      [],
    );

    expect(result.answer).not.toBe(NO_INFO_RESPONSE);
    expect(result.answer).toContain('2 сар');
    expect(result.answer).toContain('Иргэний хууль');
    expect(result.answer).toContain('эрүүгийн ял биш');
    expect(result.answer).toContain('Практик зөвлөгөө');
    expectQaContract(result.answer);
    expect(result.mode).toBe('fallback-general');
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });

  it('asks for missing facts for traffic incident questions when no source context is available', async () => {
    const result = await generate(
      { OPENAI_API_KEY: '', OPENAI_CHAT_MODEL: 'test-model' } as any,
      'Би өнөөдөр замын эсрэг урсгалаас орж ирсэн машиныг санамсаргүй шүргэчлээ ямар хуулиар шийдвэрлэх вэ',
      [],
      [],
    );

    expect(result.answer).not.toBe(NO_INFO_RESPONSE);
    expect(result.answer).toContain('мэдээлэл дутуу');
    expect(result.answer).toContain('Осол гарсан');
    expect(result.answer).toContain('цагдаа');
    expect(result.mode).toBe('fallback-general');
  });

  it('uses neutral weak-context wording without leaking wrong-law phrasing', async () => {
    const result = await generate(
      { OPENAI_API_KEY: '', OPENAI_CHAT_MODEL: 'test-model' } as any,
      'Захиргааны байгууллагын шийдвэрийг хүчингүй болгуулахад ямар шүүхэд хандах вэ?',
      [],
      [],
    );

    expect(result.answer).not.toContain('Буруу хууль');
    expect(result.answer).toContain('зөв хууль, зүйл заалт оноохын тулд');
    expect(result.mode).toBe('fallback-general');
  });

  it('returns a parking hit-and-run fallback instead of no-info for parking collision questions', async () => {
    const result = await generate(
      { OPENAI_API_KEY: '', OPENAI_CHAT_MODEL: 'test-model' } as any,
      'Өнөөдөр зогсоолд байсан машиныг машин мөргөөд зугтсан байна. Хэрхэн шийдвэрлэх вэ',
      [],
      [],
    );

    expect(result.answer).not.toBe(NO_INFO_RESPONSE);
    expect(result.answer).toContain('камер');
    expect(result.answer).toContain('даатгал');
    expect(result.answer).toContain('цагдаа');
    expect(result.mode).toBe('fallback-general');
  });

  it('answers public noise complaints as legal complaints without retrieving unrelated insurance law', async () => {
    const result = await generate(
      { OPENAI_API_KEY: '', OPENAI_CHAT_MODEL: 'test-model' } as any,
      'Манай хажуу байрны айл хэт их дуу чимээ гаргаад амгалан тайван байдал алдагдуулаад байна',
      [],
      [],
    );

    expect(result.answer).not.toBe(NO_INFO_RESPONSE);
    expect(result.answer).toContain('102');
    expect(result.answer).toContain('дуу чимээ');
    expect(result.answer).toContain('Практик зөвлөгөө');
    expect(result.answer).not.toContain('даатгал');
    expect(result.mode).toBe('fallback-general');
  });

  it('does not misread online store defect/refund questions as cyber fraud', async () => {
    const result = await generate(
      { OPENAI_API_KEY: 'test-key', OPENAI_CHAT_MODEL: 'test-model' } as any,
      'Онлайн дэлгүүрээс худалдан авсан бүтээгдэхүүн доголдолтой ирсэн. Буцаалт төлүүлэхийг маргалж болох уу?',
      [],
      [],
    );

    expect(result.answer).toContain('доголдолтой');
    expect(result.answer).toContain('буцаалт');
    expect(result.answer).toContain('хэрэглэгч');
    expect(result.answer).not.toContain('Цахим луйвар');
    expect(result.answer).not.toContain('102');
    expectQaContract(result.answer);
    expect(result.mode).toBe('fallback-general');
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });

  it('answers labor dismissal and unpaid wage questions without suspension-law drift', async () => {
    const result = await generate(
      { OPENAI_API_KEY: 'test-key', OPENAI_CHAT_MODEL: 'test-model' } as any,
      'Үндэслэлгүй ажлаас халуулсан. Цалин төлүүлэхийг маргалж болох уу?',
      [],
      [],
    );

    expect(result.answer).toContain('ажлаас халсан');
    expect(result.answer).toContain('цалин');
    expect(result.answer).toContain('хөдөлмөр');
    expect(result.answer).not.toContain('АЖИЛ ҮҮРЭГ ГҮЙЦЭТГЭХИЙГ ТҮДГЭЛЗҮҮЛЭХ');
    expectQaContract(result.answer);
    expect(result.mode).toBe('fallback-general');
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });

  it('answers cyber fraud questions immediately with practical police and bank steps', async () => {
    const result = await generate(
      { OPENAI_API_KEY: 'test-key', OPENAI_CHAT_MODEL: 'test-model' } as any,
      'цахим луйварт өртсөн ямар арга хэмжээ авах вэ',
      [],
      [],
    );

    expect(result.answer).not.toBe(NO_INFO_RESPONSE);
    expect(result.answer).toContain('банк');
    expect(result.answer).toContain('102');
    expect(result.answer).toContain('нотлох баримт');
    expect(result.answer).toContain('Цахим луйварт');
    expectQaContract(result.answer);
    expect(result.mode).toBe('fallback-general');
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });

  it('answers phone theft questions immediately with IMEI and police steps', async () => {
    const result = await generate(
      { OPENAI_API_KEY: 'test-key', OPENAI_CHAT_MODEL: 'test-model' } as any,
      'Би утсаа хулгайд алдчихлаа яаж хайж олох вэ',
      [],
      [],
    );

    expect(result.answer).not.toBe(NO_INFO_RESPONSE);
    expect(result.answer).toContain('IMEI');
    expect(result.answer).toContain('цагда');
    expect(result.answer).toContain('Find My');
    expectQaContract(result.answer);
    expect(result.mode).toBe('fallback-general');
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });

  it('answers delayed auto insurance compensation without waiting for the LLM', async () => {
    const result = await generate(
      { OPENAI_API_KEY: 'test-key', OPENAI_CHAT_MODEL: 'test-model' } as any,
      '3 сарын өмнө машинтай мөргөлдөөд даатгалаас маань одоо хүртэл мөнгөө олгохгүй байна. камер байхгүй гээд нотолж чадахгүй гэж байна',
      [],
      [],
    );

    expect(result.answer).not.toBe(NO_INFO_RESPONSE);
    expect(result.answer).toContain('камер');
    expect(result.answer).toContain('Даатгал');
    expect(result.answer).toContain('Санхүүгийн зохицуулах хороо');
    expectQaContract(result.answer);
    expect(result.mode).toBe('fallback-general');
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });

  it('replaces llm no-info output with traffic incident guidance for parking hit-and-run queries', async () => {
    const trafficChunk = makeTrafficChunk();
    rerankMock.mockResolvedValue([trafficChunk]);
    chatCompletionMock.mockResolvedValue({
      text: `${NO_INFO_RESPONSE}\nCONFIDENCE: 0.00`,
      promptTokens: 101,
      completionTokens: 7,
    });

    const result = await generate(
      { OPENAI_API_KEY: 'test-key', OPENAI_CHAT_MODEL: 'test-model' } as any,
      'Өнөөдөр зогсоолд байсан машиныг машин мөргөөд зугтсан байна. Хэрхэн шийдвэрлэх вэ',
      [trafficChunk],
      [],
    );

    expect(result.answer).not.toBe(NO_INFO_RESPONSE);
    expect(result.answer).toMatch(/ослын\s+газар|ослын\s+газр/i);
    expect(result.answer).toContain('камер');
    expect(result.answer).toContain('Практик зөвлөгөө');
  });

  it('cleans raw legalinfo prefixes from fallback law explanations', async () => {
    const rawLaborChunk = makeLaborDismissalChunk({
      document:
        'Хууль: ХӨДӨЛМӨРИЙН ТУХАЙ /Шинэчилсэн найруулга/ Зүйл: 78 ХӨДӨЛМӨР ЭРХЛЭЛТИЙН ХАРИЛЦАА ДУУСГАВАР БОЛОХ ҮНДЭСЛЭЛ 78 дугаар зүйл. Ажил олгогч хөдөлмөр эрхлэлтийн харилцааг хуульд заасан үндэслэлээр дуусгавар болгоно.',
    });
    rerankMock.mockResolvedValue([rawLaborChunk]);

    const result = await generate(
      { OPENAI_API_KEY: '', OPENAI_CHAT_MODEL: 'test-model' } as any,
      'Ажлаас үндэслэлгүй халагдсан бол яаж шийдвэрлэх вэ?',
      [rawLaborChunk],
      [],
    );

    expect(result.answer).not.toContain('Хууль:');
    expect(result.answer).not.toContain('Зүйл: 78');
    expect(result.answer).toContain('Хөдөлмөр');
    expect(result.answer).toContain('Практик зөвлөгөө');
    expectQaContract(result.answer);
  });

  it('replaces raw LLM dump responses with structured QA guidance', async () => {
    const trafficChunk = makeTrafficChunk({
      document:
        'Хууль: ЗАМЫН ХӨДӨЛГӨӨНИЙ АЮУЛГҮЙ БАЙДЛЫН ТУХАЙ Зүйл: 5 Жолооч осол гарсан үед ослын газрыг хамгаалж цагдаад мэдэгдэнэ.',
    });
    rerankMock.mockResolvedValue([trafficChunk]);
    chatCompletionMock.mockResolvedValue({
      text:
        'LLM үйлчилгээ түр боломжгүй байна. Доорх контекстээс олдсон гол мэдээлэл:\n\nХууль: ЗАМЫН ХӨДӨЛГӨӨНИЙ АЮУЛГҮЙ БАЙДЛЫН ТУХАЙ Зүйл: 5 ...\nCONFIDENCE: 0.40',
      promptTokens: 77,
      completionTokens: 18,
    });

    const result = await generate(
      { OPENAI_API_KEY: 'test-key', OPENAI_CHAT_MODEL: 'test-model' } as any,
      'Машин барьж явж байгаад машин шүргэчлээ яаж шийдвэрлэх вэ?',
      [trafficChunk],
      [],
    );

    expect(result.answer).not.toContain('LLM үйлчилгээ');
    expect(result.answer).not.toContain('Доорх контекст');
    expect(result.answer).not.toContain('Хууль:');
    expect(result.answer).toContain('Яг одоо хийх алхам');
    expect(result.answer).toContain('Практик зөвлөгөө');
    expectQaContract(result.answer);
  });

  it('system prompt forbids OCR dumps and off-topic citations', () => {
    expect(SYSTEM_PROMPT).toMatch(/түүхий\s+текст/i);
    expect(SYSTEM_PROMPT).toContain('мөнгө угаах');
    expect(SYSTEM_PROMPT).toContain('хүн худалдаалах');
    expect(SYSTEM_PROMPT).toMatch(/OCR\s*\/\s*preprocessed/i);
    expect(SYSTEM_PROMPT).toContain('CONFIDENCE: X.XX');
    expect(SYSTEM_PROMPT).toContain('SUGGESTED_QUESTIONS');
  });

  describe('stripOcrLeakage', () => {
    it('drops standalone OCR header lines from answer text', () => {
      const noisy = [
        'Эхний зөвлөгөө: ослын газрыг хамгаалах.',
        'Хууль: ЗАМЫН ХӨДӨЛГӨӨНИЙ АЮУЛГҮЙ БАЙДЛЫН ТУХАЙ Зүйл: 5 ЖОЛООЧИЙН ҮҮРЭГ',
        'Үргэлжлүүлэн цагдаад мэдэгдэнэ.',
      ].join('\n');

      const cleaned = stripOcrLeakage(noisy);

      expect(cleaned).not.toContain('Хууль: ЗАМЫН');
      expect(cleaned).not.toContain('Зүйл: 5');
      expect(cleaned).toContain('Эхний зөвлөгөө');
      expect(cleaned).toContain('цагдаад мэдэгдэнэ');
    });

    it('removes inline OCR fragments and keeps the leading prose intact', () => {
      const noisy =
        'Ослыг шийдвэрлэхэд Хууль: ЗАМЫН ХӨДӨЛГӨӨНИЙ ТУХАЙ Зүйл: 5 ЖОЛООЧИЙН ҮҮРЭГ дагана.';

      const cleaned = stripOcrLeakage(noisy);

      expect(cleaned).not.toMatch(/Хууль\s*:/i);
      expect(cleaned).not.toMatch(/Зүйл\s*:\s*5/);
      expect(cleaned).toContain('Ослыг шийдвэрлэхэд');
    });

    it('removes "LLM үйлчилгээ" preamble lines', () => {
      const noisy = [
        'LLM үйлчилгээ түр боломжгүй байна. Доорх контекстээс олдсон гол мэдээлэл:',
        '',
        'Хариулт: ослын газрыг хамгаалж цагдаад мэдэгдэнэ.',
      ].join('\n');

      const cleaned = stripOcrLeakage(noisy);

      expect(cleaned).not.toMatch(/LLM\s+үйлчилгээ/i);
      expect(cleaned).not.toMatch(/Доорх\s+контекст/i);
      expect(cleaned).toContain('ослын газрыг хамгаалж');
    });

    it('returns falsy input unchanged', () => {
      expect(stripOcrLeakage('')).toBe('');
    });
  });

  describe('cleanChunkDocumentForPrompt', () => {
    it('strips the leading "Хууль: ... Зүйл: ..." preprocessor prefix', () => {
      const raw =
        'Хууль: ХӨДӨЛМӨРИЙН ТУХАЙ /Шинэчилсэн найруулга/ Зүйл: 78 ХӨДӨЛМӨР ЭРХЛЭЛТИЙН ХАРИЛЦАА ДУУСГАВАР БОЛОХ ҮНДЭСЛЭЛ\n78.1 Ажил олгогч хөдөлмөр эрхлэлтийн харилцааг хуульд заасан үндэслэлээр дуусгавар болгоно.';

      const cleaned = cleanChunkDocumentForPrompt(raw);

      expect(cleaned).not.toMatch(/^Хууль\s*:/i);
      expect(cleaned).not.toContain('ДУУСГАВАР БОЛОХ ҮНДЭСЛЭЛ');
      expect(cleaned).toContain('78.1');
      expect(cleaned).toContain('Ажил олгогч');
    });

    it('also removes inline duplicates of the OCR header inside the chunk body', () => {
      const raw =
        '5.1 Жолооч замын хөдөлгөөнд аюулгүй оролцоно. Хууль: ЗАМЫН ХӨДӨЛГӨӨНИЙ ТУХАЙ Зүйл: 5 ЖОЛООЧИЙН ҮҮРЭГ Хэсэг 2.';

      const cleaned = cleanChunkDocumentForPrompt(raw);

      expect(cleaned).not.toMatch(/Хууль\s*:/i);
      expect(cleaned).toContain('5.1');
      expect(cleaned).toContain('Жолооч замын');
    });

    it('returns empty string when input is empty', () => {
      expect(cleanChunkDocumentForPrompt('')).toBe('');
    });
  });

  describe('cleanupAnswerStructure', () => {
    it('applies stripOcrLeakage as part of standard cleanup', () => {
      const dirty = [
        '1. Эхлээд цагдаад мэдэгдэнэ.',
        'Хууль: ЗАМЫН ХӨДӨЛГӨӨНИЙ ТУХАЙ Зүйл: 5 ЖОЛООЧИЙН ҮҮРЭГ',
        '',
        '2. Дараа нь даатгалд мэдэгдэнэ.',
      ].join('\n');

      const cleaned = cleanupAnswerStructure(dirty);

      expect(cleaned).not.toMatch(/Хууль\s*:/i);
      expect(cleaned).toContain('Эхлээд цагдаад');
      expect(cleaned).toContain('Дараа нь даатгалд');
    });
  });
});
