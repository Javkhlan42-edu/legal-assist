import type { ChatMessage, Source } from '@legal-chatbot/shared';
import type { MessageRecord } from '../repositories/conversation.repository.js';
import type { ChromaQueryResult } from '../lib/vector-db.js';
import {
  classifyLegalIntent,
  getIntentPreferredLawIds,
  rewriteQuery,
  type QueryIntent,
} from './query-rewrite.service.js';
import { classifyScope, type ScopeClassificationResult } from './scope-classifier.service.js';
import {
  buildKeywordSearchLine,
  countKeywordOverlap,
  extractRetrievalKeywordProfile,
  type RetrievalKeywordProfile,
} from './keyword-extraction.service.js';

export type WorkflowNodeName =
  | 'route_node'
  | 'clarify_node'
  | 'resolve_node'
  | 'scope_node'
  | 'out_of_scope_node'
  | 'router_node'
  | 'retrieve_node'
  | 'reasoning_node'
  | 'synthesize_node';

export type CarryForwardMode =
  | 'reuse_same_law'
  | 'clarify_skip_retrieval'
  | 'full_refresh';

interface RetrievalSnapshotChunk {
  id: string;
  document: string;
  metadata: Record<string, unknown>;
  score: number;
  rawScore?: number;
}

interface RetrievalSnapshotRelatedLaw {
  title: string;
  articleNo: string;
  url: string;
  score: number;
  displayScore?: number;
}

interface RetrievalSnapshotRelatedCase {
  title: string;
  caseNumber: string;
  url: string;
  score: number;
  displayScore?: number;
  summary?: string;
  court?: string;
  decisionType?: string;
}

interface RetrievalSnapshot {
  query?: string;
  intent?: QueryIntent;
  primaryDomain?: QueryIntent;
  keywords?: string[];
  lawIds?: string[];
  lawTitles?: string[];
  contextChunks?: RetrievalSnapshotChunk[];
  sources?: Source[];
  relatedLaws?: RetrievalSnapshotRelatedLaw[];
  relatedCases?: RetrievalSnapshotRelatedCase[];
}

export interface WorkflowEarlyResponse {
  answer: string;
  confidence: number;
  suggestedQuestions: string[];
  mode: 'fallback-general' | 'no-info';
}

export interface WorkflowPlan {
  nodes: WorkflowNodeName[];
  normalizedQuery: string;
  rewrittenQuery: string;
  scope: ScopeClassificationResult;
  intent: QueryIntent;
  preferredLawIds: string[];
  relevantHistory: ChatMessage[];
  usesHistoryContext: boolean;
  carryForwardMode: CarryForwardMode;
  carryForwardChunks: ChromaQueryResult[];
  carryForwardSources: Source[];
  carryForwardRelatedLaws: RetrievalSnapshotRelatedLaw[];
  carryForwardRelatedCases: RetrievalSnapshotRelatedCase[];
  keywordProfile: RetrievalKeywordProfile;
  previousKeywords: string[];
  query: string;
  shouldSkipRetrieval: boolean;
  earlyResponse?: WorkflowEarlyResponse;
}

interface PlanWorkflowInput {
  message: string;
  history: ChatMessage[];
  messageRecords?: MessageRecord[];
}

const CLARIFY_PATTERNS = [
  'тайлбарла',
  'дэлгэрэнгүй',
  'дэлгэрүүл',
  'жишээ',
  'үргэлжлүүл',
  'нэг бүрчлэн',
  'алхам алхмаар',
  'тэгээд',
  'дараа нь',
];

