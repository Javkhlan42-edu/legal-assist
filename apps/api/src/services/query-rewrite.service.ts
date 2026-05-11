// ────────────────────────────────────────────────────────────
// Query Rewrite Service — Normalize user phrasing to legal search intent
// ────────────────────────────────────────────────────────────

import {
  DOMAIN_KNOWLEDGE,
  LEGAL_DOMAINS,
  getDomainQueryExpansions,
  getPreferredLawIds,
} from './domain-knowledge.service.js';

export type QueryIntent =
  | 'crime'
  | 'traffic'
  | 'election'
  | 'contract'
  | 'tax'
  | 'socialInsurance'
  | 'labor'
  | 'family'
  | 'unknown';

export type QueryMode = 'qa' | 'article' | 'document';
export type CuratedQueryScenario =
  | 'none'
  | 'child_abuse_emergency'
  | 'public_noise_complaint'
  | 'contract_debt'
  | 'family_custody'
  | 'labor_dismissal'
  | 'rental_deposit'
  | 'traffic_collision'
  | 'traffic_collision_hit_and_run';

const BASE_INTENT_PREFERRED_LAW_IDS: Record<Exclude<QueryIntent, 'unknown'>, string[]> = {
  crime: ['12172', '12694', '9287', '12695', '12469', '523'],
  traffic: ['11224', '12695', '12172', '29'],
  election: ['367'],
  contract: ['299', '232'],
  tax: ['13830'],
  socialInsurance: ['12297', '16230709635751'],
  labor: ['16230709635751', '564'],
  family: ['226', '12393', '11709', '17140463602711', '302'],
};

const INTENT_PREFERRED_LAW_IDS = Object.fromEntries(
  LEGAL_DOMAINS.map((domain) => [
    domain,
    Array.from(new Set([...BASE_INTENT_PREFERRED_LAW_IDS[domain], ...getPreferredLawIds(domain)])),
  ]),
) as Record<Exclude<QueryIntent, 'unknown'>, string[]>;

const BASE_INTENT_KEYWORDS: Record<Exclude<QueryIntent, 'unknown'>, string[]> = {
  crime: [
    'эрүүгийн',
    'гэмт хэрэг',
    'хулгай',
    'хулгайлах',
    'залилан',
    'залилах',
    'залилсан',
    'луйвар',
    'луйварт',
    'луйвардсан',
    'цахим луйвар',
    'цахим залилан',
    'онлайн залилан',
    'фишинг',
    'данс руу мөнгө шилжүүлсэн',
    'картын мэдээлэл',
    'otp',
    'нэг удаагийн код',
    'кибер',
    'хакер',
    'аккаунт',
    'сошиал хаяг',
    'хувийн мэдээлэл',
    'хувийн нууц',
    'зураг тараах',
    'зөвшөөрөлгүй нийтлэх',
    'заналхийлэх',
    'сүрдүүлэх',
    'хууран мэхлэх',
    'авлига',
    'дээрэм',
    'дээрэмдэх',
    'дээрэмдсэн',
    'хүчирхийлэл',
    'хахууль',
    'булаах',
    'булаасан',
    'завших',
    'завшсан',
    'үрэгдүүлэх',
    'үрэгдүүлсэн',
    'шамшигдуулах',
    'шамшигдуулсан',
    'дарамтлах',
    'хүн алах',
    'бусдын эд хөрөнгө',
    'гэмт хэргийн',
    'утас',
    'гар утас',
    'хулгайд алдсан',
    'IMEI',
    'эрэн сурвалжлах',
    'цагдаа',
    'цагдаагийн',
    'мөрдөн байцаах',
    'зөрчил',
    'нийтийн хэв журам',
    'амгалан тайван',
    'амгалан тайван байдал',
    'дуу чимээ',
    'шуугиан',
    'хөрш',
    'хажуу айл',
    'хажуу байр',
    'шөнийн цаг',
    'шөнө',
    'цагдаа дууд',
  ],
  traffic: [
    'согтуугаар',
    'согтуу',
    'жолоо',
    'жолоодох',
    'жолоодвол',
    'жолооны эрх',
    'жолоочийн үнэмлэх',
    'тээврийн хэрэгсэл',
    'замын хөдөлгөөн',
    'осол',
    'зөрчил',
    'мөргөх',
    'мөргөөд',
    'мөргсөн',
    'зугтах',
    'зугтсан',
    'зугтчихлаа',
    'машин',
    'автомашин',
    'зам тээвэр',
    'зам тээврийн осол',
    'ослын газар',
    'эсрэг урсгал',
    'зогсоол',
    'паркинг',
    'мөргөлдөөн',
    'мөргөлдсөн',
    'шүргэх',
    'шүргэсэн',
    'шүргэчих',
    'авто даатгал',
    'тээврийн хэрэгслийн даатгал',
    'каско',
    'камер',
    'осолд',
    'тормоз',
    'хурд хэтрүүлэх',
  ],
  election: [
    'сонгууль',
    'сонгуулийн',
    'сонгогч',
    'сонгох эрх',
    'санал өгөх',
    'санал',
    '18 нас',
    'арван найм',
    'үндсэн хууль',
  ],
  contract: [
    'банк',
    'зээл',
    'зээлийн',
    'иргэний',
    'гэрээ',
    'даатгал',
    'даатгагч',
    'даатгуулагч',
    'нөхөн төлбөр',
    'татгалзсан',
    'татгалзах',
    'гал',
    'шатсан',
    'шатчихлаа',
    'түймэр',
    'гэнэтийн эрсдэл',
    'төлбөр',
    'өр',
    'үүрэг',
    'нэхэмжлэл',
    'хохирол',
    'худалдах',
    'худалдан',
    'зарах',
    'шилжүүлэх',
    'эд хөрөнгө',
    'хөрөнгө',
    'үл хөдлөх',
    'өмчлөх',
    'өмчлөлийн',
    'түрээс',
    'түрээслэх',
    'түрээслэгч',
    'түрээслүүлэгч',
    'барьцаа',
    'ипотек',
    'байр',
    'орон сууц',
    'хөрөнгөжсөн',
    'үндэслэлгүй',
    'хэрэглэгч',
    'бараа',
    'үйлчилгээ',
    'буцаалт',
    'баталгаа',
    'онлайн дэлгүүр',
    'чанаргүй бараа',
    'өв залгамжлал',
    'өвлөх',
    'өв нээлгэх',
    'гэрээслэл',
    'нотариат',
    'газар',
    'хашаа газар',
    'кадастр',
    'улсын бүртгэл',
    'захиргаа',
    'зөвшөөрөл',
    'лиценз',
    'паспорт',
    'иргэний бүртгэл',
  ],
  tax: ['татвар', 'албан татвар', 'татвар төлөөгүй', 'нөат', 'татварын', 'гааль', 'импорт', 'ebarimt'],
  family: [
    'гэр бүл',
    'гэрлэлт',
    'салалт',
    'хүүхэд',
    'тэтгэлэг',
    'асран хамгаалах',
    'эцэг эх',
    'уулзуулах',
    'уулзах эрх',
    'харилцах эрх',
    'асрамж',
    'хамт амьдрах',
  ],
  labor: [
    'хөдөлмөр',
    'ажил',
    'ажилтан',
    'ажилтны',
    'ажилчны',
    'ажилтны эрх',
    'ажилтны үүрэг',
    'ажил олгогч',
    'ажил олгогчийн үүрэг',
    'цалин',
    'ажлаас',
    'хөдөлмөрийн гэрээ',
  ],
  socialInsurance: ['нийгмийн даатгал', 'шимтгэл', 'даатгал төлөөгүй', 'ндш', 'нийгмийн хамгаалал'],
};

