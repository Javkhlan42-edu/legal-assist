import { describe, expect, it } from 'vitest';
import { classifyLegalIntent, rewriteQuery } from '../../src/services/query-rewrite.service.ts';

describe('QueryRewriteService', () => {
  it('classifies inflected labor queries as labor intent', () => {
    expect(classifyLegalIntent('ажилтны эрх, үүргийн талаар дэлгэрэнгүй мэдээлэл өгнө үү')).toBe(
      'labor',
    );
    expect(classifyLegalIntent('ажилтны эрх үүрэг')).toBe('labor');
  });

  it('adds labor law expansions for longer worker-rights questions', () => {
    const rewritten = rewriteQuery('ажилтны эрх, үүргийн талаар дэлгэрэнгүй мэдээлэл өгнө үү');

    expect(rewritten).toContain('хөдөлмөрийн тухай хууль');
    expect(rewritten).toContain('хөдөлмөрийн тухай хууль ажилтан ажил олгогч');
  });

  it('does not overmatch unrelated longer words that only share a short prefix', () => {
    expect(classifyLegalIntent('ажиллагааны журам')).toBe('unknown');
  });

  it('classifies traffic collision and parking hit-and-run questions as traffic intent', () => {
    expect(
      classifyLegalIntent(
        'Би өнөөдөр замын эсрэг урсгалаас орж ирсэн машиныг санамсаргүй шүргэчлээ ямар хуулиар шийдвэрлэх вэ',
      ),
    ).toBe('traffic');
    expect(
      classifyLegalIntent(
        'Өнөөдөр зогсоолд байсан машиныг машин мөргөөд зугтсан байна. Хэрхэн шийдвэрлэх вэ',
      ),
    ).toBe('traffic');
  });

  it('adds accident-specific traffic expansions for incident questions', () => {
    const oppositeLane = rewriteQuery(
      'Би өнөөдөр замын эсрэг урсгалаас орж ирсэн машиныг санамсаргүй шүргэчлээ ямар хуулиар шийдвэрлэх вэ',
    );
    const parkingHitRun = rewriteQuery(
      'Өнөөдөр зогсоолд байсан машиныг машин мөргөөд зугтсан байна. Хэрхэн шийдвэрлэх вэ',
    );

    expect(oppositeLane).toContain('зам тээврийн осол жолоочийн үүрэг ослын газар зогсох');
    expect(oppositeLane).toContain('эсрэг урсгал зам тээврийн осол жолоочийн буруу');
    expect(parkingHitRun).toContain('зөрчлийн тухай хууль зам тээврийн осол зугтсан жолооч');
    expect(parkingHitRun).toContain('зогсоол дээрх мөргөлт зугтсан жолооч камер цагдаа');
  });

  it('classifies and enriches cyber fraud questions as crime intent', () => {
    const query = 'цахим луйварт өртсөн ямар арга хэмжээ авах вэ';
    const rewritten = rewriteQuery(query);

    expect(classifyLegalIntent(query)).toBe('crime');
    expect(rewritten).toContain('цахим залилан эрүүгийн хууль');
    expect(rewritten).toContain('цахим луйвар цагдаад гомдол гаргах');
  });

  it('keeps bank loan advice focused on loan and banking laws', () => {
    const query = 'Банкнаас зээл авахдаа аль аль хууль дээр анхаарах вэ';
    const rewritten = rewriteQuery(query);

    expect(classifyLegalIntent(query)).toBe('contract');
    expect(rewritten).toContain('банк эрх бүхий хуулийн этгээдийн зээлийн үйл ажиллагаа зээлийн гэрээ зээлийн хүү');
    expect(rewritten).toContain('банкны тухай хууль банкны үйл ажиллагаа зээл');
    expect(rewritten).not.toContain('хадгаламжийн даатгал');
  });

  it('keeps public noise complaints in public-order legal search terms', () => {
    const query =
      'Манай хажуу байрны айл хэт их дуу чимээ гаргаад амгалан тайван байдал алдагдуулаад байна';
    const rewritten = rewriteQuery(query);

    expect(classifyLegalIntent(query)).toBe('crime');
    expect(rewritten).toContain('зөрчлийн тухай хууль амгалан тайван байдал алдагдуулах дуу чимээ');
    expect(rewritten).toContain('цагдаагийн албаны тухай хууль гомдол мэдээлэл');
    expect(rewritten).toContain('дуудлага');
    expect(rewritten).not.toContain('даатгалын тухай хууль');
  });

  it('treats delayed auto-insurance compensation as a civil insurance claim', () => {
    const query =
      '3 сарын өмнө машинтай мөргөлдөөд даатгалаас маань одоо хүртэл мөнгөө олгохгүй байна. камер байхгүй гээд нотолж чадахгүй гэж байна';
    const rewritten = rewriteQuery(query);

    expect(classifyLegalIntent(query)).toBe('contract');
    expect(rewritten).toContain('даатгалын тухай хууль нөхөн төлбөр олгохоос татгалзсан үндэслэл');
    expect(rewritten).toContain('иргэний хууль даатгалын гэрээ даатгалын тохиолдол нөхөн төлбөр');
    expect(rewritten).not.toContain('замын хөдөлгөөний осол зугтах эрүүгийн хууль');
  });

  it('adds focused expansions for consumer, land, inheritance, privacy, and admin questions', () => {
    expect(rewriteQuery('онлайн дэлгүүрээс бараа авсан чинь буцааж авахгүй байна яах вэ')).toContain(
      'хэрэглэгчийн эрхийг хамгаалах тухай хууль бараа үйлчилгээ буцаалт',
    );
    expect(rewriteQuery('газрын гэрчилгээ кадастр давхцаад маргаан гарлаа яах вэ')).toContain(
      'газрын тухай хууль газар эзэмших өмчлөх маргаан',
    );
    expect(rewriteQuery('өв залгамжлал нээлгэхэд ямар материал бүрдүүлэх вэ')).toContain(
      'иргэний хууль өв залгамжлал өвлөх эрх',
    );
    expect(rewriteQuery('миний зургийг зөвшөөрөлгүй фэйсбүүкт тавьсан бол яах вэ')).toContain(
      'хувь хүний мэдээлэл хамгаалах тухай хууль хувийн мэдээлэл алдагдсан',
    );
    expect(rewriteQuery('лиценз цуцалсан шийдвэрт хаана гомдол гаргах вэ')).toContain(
      'захиргааны ерөнхий хууль захиргааны байгууллагын шийдвэр гомдол',
    );
  });
});
