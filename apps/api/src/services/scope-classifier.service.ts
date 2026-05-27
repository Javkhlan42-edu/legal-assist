import { classifyLegalIntent, type QueryIntent } from './query-rewrite.service.js';
import { extractRetrievalKeywordProfile } from './keyword-extraction.service.js';
import {
  getAllColloquialLegalKeywords,
  getAllLegalKeywords,
  getAllProtectedNonLegalPhrases,
} from './domain-knowledge.service.js';

export type ScopeClassification = 'legal' | 'greeting' | 'non_legal';

export interface ScopeClassificationResult {
  scope: ScopeClassification;
  legalScore: number;
  nonLegalScore: number;
  greetingScore: number;
  matchedLegalKeywords: string[];
  matchedColloquialKeywords: string[];
  matchedNonLegalKeywords: string[];
  matchedGreetings: string[];
  intentHint: QueryIntent;
}

const GREETING_PATTERNS = [
  'сайн байна уу',
  'сайн уу',
  'hello',
  'hi',
  'hey',
  'байна уу',
  'баярлалаа',
  'thanks',
  'thank you',
  'туслаач',
  'туслаарай',
  'мэнд',
  'өглөөний мэнд',
  'өдрийн мэнд',
  'оройн мэнд',
  'ok',
  'за',
];

const BASE_LEGAL_KEYWORDS = [
  'хууль',
  'зүйл',
  'заалт',
  'эрх',
  'үүрэг',
  'хариуцлага',
  'нэхэмжлэл',
  'шүүх',
  'шүүгч',
  'прокурор',
  'цагдаа',
  'гэмт хэрэг',
  'зөрчил',
  'эрүүгийн',
  'иргэний',
  'хөдөлмөр',
  'гэр бүл',
  'тэтгэлэг',
  'асрамж',
  'гэрээ',
  'үүрэг гүйцэтгэх',
  'алданги',
  'нөхөн төлбөр',
  'гэм хор',
  'барьцаа',
  'ипотек',
  'зээл',
  'банк',
  'даатгал',
  'татвар',
  'шимтгэл',
  'өмч',
  'өмчлөх',
  'шилжүүлэх',
  'түрээс',
  'ажлаас халах',
  'цалин',
  'амралт',
  'сонгууль',
  'замын хөдөлгөөн',
  'жолооч',
  'авто осол',
  'осол',
  'хулгай',
  'залилан',
  'луйвар',
  'цахим луйвар',
  'цахим залилан',
  'онлайн залилан',
  'фишинг',
  'кибер',
  'хувийн мэдээлэл',
  'хувийн нууц',
  'зөвшөөрөлгүй нийтлэх',
  'аккаунт',
  'дээрэм',
  'шийдвэр гүйцэтгэл',
  'нотлох баримт',
  'давж заалдах',
  'шүүхэд хандах',
  'өргөдөл',
  'гомдол',
  'гэрч',
  'хохирол',
  'торгууль',
  'эрх хасах',
  'нийтийн хэв журам',
  'амгалан тайван',
  'амгалан тайван байдал',
  'дуу чимээ',
  'шуугиан',
  'хөрш',
  'шөнийн цаг',
  'хэрэглэгч',
  'бараа',
  'үйлчилгээ',
  'буцаалт',
  'баталгаа',
  'өв залгамжлал',
  'гэрээслэл',
  'өвлөх',
  'газар',
  'кадастр',
  'улсын бүртгэл',
  'захиргаа',
  'зөвшөөрөл',
  'лиценз',
  'паспорт',
  'иргэний бүртгэл',
];

const LEGAL_KEYWORDS = Array.from(new Set([...BASE_LEGAL_KEYWORDS, ...getAllLegalKeywords()]));