const INTENT_KEYWORDS = Object.fromEntries(
  LEGAL_DOMAINS.map((domain) => [
    domain,
    Array.from(
      new Set([
        ...BASE_INTENT_KEYWORDS[domain],
        ...DOMAIN_KNOWLEDGE[domain].legalKeywords,
        ...DOMAIN_KNOWLEDGE[domain].colloquialKeywords,
        ...DOMAIN_KNOWLEDGE[domain].domainTerms,
      ]),
    ),
  ]),
) as Record<Exclude<QueryIntent, 'unknown'>, string[]>;

const LABOR_DISMISSAL_QUERY_PATTERN =
  /(ажлаас|ажил\s*олгогч|хөдөлмөр\s*эрхлэлтийн\s*харилцаа).{0,40}(халах|халсан|халчих|халагд|цуцлах|дуусгавар)|үндэслэлгүй\s+хал/i;
/** Зээл/төлбөр төлөгдөөгүй, банкны зээлийн default — урт өгүүлбэр, «барагдуулж чадаагүй» зэргийг хамарна */
const CONTRACT_DEBT_QUERY_PATTERN =
  /(өрөө|өр\s*төлбөр|авлага|зээлээ|зээл|мөнгө|төлбөр).{0,72}(төлөхгүй|өгөхгүй|барагдуулахгүй|барагдуулах|барагдуулж|төлж\s+чадаагүй|чадаагүй|хугацаа\s+хэтрүүл)|үүрэг.{0,32}(биелүүлэхгүй|биелүүлээгүй)|(банкнаас|банкны)\s+зээл.{0,240}(төлөхгүй|төлж\s+чадаагүй|барагдуулж\s+чадаагүй|алданги|хугацаа\s+хэтрүүл|сарын\s+төлбөр|төлбөр.{0,56}(төл|барагдуул)|6\s+сар)/i;
const CONTRACT_BREACH_QUERY_PATTERN =
  /(гэрээ|үүрэг|нийлүүл|ажил\s*гүйцэтгэл|захиалга).{0,32}(зөрч|биелүүлээгүй|гүйцэтгээгүй|нийлүүлээгүй|хийж\s*өгөхгүй|хугацаа\s*хоцор)/i;
const CONTRACT_REFUND_QUERY_PATTERN =
  /(урьдчилгаа|буцаан\s*авах|буцааж\s*өгөх|гэрээгээ\s*цуцлах|цуцалсан|дэнчин|захиалга\s*цуцлах|барьцаа).{0,28}(өгөхгүй|буцаахгүй|авахгүй|цуцлах|татгалз)/i;
const CONTRACT_INVALIDITY_QUERY_PATTERN =
  /(хүчингүй|хүчин\s*төгөлдөр\s*бус|хуурамч|төөрөгд|хуурч\s*байгуулсан|хэлцэл)/i;
const FAMILY_CUSTODY_QUERY_PATTERN =
  /(хүүхэд|хүүхдээ|хүүхдийн).{0,40}(асрамж|асрамждаа|асран\s*хамгаал|харгалзан\s*дэмж|хамт\s*амьдрах|өөр дээрээ авах|авч\s*авах)|асран\s*хамгаалагч/i;
const CHILD_ABUSE_EMERGENCY_QUERY_PATTERN =
  /(хүүхэд|хүүхдээ|бага\s*насны).{0,60}(зод|цохи|хүчирхийл|тамла|доромжил|айлган|заналхийл|хөхрүүл|гэмтээ|уйлуул|хашгир|чирч|түлх|өшигл)|((хажуу\s*айл|хөрш|айлын|эцэг|эх|аав|ээж|асран\s*хамгаал(?:агч)?).{0,60}(хүүхэд|хүүхдээ).{0,40}(зод|цохи|хүчирхийл|уйлуул|хашгир|тамла|гэмтээ))|((гэр\s*бүлийн\s*хүчирхийлэл).{0,40}(хүүхэд|бага\s*нас))/i;
const PUBLIC_NOISE_COMPLAINT_QUERY_PATTERN =
  /(хажуу\s*(талын\s*)?(айл|байр)|хөрш|сууц\s*өмчлөгч|орц|байрны).{0,80}(дуу\s*чимээ|шуугиан|чанга\s*дуу|орил|хашгир|амгалан\s*тайван|тайван\s*байдал)|((дуу\s*чимээ|шуугиан|чанга\s*дуу|орил|хашгир).{0,80}(амгалан\s*тайван|шөнө|шөнийн|цаг\s*12|00:|нойр|унтах|цагдаа|дууд))/i;
const PRIVACY_CYBER_ABUSE_QUERY_PATTERN =
  /(хувийн\s+мэдээлэл|хувийн\s+нууц|зург|зураг|бичлэг|аккаунт|сошиал|facebook|фэйсбүүк).{0,100}(алдагд|тараа|тавь|нийтэл|зөвшөөрөлгүй|хакер|сүрдүүл|заналхийл)|(зөвшөөрөлгүй).{0,80}(зург|зураг|бичлэг|нийтэл|тавь)/i;
