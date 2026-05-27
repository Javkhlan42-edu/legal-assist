import { describe, expect, it } from 'vitest';
import { classifyScope } from '../../../apps/api/src/services/scope-classifier.service.ts';

describe('ScopeClassifierService', () => {
  it('classifies cyber fraud questions as legal crime questions', () => {
    const result = classifyScope('цахим луйварт өртсөн ямар арга хэмжээ авах вэ');

    expect(result.scope).toBe('legal');
    expect(result.intentHint).toBe('crime');
    expect(result.legalScore).toBeGreaterThan(result.nonLegalScore);
  });

  it('classifies late-night public noise as a legal complaint, not out of scope', () => {
    const result = classifyScope(
      'Манай хажуу байрны айл хэт их дуу чимээ гаргаад амгалан тайван байдал алдагдуулаад байна',
    );

    expect(result.scope).toBe('legal');
    expect(result.intentHint).toBe('crime');
    expect(result.legalScore).toBeGreaterThan(result.nonLegalScore);
  });

  it.each([
    ['Банкнаас зээл авахдаа аль аль хууль дээр анхаарах вэ', 'contract'],
    ['Би утсаа хулгайд алдчихлаа яаж хайж олох вэ', 'crime'],
    ['цахим луйварт өртсөн ямар арга хэмжээ авах вэ', 'crime'],
    ['3 сарын өмнө машинтай мөргөлдөөд даатгалаас нөхөн төлбөр олгохгүй байна', 'contract'],
    ['Манай хажуу байрны айл хэт их дуу чимээ гаргаад амгалан тайван байдал алдагдуулж байна', 'crime'],
    ['онлайн дэлгүүрээс бараа авсан чинь буцааж авахгүй байна яах вэ', 'contract'],
    ['газрын гэрчилгээ кадастр давхцаад маргаан гарлаа яах вэ', 'contract'],
    ['миний зургийг зөвшөөрөлгүй фэйсбүүкт тавьсан бол яах вэ', 'crime'],
    ['өв залгамжлал нээлгэхэд ямар материал бүрдүүлэх вэ', 'contract'],
    ['лиценз цуцалсан шийдвэрт хаана гомдол гаргах вэ', 'contract'],
    ['нийгмийн даатгалын шимтгэл төлөөгүй бол яах вэ', 'socialInsurance'],
    ['татвар төлөөгүй бол ямар хариуцлага хүлээх вэ', 'tax'],
    ['ажлаас үндэслэлгүй халагдсан бол яах вэ', 'labor'],
    ['хүүхдээ уулзуулахгүй байвал яах вэ', 'family'],
  ] as const)('classifies common missed legal question: %s', (query, intent) => {
    const result = classifyScope(query);

    expect(result.scope).toBe('legal');
    expect(result.intentHint).toBe(intent);
    expect(result.legalScore).toBeGreaterThan(result.nonLegalScore);
  });
});
