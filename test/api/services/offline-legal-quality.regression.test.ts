import { describe, expect, it } from 'vitest';

import { generate, NO_INFO_RESPONSE } from '../../../apps/api/src/services/generation.service.ts';
import { evaluateAnswerQuality } from '../../../apps/api/src/services/answer-quality.service.ts';
import {
  classifyLegalIntent,
  rewriteQuery,
  type QueryIntent,
} from '../../../apps/api/src/services/query-rewrite.service.ts';
import { classifyScope } from '../../../apps/api/src/services/scope-classifier.service.ts';

const INTERNAL_LEAK_RE = /retrieval|rerank|chunk|source score|контекстэд давтагдсан|системийн дотоод/i;

async function generateOffline(query: string) {
  const startedAt = Date.now();
  const result = await generate(
    {
      OPENAI_API_KEY: '',
      OPENAI_CHAT_MODEL: 'test-model',
      OPENAI_TIMEOUT_MS: 1,
    } as any,
    query,
    [],
    [],
  );
  const latencyMs = Date.now() - startedAt;
  const quality = evaluateAnswerQuality({
    query,
    answer: result.answer,
    sources: [],
    relatedLaws: [],
    latencyMs,
    latencyBudgetMs: 500,
    generationMode: result.mode,
  });

  return { result, quality, latencyMs };
}