const TRAFFIC_COLLISION_QUERY_PATTERN =
  /(машин|автомашин|тээврийн\s+хэрэгсэл).{0,24}(шүрг|шүргэ|мөрг|мөргө)|зогсоол|паркинг/i;
const TRAFFIC_INSURANCE_CLAIM_QUERY_PATTERN =
  /(?:даатгал|даатгагч|даатгуулагч|нөхөн\s*төлбөр|төлбөрөө|мөнгөө|мөнгө|олгохгүй|өгөхгүй|татгалз|нотолж\s*чадахгүй|камер).{0,140}(?:машин|автомашин|тээврийн\s+хэрэгсэл|осол|мөрг|мөргө|мөргөлд|шүрг|шүргэ|засвар|хохирол)|(?:машин|автомашин|тээврийн\s+хэрэгсэл|осол|мөрг|мөргө|мөргөлд|шүрг|шүргэ|засвар|хохирол).{0,140}(?:даатгал|даатгагч|даатгуулагч|нөхөн\s*төлбөр|төлбөрөө|мөнгөө|мөнгө|олгохгүй|өгөхгүй|татгалз|нотолж\s*чадахгүй|камер)/i;
const TRAFFIC_INJURY_QUERY_PATTERN =
  /(осол|мөрг|мөргөлд|шүрг|шүргэ).{0,40}(гэмтэл|бэртэл|эмнэлэг|амь\s*нас|нас\s*бар)|гэмтэл|бэртэл/i;
const TRAFFIC_DUI_QUERY_PATTERN = /(согтуур|согтуу|согтуугаар|мансуур)/i;
const RENTAL_DEPOSIT_QUERY_PATTERN =
  /(түрээс|түрээсийн|хөлслөх|орон\s*сууц|байр).{0,40}(барьцаа|дэнчин|буцааж|буцаан|өгөхгүй|олгохгүй|авч\s*чадахгүй)|барьцаагаа.{0,24}(буцааж|авч|өгөх)/i;
const LABOR_PROTECTED_DISMISSAL_QUERY_PATTERN =
  /(жирэмсэн|жирэмслэлт|гурван\s*хүртэлх\s*насны\s*хүүхэд|ганц\s*бие\s*эцэг|ганц\s*бие\s*эх).{0,40}(ажлаас|халах|цуцлах|ажил\s*олгогч)/i;
const LABOR_TERMINATION_SETTLEMENT_QUERY_PATTERN =
  /(эцсийн\s*тооцоо|тэтгэмж|олговор|компенсац|цалингаа|цалин\s*өгөхгүй|тооцоо\s*хийхгүй).{0,36}(ажлаас|хал|гарах|цуцлах|дуусгавар)|ажлаас.{0,36}(тэтгэмж|олговор|эцсийн\s*тооцоо|цалин)/i;
const LABOR_REINSTATEMENT_QUERY_PATTERN =
  /(ажилд\s*эргүүлэн\s*авах|ажилд\s*нь\s*авах|өмнөх\s*ажилд|буцааж\s*авах|эгүүлэн\s*авах)/i;

function isLaborDismissalQuery(query: string): boolean {
  return LABOR_DISMISSAL_QUERY_PATTERN.test(query);
}

function isContractDebtQuery(query: string): boolean {
  return CONTRACT_DEBT_QUERY_PATTERN.test(query);
}

function isSocialInsuranceQuery(query: string): boolean {
  const q = normalize(query);

  if (/нийгмийн\s+даатгал/i.test(q)) {
    return true;
  }

  if (/шимтгэл/i.test(q) && /(ажил\s*олгогч|даатгал|нийгмийн)/i.test(q)) {
    return true;
  }

  return /(тэтгэвэр|тэтгэмж)/i.test(q) && /(нийгмийн|даатгалын\s+сан)/i.test(q);
}

/** Банкны зээл төлөгдөөгүй / default — retrieval болон chunk шүүхэд ашиглана */
export function isContractDebtBankLoanQuery(userQuery: string): boolean {
  const q = normalize(userQuery);
  if (!isContractDebtQuery(userQuery)) {
    return false;
  }
  return isBankLoanQuery(q);
}

export function isBankLoanQuery(userQuery: string): boolean {
  const q = normalize(userQuery);
  return (
    /(банкнаас|банкны|банк)\s+зээл|зээл.{0,40}банк|зээлийн\s+гэрээ/i.test(q) ||
    (/зээл/i.test(q) && /банк/i.test(q))
  );
}

export function isBankLoanApplicationQuery(userQuery: string): boolean {
  const q = normalize(userQuery);
  if (!isBankLoanQuery(q)) {
    return false;
  }

  if (isContractDebtBankLoanQuery(q)) {
    return false;
  }

  return /авах|авахдаа|олгох|олгохдоо|анхаарах|юуг\s+шалгах|ямар\s+хууль|гэрээ\s+байгуулах|нөхцөл|хүү|барьцаа|зээлийн\s+мэдээлэл/i.test(
    q,
  );
}

export function isPublicNoiseComplaintQuery(userQuery: string): boolean {
  return PUBLIC_NOISE_COMPLAINT_QUERY_PATTERN.test(normalize(userQuery));
}

export function isPrivacyCyberAbuseQuery(userQuery: string): boolean {
  return PRIVACY_CYBER_ABUSE_QUERY_PATTERN.test(normalize(userQuery));
}

export function isContractDebtBankLoanPenaltyQuery(userQuery: string): boolean {
  const q = normalize(userQuery);
  if (!isContractDebtBankLoanQuery(userQuery)) {
    return false;
  }

  return /алданги|анз|нэмэгдүүлсэн\s*хүү|гэрээнд\s*заа(?:сан|гаагүй)|заагаагүй\s+байхад|стандарт\s+нөхцөл|нэхэмжил|нэхэмжлэх|хүүгийн\s+20\s*хувь/i.test(
    q,
  );
}

function isContractBreachQuery(query: string): boolean {
  return CONTRACT_BREACH_QUERY_PATTERN.test(query);
}

function isContractRefundQuery(query: string): boolean {
  return CONTRACT_REFUND_QUERY_PATTERN.test(query);
}

