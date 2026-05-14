import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../src/config/env.ts';
import type { ChromaQueryResult } from '../../src/lib/vector-db.ts';
import { __test__ } from '../../src/services/retrieval.service.ts';

function chunk(
  overrides: Partial<ChromaQueryResult> & {
    title: string;
    lawId: string;
    articleNo?: string;
    document: string;
  },
): ChromaQueryResult {
  return {
    id: `${overrides.lawId}-${overrides.articleNo ?? 'general'}`,
    document: overrides.document,
    metadata: {
      source: 'legalinfo',
      title: overrides.title,
      sourceId: overrides.lawId,
      lawId: overrides.lawId,
      articleNo: overrides.articleNo ?? '',
      url: `https://legalinfo.mn/mn/detail?lawId=${overrides.lawId}`,
      ...(overrides.metadata ?? {}),
    },
    score: overrides.score ?? 0.82,
    rawScore: overrides.rawScore ?? overrides.score ?? 0.82,
  };
}

const env = {
  RETRIEVAL_SPEED_MODE: 'quality',
  INCLUDE_RELATED_CASES: 'auto',
} as AppEnv;

describe('RetrievalService traffic quality guards', () => {
  it('rejects road-facility Zurchil §5/§6 chunks for parking hit-and-run queries', () => {
    const badRoadFacility = chunk({
      title: 'ЗӨРЧЛИЙН ТУХАЙ',
      lawId: '12695',
      articleNo: '5',
      document:
        '5 дугаар зүйл. Авто зам, замын байгууламж, тэмдэг, тэмдэглэлийг гэмтээх, орц гарц, зогсоолын талбай, хурд сааруулагч хийх.',
    });
    const badRouteStop = chunk({
      title: 'ЗӨРЧЛИЙН ТУХАЙ',
      lawId: '12695',
      articleNo: '6',
      document:
        '6 дугаар зүйл. Чиглэлийн тээврийн хэрэгслийн чиглэл, замналын зогсоолыг зөвшөөрөлгүй өөрчлөх.',
    });

    expect(__test__.isTrafficIncidentRelevantResult(badRoadFacility)).toBe(false);
    expect(__test__.isTrafficIncidentRelevantResult(badRouteStop)).toBe(false);
  });

  it('keeps canonical accident-related laws for traffic hit-and-run queries', () => {
    const zurchil147 = chunk({
      title: 'ЗӨРЧЛИЙН ТУХАЙ',
      lawId: '12695',
      articleNo: '14.7',
      document:
        '14.7 дугаар зүйл. Замын хөдөлгөөний дүрэм зөрчих. Жолооч ослын газраас зугтах, мэдэгдэх үүргээ биелүүлэхгүй байх.',
    });
    const civil497 = chunk({
      title: 'ИРГЭНИЙ ХУУЛЬ',
      lawId: '299',
      articleNo: '497',
      document:
        '497 дугаар зүйл. Гэм хор учруулснаас хариуцлага хүлээх үндэслэл. Эд хөрөнгөд учирсан хохирлыг нөхөн төлүүлэх.',
    });

    expect(__test__.isTrafficIncidentRelevantResult(zurchil147)).toBe(true);
    expect(__test__.isTrafficIncidentRelevantResult(civil497)).toBe(true);
  });

  it('does not retrieve related court cases for practical traffic advice unless explicitly requested', () => {
    const practical =
      'Өчигдөр орой зогсоолд зогсож байсан машиныг мөргөөд зугтсан байна ямар арга хэмжээ авах вэ';
    const explicit = 'Зогсоолд мөргөөд зугтсан ижил төстэй шүүхийн кейс байна уу?';
    const serious = 'Согтуугаар жолоодож осол гаргаад хүн гэмтээсэн бол ямар ял авах вэ?';

    expect(__test__.shouldRetrieveRelatedCasesForQuery(env, practical, 'traffic', 'qa')).toBe(
      false,
    );
    expect(__test__.shouldRetrieveRelatedCasesForQuery(env, explicit, 'traffic', 'qa')).toBe(true);
    expect(__test__.shouldRetrieveRelatedCasesForQuery(env, serious, 'traffic', 'qa')).toBe(true);
  });

  it('uses compact retrieval caps for practical traffic incidents even in quality mode', () => {
    const config = __test__.getRetrievalRuntimeConfig(
      env,
      'Өчигдөр орой зогсоолд зогсож байсан машиныг мөргөөд зугтсан байна ямар арга хэмжээ авах вэ',
      false,
      false,
      'traffic',
      'qa',
    );

    expect(config.maxQueryVariants).toBeLessThanOrEqual(4);
    expect(config.rerankCandidateLimit).toBeLessThanOrEqual(12);
    expect(config.retrieveRelatedCases).toBe(false);
    expect(config.caseVectorTopK).toBe(0);
    expect(config.caseKeywordTopK).toBe(0);
  });

  it('uses compact retrieval caps for common labor and consumer practical questions', () => {
    const laborConfig = __test__.getRetrievalRuntimeConfig(
      env,
      'Ажлаас үндэслэлгүй халагдсан бол яаж шийдвэрлэх вэ?',
      false,
      false,
      'labor',
      'qa',
    );
    const consumerConfig = __test__.getRetrievalRuntimeConfig(
      env,
      'Онлайн дэлгүүрээс авсан бараа доголдолтой ирсэн бол буцаалт маргаж болох уу?',
      false,
      false,
      'contract',
      'qa',
    );

    expect(laborConfig.maxQueryVariants).toBeLessThanOrEqual(4);
    expect(laborConfig.rerankCandidateLimit).toBeLessThanOrEqual(12);
    expect(consumerConfig.maxQueryVariants).toBeLessThanOrEqual(4);
    expect(consumerConfig.rerankCandidateLimit).toBeLessThanOrEqual(12);
  });

  it('builds canonical traffic search variants', () => {
    const variants = __test__.buildSearchQueries(
      'Зогсоолд байсан машиныг мөргөөд зугтсан байна яаж шийдвэрлэх вэ?',
      false,
      '',
    );

    expect(variants.join(' ; ')).toContain('зөрчлийн тухай хууль 14.7');
    expect(variants.join(' ; ')).toContain('иргэний хууль 497');
    expect(variants.join(' ; ')).toContain('ослын газраас зугтсан жолооч');
  });

  it('traffic fallback laws prefer §14.7, driver duties, and civil damages', () => {
    const laws = __test__.buildIntentFallbackRelatedLaws(
      'traffic',
      'Зогсоолд байсан машиныг мөргөөд зугтсан байна яаж шийдвэрлэх вэ?',
    );
    const labels = laws.map((law) => `${law.title} ${law.articleNo}`).join(' | ');

    expect(labels).toContain('Зөрчлийн тухай хууль §14.7');
    expect(labels).toContain('Замын хөдөлгөөний аюулгүй байдлын тухай хууль');
    expect(labels).toContain('Иргэний хууль §497');
    expect(labels).not.toContain('Зөрчлийн тухай хууль §5');
    expect(labels).not.toContain('Зөрчлийн тухай хууль §6');
  });

  it('uses targeted fallback laws for administrative and crime evaluation failures', () => {
    const petition = __test__.buildIntentFallbackRelatedLaws(
      'unknown',
      'Төрийн байгууллага миний өргөдөлд хугацаанд нь хариу өгөхгүй бол хаана гомдол гаргах вэ?',
    );
    const propertyDamage = __test__.buildIntentFallbackRelatedLaws(
      'crime',
      'Согтуугаар бусдын эд хөрөнгийг эвдсэн бол ямар хуулиар шийдвэрлэх вэ?',
    );
    const defamation = __test__.buildIntentFallbackRelatedLaws(
      'crime',
      'Бусдын нэр төрд халдсан худал мэдээлэл тараавал ямар хариуцлага үүсэх вэ?',
    );

    expect(petition.map((law) => law.title).join(' | ')).toContain('Захиргааны ерөнхий хууль');
    expect(petition.map((law) => law.title).join(' | ')).not.toContain('Иргэний хууль §225.1');
    expect(propertyDamage.map((law) => law.title).join(' | ')).toContain('Эрүүгийн хууль');
    expect(propertyDamage.map((law) => law.title).join(' | ')).toContain('Иргэний хууль §497');
    expect(defamation.map((law) => law.title).join(' | ')).toContain('Эрүүгийн хууль');
  });
});