const DETAIL_FOLLOW_UP_PATTERNS = [
  'ямар баримт',
  'баримт бүрдүүлэх',
  'баримт хэрэгтэй',
  'нотлох баримт',
  'нотолгоо',
  'хугацаа',
  'хэтэрсэн',
  'хаана хандах',
  'хаашаа хандах',
  'хэнд хандах',
  'аль байгууллага',
  'ямар байгууллага',
  'эхлээд хаана',
  'эхлээд яах',
  'одоо яах',
  'дараагийн алхам',
  'ямар алхам',
  'гомдол гаргах',
  'өргөдөл гаргах',
  'нэхэмжлэл гаргах',
  'ажилдаа буцааж',
  'буцааж оруулах',
  'ажилд эгүүлэн',
  'гарын үсэг',
  'тушаал',
  'мэдэгдэл',
  'тайлбар аваагүй',
  'тайлбар авах',
  'зөвшөөрсөн',
  'комисс',
  'шүүхэд',
  'боломжтой юу',
];

const FOLLOW_UP_PATTERNS = [
  'энэ',
  'тэр',
  'дээрх',
  'ингэвэл',
  'тэгвэл',
  'тэгэхээр',
  'энэ тохиолдолд',
  'адил',
  'төсөөтэй',
  'ямар зүйл',
  'ямар заалт',
];

const NON_LEGAL_FOLLOW_UP_BLOCKER_PATTERN =
  /(кино|тоглоом|хоол|жор|код|програм|javascript|python|react|цаг\s+агаар|зураг|дизайн|спорт|аялал|эмчилгээ|өвчин|вакцин|крипто|bitcoin|меме|аниме)/i;

function compactText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeText(text: string): string {
  return compactText(text).toLowerCase();
}

function includesAnyPattern(normalizedQuery: string, patterns: string[]): boolean {
  return patterns.some((pattern) => normalizedQuery.includes(pattern));
}

function mergeRetrievalQuery(
  message: string,
  rewrittenQuery: string,
  keywordProfile: RetrievalKeywordProfile,
  previousKeywords: string[] = [],
  relevantHistory: ChatMessage[] = [],
): string {
  const contextualQuestion = buildContextualRetrievalQuestion(message, relevantHistory);
  const lines = [contextualQuestion];

  if (contextualQuestion !== message) {
    lines.push(`Одоогийн тодруулга: ${message}`);
  }

  if (rewrittenQuery && rewrittenQuery !== message) {
    lines.push(`Хайлтын хувилбар: ${rewrittenQuery}`);
  }

  const keywordLine = buildKeywordSearchLine(keywordProfile);
  if (keywordLine) {
    lines.push(`Түлхүүр үг: ${keywordLine}`);
  }

  if (previousKeywords.length > 0) {
    lines.push(`Өмнөх холбоотой түлхүүр үг: ${previousKeywords.slice(0, 10).join(' ')}`);
  }

  return lines.join('\n');
}

function buildContextualRetrievalQuestion(
  message: string,
  relevantHistory: ChatMessage[] = [],
): string {
  const previousUserQuestion = relevantHistory
    .slice()
    .reverse()
    .find((item) => item.role === 'user')?.content;

  if (!previousUserQuestion) {
    return message;
  }

  const compactPrevious = compactText(previousUserQuestion);
  const compactMessage = compactText(message);

  if (!compactPrevious || compactPrevious.includes(compactMessage)) {
    return message;
  }

  return compactText(`${compactPrevious} ${compactMessage}`).slice(0, 700);
}

function parseSnapshot(record?: MessageRecord | null): RetrievalSnapshot | null {
  if (!record?.metadata || typeof record.metadata !== 'object') {
    return null;
  }

  const metadata = record.metadata as Record<string, unknown>;
  const snapshot = metadata.retrievalSnapshot;
  if (!snapshot || typeof snapshot !== 'object') {
    return null;
  }

  const snapshotRecord = snapshot as RetrievalSnapshot;
  return {
    ...snapshotRecord,
    sources: Array.isArray(snapshotRecord.sources)
      ? snapshotRecord.sources
      : Array.isArray(metadata.sources)
        ? (metadata.sources as Source[])
        : [],
    relatedLaws: Array.isArray(snapshotRecord.relatedLaws)
      ? snapshotRecord.relatedLaws
      : Array.isArray(metadata.relatedLaws)
        ? (metadata.relatedLaws as RetrievalSnapshotRelatedLaw[])
        : [],
    relatedCases: Array.isArray(snapshotRecord.relatedCases)
      ? snapshotRecord.relatedCases
      : Array.isArray(metadata.relatedCases)
        ? (metadata.relatedCases as RetrievalSnapshotRelatedCase[])
        : [],
  };
}