function isContractInvalidityQuery(query: string): boolean {
  return CONTRACT_INVALIDITY_QUERY_PATTERN.test(query);
}

function isFamilyCustodyQuery(query: string): boolean {
  return FAMILY_CUSTODY_QUERY_PATTERN.test(query);
}

function isChildAbuseEmergencyQuery(query: string): boolean {
  return CHILD_ABUSE_EMERGENCY_QUERY_PATTERN.test(query);
}

function isTrafficCollisionQuery(query: string): boolean {
  return TRAFFIC_COLLISION_QUERY_PATTERN.test(query);
}

export function isTrafficInsuranceClaimQuery(query: string): boolean {
  return TRAFFIC_INSURANCE_CLAIM_QUERY_PATTERN.test(normalize(query));
}

function isRentalDepositQuery(query: string): boolean {
  return RENTAL_DEPOSIT_QUERY_PATTERN.test(query);
}

function isTrafficInjuryQuery(query: string): boolean {
  return TRAFFIC_INJURY_QUERY_PATTERN.test(query);
}

function isTrafficDuiQuery(query: string): boolean {
  return TRAFFIC_DUI_QUERY_PATTERN.test(query);
}

function isLaborProtectedDismissalQuery(query: string): boolean {
  return LABOR_PROTECTED_DISMISSAL_QUERY_PATTERN.test(query);
}

function isLaborTerminationSettlementQuery(query: string): boolean {
  return LABOR_TERMINATION_SETTLEMENT_QUERY_PATTERN.test(query);
}

function isLaborReinstatementQuery(query: string): boolean {
  return LABOR_REINSTATEMENT_QUERY_PATTERN.test(query);
}

const TRAFFIC_HIT_AND_RUN_QUERY_PATTERN =
  /(зугт|ослын\s+газар|орхиод\s+яв|зугтчих|зугтаад)/i;

export function resolveCuratedQueryScenario(
  userQuery: string,
  intent?: QueryIntent,
): CuratedQueryScenario {
  const query = normalize(userQuery);
  if (!query) {
    return 'none';
  }

  if (isContractDebtBankLoanQuery(query)) {
    return 'contract_debt';
  }

  if (isLaborDismissalQuery(query)) {
    return 'labor_dismissal';
  }

  if (isChildAbuseEmergencyQuery(query)) {
    return 'child_abuse_emergency';
  }

  if (isPublicNoiseComplaintQuery(query)) {
    return 'public_noise_complaint';
  }

  if (
    isFamilyCustodyQuery(query) &&
    (!intent || intent === 'family' || intent === 'unknown')
  ) {
    return 'family_custody';
  }

  if (
    isRentalDepositQuery(query) &&
    (!intent || intent === 'contract' || intent === 'unknown')
  ) {
    return 'rental_deposit';
  }

  if (
    isContractDebtQuery(query) &&
    (!intent || intent === 'contract' || intent === 'unknown')
  ) {
    return 'contract_debt';
  }

  if (isTrafficCollisionQuery(query)) {
    return TRAFFIC_HIT_AND_RUN_QUERY_PATTERN.test(query)
      ? 'traffic_collision_hit_and_run'
      : 'traffic_collision';
  }

  return 'none';
}

const ARTICLE_MODE_PATTERNS: RegExp[] = [
  /(?:аль|ямар)\s+(?:зүйл|заалт|хэсэг)/iu,
  /(?:зүйл|заалт|хэсэг)\s*(?:аль|ямар|дээр|вэ|юу)/iu,
  /\d+(?:\.\d+)*\s*(?:дугаар|дүгээр)\s*(?:зүйл|заалт|хэсэг)/iu,
  /(?:зүйл|заалт|хэсэг)\s*\d+(?:\.\d+)*/iu,
];

const DOCUMENT_MODE_PATTERNS: RegExp[] = [
  /(?:хууль|хуулийг)\s*(?:хармаар|өг|өгөөч|үзье|бүтнээр|бүрэн|танилцуул|ерөнхий)/iu,
  /хуули(?:йг|ийг)?\s+тайлбарла/iu,
  /хууль\s+юу\s+зохицуулдаг/iu,
  /(?:тухай\s+хууль)\s*$/iu,
  /law\s+overview|full\s+law/i,
];

export function detectQueryMode(userQuery: string): QueryMode {
  const query = normalize(userQuery);
  if (!query) {
    return 'qa';
  }

  if (ARTICLE_MODE_PATTERNS.some((pattern) => pattern.test(query))) {
    return 'article';
  }

  if (DOCUMENT_MODE_PATTERNS.some((pattern) => pattern.test(query))) {
    return 'document';
  }

  return 'qa';
}