const BASE_COLLOQUIAL_LEGAL_KEYWORDS = [
  'яаж шийдэх',
  'яаж мөнгөө авах',
  'цагдаад өгөх',
  'гомдол гаргах',
  'өрөө төлөхгүй',
  'банк дарамтлаад',
  'ажлаас халчихлаа',
  'машин шүргэсэн',
  'машин мөргөлдсөн',
  'даатгал мөнгөө өгөхгүй',
  'түрээсийн барьцаа',
  'утсаа хулгайд алдсан',
  'цахим луйварт өртсөн',
  'цахим луйвар болсон',
  'онлайнаар залилуулсан',
  'мөнгө шилжүүлээд залилуулсан',
  'данс руу мөнгө шилжүүлсэн',
  'фэйсбүүкээр залилуулсан',
  'линкээр орж залилуулсан',
  'зураг зөвшөөрөлгүй тавьсан',
  'зураг тараана гэж сүрдүүлсэн',
  'сошиал хаягаа алдсан',
  'дансаа хакердуулсан',
  'хувийн мэдээлэл алдагдсан',
  'хүүхдээ уулзуулахгүй',
  'тэтгэлэг өгөхгүй',
  'салмаар байна',
  'гэрлэлт цуцлах',
  'өв залгамжлал',
  'үл хөдлөх',
  'хашаа газар',
  'зөрчил гаргасан',
  'ял авах уу',
  'торгуулсан',
  'барьцаа хөрөнгө',
  'гэрээ зөрчсөн',
  'өр төлбөр',
  'зээлийн төлбөр',
  'нэмэгдүүлсэн хүү',
  'алданги тооцсон',
  'шүүхэд өгнө гэсэн',
  'IMEI',
  'сим хаах',
  'гэр бүлийн хүчирхийлэл',
  'хүүхэд зодож',
  'яаралтай тусламж',
  'гэрчийн мэдүүлэг',
  'давах шат',
  'мөнгө нэхэх',
  'ажил олгогч',
  'мөрдөн шалгах',
  'шийтгэх тогтоол',
  'хөдөлмөрийн гэрээ',
  'ажлаас үндэслэлгүй',
  'гадаад паспорт',
  'оршин суух',
  'импорт',
  'лиценз',
  'тусгай зөвшөөрөл',
  'нотариат',
  'кадастр',
  'хажуу айл дуу чимээ',
  'хажуу байр дуу чимээ',
  'амгалан тайван байдал алдагдуулах',
  'шөнийн цагаар дуу чимээ',
  'цагдаа дуудах',
  'хөрш шуугиан',
  'бараа буцаахгүй',
  'онлайн дэлгүүр буцаалт өгөхгүй',
  'баталгаат засвар хийхгүй',
  'чанаргүй бараа',
  'өв нээлгэх',
  'гэрээслэл маргаан',
  'газрын маргаан',
  'кадастр давхцсан',
  'улсын бүртгэлд бүртгүүлэхгүй',
  'зөвшөөрөл өгөхгүй',
  'лиценз цуцалсан',
  'паспорт татгалзсан',
];

const COLLOQUIAL_LEGAL_KEYWORDS = Array.from(
  new Set([...BASE_COLLOQUIAL_LEGAL_KEYWORDS, ...getAllColloquialLegalKeywords()]),
);

const NON_LEGAL_KEYWORDS = [
  'кино',
  'дуу',
  'тоглоом',
  'спорт',
  'хоол',
  'жор',
  'турах',
  'диет',
  'фитнес',
  'аялал',
  'цаг агаар',
  'зураг',
  'өнгө',
  'дизайн',
  'код',
  'програм',
  'html',
  'css',
  'javascript',
  'python',
  'react',
  'алгоритм',
  'математик',
  'физик',
  'хими',
  'биологи',
  'эмчилгээ',
  'эм уух',
  'өвчин',
  'вакцин',
  'халуун',
  'толгой өвдөх',
  'стресс',
  'сэтгэл зүй',
  'зоос',
  'крипто',
  'bitcoin',
  'twitter',
  'facebook',
  'instagram',
  'youtube',
  'tiktok',
  'pc',
  'laptop',
  'утас засах',
  'фильм',
  'аниме',
  'лоол',
  'меме',
  'хичээл',
  'essay',
  'дүрэм',
];