describe('offline legal quality regression', () => {
  const broadLegalCases: Array<{
    name: string;
    query: string;
    expectedIntent: QueryIntent;
    rewriteHints: string[];
  }> = [
    {
      name: 'bank loan application',
      query: 'Банкнаас зээл авахдаа аль аль хууль дээр анхаарах вэ?',
      expectedIntent: 'contract',
      rewriteHints: ['зээлийн гэрээ', 'зээлийн хүү', 'барьцаа'],
    },
    {
      name: 'bank loan overdue',
      query: 'Банкны зээлийн төлбөрөө 6 сар төлж чадаагүй бол ямар хариуцлага үүсэх вэ?',
      expectedIntent: 'contract',
      rewriteHints: ['зээлийн гэрээ', 'хугацаа хэтрүүлэх', 'алданги'],
    },
    {
      name: 'delayed auto insurance claim',
      query:
        '3 сарын өмнө машинтай мөргөлдөөд даатгалаас одоо хүртэл мөнгөө олгохгүй байна. Камерын бичлэг байхгүй гээд татгалзаж байна.',
      expectedIntent: 'contract',
      rewriteHints: ['даатгалын гэрээ', 'нөхөн төлбөр', 'санхүүгийн зохицуулах хороо'],
    },
    {
      name: 'cyber fraud',
      query: 'Цахим луйварт өртөөд данс руу мөнгө шилжүүлчихлээ. Одоо ямар арга хэмжээ авах вэ?',
      expectedIntent: 'crime',
      rewriteHints: ['залилах', 'нотлох баримт', 'цагдаагийн'],
    },
    {
      name: 'phone theft',
      query: 'Гар утсаа хулгайд алдчихлаа. IMEI дугаараар яаж хайж олох вэ?',
      expectedIntent: 'crime',
      rewriteHints: ['хулгай', 'IMEI', 'цагдаагийн'],
    },
    {
      name: 'public noise',
      query: 'Манай хажуу байрны айл шөнө 12 өнгөрөөд хэт их дуу чимээ гаргаад байна. Яах вэ?',
      expectedIntent: 'crime',
      rewriteHints: ['амгалан тайван', 'дуу чимээ', 'зөрчлийн'],
    },
    {
      name: 'traffic collision',
      query: 'Зогсоолд байсан машиныг шүргээд зугтчихсан бол яаж шийдвэрлэх вэ?',
      expectedIntent: 'traffic',
      rewriteHints: ['зам тээврийн осол', 'жолоочийн үүрэг', 'зөрчлийн'],
    },
    {
      name: 'labor dismissal',
      query: 'Ажлаас үндэслэлгүй халсан бол ямар баримт бүрдүүлж хаана гомдол гаргах вэ?',
      expectedIntent: 'labor',
      rewriteHints: ['хөдөлмөрийн тухай', 'ажлаас', 'маргаан'],
    },
    {
      name: 'family custody',
      query: 'Салсны дараа хүүхдээ уулзуулахгүй байвал асрамж, тэтгэлгийн асуудлыг яаж шийдэх вэ?',
      expectedIntent: 'family',
      rewriteHints: ['гэр бүлийн тухай', 'хүүхэд', 'тэтгэлэг'],
    },
    {
      name: 'rental deposit',
      query: 'Түрээсийн байрны барьцаагаа буцааж авч чадахгүй байна. Яах вэ?',
      expectedIntent: 'contract',
      rewriteHints: ['түрээсийн гэрээ', 'барьцаа', 'иргэний хууль'],
    },
    {
      name: 'consumer return',
      query: 'Онлайн дэлгүүрээс авсан чанаргүй барааг буцаахгүй мөнгө өгөхгүй байна.',
      expectedIntent: 'contract',
      rewriteHints: ['хэрэглэгчийн эрх', 'буцаалт', 'хохирол'],
    },
    {
      name: 'inheritance',
      query: 'Аавын өв залгамжлалыг нотариатаар нээлгэхэд ямар материал хэрэгтэй вэ?',
      expectedIntent: 'contract',
      rewriteHints: ['өв залгамжлал', 'нотариат', 'гэрээслэл'],
    },
    {
      name: 'land cadaster',
      query: 'Хашаа газрын кадастр давхцаад улсын бүртгэлд бүртгүүлэхгүй байна.',
      expectedIntent: 'contract',
      rewriteHints: ['газрын тухай', 'кадастр', 'улсын бүртгэл'],
    },
    {
      name: 'social insurance',
      query: 'Ажил олгогч нийгмийн даатгалын шимтгэл төлөөгүй бол би яаж шаардах вэ?',
      expectedIntent: 'socialInsurance',
      rewriteHints: ['нийгмийн даатгал', 'шимтгэл', 'ажил олгогч'],
    },
    {
      name: 'tax penalty',
      query: 'Татвараа хугацаандаа тайлагнаагүй бол ямар торгууль алданги үүсэх вэ?',
      expectedIntent: 'tax',
      rewriteHints: ['татвар', 'алданги', 'тайлан'],
    },
  ];

  it.each(broadLegalCases)(
    'classifies and rewrites common legal question: $name',
    ({ query, expectedIntent, rewriteHints }) => {
      const scope = classifyScope(query);
      const intent = classifyLegalIntent(query);
      const rewritten = rewriteQuery(query).toLowerCase();

      expect(scope.scope).toBe('legal');
      expect(intent).toBe(expectedIntent);
      expect(
        rewriteHints.some((hint) => rewritten.includes(hint.toLowerCase())),
        `rewrite did not include any of: ${rewriteHints.join(', ')}\n${rewritten}`,
      ).toBe(true);
    },
  );

  const offlineAnswerCases = broadLegalCases.filter((item) =>
    [
      'bank loan application',
      'bank loan overdue',
      'delayed auto insurance claim',
      'cyber fraud',
      'phone theft',
      'public noise',
      'traffic collision',
      'labor dismissal',
      'family custody',
      'rental deposit',
      'consumer return',
      'social insurance',
      'tax penalty',
    ].includes(item.name),
  );

  it.each(offlineAnswerCases)(
    'returns usable offline fallback answer: $name',
    async ({ query }) => {
      const { result, quality, latencyMs } = await generateOffline(query);

      expect(result.answer).not.toBe(NO_INFO_RESPONSE);
      expect(result.mode).not.toBe('no-info');
      expect(result.answer.length).toBeGreaterThan(180);
      expect(result.answer).not.toMatch(INTERNAL_LEAK_RE);
      expect(result.promptTokens).toBe(0);
      expect(result.completionTokens).toBe(0);
      expect(latencyMs).toBeLessThan(200);
      expect(quality.answerFaithfulness).toBeGreaterThanOrEqual(0.75);
      expect(quality.responseLatency).toBe(1);
      expect(quality.overall).toBeGreaterThanOrEqual(0.65);
    },
  );

  it('keeps pure greetings out of legal retrieval routing', () => {
    const query = 'сайн байна уу';
    const scope = classifyScope(query);

    expect(scope.scope).toBe('greeting');
    expect(classifyLegalIntent(query)).toBe('unknown');
  });
});