export function rewriteQuery(userQuery: string): string {
  const query = normalize(userQuery);
  if (!query) {
    return '';
  }

  const intent = classifyLegalIntent(userQuery);
  const mode = detectQueryMode(userQuery);
  const isPublicNoiseComplaint = isPublicNoiseComplaintQuery(query);
  const isTrafficInsuranceClaim = isTrafficInsuranceClaimQuery(query);
  const expansions = new Set<string>();

  expansions.add(query);

  if (mode === 'article') {
    expansions.add('хуулийн зүйл заалт тайлбар');
  }

  if (mode === 'document') {
    expansions.add('хууль ерөнхий танилцуулга зохицуулах хүрээ');
  }

  const domainExpansions =
    isPublicNoiseComplaint && intent === 'crime'
      ? ['зөрчлийн тухай хууль', 'цагдаагийн албаны тухай хууль гомдол мэдээлэл']
      : getDomainQueryExpansions(intent);

  for (const expansion of domainExpansions) {
    expansions.add(expansion);
  }

  if (/утас|гар утас|алдсан|хулгайд/i.test(query)) {
    expansions.add('хулгай гэмт хэрэг эрүүгийн хууль');
    expansions.add('цагдаагийн албаны тухай хууль эрэн сурвалжлах');
    expansions.add('харилцаа холбооны тухай хууль IMEI төхөөрөмж байршил');
    expansions.add('эрүүгийн хэрэг хянан шийдвэрлэх тухай хууль мөрдөн байцаах');
    expansions.add('зөрчлийн тухай хууль эд хөрөнгө олж авсан');
  }

  const isCyberFraudQuery =
    /(цахим|онлайн|интернет|фишинг|facebook|фэйсбүүк|чат|линк|otp|нэг\s+удаагийн\s+код|карт|данс|шилжүүлэг|апп)/i.test(
      query,
    ) && /(луйвар|залил|хууран\s*мэхл|мэхэл|мөнгө\s*шилжүүл|шилжүүлсэн)/i.test(query);

  if (/залил|луйвар|фишинг|хууран\s*мэхл|мэхэл/i.test(query)) {
    expansions.add('залилан мэхлэх гэмт хэрэг эрүүгийн хууль');
    expansions.add('эрүүгийн хууль бусдын эд хөрөнгийг залилан мэхлэж авах');
  }

  if (isCyberFraudQuery) {
    expansions.add('цахим залилан эрүүгийн хууль');
    expansions.add('цахим луйвар цагдаад гомдол гаргах');
    expansions.add('дансны шилжүүлэг залилан нотлох баримт');
    expansions.add('эрүүгийн хэрэг хянан шийдвэрлэх тухай хууль нотлох баримт');
    expansions.add('цагдаагийн албаны тухай хууль гэмт хэргийн талаарх гомдол мэдээлэл');
  }

  if (isPrivacyCyberAbuseQuery(query)) {
    expansions.add('хувь хүний мэдээлэл хамгаалах тухай хууль хувийн мэдээлэл алдагдсан');
    expansions.add('эрүүгийн хууль заналхийлэх хувийн мэдээлэл зөвшөөрөлгүй тараах');
    expansions.add('эрүүгийн хэрэг хянан шийдвэрлэх тухай хууль нотлох баримт');
    expansions.add('цагдаагийн албаны тухай хууль гомдол мэдээлэл');
  }

  if (
    /(хэрэглэгч|бараа|үйлчилгээ|онлайн\s+дэлгүүр|дэлгүүр|захиалга).{0,80}(буцаа|солих|чанаргүй|баталгаа|засвар|мөнгө\s+буцаах|өгөхгүй)/i.test(
      query,
    )
  ) {
    expansions.add('хэрэглэгчийн эрхийг хамгаалах тухай хууль бараа үйлчилгээ буцаалт');
    expansions.add('иргэний хууль худалдах худалдан авах гэрээ доголдолтой бараа');
    expansions.add('иргэний хууль хохирол нөхөн төлбөр хэрэглэгч');
  }

  if (/өв\s*залгамжлал|өвлөх|өв\s+нээлгэх|гэрээслэл|нотариат.{0,40}өв/i.test(query)) {
    expansions.add('иргэний хууль өв залгамжлал өвлөх эрх');
    expansions.add('иргэний хууль гэрээслэл өв нээлгэх');
    expansions.add('нотариатын тухай хууль өв залгамжлалын гэрчилгээ');
  }

  if (
    /(газар|хашаа|кадастр|үл\s+хөдлөх|улсын\s+бүртгэл).{0,80}(маргаан|давхц|бүртгүүлэх|гэрчилгээ|өмчлөх|эзэмших)/i.test(
      query,
    )
  ) {
    expansions.add('газрын тухай хууль газар эзэмших өмчлөх маргаан');
    expansions.add('эд хөрөнгийн эрхийн улсын бүртгэлийн тухай хууль үл хөдлөх эд хөрөнгө');
    expansions.add('иргэний хууль өмчлөх эрх газар үл хөдлөх эд хөрөнгө');
  }

  if (
    /(захиргаа|зөвшөөрөл|лиценз|паспорт|иргэний\s+бүртгэл|төрийн\s+байгууллага).{0,80}(татгалз|цуцал|олгохгүй|шийдвэр|гомдол|маргах)/i.test(
      query,
    )
  ) {
    expansions.add('захиргааны ерөнхий хууль захиргааны байгууллагын шийдвэр гомдол');
    expansions.add('захиргааны хэрэг шүүхэд хянан шийдвэрлэх тухай хууль нэхэмжлэл');
    expansions.add('зөвшөөрлийн тухай хууль зөвшөөрөл лиценз цуцлах татгалзах');
    expansions.add('иргэний улсын бүртгэлийн тухай хууль паспорт бүртгэл');
  }

  if (/завш|үрэгдүүл|шамшигдуул/i.test(query)) {
    expansions.add('эрүүгийн хууль бусдын эд хөрөнгийг завших үрэгдүүлэх');
    expansions.add('эрүүгийн хууль итгэмжлэн хариуцуулсан эд хөрөнгө завших');
  }

  if (/дээрэм|дээрэмдэх|булаа|булаасан/i.test(query)) {
    expansions.add('эрүүгийн хууль бусдын эд хөрөнгийг булаах дээрэмдэх');
    expansions.add('эрүүгийн хууль хүч хэрэглэж эд хөрөнгө авах');
  }

  if (!isPublicNoiseComplaint && /түрээс|түрээсл|байр|орон\s*сууц/i.test(query)) {
    expansions.add('түрээсийн гэрээ иргэний хууль');
    expansions.add('орон сууц түрээслэх гэрээ хохирол нөхөн төлбөр');
  }

  if (
    !isTrafficInsuranceClaim &&
    /мөргө|мөргс|зугт|мөргөлд|шүрг|шүргэ|ослын\s*газар|зогсоол|паркинг|эсрэг\s*урсгал/i.test(
      query,
    )
  ) {
    expansions.add('замын хөдөлгөөний осол зугтах эрүүгийн хууль');
    expansions.add('тээврийн хэрэгслийн осол хариуцлага зөрчлийн тухай');
    expansions.add('зам тээврийн осол жолоочийн үүрэг ослын газар зогсох');
    expansions.add('замын хөдөлгөөний аюулгүй байдлын тухай хууль жолоочийн үүрэг осол');
    expansions.add('зөрчлийн тухай хууль зам тээврийн осол зугтсан жолооч');
  }

  if (isTrafficInsuranceClaim) {
    expansions.add('даатгалын тухай хууль нөхөн төлбөр олгохоос татгалзсан үндэслэл');
    expansions.add('жолоочийн даатгалын тухай хууль зам тээврийн осол нөхөн төлбөр');
    expansions.add('иргэний хууль даатгалын гэрээ даатгалын тохиолдол нөхөн төлбөр');
    expansions.add('иргэний хууль гэм хор эд хөрөнгийн хохирол нөхөн төлбөр');
    expansions.add('санхүүгийн зохицуулах хороо даатгалын нөхөн төлбөрийн гомдол');
  }

  if (/авто\s*даатгал|тээврийн\s*хэрэгслийн\s*даатгал|каско/i.test(query)) {
    expansions.add('зам тээврийн осол даатгал нөхөн төлбөр');
    expansions.add('тээврийн хэрэгслийн даатгал ослын хохирол');
  }

  if (/даатгал|даатгагч|даатгуулагч|нөхөн\s*төлбөр|татгалз/i.test(query)) {
    expansions.add('даатгалын тухай хууль нөхөн төлбөр олгохоос татгалзсан үндэслэл');
    expansions.add('иргэний хууль даатгалын гэрээ нөхөн төлбөр');
    expansions.add('иргэний хууль даатгалын гэрээ даатгалын тохиолдол');
  }

  if (isPublicNoiseComplaint) {
    expansions.add('зөрчлийн тухай хууль амгалан тайван байдал алдагдуулах дуу чимээ');
    expansions.add('зөрчлийн тухай хууль нийтийн хэв журам зөрчих шөнийн дуу чимээ');
    expansions.add('цагдаагийн албаны тухай хууль зөрчил дуудлага гомдол шалгах');
    expansions.add('сууц өмчлөгчдийн холбоо байрны дотоод журам амгалан тайван байдал');
  }

  if (isBankLoanQuery(query)) {
    expansions.add('иргэний хууль банк зээлийн гэрээ зээл олгох гэрээ');
    expansions.add('иргэний хууль банкнаас олгох зээлийн хүү зээлдэгчийн хариуцлага');
    expansions.add('банк эрх бүхий хуулийн этгээдийн зээлийн үйл ажиллагаа зээлийн гэрээ зээлийн хүү');
    expansions.add('банкны тухай хууль банкны үйл ажиллагаа зээл');
    expansions.add('зээлийн мэдээллийн тухай хууль зээлийн мэдээлэл хэрэглэгчийн эрх үүрэг');
    if (/барьцаа|ипотек|үл\s*хөдлөх|орон\s*сууц|хөдлөх\s*эд/i.test(query)) {
      expansions.add('үл хөдлөх эд хөрөнгийн барьцааны тухай хууль зээлийн барьцаа');
      expansions.add('хөдлөх эд хөрөнгө болон эдийн бус хөрөнгийн барьцааны тухай хууль');
    }
  }

  if (
    /даатгал|нөхөн\s*төлбөр|татгалз/i.test(query) &&
    /гал|шат|түймэр|гэнэтийн\s*эрсдэл|гэр\s*орон|орон\s*сууц|эд\s*хөрөнг/i.test(query)
  ) {
    expansions.add('иргэний хууль даатгалын гэрээ эд хөрөнгийн даатгал гал түймэр');
    expansions.add('иргэний хууль гэм хор эд хөрөнгийн хохирол нөхөн төлбөр');
  }

  if (
    /даатгал|нөхөн\s*төлбөр|татгалз/i.test(query) &&
    /банк|зээл|барьцаа|ипотек/i.test(query)
  ) {
    expansions.add('үл хөдлөх эд хөрөнгийн барьцааны тухай банк ипотек даатгал');
    expansions.add('иргэний хууль банк барьцаа даатгал нөхөн төлбөр');
  }

  if (/эсрэг\s*урсгал/i.test(query)) {
    expansions.add('эсрэг урсгал зам тээврийн осол жолоочийн буруу');
  }

  if (/зогсоол|паркинг/i.test(query)) {
    expansions.add('зогсоол дээрх мөргөлт зугтсан жолооч камер цагдаа');
  }

  if (/согтуур|согтуу|жолоод|жолооны\s*эрх|тээврийн\s*хэрэгсэл|замын\s*хөдөлгөөн/i.test(query)) {
    expansions.add('согтуугаар тээврийн хэрэгсэл жолоодох хариуцлага');
    expansions.add('замын хөдөлгөөний аюулгүй байдлын тухай хууль');
    expansions.add('зөрчлийн тухай хууль согтуугаар жолоодох');
    expansions.add('эрүүгийн хууль тээврийн хэрэгсэл жолоодох');
  }

  if (/сонгуул|сонгогч|санал\s*өгөх|сонгох\s*эрх|18\s*нас|арван\s*найм/i.test(query)) {
    expansions.add('сонгуулийн тухай хууль сонгогчийн нас');
    expansions.add('үндсэн хууль сонгох эрх 18 нас');
  }

  if (
    !isPublicNoiseComplaint &&
    /гэрээ|төлбөр|төлөөгүй|өр|үүрэг|худалдах|худалдан|зарах|шилжүүлэх|эд\s*хөрөнгө|үл\s*хөдлөх|өмчлөх/i.test(
      query,
    ) &&
    !/нийгмийн\s*даатгал|шимтгэл|ндш|татвар|нөат/i.test(query)
  ) {
    expansions.add('гэрээний үүрэг биелүүлэх иргэний хууль');
    expansions.add('худалдах худалдан авах гэрээ өмч шилжүүлэх иргэний хууль');
    expansions.add('үл хөдлөх эд хөрөнгө өмчлөх эрх шилжүүлэх хууль');
  }

  if (/татвар|албан\s*татвар|нөат|татвараа|татварын/i.test(query)) {
    expansions.add('татварын тухай хууль татвар төлөх үүрэг алданги');
  }

  if (/нийгмийн\s*даатгал|шимтгэл|ндш/i.test(query)) {
    expansions.add('нийгмийн даатгалын шимтгэл төлөх үүрэг хууль');
  }

  if (/хөдөлмөр|ажилтн|ажилч|ажил\s*олгогч|цалин|ажлаас/i.test(query)) {
    expansions.add('хөдөлмөрийн тухай хууль');
    expansions.add('хөдөлмөрийн тухай хууль ажилтан ажил олгогч');
  }

  if (/эцэг\s*эх|хүүхэд.*уулз|уулзуулах|харилцах\s*эрх|асрамж|хамт\s+амьдрах|асран\s+хүмүүжүүлэх/i.test(query)) {
    expansions.add('гэр бүлийн тухай хууль эцэг эх хүүхэдтэй харилцах эрх');
    expansions.add('гэр бүлийн тухай хууль хүүхэдтэй уулзах уулзуулах');
    expansions.add('хүүхдийн эрхийн тухай хууль хүүхдийн эрх ашиг');
    expansions.add('иргэний хэрэг шүүхэд хянан шийдвэрлэх тухай хүүхэд уулзуулах');
  }

  const curatedScenario = resolveCuratedQueryScenario(userQuery, intent);
  if (curatedScenario === 'child_abuse_emergency') {
    expansions.add('гэр бүлийн хүчирхийлэлтэй тэмцэх тухай гэр бүлийн хүчирхийллийг илрүүлэх мэдээлэх');
    expansions.add('гэр бүлийн хүчирхийлэлтэй тэмцэх тухай хүүхдийг гэр бүлийн хүчирхийллээс хамгаалах');
    expansions.add('гэр бүлийн хүчирхийлэлтэй тэмцэх тухай аюулын зэргийн үнэлгээ цагдаагийн байгууллага');
    expansions.add('хүүхэд хамгааллын тухай шуурхай тусламжийн үйлчилгээ гэр бүл дэх хүүхэд хамгаалал');
    expansions.add('хүүхдийн эрхийн тухай хүүхдийн эсэн мэнд амьдрах эрх');
  }
  if (curatedScenario === 'family_custody') {
    expansions.add('гэр бүлийн тухай хууль эцэг эх хүүхдийн хооронд эрх үүрэг үүсэх');
    expansions.add('гэр бүлийн тухай хууль асран хамгаалалтад байх хүн');
    expansions.add('иргэний хэрэг шүүхэд хянан шийдвэрлэх тухай гэр бүлийн холбогдолтой хэрэг урьдчилсан арга хэмжээ');
  }

  if (curatedScenario === 'rental_deposit') {
    expansions.add('иргэний хууль орон сууц хөлслөх гэрээ');
    expansions.add('иргэний хууль үүргийн гүйцэтгэлийг хангах арга барьцаа дэнчин');
    expansions.add('иргэний хууль үүрэг гүйцэтгэгч хугацаа хэтрүүлэх');
    expansions.add('иргэний хууль түрээсийн гэрээ');
  }

  if (isContractDebtQuery(query)) {
    expansions.add('иргэний хууль үүрэг гүйцэтгэгч хугацаа хэтрүүлэх');
    expansions.add('иргэний хууль үүргийн гүйцэтгэлийг хангах арга');
    expansions.add('иргэний хууль гэрээнээс татгалзах журам');
    expansions.add('иргэний хэрэг шүүхэд хянан шийдвэрлэх тухай нэхэмжлэл');
    if (/(банкнаас|банкны)\s+зээл|банк.*зээл/i.test(query)) {
      expansions.add('иргэний хууль зээлийн гэрээ зээлдэгч зээлдүүлэгч');
      expansions.add('иргэний хууль үүрэг барагдуулах алданги');
      expansions.add('үл хөдлөх эд хөрөнгийн барьцааны тухай хууль банк');
    }
  }

  if (isLaborDismissalQuery(query)) {
    expansions.add('хөдөлмөрийн тухай хууль хөдөлмөр эрхлэлтийн харилцаа дуусгавар болох үндэслэл');
    expansions.add('хөдөлмөрийн тухай хууль хөдөлмөр эрхлэлтийн харилцааг ажил олгогч цуцлах');
    expansions.add('хөдөлмөрийн тухай хууль хөдөлмөрийн гэрээ түүний талууд');
    expansions.add('хөдөлмөрийн сонирхлын маргаан шийдвэрлэх');
  }

  if (isTrafficCollisionQuery(query)) {
    expansions.add('иргэний хууль гэм хор эд хөрөнгийн хохирол');
    expansions.add('замын хөдөлгөөний аюулгүй байдлын тухай хууль замын хөдөлгөөнд оролцогчийн эрх үүрэг');
    expansions.add('зөрчлийн тухай хууль замын хөдөлгөөний зөрчил ослын газар');
  }

  if (isContractBreachQuery(query)) {
    expansions.add('иргэний хууль үүрэг зөрчсөнөөс талууд гэрээнээс татгалзах');
    expansions.add('иргэний хууль үүргийн гүйцэтгэлийг хангах арга');
    expansions.add('иргэний хууль гэрээнээс татгалзах журам');
  }

  if (isContractRefundQuery(query)) {
    expansions.add('иргэний хууль гэрээнээс татгалзах журам буцаан олголт');
    expansions.add('иргэний хууль урьдчилгаа төлбөр буцаах гэрээ цуцлах');
    expansions.add('иргэний хууль үүрэг зөрчсөнөөс талууд гэрээнээс татгалзах');
  }

  if (isContractInvalidityQuery(query)) {
    expansions.add('иргэний хууль хүчин төгөлдөр бус байх хэлцэл');
    expansions.add('иргэний хууль хэлцэл хийсэн гэж үзэх');
    expansions.add('иргэний хууль гэрээнээс татгалзах журам');
  }

  if (isLaborProtectedDismissalQuery(query)) {
    expansions.add('хөдөлмөрийн тухай хууль жирэмсэн эмэгтэй гурван хүртэлх насны хүүхэдтэй эхийн хөдөлмөр эрхлэлтийн харилцааг цуцлахыг хориглох');
    expansions.add('хөдөлмөрийн тухай хууль хөдөлмөр эрхлэлтийн харилцаа дуусгавар болох үндэслэл');
  }

  if (isLaborTerminationSettlementQuery(query)) {
    expansions.add('хөдөлмөрийн тухай хууль ажлаас чөлөөлөх үеийн тэтгэмж эцсийн тооцоо');
    expansions.add('хөдөлмөрийн тухай хууль хөдөлмөр эрхлэлтийн харилцаа дуусгавар болох үндэслэл тэтгэмж');
    expansions.add('хөдөлмөрийн сонирхлын маргаан шийдвэрлэх');
  }

  if (isLaborReinstatementQuery(query)) {
    expansions.add('хөдөлмөрийн тухай хууль урьд эрхэлж байсан ажил албан тушаалд нь эгүүлэн авах');
    expansions.add('хөдөлмөрийн тухай хууль хөдөлмөрийн гэрээ түүний талууд');
    expansions.add('хөдөлмөрийн сонирхлын маргаан шийдвэрлэх');
  }

  if (isTrafficDuiQuery(query)) {
    expansions.add('эрүүгийн хууль тээврийн хэрэгслийн хөдөлгөөний аюулгүй байдлын болон ашиглалтын журам зөрчих');
    expansions.add('зөрчлийн тухай хууль согтуугаар жолоодох жолоодох эрх');
  }

  if (isTrafficInjuryQuery(query)) {
    expansions.add('эрүүгийн хууль тээврийн хэрэгслийн хөдөлгөөний аюулгүй байдлын болон ашиглалтын журам зөрчих хүний эрүүл мэндэд хохирол');
    expansions.add('иргэний хууль гэм хор учруулснаас хариуцлага хүлээх үндэслэл');
  }

  switch (intent) {
    case 'crime':
      if (isPublicNoiseComplaint) {
        expansions.add('зөрчлийн тухай хууль нийтийн хэв журам амгалан тайван');
        expansions.add('цагдаагийн албаны тухай хууль дуудлага гомдол мэдээлэл');
      } else {
        expansions.add('эрүүгийн хууль гэмт хэрэг хариуцлага');
        expansions.add('цагдаагийн албаны тухай хууль эрэн сурвалжлах мөрдөн байцаалт');
        expansions.add('зөрчлийн тухай хууль');
      }
      break;
    case 'traffic':
      expansions.add('замын хөдөлгөөний аюулгүй байдлын тухай хууль зөрчлийн тухай хууль');
      expansions.add('согтуугаар жолоодох хариуцлага эрх хасах торгууль');
      break;
    case 'election':
      expansions.add('сонгуулийн тухай хууль сонгогчийн эрх 18 нас');
      expansions.add('үндсэн хууль иргэний сонгох эрх насны босго');
      break;
    case 'contract':
      expansions.add('иргэний хууль гэрээний үүрэг өр төлбөр');
      if (/даатгал|даатгагч|даатгуулагч|нөхөн\s*төлбөр|татгалз/i.test(query)) {
        expansions.add('даатгалын тухай хууль даатгалын гэрээ нөхөн төлбөр');
        expansions.add('иргэний хууль даатгалын гэрээ гэм хор');
      }
      break;
    case 'tax':
      expansions.add('татварын тухай хууль албан татварын үүрэг алданги');
      break;
    case 'family':
      expansions.add('гэр бүлийн тухай хууль гэр бүлийн харилцаа');
      expansions.add('гэр бүлийн тухай хууль эцэг эх хүүхдийн эрх үүрэг');
      expansions.add('гэр бүлийн тухай хууль хүүхэдтэй харилцах эрх');
      break;
    case 'labor':
      expansions.add('хөдөлмөрийн тухай хууль ажилтан ажил олгогч');
      break;
    case 'socialInsurance':
      expansions.add('нийгмийн даатгалын тухай хууль шимтгэл төлөх үүрэг');
      break;
    default:
      expansions.add(`${query} хууль эрх зүйн зохицуулалт`);
      break;
  }

  if (mode === 'document') {
    const lawHint = getIntentLawHint(intent);
    if (lawHint) {
      expansions.add(`${lawHint} бүрэн эх`);
      expansions.add(`${lawHint} ерөнхий агуулга`);
    }
  }

  return Array.from(expansions)
    .filter((value) => !/[ÃÂ]/.test(value))
    .join(' ; ');
}