const UNICODE_GREETING_PATTERNS = [
  'сайн байна уу',
  'сайн уу',
  'баярлалаа',
  'туслаач',
  'туслаарай',
  'мэнд',
  'өглөөний мэнд',
  'өдрийн мэнд',
  'оройн мэнд',
  'за',
];

const UNICODE_LEGAL_KEYWORDS = [
  'хууль',
  'зүйл',
  'заалт',
  'эрх',
  'үүрэг',
  'хариуцлага',
  'нэхэмжлэл',
  'шүүх',
  'шүүгч',
  'прокурор',
  'цагдаа',
  'гэмт хэрэг',
  'зөрчил',
  'эрүүгийн',
  'иргэний',
  'хөдөлмөр',
  'гэр бүл',
  'тэтгэлэг',
  'асрамж',
  'гэрээ',
  'алданги',
  'нөхөн төлбөр',
  'гэм хор',
  'барьцаа',
  'ипотек',
  'зээл',
  'банк',
  'даатгал',
  'татвар',
  'шимтгэл',
  'өмч',
  'түрээс',
  'ажлаас хал',
  'цалин',
  'замын хөдөлгөөн',
  'жолооч',
  'авто осол',
  'машин',
  'мөргөлд',
  'шүргэ',
  'осол',
  'хулгай',
  'залилан',
  'луйвар',
  'цахим луйвар',
  'цахим залилан',
  'авлига',
  'хахууль',
  'нотлох баримт',
  'давж заалдах',
  'өргөдөл',
  'гомдол',
  'гэрч',
  'хохирол',
  'торгууль',
  'эрх хасах',
  'нийтийн хэв журам',
  'амгалан тайван',
  'дуу чимээ',
  'шуугиан',
  'хөрш',
  'хэрэглэгч',
  'бараа',
  'үйлчилгээ',
  'буцаалт',
  'доголдол',
  'баталгаа',
  'онлайн дэлгүүр',
  'өв залгамжлал',
  'гэрээслэл',
  'газар',
  'кадастр',
  'улсын бүртгэл',
  'захиргаа',
  'зөвшөөрөл',
  'лиценз',
  'паспорт',
  'иргэний бүртгэл',
];

const UNICODE_COLLOQUIAL_LEGAL_KEYWORDS = [
  'яаж шийдэх',
  'яах вэ',
  'ямар арга хэмжээ',
  'яаж мөнгөө авах',
  'цагдаад өгөх',
  'гомдол гаргах',
  'өрөө төлөхгүй',
  'банкнаас зээл',
  'зээлийн төлбөр',
  'ажлаас халуулсан',
  'ажлаас үндэслэлгүй',
  'машин шүргэсэн',
  'машин мөргөлдсөн',
  'даатгал мөнгөө өгөхгүй',
  'түрээсийн барьцаа',
  'утсаа хулгайд алдсан',
  'цахим луйварт өртсөн',
  'онлайнаар залилуулсан',
  'мөнгө шилжүүлээд залилуулсан',
  'хүүхэд зодож',
  'гэр бүлийн хүчирхийлэл',
  'шүүхэд өгнө',
  'нэхэмжлэл гаргах',
  'бараа буцаахгүй',
  'буцаалт өгөхгүй',
  'доголдолтой ирсэн',
  'камер бичлэг байхгүй',
  'нөхөн төлбөр өгөхгүй',
];

const UNICODE_NON_LEGAL_KEYWORDS = [
  'кино',
  'тоглоом',
  'хоол',
  'жор',
  'диет',
  'спорт',
  'аялал',
  'цаг агаар',
  'зураг зурах',
  'дизайн',
  'код бич',
  'javascript',
  'python',
  'react',
  'крипто',
  'bitcoin',
];

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function countKeywordMatches(query: string, keywords: string[]): string[] {
  const normalized = normalizeText(query);
  return keywords.filter((keyword) => normalized.includes(normalizeText(keyword)));
}

