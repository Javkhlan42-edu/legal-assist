import { describe, expect, it } from 'vitest';
import {
  classifyLegalIntent,
  isTrafficInsuranceClaimQuery,
  resolveCuratedQueryScenario,
  rewriteQuery,
} from '../../src/services/query-rewrite.service.ts';

describe('QueryRewriteService', () => {
  it('classifies readable Mongolian labor, traffic, cyber, and consumer queries', () => {
    expect(classifyLegalIntent('Ажлаас үндэслэлгүй халагдсан бол яаж шийдвэрлэх вэ?')).toBe(
      'labor',
    );
    expect(
      classifyLegalIntent(
        'Өчигдөр орой зогсоолд зогсож байсан машиныг мөргөөд зугтсан байна ямар арга хэмжээ авах вэ',
      ),
    ).toBe('traffic');
    expect(classifyLegalIntent('цахим луйварт өртсөн ямар арга хэмжээ авах вэ')).toBe('crime');
    expect(
      classifyLegalIntent(
        'Онлайн дэлгүүрээс худалдан авсан бүтээгдэхүүн доголдолтой ирсэн. Буцаалт төлүүлэхийг маргалж болох уу?',
      ),
    ).toBe('contract');
  });

  it('adds canonical traffic hit-and-run expansions without mojibake', () => {
    const rewritten = rewriteQuery(
      'Өчигдөр орой зогсоолд зогсож байсан машиныг мөргөөд зугтсан байна ямар арга хэмжээ авах вэ',
    );

    expect(rewritten).toContain('зөрчлийн тухай хууль 14.7');
    expect(rewritten).toContain('ослын газраас зугтсан жолооч');
    expect(rewritten).toContain('иргэний хууль 497');
    expect(rewritten).not.toMatch(/[ÐÑÒÓÃÂ]/);
  });

  it('keeps traffic insurance claims in contract/insurance retrieval instead of hit-and-run traffic', () => {
    const query =
      "Даатгалын компани 'камер бичлэг байхгүй' гэдгээр нөхөн төлбөр өгөхгүй. Маргалж болох уу?";
    const rewritten = rewriteQuery(query);

    expect(classifyLegalIntent(query)).toBe('contract');
    expect(isTrafficInsuranceClaimQuery(query)).toBe(true);
    expect(rewritten).toContain('даатгалын тухай хууль нөхөн төлбөр');
    expect(rewritten).toContain('иргэний хууль даатгалын гэрээ');
    expect(rewritten).not.toContain('ослын газраас зугтсан жолооч');
  });

  it('resolves parking hit-and-run and labor dismissal scenarios for workflow routing', () => {
    expect(
      resolveCuratedQueryScenario(
        'Зогсоолд байсан машиныг мөргөөд зугтсан байна яаж шийдвэрлэх вэ?',
        'traffic',
      ),
    ).toBe('traffic_collision_hit_and_run');

    expect(
      resolveCuratedQueryScenario('Ажлаас үндэслэлгүй халагдсан бол яах вэ?', 'labor'),
    ).toBe('labor_dismissal');
  });

  it('keeps bank loan and public-noise expansions focused', () => {
    const bank = rewriteQuery(
      'Банкнаас авсан зээлийг 2-3 сар төлөөгүй. Торгуулийн хэмжээ хэд байх вэ?',
    );
    const noise = rewriteQuery(
      'Манай хажуу байрны айл хэт их дуу чимээ гаргаад амгалан тайван байдал алдагдуулаад байна.',
    );

    expect(classifyLegalIntent('Банкнаас зээл авахдаа аль аль хууль дээр анхаарах вэ')).toBe(
      'contract',
    );
    expect(bank).toContain('иргэний хууль банк зээлийн гэрээ');
    expect(bank).toContain('үүрэг гүйцэтгэгч хугацаа хэтрүүлэх');
    expect(bank).not.toContain('хадгаламжийн даатгал');

    expect(classifyLegalIntent(noise)).toBe('crime');
    expect(noise).toContain('амгалан тайван байдал алдагдуулах дуу чимээ');
    expect(noise).not.toContain('даатгалын тухай хууль');
  });
});