export function classifyLegalIntent(userQuery: string): QueryIntent {
  const query = normalize(userQuery);
  const queryTokens = tokenizeForIntent(userQuery);
  if (!query || queryTokens.length === 0) {
    return 'unknown';
  }

  if (isSocialInsuranceQuery(query)) {
    return 'socialInsurance';
  }

  if (isLaborDismissalQuery(query)) {
    return 'labor';
  }

  if (isFamilyCustodyQuery(query)) {
    return 'family';
  }

  if (isRentalDepositQuery(query)) {
    return 'contract';
  }

  if (isTrafficInsuranceClaimQuery(query)) {
    return 'contract';
  }

  if (isTrafficCollisionQuery(query)) {
    return 'traffic';
  }

  if (isPublicNoiseComplaintQuery(query)) {
    return 'crime';
  }

  if (isPrivacyCyberAbuseQuery(query)) {
    return 'crime';
  }

  if (isContractDebtQuery(query)) {
    return 'contract';
  }

  let bestIntent: QueryIntent = 'unknown';
  let bestScore = 0;

  for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS) as Array<
    [Exclude<QueryIntent, 'unknown'>, string[]]
  >) {
    const score = keywords.reduce(
      (sum, keyword) => sum + (matchesIntentKeyword(queryTokens, keyword) ? 1 : 0),
      0,
    );

    if (score > bestScore) {
      bestScore = score;
      bestIntent = intent;
    }
  }

  return bestScore > 0 ? bestIntent : 'unknown';
}