function countNonLegalKeywordMatches(query: string, keywords: string[]): string[] {
  const normalized = normalizeText(query);
  const protectedLegalPhrases = getAllProtectedNonLegalPhrases();

  return keywords.filter((keyword) => {
    const normalizedKeyword = normalizeText(keyword);
    if (
      protectedLegalPhrases.some((phrase) => normalized.includes(phrase)) &&
      (normalizedKeyword === 'дуу' || normalizedKeyword === 'өнгө')
    ) {
      return false;
    }

    if (/^[а-яөүёa-z0-9]{1,4}$/i.test(normalizedKeyword)) {
      const escaped = normalizedKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^а-яөүёa-z0-9])${escaped}($|[^а-яөүёa-z0-9])`, 'i').test(
        normalized,
      );
    }

    return normalized.includes(normalizedKeyword);
  });
}

function looksLikeGreetingOnly(
  normalized: string,
  matchedGreetings: string[],
  matchedLegalKeywords: string[],
  matchedColloquialKeywords: string[],
): boolean {
  if (normalized.length === 0) {
    return true;
  }

  return (
    matchedGreetings.length > 0 &&
    matchedLegalKeywords.length === 0 &&
    matchedColloquialKeywords.length === 0 &&
    normalized.length <= 32
  );
}

export function classifyScope(query: string): ScopeClassificationResult {
  const normalized = normalizeText(query);
  const matchedGreetings = Array.from(
    new Set([
      ...countKeywordMatches(normalized, GREETING_PATTERNS),
      ...countKeywordMatches(normalized, UNICODE_GREETING_PATTERNS),
    ]),
  );
  const matchedLegalKeywords = Array.from(
    new Set([
      ...countKeywordMatches(normalized, LEGAL_KEYWORDS),
      ...countKeywordMatches(normalized, UNICODE_LEGAL_KEYWORDS),
    ]),
  );
  const matchedColloquialKeywords = Array.from(
    new Set([
      ...countKeywordMatches(normalized, COLLOQUIAL_LEGAL_KEYWORDS),
      ...countKeywordMatches(normalized, UNICODE_COLLOQUIAL_LEGAL_KEYWORDS),
    ]),
  );
  const matchedNonLegalKeywords = Array.from(
    new Set([
      ...countNonLegalKeywordMatches(normalized, NON_LEGAL_KEYWORDS),
      ...countNonLegalKeywordMatches(normalized, UNICODE_NON_LEGAL_KEYWORDS),
    ]),
  );
  const keywordProfile = extractRetrievalKeywordProfile(query);
  const detectedIntent = classifyLegalIntent(query);
  const intentHint = detectedIntent !== 'unknown' ? detectedIntent : keywordProfile.primaryDomain;

  const greetingScore = matchedGreetings.length;
  const legalScore =
    matchedLegalKeywords.length * 2 +
    matchedColloquialKeywords.length +
    keywordProfile.legalScore +
    (intentHint !== 'unknown' ? 2 : 0);
  const nonLegalScore = matchedNonLegalKeywords.length * 2;

  if (
    looksLikeGreetingOnly(
      normalized,
      matchedGreetings,
      matchedLegalKeywords,
      matchedColloquialKeywords,
    )
  ) {
    return {
      scope: 'greeting',
      legalScore,
      nonLegalScore,
      greetingScore,
      matchedLegalKeywords,
      matchedColloquialKeywords,
      matchedNonLegalKeywords,
      matchedGreetings,
      intentHint,
    };
  }

  const scope =
    legalScore > nonLegalScore || matchedLegalKeywords.length > 0 || matchedColloquialKeywords.length > 0
      ? 'legal'
      : greetingScore > 0 && nonLegalScore === 0
        ? 'greeting'
        : 'non_legal';

  return {
    scope,
    legalScore,
    nonLegalScore,
    greetingScore,
    matchedLegalKeywords,
    matchedColloquialKeywords,
    matchedNonLegalKeywords,
    matchedGreetings,
    intentHint,
  };
}