function toCarryForwardChunks(chunks: RetrievalSnapshotChunk[] = []): ChromaQueryResult[] {
  return chunks
    .filter((chunk) => chunk && typeof chunk.id === 'string' && typeof chunk.document === 'string')
    .map((chunk, index) => ({
      id: chunk.id,
      document: chunk.document,
      metadata: chunk.metadata ?? {},
      score: Math.max(0.36, Math.min(0.94, Number(chunk.score ?? 0.72) || 0.72 - index * 0.04)),
      rawScore: Math.max(0.28, Math.min(0.94, Number(chunk.rawScore ?? chunk.score ?? 0.68) || 0.68)),
    }));
}

function buildGreetingResponse(): WorkflowEarlyResponse {
  return {
    answer:
      '## Зөвлөгөө\nСайн байна уу. Би Монгол Улсын хууль зүйн асуултад тусалдаг тул асуудлаа нэг өгүүлбэрээр товч, тодорхой бичээд асуугаарай.\n\n## Яг одоо хийх алхам\n1. Асуудлаа бодит нөхцөлөөр нь бичнэ.\n2. Хэрэв гэрээ, осол, зээл, ажил, гэр бүл, эрүүгийн асуудал бол огноо, байгууллага, баримт байгаа эсэхээ хавсаргана.\n3. Хүсвэл ямар үр дүн мэдэх гэж байгаагаа нэмж бичнэ.\n\n## Практик зөвлөгөө\n- Жишээ: “Банкны зээлийн төлбөр 6 сар хоцорсон бол ямар хариуцлага үүсэх вэ?”\n- Жишээ: “Авто ослын дараа даатгал мөнгө өгөхгүй бол яах вэ?”\n- Жишээ: “Ажлаас үндэслэлгүй халсан бол яаж маргах вэ?”',
    confidence: 0.42,
    suggestedQuestions: [
      'Банкны зээлээ төлж чадаагүй бол ямар хариуцлага үүсэх вэ?',
      'Даатгал нөхөн төлбөрөөс татгалзвал яах вэ?',
      'Ажлаас үндэслэлгүй халсан бол яаж маргах вэ?',
    ],
    mode: 'fallback-general',
  };
}

function buildOutOfScopeResponse(): WorkflowEarlyResponse {
  return {
    answer:
      '## Зөвлөгөө\nЭнэ асуулт одоогийн системийн хууль зүйн домэйнээс гадуур байна. Би Монгол Улсын хууль, эрх зүйн асуудлыг тайлбарлахад хамгийн сайн ажиллана.\n\n## Яг одоо хийх алхам\n1. Асуултаа хууль, эрх, үүрэг, торгууль, гэрээ, зээл, осол, ажил, гэр бүл, шүүхтэй холбоотой байдлаар дахин бичнэ.\n2. Хэрэв тодорхой байгууллага, гэрээ, акт, осол, маргаан байвал түүнийгээ дурдана.\n3. Ямар үр дүн мэдэх гэж байгаагаа нэмж бичнэ.\n\n## Практик зөвлөгөө\n- Жишээ: “Түрээсийн барьцаагаа буцааж авч чадахгүй бол яах вэ?”\n- Жишээ: “Утсаа хулгайд алдсан бол ямар арга хэмжээ авах вэ?”\n- Жишээ: “Хүүхдийн тэтгэлэг өгөхгүй бол яаж нэхэмжлэх вэ?”',
    confidence: 0.28,
    suggestedQuestions: [
      'Түрээсийн барьцаагаа буцааж авч чадахгүй бол яах вэ?',
      'Утсаа хулгайд алдсан бол ямар арга хэмжээ авах вэ?',
      'Банкны зээл төлөөгүй бол ямар хариуцлага үүсэх вэ?',
    ],
    mode: 'no-info',
  };
}

