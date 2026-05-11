import type { QueryIntent } from './query-rewrite.service.js';
import { getAllLawHints, getDomainTermsByIntent } from './domain-knowledge.service.js';

export type RetrievalDomain = QueryIntent;

export interface RetrievalDomainSignal {
  domain: RetrievalDomain;
  score: number;
  matches: string[];
}

export interface RetrievalKeywordProfile {
  normalized: string;
  tokens: string[];
  stems: string[];
  topicalTerms: string[];
  phrases: string[];
  lawHints: string[];
  articleRefs: string[];
  expansionTerms: string[];
  domains: RetrievalDomainSignal[];
  primaryDomain: RetrievalDomain;
  legalScore: number;
}

const MONGOLIAN_SUFFIX_PATTERN =
  /(ийн|ын|ийг|ыг|ийнх|ийнгээ|ыгөө|тай|тэй|той|гүй|наас|нээс|ноос|нөөс|аар|ээр|оор|өөр|аас|ээс|оос|өөс|ууд|үүд|нууд|нүүд|даа|дээ|доо|дөө|д|т)$/iu;

const STOPWORDS = new Set([
  'би',
  'чи',
  'та',
  'миний',
  'манай',
  'танай',
  'энэ',
  'тэр',
  'нь',
  'бол',
  'бас',
  'гэж',
  'юм',
  'байна',
  'байгаа',
  'байсан',
  'юу',
  'уу',
  'үү',
  'вэ',
  'яаж',
  'ямар',
  'хэрхэн',
  'болох',
  'болно',
  'аваа',
  'авах',
  'өгөх',
  'төлж',
  'чадаа',
  'тооцох',
  'сүүл',
  'тухай',
  'хууль',
  'зүйл',
  'заалт',
  'хэсэг',
]);

const LEGAL_SIGNAL_TERMS = [
  'хууль',
  'зүйл',
  'заалт',
  'эрх',
  'үүрэг',
  'хариуцлага',
  'шүүх',
  'цагдаа',
  'прокурор',
  'нэхэмжлэл',
  'гомдол',
  'өргөдөл',
  'гэрээ',
  'зөрчил',
  'гэмт хэрэг',
  'залилан',
  'луйвар',
  'фишинг',
  'кибер',
  'хувийн мэдээлэл',
  'хувийн нууц',
  'торгууль',
  'ял',
  'хохирол',
  'нөхөн төлбөр',
  'барьцаа',
  'даатгал',
  'банк',
  'зээл',
  'ажлаас',
  'хүүх',
  'хүүхэд',
  'асрамж',
  'татвар',
  'хэрэглэгч',
  'буцаалт',
  'баталгаа',
  'өв залгамжлал',
  'газар',
  'кадастр',
  'улсын бүртгэл',
  'зөвшөөрөл',
  'лиценз',
];

const BASE_LAW_HINTS = [
  'иргэний хууль',
  'эрүүгийн хууль',
  'зөрчлийн тухай хууль',
  'замын хөдөлгөөний аюулгүй байдлын тухай хууль',
  'даатгалын тухай',
  'банкны тухай',
  'банк, эрх бүхий хуулийн этгээдийн мөнгөн хадгаламж, мөнгөн хөрөнгийн шилжүүлэг, зээлийн үйл ажиллагааны тухай',
  'зээлийн мэдээллийн тухай',
  'гэр бүлийн тухай',
  'хүүхдийн эрхийн тухай',
  'хүүхэд хамгааллын тухай',
  'гэр бүлийн хүчирхийлэлтэй тэмцэх тухай',
  'хөдөлмөрийн тухай',
  'татварын ерөнхий хууль',
  'иргэний хэрэг шүүхэд хянан шийдвэрлэх тухай',
  'эрүүгийн хэрэг хянан шийдвэрлэх тухай',
  'цагдаагийн албаны тухай',
  'харилцаа холбооны тухай',
  'хувь хүний мэдээлэл хамгаалах тухай',
  'кибер аюулгүй байдлын тухай',
  'хэрэглэгчийн эрхийг хамгаалах тухай',
  'газрын тухай',
  'эд хөрөнгийн эрхийн улсын бүртгэлийн тухай',
  'захиргааны ерөнхий хууль',
  'зөвшөөрлийн тухай',
  'үл хөдлөх эд хөрөнгийн барьцааны тухай',
];