describe('RetrievalService bank loan Postgre quality guards', () => {
  const overdueQuery =
    'Банкнаас зээл аваад сүүлийн 3 сар төлбөрийг төлсөнгүй ямар арга хэмжээ авах вэ';

  it('classifies bank loan subtypes without turning insurance disputes into bank retrieval', () => {
    expect(__test__.resolveContractSubtype(overdueQuery)).toBe('bank_loan_overdue');
    expect(__test__.resolveContractSubtype('Банкнаас зээл авахдаа аль хууль дээр анхаарах вэ')).toBe(
      'bank_loan_application',
    );
    expect(__test__.resolveContractSubtype('Банкны барьцаатай зээл төлөөгүй бол яах вэ')).toBe(
      'bank_loan_collateral',
    );
    expect(__test__.resolveContractSubtype('Даатгалын компани нөхөн төлбөр өгөхгүй байна')).toBe(
      'generic_contract',
    );
  });

  it('rejects insurance, franchise, inheritance, and noisy generic civil chunks for bank overdue queries', () => {
    const badInsurance = chunk({
      title: 'ДААТГАЛЫН ТУХАЙ',
      lawId: '232',
      articleNo: '28',
      document: '28 дугаар зүйл. Үйлчлэхгүй. Даатгалын гэрээний зарим харилцаанд хамаарахгүй.',
    });
    const badDepositInsurance = chunk({
      title: 'БАНКИН ДАХЬ МӨНГӨН ХАДГАЛАМЖИЙН ДААТГАЛЫН ТУХАЙ',
      lawId: '9022',
      articleNo: '7',
      document: 'Хадгаламжийн даатгалд үл хамаарах нөхцөл, нөхөн төлбөрийн хэмжээ.',
    });
    const badFranchise = chunk({
      title: 'ИРГЭНИЙ ХУУЛЬ',
      lawId: '299',
      articleNo: '333',
      document: '333 дугаар зүйл. Франчайзийн гэрээ.',
    });
    const badInheritance = chunk({
      title: 'ИРГЭНИЙ ХУУЛЬ',
      lawId: '299',
      articleNo: '24',
      document: '24 дүгээр зүйл. Д заасан өдрөөс өв нээгдэнэ.',
    });

    expect(__test__.isBankLoanRelevantResult(overdueQuery, badInsurance)).toBe(false);
    expect(__test__.isBankLoanRelevantResult(overdueQuery, badDepositInsurance)).toBe(false);
    expect(__test__.isBankLoanRelevantResult(overdueQuery, badFranchise)).toBe(false);
    expect(__test__.isBankLoanRelevantResult(overdueQuery, badInheritance)).toBe(false);
  });

  it('keeps Civil Code loan articles and bank loan activity chunks for bank overdue queries', () => {
    const civil451 = chunk({
      title: 'ИРГЭНИЙ ХУУЛЬ',
      lawId: '299',
      articleNo: '451',
      document:
        '451 дүгээр зүйл. Банк, зээлийн үйл ажиллагаа эрхлэх эрх бүхий хуулийн этгээдээс зээл олгох гэрээ.',
    });
    const civil452 = chunk({
      title: 'ИРГЭНИЙ ХУУЛЬ',
      lawId: '299',
      articleNo: '452',
      document:
        '452 дугаар зүйл. Банк, зээлийн үйл ажиллагаа эрхлэх эрх бүхий этгээдээс олгох зээлийн хүү, нэмэгдүүлсэн хүү.',
    });
    const civil453 = chunk({
      title: 'ИРГЭНИЙ ХУУЛЬ',
      lawId: '299',
      articleNo: '453',
      document: '453 дугаар зүйл. Зээлдэгч зээлийг гэрээнд заасан хугацаанд буцаан төлөх үүрэгтэй.',
    });
    const bankLoanLaw = chunk({
      title:
        'БАНК, ЭРХ БҮХИЙ ХУУЛИЙН ЭТГЭЭДИЙН МӨНГӨН ХАДГАЛАМЖ, МӨНГӨН ХӨРӨНГИЙН ШИЛЖҮҮЛЭГ, ЗЭЭЛИЙН ҮЙЛ АЖИЛЛАГААНЫ ТУХАЙ',
      lawId: '16230554816671',
      articleNo: '20',
      document: 'Зээлийн гэрээ, зээлийн хүү, зээлийн хувийн хэрэг, зээлийн үйл ажиллагааны нөхцөл.',
    });
    const followOnLaw = chunk({
      title:
        'БАНК, ЭРХ БҮХИЙ ХУУЛИЙН ЭТГЭЭДИЙН МӨНГӨН ХАДГАЛАМЖ, МӨНГӨН ХӨРӨНГИЙН ШИЛЖҮҮЛЭГ, ЗЭЭЛИЙН ҮЙЛ АЖИЛЛАГААНЫ ТУХАЙ ХУУЛЬ /ШИНЭЧИЛСЭН НАЙРУУЛГА/-ИЙГ ДАГАЖ МӨРДӨХ ЖУРМЫН ТУХАЙ',
      lawId: '16230549381421',
      articleNo: '1',
      document: 'Дагаж мөрдөх журмын тухай зохицуулалт.',
    });

    expect(__test__.isBankLoanRelevantResult(overdueQuery, civil451)).toBe(true);
    expect(__test__.isBankLoanRelevantResult(overdueQuery, civil452)).toBe(true);
    expect(__test__.isBankLoanRelevantResult(overdueQuery, civil453)).toBe(true);
    expect(__test__.isBankLoanRelevantResult(overdueQuery, bankLoanLaw)).toBe(true);
    expect(__test__.isBankLoanRelevantResult(overdueQuery, followOnLaw)).toBe(false);
  });

  it('filters noisy top chunks and preserves canonical bank loan sources', () => {
    const badInsurance = chunk({
      title: 'ДААТГАЛЫН ТУХАЙ',
      lawId: '232',
      articleNo: '28',
      document: '28 дугаар зүйл. Үйлчлэхгүй.',
      score: 0.95,
    });
    const badFranchise = chunk({
      title: 'ИРГЭНИЙ ХУУЛЬ',
      lawId: '299',
      articleNo: '333',
      document: '333 дугаар зүйл. Франчайзийн гэрээ.',
      score: 0.94,
    });
    const civil452 = chunk({
      title: 'ИРГЭНИЙ ХУУЛЬ',
      lawId: '299',
      articleNo: '452',
      document:
        '452 дугаар зүйл. Зээлийн хүү, нэмэгдүүлсэн хүү, хугацаа хэтэрсэн төлбөрийн зохицуулалт.',
      score: 0.72,
    });
    const civil451 = chunk({
      title: 'ИРГЭНИЙ ХУУЛЬ',
      lawId: '299',
      articleNo: '451',
      document: '451 дүгээр зүйл. Банкнаас зээл олгох гэрээ, зээлдэгчийн үүрэг.',
      score: 0.7,
    });

    const filtered = __test__.applyBankLoanFiltering(overdueQuery, [
      badInsurance,
      badFranchise,
      civil451,
      civil452,
    ]);
    const articleNos = filtered.map((result) => String(result.metadata.articleNo));

    expect(articleNos).toEqual(expect.arrayContaining(['451', '452']));
    expect(articleNos).not.toContain('28');
    expect(articleNos).not.toContain('333');
    expect(filtered[0]?.metadata.articleNo).toBe('452');
  });

  it('uses canonical bank loan fallback laws instead of displaying noisy retrieved laws', () => {
    const laws = __test__.buildBankLoanFallbackRelatedLaws(overdueQuery);
    const labels = laws.map((law) => `${law.title} ${law.articleNo}`).join(' | ');

    expect(labels).toContain('Иргэний хууль §451');
    expect(labels).toContain('Иргэний хууль §452');
    expect(labels).toContain('Иргэний хууль §453');
    expect(labels).toContain('Банк, эрх бүхий хуулийн этгээдийн мөнгөн хадгаламж');
    expect(labels).not.toContain('Даатгал');
    expect(labels).not.toContain('Франчайз');
    expect(labels).not.toContain('§232');
  });

  it('keeps bank loan retrieval compact even when quality mode is enabled', () => {
    const config = __test__.getRetrievalRuntimeConfig(
      env,
      overdueQuery,
      false,
      false,
      'contract',
      'qa',
    );

    expect(config.maxQueryVariants).toBeLessThanOrEqual(4);
    expect(config.rerankCandidateLimit).toBeLessThanOrEqual(12);
    expect(config.retrieveRelatedCases).toBe(false);
    expect(config.caseVectorTopK).toBe(0);
    expect(config.caseKeywordTopK).toBe(0);
  });
});