function buildClarifyResponse(): WorkflowEarlyResponse {
  return {
    answer:
      '## Зөвлөгөө\nАсуулт арай дутуу байна. Нөхцөлөө нэг мөрөөр тодруулбал би яг тохирох хууль, зүйл, алхмыг нь гаргаж өгнө.\n\n## Яг одоо хийх алхам\n1. Ямар асуудал үүссэнийг товч тодорхой бичнэ.\n2. Хэнтэй холбоотой маргаан болохыг дурдана.\n3. Гэрээ, зээл, осол, ажил, гэр бүл, эрүүгийн аль чиглэлийн асуудал болохыг нэмнэ.\n\n## Практик зөвлөгөө\n- “Банкнаас зээл аваад 6 сар төлөөгүй бол ямар хариуцлага үүсэх вэ?”\n- “Даатгал нөхөн төлбөрөөс татгалзсан бол яаж маргах вэ?”\n- “Ажлаас халсан тушаалаа яаж хүчингүй болгуулах вэ?”',
    confidence: 0.22,
    suggestedQuestions: [
      'Банкны зээлээ төлж чадаагүй бол ямар хариуцлага үүсэх вэ?',
      'Даатгал нөхөн төлбөрөөс татгалзвал яаж маргах вэ?',
      'Ажлаас халсан тушаалаа яаж хүчингүй болгуулах вэ?',
    ],
    mode: 'no-info',
  };
}

function isClarifyPattern(query: string): boolean {
  const normalized = normalizeText(query);
  return (
    includesAnyPattern(normalized, CLARIFY_PATTERNS) ||
    includesAnyPattern(normalized, DETAIL_FOLLOW_UP_PATTERNS)
  );
}

function isContextualFollowUpQuery(
  query: string,
  keywordProfile?: RetrievalKeywordProfile,
): boolean {
  const normalized = normalizeText(query);
  if (!normalized) {
    return false;
  }

  const shortEnough = normalized.length <= 180;
  const explicitDetailFollowUp =
    includesAnyPattern(normalized, CLARIFY_PATTERNS) ||
    includesAnyPattern(normalized, DETAIL_FOLLOW_UP_PATTERNS);
  const explicitFollowUp =
    explicitDetailFollowUp || includesAnyPattern(normalized, FOLLOW_UP_PATTERNS);

  if (!shortEnough) {
    return false;
  }

  if (!explicitDetailFollowUp && NON_LEGAL_FOLLOW_UP_BLOCKER_PATTERN.test(normalized)) {
    return false;
  }

  if (explicitFollowUp) {
    return true;
  }

  const topicalTermCount =
    keywordProfile?.topicalTerms.length ??
    extractRetrievalKeywordProfile(normalized).topicalTerms.length;
  const proceduralHint =
    /(баримт|нотолгоо|хугацаа|хандах|гомдол|өргөдөл|нэхэмжлэл|тушаал|мэдэгдэл|гарын\s+үсэг|алхам|комисс|шүүх)/i.test(
      normalized,
    );
  const questionShape = /(?:\?|(?:вэ|уу|үү)\s*$)/iu.test(normalized);

  return questionShape && proceduralHint && topicalTermCount <= 5;
}

function isSupplementalFactFollowUpQuery(
  normalizedQuery: string,
  keywordProfile: RetrievalKeywordProfile,
): boolean {
  if (!normalizedQuery || normalizedQuery.length > 180) {
    return false;
  }

  if (NON_LEGAL_FOLLOW_UP_BLOCKER_PATTERN.test(normalizedQuery)) {
    return false;
  }

  const hasEnoughLegalTerms = keywordProfile.topicalTerms.length >= 2;
  const hasSupplementalFact =
    /(банк|зээл|төлөөгүй|хоцорсон|хугацаа|сар|хоног|барьцаа|гэрээ|мэдэгдэл|акт|даатгал|цагдаа|осол|ажлаас|халсан|хүүхэд|тэтгэлэг|түрээс|барьцаа)/i.test(
      normalizedQuery,
    );

  return hasEnoughLegalTerms && hasSupplementalFact;
}