const LAW_HINTS = unique([...BASE_LAW_HINTS, ...getAllLawHints()]);

const PHRASE_PATTERNS: Array<{ phrase: string; pattern: RegExp }> = [
  { phrase: 'банкны зээл', pattern: /банк(?:наас|ны)?\s+зээл|зээлийн\s+гэрээ/i },
  {
    phrase: 'зээлийн төлбөр хоцрох',
    pattern:
      /(зээл|зээлийн|банк).{0,80}(төлбөр|6\s+сар|хугацаа\s+хэтрүүл|төлж\s+чадаагүй|барагдуулж\s+чадаагүй)|төлбөр.{0,40}(зээл|банк)/i,
  },
  { phrase: 'даатгалын нөхөн төлбөр', pattern: /даатгал|нөхөн\s+төлбөр|даатгагч|татгалз/i },
  { phrase: 'авто осол', pattern: /машин|автомашин|мөрг|шүрг|осол|зогсоол|паркинг/i },
  { phrase: 'ослын газрыг орхих', pattern: /зугт|ослын\s+газар|орхиод\s+яв/i },
  { phrase: 'согтуугаар жолоодох', pattern: /согтуу|согтуур|мансуур|жолоод/i },
  { phrase: 'хулгай', pattern: /хулгай|алдчих|алдсан|эд\s+хөрөнгө/i },
  {
    phrase: 'залилан',
    pattern: /залил|луйвар|хууран\s+мэхл|мэхэл|фишинг|цахим\s+(?:залилан|луйвар)|онлайн\s+залилан/i,
  },
  {
    phrase: 'цахим залилан',
    pattern:
      /(цахим|онлайн|интернет|фишинг|линк|otp|нэг\s+удаагийн\s+код|карт|данс|шилжүүлэг).{0,80}(луйвар|залил|мэхэл|мөнгө|шилжүүл)|(луйвар|залил).{0,80}(цахим|онлайн|данс|карт|линк|шилжүүлэг)/i,
  },
  {
    phrase: 'хувийн мэдээлэл хамгаалах',
    pattern:
      /(хувийн\s+мэдээлэл|хувийн\s+нууц|зург|зураг|бичлэг|аккаунт|сошиал).{0,100}(алдагд|тараа|тавь|нийтэл|зөвшөөрөлгүй|хакер|сүрдүүл|заналхийл)|(зөвшөөрөлгүй).{0,80}(зург|зураг|бичлэг|нийтэл|тавь)/i,
  },
  {
    phrase: 'хэрэглэгчийн эрх',
    pattern:
      /(хэрэглэгч|бараа|үйлчилгээ|онлайн\s+дэлгүүр|дэлгүүр|захиалга).{0,80}(буцаа|солих|чанаргүй|баталгаа|засвар|мөнгө\s+буцаах|өгөхгүй)/i,
  },
  {
    phrase: 'өв залгамжлал',
    pattern: /өв\s*залгамжлал|өвлөх|өв\s+нээлгэх|гэрээслэл|нотариат.{0,40}өв/i,
  },
  {
    phrase: 'газрын маргаан',
    pattern: /(газар|хашаа|кадастр|үл\s+хөдлөх|улсын\s+бүртгэл).{0,80}(маргаан|давхц|бүртгүүлэх|гэрчилгээ|өмчлөх|эзэмших)/i,
  },
  {
    phrase: 'захиргааны гомдол',
    pattern:
      /(захиргаа|зөвшөөрөл|лиценз|паспорт|иргэний\s+бүртгэл|төрийн\s+байгууллага).{0,80}(татгалз|цуцал|олгохгүй|шийдвэр|гомдол|маргах)/i,
  },
  { phrase: 'амгалан тайван байдал алдагдуулах', pattern: /дуу\s*чимээ|шуугиан|амгалан\s*тайван|хажуу\s*(айл|байр)|хөрш|шөнийн|цаг\s*12/i },
  { phrase: 'гэр бүлийн хүчирхийлэл', pattern: /гэр\s+бүлийн\s+хүчирхийлэл|хүүх(?:эд|дээ|дийн)?[^.?!]{0,50}(зод|цохи|уйлуул|хүчирхийл)/i },
  { phrase: 'хүүхэд хамгаалал', pattern: /хүүх(?:эд|дээ|дийн)?|бага\s+нас|асран\s+хамгаал|хамгаалал/i },
  { phrase: 'ажлаас халах', pattern: /ажлаас|халсан|халах|хөдөлмөрийн\s+гэрээ/i },
  {
    phrase: 'түрээсийн барьцаа',
    pattern: /түрээс|түрээсл|орон\s*сууц.{0,40}(барьцаа|дэнчин)|байрны\s+барьцаа|барьцаа|дэнчин/i,
  },
  { phrase: 'гэрээ зөрчих', pattern: /гэрээ|үүрэг|биелүүлээгүй|зөрч/i },
  { phrase: 'татварын хариуцлага', pattern: /татвар|нөат|тайлан/i },
];