export function getIntentLawHint(intent: QueryIntent): string {
  if (intent === 'unknown') {
    return '';
  }

  return DOMAIN_KNOWLEDGE[intent].lawHints.join('; ');
}

export function getIntentPreferredLawIds(intent: QueryIntent): string[] {
  if (intent === 'unknown') {
    return [];
  }

  return [...(INTENT_PREFERRED_LAW_IDS[intent] ?? [])];
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:"'`()\[\]{}\\/\n\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeForIntent(text: string): string[] {
  return normalize(text)
    .split(/\s+/)
    .map((token) => stemMongolianToken(token))
    .filter((token) => token.length >= 2);
}

function matchesIntentKeyword(queryTokens: string[], keyword: string): boolean {
  const keywordTokens = tokenizeForIntent(keyword);
  if (keywordTokens.length === 0) {
    return false;
  }

  return keywordTokens.every((keywordToken) =>
    queryTokens.some((queryToken) => tokensLooselyMatch(queryToken, keywordToken)),
  );
}

function stemMongolianToken(token: string): string {
  return token.replace(
    /(ийн|ын|ийг|ыг|аас|ээс|д|т|аар|ээр|оор|өөр|тай|тэй|гүй|ууд|үүд|нууд|нүүд)$/iu,
    '',
  );
}

function tokensLooselyMatch(queryToken: string, keywordToken: string): boolean {
  if (queryToken === keywordToken) {
    return true;
  }

  if (queryToken.startsWith(keywordToken) || keywordToken.startsWith(queryToken)) {
    return Math.abs(queryToken.length - keywordToken.length) <= 3;
  }

  return false;
}