type FineTopic =
  | 'bank_loan'
  | 'insurance'
  | 'consumer'
  | 'labor'
  | 'traffic'
  | 'family'
  | 'crime'
  | 'rental'
  | 'unknown';

function detectFineTopic(text: string, extraTerms: string[] = []): FineTopic {
  const normalized = normalizeText([text, ...extraTerms].join(' '));

  if (/ажлаас|халсан|халах|ажил\s*олгогч|хөдөлмөр|цалин/i.test(normalized)) {
    return 'labor';
  }

  if (/түрээс|түрээсл|барьцаа\s*буцаах|түрээсийн\s*барьцаа/i.test(normalized)) {
    return 'rental';
  }

  if (/банк|зээл|зээлийн|нэмэгдүүлсэн\s*хүү|алданги|барьцаа.{0,24}зээл|зээл.{0,24}барьцаа/i.test(normalized)) {
    return 'bank_loan';
  }

  if (/даатгал|даатгагч|нөхөн\s*төлбөр|каско/i.test(normalized)) {
    return 'insurance';
  }

  if (/онлайн\s*дэлгүүр|дэлгүүр|доголдол|буцаалт|хэрэглэгч|бараа|захиалга|баталгаа/i.test(normalized)) {
    return 'consumer';
  }

  if (/машин|авто|жолооч|замын\s*хөдөлгөөн|осол|мөрг|шүрг|зогсоол/i.test(normalized)) {
    return 'traffic';
  }

  if (/гэр\s*бүл|салалт|хүүхэд|асрамж|тэтгэлэг/i.test(normalized)) {
    return 'family';
  }

  if (/эрүүгийн|гэмт\s*хэрэг|хулгай|залилан|луйвар|авлиг|хахууль|цагдаа/i.test(normalized)) {
    return 'crime';
  }

  return 'unknown';
}

function isHardTopicMismatch(currentTopic: FineTopic, previousTopic: FineTopic): boolean {
  if (currentTopic === 'unknown' || previousTopic === 'unknown' || currentTopic === previousTopic) {
    return false;
  }

  const compatiblePairs = new Set([
    'traffic:insurance',
    'insurance:traffic',
    'consumer:insurance',
    'insurance:consumer',
  ]);

  return !compatiblePairs.has(`${currentTopic}:${previousTopic}`);
}

function isShortAmbiguousQuery(query: string): boolean {
  const normalized = normalizeText(query);
  if (normalized.length >= 8) {
    return false;
  }

  return !/\d+(?:\.\d+)?\s*(?:зүйл|заалт)/iu.test(normalized);
}