const BASE_DOMAIN_TERMS: Record<Exclude<QueryIntent, 'unknown'>, string[]> = {
  crime: [
    'эрүү',
    'гэмт',
    'ял',
    'цагдаа',
    'прокурор',
    'мөрдөн',
    'хулгай',
    'залилан',
    'луйвар',
    'цахим',
    'онлайн',
    'фишинг',
    'данс',
    'карт',
    'шилжүүлэг',
    'код',
    'линк',
    'кибер',
    'хакер',
    'аккаунт',
    'сошиал',
    'хувийн мэдээлэл',
    'хувийн нууц',
    'зураг',
    'нийтлэх',
    'тараах',
    'заналхийл',
    'сүрдүүл',
    'дээрэм',
    'утас',
    'imei',
    'эрэн сурвалж',
    'зөрчил',
    'нийтийн хэв журам',
    'амгалан тайван',
    'дуу чимээ',
    'шуугиан',
    'хөрш',
    'хажуу айл',
    'шөнө',
  ],
  traffic: [
    'зам',
    'жолоо',
    'жолооч',
    'тээврийн',
    'машин',
    'автомашин',
    'осол',
    'мөргө',
    'мөргөлд',
    'шүргэ',
    'согтуу',
    'согтуур',
    'зогсоол',
    'паркинг',
  ],
  election: ['сонгууль', 'сонгогч', 'санал', 'сонгох эрх', 'үндсэн хууль'],
  contract: [
    'иргэний',
    'гэрээ',
    'үүрэг',
    'өр',
    'төлбөр',
    'зээл',
    'банк',
    'даатгал',
    'нөхөн төлбөр',
    'барьцаа',
    'хохирол',
    'түрээс',
    'өмч',
    'хэрэглэгч',
    'бараа',
    'үйлчилгээ',
    'буцаалт',
    'баталгаа',
    'онлайн худалдаа',
    'өв',
    'өвлөх',
    'өв залгамжлал',
    'гэрээслэл',
    'газар',
    'хашаа',
    'кадастр',
    'улсын бүртгэл',
    'зөвшөөрөл',
    'лиценз',
    'захиргаа',
    'паспорт',
  ],
  tax: ['татвар', 'нөат', 'тайлан'],
  socialInsurance: ['нийгмийн даатгал', 'шимтгэл', 'тэтгэвэр', 'тэтгэмж', 'ндш'],
  labor: ['хөдөлмөр', 'ажилтан', 'ажил олгогч', 'цалин', 'ажлаас', 'халсан', 'амралт'],
  family: [
    'гэр бүл',
    'гэрлэлт',
    'салалт',
    'хүүх',
    'хүүхэд',
    'асрамж',
    'тэтгэлэг',
    'эцэг',
    'эх',
    'уулзуулах',
    'хүчирхийлэл',
  ],
};

const DOMAIN_TERMS = Object.fromEntries(
  (Object.entries(BASE_DOMAIN_TERMS) as Array<[Exclude<QueryIntent, 'unknown'>, string[]]>).map(
    ([domain, terms]) => [domain, unique([...terms, ...(getDomainTermsByIntent()[domain] ?? [])])],
  ),
) as Record<Exclude<QueryIntent, 'unknown'>, string[]>;

export function normalizeKeywordText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:"'`()\[\]{}\\/\n\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stemMongolianToken(token: string): string {
  return token.replace(MONGOLIAN_SUFFIX_PATTERN, '');
}

export function tokenizeForRetrieval(text: string): string[] {
  return normalizeKeywordText(text)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function extractArticleRefs(normalized: string): string[] {
  const refs = new Set<string>();
  const patterns = [
    /(?:§|зүйл\s*)\s*(\d+(?:\.\d+)*)/giu,
    /(\d+(?:\.\d+)*)\s*(?:дугаар|дүгээр)?\s*(?:зүйл|заалт|хэсэг)/giu,
  ];

  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      if (match[1]) {
        refs.add(match[1]);
      }
    }
  }

  return Array.from(refs);
}