function selectRelevantHistory(
  message: string,
  history: ChatMessage[],
  keywordProfile: RetrievalKeywordProfile,
): ChatMessage[] {
  if (history.length === 0) {
    return [];
  }

  const currentTokens = keywordProfile.topicalTerms;
  const recentWindow = history.slice(-6).map((item) => ({
    role: item.role,
    content: compactText(item.content),
  }));

  const recentUserText = recentWindow
    .filter((item) => item.role === 'user')
    .map((item) => item.content)
    .join(' ');
  const historyProfile = extractRetrievalKeywordProfile(recentUserText);

  const overlap = countKeywordOverlap(currentTokens, historyProfile.topicalTerms);
  const looksLikeFollowUp = isContextualFollowUpQuery(message, keywordProfile);
  const directCurrentIntent = classifyLegalIntent(message);
  const directHistoryIntent = classifyLegalIntent(recentUserText);
  const currentIntent =
    directCurrentIntent !== 'unknown' ? directCurrentIntent : keywordProfile.primaryDomain;
  const historyIntent =
    directHistoryIntent !== 'unknown' ? directHistoryIntent : historyProfile.primaryDomain;

  if (
    !looksLikeFollowUp &&
    currentIntent !== 'unknown' &&
    historyIntent !== 'unknown' &&
    currentIntent !== historyIntent
  ) {
    return [];
  }

  const currentFineTopic = detectFineTopic(message, keywordProfile.topicalTerms);
  const historyFineTopic = detectFineTopic(recentUserText, historyProfile.topicalTerms);

  if (!looksLikeFollowUp && isHardTopicMismatch(currentFineTopic, historyFineTopic)) {
    return [];
  }

  const normalized = normalizeText(message);
  const supplementalFactFollowUp =
    normalized.length <= 180 &&
    countKeywordOverlap(currentTokens, historyProfile.topicalTerms) >= 1 &&
    isSupplementalFactFollowUpQuery(normalized, keywordProfile);

  if (overlap >= 2 || looksLikeFollowUp || supplementalFactFollowUp) {
    return recentWindow.slice(-4);
  }

  return [];
}

function resolveCarryForwardMode(
  message: string,
  intent: QueryIntent,
  snapshot: RetrievalSnapshot | null,
  keywordProfile: RetrievalKeywordProfile,
): {
  mode: CarryForwardMode;
  chunks: ChromaQueryResult[];
  sources: Source[];
  relatedLaws: RetrievalSnapshotRelatedLaw[];
  relatedCases: RetrievalSnapshotRelatedCase[];
  preferredLawIds: string[];
  previousKeywords: string[];
} {
  if (!snapshot?.contextChunks?.length) {
    return {
      mode: 'full_refresh',
      chunks: [],
      sources: [],
      relatedLaws: [],
      relatedCases: [],
      preferredLawIds: [],
      previousKeywords: [],
    };
  }

  const snapshotIntent = snapshot.intent ?? 'unknown';
  const snapshotDomain = snapshot.primaryDomain ?? snapshotIntent;
  const snapshotLawIds = snapshot.lawIds ?? [];
  const snapshotLawTitles = snapshot.lawTitles ?? [];
  const previousKeywords =
    snapshot.keywords && snapshot.keywords.length > 0
      ? snapshot.keywords
      : extractRetrievalKeywordProfile(snapshotLawTitles.join(' ')).topicalTerms;
  const overlap = countKeywordOverlap(keywordProfile.topicalTerms, previousKeywords);
  const carryChunks = toCarryForwardChunks(snapshot.contextChunks);
  const carrySources = snapshot.sources ?? [];
  const carryRelatedLaws = snapshot.relatedLaws ?? [];
  const carryRelatedCases = snapshot.relatedCases ?? [];
  const looksLikeFollowUp = isContextualFollowUpQuery(message, keywordProfile);
  const currentHasFreshDomain =
    keywordProfile.primaryDomain !== 'unknown' &&
    snapshotDomain !== 'unknown' &&
    keywordProfile.primaryDomain !== snapshotDomain &&
    intent !== snapshotIntent &&
    keywordProfile.topicalTerms.length >= 4 &&
    !looksLikeFollowUp;
  const currentFineTopic = detectFineTopic(message, keywordProfile.topicalTerms);
  const snapshotFineTopic = detectFineTopic(snapshotLawTitles.join(' '), previousKeywords);
  const currentHasFreshTopic =
    keywordProfile.topicalTerms.length >= 3 &&
    !looksLikeFollowUp &&
    isHardTopicMismatch(currentFineTopic, snapshotFineTopic);

  if (currentHasFreshTopic) {
    return {
      mode: 'full_refresh',
      chunks: [],
      sources: [],
      relatedLaws: [],
      relatedCases: [],
      preferredLawIds: [],
      previousKeywords: [],
    };
  }

  if (isClarifyPattern(message)) {
    const half = Math.max(2, Math.ceil(carryChunks.length / 2));
    return {
      mode: 'reuse_same_law',
      chunks: carryChunks.slice(0, half),
      sources: carrySources,
      relatedLaws: carryRelatedLaws,
      relatedCases: carryRelatedCases,
      preferredLawIds: snapshotLawIds,
      previousKeywords,
    };
  }

  if (looksLikeFollowUp) {
    const half = Math.max(2, Math.ceil(carryChunks.length / 2));
    return {
      mode: 'reuse_same_law',
      chunks: carryChunks.slice(0, half),
      sources: carrySources,
      relatedLaws: carryRelatedLaws,
      relatedCases: carryRelatedCases,
      preferredLawIds: snapshotLawIds,
      previousKeywords,
    };
  }

  if (currentHasFreshDomain) {
    return {
      mode: 'full_refresh',
      chunks: [],
      sources: [],
      relatedLaws: [],
      relatedCases: [],
      preferredLawIds: [],
      previousKeywords: [],
    };
  }

  if (
    snapshotIntent !== 'unknown' &&
    intent !== 'unknown' &&
    snapshotIntent === intent &&
    (overlap >= 1 || looksLikeFollowUp)
  ) {
    const half = Math.max(2, Math.ceil(carryChunks.length / 2));
    return {
      mode: 'reuse_same_law',
      chunks: carryChunks.slice(0, half),
      sources: carrySources,
      relatedLaws: carryRelatedLaws,
      relatedCases: carryRelatedCases,
      preferredLawIds: snapshotLawIds,
      previousKeywords,
    };
  }

  return {
    mode: 'full_refresh',
    chunks: [],
    sources: [],
    relatedLaws: [],
    relatedCases: [],
    preferredLawIds: [],
    previousKeywords: [],
  };
}

function resolveSnapshotIntent(snapshot: RetrievalSnapshot | null): QueryIntent {
  if (snapshot?.intent && snapshot.intent !== 'unknown') {
    return snapshot.intent;
  }

  if (snapshot?.primaryDomain && snapshot.primaryDomain !== 'unknown') {
    return snapshot.primaryDomain;
  }

  return 'unknown';
}

function promoteScopeForContext(
  scope: ScopeClassificationResult,
  snapshotIntent: QueryIntent,
): ScopeClassificationResult {
  return {
    ...scope,
    scope: 'legal',
    legalScore: Math.max(scope.legalScore, scope.nonLegalScore + 1, 1),
    intentHint: snapshotIntent !== 'unknown' ? snapshotIntent : scope.intentHint,
  };
}

export function planChatWorkflow(input: PlanWorkflowInput): WorkflowPlan {
  const nodes: WorkflowNodeName[] = ['route_node'];
  const normalizedQuery = compactText(input.message);
  const keywordProfile = extractRetrievalKeywordProfile(normalizedQuery);
  const lastAssistantRecord =
    input.messageRecords
      ?.slice()
      .reverse()
      .find((record) => record.role === 'assistant') ?? null;
  const snapshot = parseSnapshot(lastAssistantRecord);
  const snapshotIntent = resolveSnapshotIntent(snapshot);
  const hasUsableSnapshot = Boolean(snapshot?.contextChunks?.length);
  const canContinueFromSnapshot =
    hasUsableSnapshot && isContextualFollowUpQuery(normalizedQuery, keywordProfile);

  if (isShortAmbiguousQuery(normalizedQuery) && !canContinueFromSnapshot) {
    nodes.push('clarify_node');
    return {
      nodes,
      normalizedQuery,
      rewrittenQuery: normalizedQuery,
      scope: classifyScope(normalizedQuery),
      intent: 'unknown',
      preferredLawIds: [],
      relevantHistory: [],
      usesHistoryContext: false,
      carryForwardMode: 'full_refresh',
      carryForwardChunks: [],
      carryForwardSources: [],
      carryForwardRelatedLaws: [],
      carryForwardRelatedCases: [],
      keywordProfile,
      previousKeywords: [],
      query: normalizedQuery,
      shouldSkipRetrieval: true,
      earlyResponse: buildClarifyResponse(),
    };
  }

  nodes.push('resolve_node');
  const rewrittenQuery = rewriteQuery(normalizedQuery);

  nodes.push('scope_node');
  const rawScope = classifyScope(normalizedQuery);
  const scope =
    rawScope.scope === 'non_legal' && canContinueFromSnapshot
      ? promoteScopeForContext(rawScope, snapshotIntent)
      : rawScope;

  if (scope.scope === 'greeting' && !canContinueFromSnapshot) {
    nodes.push('out_of_scope_node');
    return {
      nodes,
      normalizedQuery,
      rewrittenQuery,
      scope,
      intent: scope.intentHint,
      preferredLawIds: [],
      relevantHistory: [],
      usesHistoryContext: false,
      carryForwardMode: 'full_refresh',
      carryForwardChunks: [],
      carryForwardSources: [],
      carryForwardRelatedLaws: [],
      carryForwardRelatedCases: [],
      keywordProfile,
      previousKeywords: [],
      query: normalizedQuery,
      shouldSkipRetrieval: true,
      earlyResponse: buildGreetingResponse(),
    };
  }

  if (scope.scope === 'non_legal' && !canContinueFromSnapshot) {
    nodes.push('out_of_scope_node');
    return {
      nodes,
      normalizedQuery,
      rewrittenQuery,
      scope,
      intent: scope.intentHint,
      preferredLawIds: [],
      relevantHistory: [],
      usesHistoryContext: false,
      carryForwardMode: 'full_refresh',
      carryForwardChunks: [],
      carryForwardSources: [],
      carryForwardRelatedLaws: [],
      carryForwardRelatedCases: [],
      keywordProfile,
      previousKeywords: [],
      query: normalizedQuery,
      shouldSkipRetrieval: true,
      earlyResponse: buildOutOfScopeResponse(),
    };
  }

  nodes.push('router_node');
  const intent =
    scope.intentHint !== 'unknown'
      ? scope.intentHint
      : keywordProfile.primaryDomain !== 'unknown'
        ? keywordProfile.primaryDomain
        : classifyLegalIntent(rewrittenQuery);
  const relevantHistory = selectRelevantHistory(normalizedQuery, input.history, keywordProfile);
  const usesHistoryContext = relevantHistory.length > 0;
  const carryForward = resolveCarryForwardMode(normalizedQuery, intent, snapshot, keywordProfile);
  const effectiveIntent =
    carryForward.mode !== 'full_refresh' && snapshot?.intent && snapshot.intent !== 'unknown'
      ? snapshot.intent
      : intent;
  const effectiveRewrittenQuery =
    carryForward.mode !== 'full_refresh' && effectiveIntent !== intent
      ? normalizedQuery
      : rewrittenQuery;
  const basePreferredLawIds = getIntentPreferredLawIds(effectiveIntent);
  const preferredLawIds = Array.from(
    new Set([...basePreferredLawIds, ...carryForward.preferredLawIds]),
  );

  nodes.push('retrieve_node', 'reasoning_node', 'synthesize_node');
  return {
    nodes,
    normalizedQuery,
    rewrittenQuery: effectiveRewrittenQuery,
    scope,
    intent: effectiveIntent,
    preferredLawIds,
    relevantHistory,
    usesHistoryContext,
    carryForwardMode: carryForward.mode,
    carryForwardChunks: carryForward.chunks,
    carryForwardSources: carryForward.sources,
    carryForwardRelatedLaws: carryForward.relatedLaws,
    carryForwardRelatedCases: carryForward.relatedCases,
    keywordProfile,
    previousKeywords: carryForward.previousKeywords,
    query: mergeRetrievalQuery(
      normalizedQuery,
      effectiveRewrittenQuery,
      keywordProfile,
      carryForward.previousKeywords,
      relevantHistory,
    ),
    shouldSkipRetrieval: false,
  };
}