function countContains(corpus: string, terms: string[]): { score: number; matches: string[] } {
  const matches = unique(
    terms.filter((term) => {
      const normalizedTerm = normalizeKeywordText(term);
      if (/^[а-яөүёa-z0-9]{1,3}$/i.test(normalizedTerm)) {
        const escaped = normalizedTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(^|[^а-яөүёa-z0-9])${escaped}($|[^а-яөүёa-z0-9])`, 'i').test(
          corpus,
        );
      }

      return corpus.includes(normalizedTerm);
    }),
  );
  return {
    score: matches.length,
    matches,
  };
}

function scoreDomains(normalized: string, stems: string[], phrases: string[]): RetrievalDomainSignal[] {
  const stemCorpus = ` ${stems.join(' ')} `;
  const phraseCorpus = `${normalized} ${phrases.join(' ')}`;

  const signals = (Object.entries(DOMAIN_TERMS) as Array<[Exclude<QueryIntent, 'unknown'>, string[]]>)
    .map(([domain, terms]) => {
      const matches = unique(
        terms.filter((term) => {
          const normalizedTerm = normalizeKeywordText(term);
          const termStems = tokenizeForRetrieval(normalizedTerm).map(stemMongolianToken);
          const phraseMatch = /^[а-яөүёa-z0-9]{1,3}$/i.test(normalizedTerm)
            ? new RegExp(
                `(^|[^а-яөүёa-z0-9])${normalizedTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^а-яөүёa-z0-9])`,
                'i',
              ).test(phraseCorpus)
            : phraseCorpus.includes(normalizedTerm);
          const stemMatch =
            termStems.length > 0 && termStems.every((stem) => stemCorpus.includes(` ${stem} `));
          return phraseMatch || stemMatch;
        }),
      );

      return {
        domain,
        score: matches.length,
        matches,
      };
    })
    .filter((signal) => signal.score > 0)
    .sort((a, b) => b.score - a.score);

  return signals;
}

export function extractRetrievalKeywordProfile(text: string): RetrievalKeywordProfile {
  const normalized = normalizeKeywordText(text);
  const tokens = tokenizeForRetrieval(normalized);
  const stems = unique(
    tokens
      .map(stemMongolianToken)
      .filter((token) => token.length >= 2 && !STOPWORDS.has(token)),
  );
  const topicalTerms = unique(
    stems
      .filter((token) => token.length >= 3)
      .filter((token) => !/^\d+$/.test(token))
      .slice(0, 18),
  );
  const phrases = unique(
    PHRASE_PATTERNS.filter(({ pattern }) => pattern.test(normalized)).map(({ phrase }) => phrase),
  );
  const lawHints = unique(LAW_HINTS.filter((hint) => normalized.includes(normalizeKeywordText(hint))));
  const articleRefs = extractArticleRefs(normalized);
  const domains = scoreDomains(normalized, stems, phrases);
  const legalMatches = countContains(normalized, LEGAL_SIGNAL_TERMS);
  const primaryDomain = domains[0]?.domain ?? 'unknown';
  const expansionTerms = unique([
    ...phrases,
    ...lawHints,
    ...articleRefs.map((article) => `${article} дугаар зүйл`),
    topicalTerms.slice(0, 8).join(' '),
  ]).filter((term) => term.trim().length >= 3);

  return {
    normalized,
    tokens,
    stems,
    topicalTerms,
    phrases,
    lawHints,
    articleRefs,
    expansionTerms,
    domains,
    primaryDomain,
    legalScore: legalMatches.score + phrases.length + lawHints.length * 2,
  };
}

export function countKeywordOverlap(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const rightSet = new Set(right.map(stemMongolianToken));
  return unique(left.map(stemMongolianToken)).reduce(
    (count, token) => count + (rightSet.has(token) ? 1 : 0),
    0,
  );
}

export function buildKeywordSearchLine(profile: RetrievalKeywordProfile): string {
  return unique([
    ...profile.phrases,
    ...profile.lawHints,
    ...profile.articleRefs.map((article) => `${article} дугаар зүйл`),
    ...profile.topicalTerms.slice(0, 10),
  ])
    .join(' ')
    .trim();
}
