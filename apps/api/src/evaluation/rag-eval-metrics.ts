import type { Source } from '@legal-chatbot/shared';
import type { ChromaQueryResult } from '../lib/vector-db.js';
import type { RelatedCase, RelatedLaw } from '../services/retrieval.service.js';
import type { LegalEvalCase } from './legal-eval-dataset.js';

export interface RetrievedSourceSnapshot {
  id?: string;
  title?: string;
  url?: string;
  snippet?: string;
  articleNo?: string;
  source?: string;
  score?: number;
}

export interface EvaluationCitationSnapshot {
  title?: string;
  url?: string;
  articleNo?: string;
  snippet?: string;
  source?: string;
}

export interface RetrievalMetricResult {
  retrievalHit: boolean;
  precisionAt5: number;
  hitAt5: boolean;
}

export interface CitationMetricResult {
  citationCorrect: boolean;
  citationAccuracy: number;
}

export interface FaithfulnessMetricResult {
  faithful: boolean;
  faithfulnessScore: number;
  faithfulnessNotes: string[];
}

export interface LatencyInput {
  totalLatencyMs: number;
}

export interface LatencySummary {
  averageLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  maxLatencyMs: number;
}

function normalize(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[§№#:,.;()\[\]{}"'“”‘’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function roundMetric(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
}

function roundMs(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.round(value);
}

function includesKeyword(haystack: string, keyword: string): boolean {
  const normalizedKeyword = normalize(keyword);
  return Boolean(normalizedKeyword) && haystack.includes(normalizedKeyword);
}

function getExpectedSourceKeywords(testCase: LegalEvalCase): string[] {
  return [testCase.expectedLawTitle, ...(testCase.expectedSourceKeywords ?? [])]
    .filter((keyword): keyword is string => Boolean(keyword?.trim()));
}

function sourceSnapshotText(source: RetrievedSourceSnapshot): string {
  return normalize(
    [source.id, source.title, source.url, source.snippet, source.articleNo, source.source]
      .filter(Boolean)
      .join(' '),
  );
}

function citationSnapshotText(citation: EvaluationCitationSnapshot): string {
  return normalize(
    [citation.title, citation.url, citation.snippet, citation.articleNo, citation.source]
      .filter(Boolean)
      .join(' '),
  );
}

function retrievedSourceKey(source: RetrievedSourceSnapshot): string {
  return normalize([source.url, source.title, source.articleNo, source.id].filter(Boolean).join(' '));
}

function citationKey(citation: EvaluationCitationSnapshot): string {
  return normalize([citation.url, citation.title, citation.articleNo].filter(Boolean).join(' '));
}

export function toRetrievedSourceSnapshots(input: {
  contextChunks?: ChromaQueryResult[];
  sources?: Source[];
  relatedLaws?: RelatedLaw[];
  relatedCases?: RelatedCase[];
}): RetrievedSourceSnapshot[] {
  const chunkSnapshots = (input.contextChunks ?? []).map((chunk) => ({
    id: chunk.id,
    title: String(chunk.metadata.title ?? chunk.metadata.lawTitle ?? chunk.metadata.caseTitle ?? ''),
    url: String(chunk.metadata.url ?? ''),
    snippet: chunk.document,
    articleNo: String(chunk.metadata.articleNo ?? ''),
    source: String(chunk.metadata.source ?? ''),
    score: chunk.score,
  }));
  const sourceSnapshots = (input.sources ?? []).map((source) => ({
    id: source.lawId ?? source.caseId,
    title: source.title,
    url: source.url,
    snippet: source.snippet,
    articleNo: source.articleNo,
    source: source.type,
  }));
  const lawSnapshots = (input.relatedLaws ?? []).map((law) => ({
    title: law.title,
    url: law.url,
    articleNo: law.articleNo,
    source: 'legalinfo',
    score: law.displayScore ?? law.score,
  }));
  const caseSnapshots = (input.relatedCases ?? []).map((caseItem) => ({
    id: caseItem.caseNumber,
    title: caseItem.title,
    url: caseItem.url,
    snippet: caseItem.summary,
    source: 'shuukh',
    score: caseItem.displayScore ?? caseItem.score,
  }));

  return [...chunkSnapshots, ...sourceSnapshots, ...lawSnapshots, ...caseSnapshots];
}

export function toCitationSnapshots(input: {
  sources?: Source[];
  relatedLaws?: RelatedLaw[];
  relatedCases?: RelatedCase[];
}): EvaluationCitationSnapshot[] {
  return [
    ...(input.sources ?? []).map((source) => ({
      title: source.title,
      url: source.url,
      snippet: source.snippet,
      articleNo: source.articleNo,
      source: source.type,
    })),
    ...(input.relatedLaws ?? []).map((law) => ({
      title: law.title,
      url: law.url,
      articleNo: law.articleNo,
      source: 'legalinfo',
    })),
    ...(input.relatedCases ?? []).map((caseItem) => ({
      title: caseItem.title,
      url: caseItem.url,
      snippet: caseItem.summary,
      articleNo: caseItem.caseNumber,
      source: 'shuukh',
    })),
  ];
}

export function evaluateRetrievalAccuracy(
  testCase: LegalEvalCase,
  retrievedSources: RetrievedSourceSnapshot[],
): RetrievalMetricResult {
  // Retrieval is counted as correct when any of the top-5 retrieved items contains
  // the expected law title or one of the source keywords from the evaluation case.
  const expectedKeywords = getExpectedSourceKeywords(testCase);
  const top5 = retrievedSources.slice(0, 5);

  if (expectedKeywords.length === 0 || top5.length === 0) {
    return { retrievalHit: false, precisionAt5: 0, hitAt5: false };
  }

  const matchingCount = top5.filter((source) => {
    const text = sourceSnapshotText(source);
    return expectedKeywords.some((keyword) => includesKeyword(text, keyword));
  }).length;
  const hitAt5 = matchingCount > 0;

  return {
    retrievalHit: hitAt5,
    precisionAt5: roundMetric(matchingCount / 5),
    hitAt5,
  };
}

export function evaluateCitationCorrectness(
  testCase: LegalEvalCase,
  citations: EvaluationCitationSnapshot[],
  retrievedSources: RetrievedSourceSnapshot[],
): CitationMetricResult {
  // Citation accuracy combines explicit expected citation keyword matches with
  // a source-consistency check against the retrieved URLs/titles/article numbers.
  const expectedKeywords = testCase.expectedCitationKeywords.filter((keyword) => keyword.trim());

  if (citations.length === 0) {
    return { citationCorrect: false, citationAccuracy: 0 };
  }

  const citationTexts = citations.map(citationSnapshotText);
  const matchedExpected = expectedKeywords.filter((keyword) =>
    citationTexts.some((text) => includesKeyword(text, keyword)),
  ).length;
  const expectedScore = expectedKeywords.length === 0 ? 0 : matchedExpected / expectedKeywords.length;
  const retrievedKeys = retrievedSources.map(retrievedSourceKey).filter(Boolean);
  const sourceMatchedCount = citations.filter((citation) => {
    const key = citationKey(citation);
    return Boolean(key) && retrievedKeys.some((retrievedKey) => retrievedKey.includes(key) || key.includes(retrievedKey));
  }).length;
  const sourceMatchScore = citations.length === 0 ? 0 : sourceMatchedCount / citations.length;
  const citationAccuracy = roundMetric(expectedScore * 0.7 + sourceMatchScore * 0.3);

  return {
    citationCorrect: citationAccuracy >= 0.6,
    citationAccuracy,
  };
}

function extractLawTitleMentions(text: string): string[] {
  const matches = text.match(/([А-ЯӨҮЁа-яөүё\s-]{2,80}(?:хууль|тухай))/gi) ?? [];
  return Array.from(new Set(matches.map((match) => normalize(match)).filter(Boolean)));
}

function extractArticleMentions(text: string): string[] {
  const matches = text.match(/(?:§\s*)?\d+(?:\.\d+)*\s*(?:дугаар\s*)?(?:зүйл|заалт)?/gi) ?? [];
  return Array.from(new Set(matches.map((match) => normalize(match)).filter((match) => /\d/.test(match))));
}

function hasCitationBackedWording(answer: string, citations: EvaluationCitationSnapshot[]): boolean {
  const normalizedAnswer = normalize(answer);
  if (citations.length === 0) {
    return false;
  }

  if (/эх сурвалж|хууль|зүйл|заалт|үндэслэл|дагуу|тусгасан|заасан/i.test(answer)) {
    return true;
  }

  return citations.some((citation) => {
    const title = normalize(citation.title);
    const articleNo = normalize(citation.articleNo);
    return (title && normalizedAnswer.includes(title)) || (articleNo && normalizedAnswer.includes(articleNo));
  });
}

export function evaluateAnswerFaithfulness(input: {
  answer: string;
  retrievedSources: RetrievedSourceSnapshot[];
  citations: EvaluationCitationSnapshot[];
}): FaithfulnessMetricResult {
  // Faithfulness is a rule-based guardrail: do not make legal claims without
  // retrieved context, cite/source-back the wording, and avoid unsupported laws/articles.
  const notes: string[] = [];
  const answer = input.answer.trim();
  const normalizedAnswer = normalize(answer);
  const contextText = normalize(input.retrievedSources.map(sourceSnapshotText).join(' '));
  let score = 1;

  if (!normalizedAnswer) {
    notes.push('empty_answer');
    score -= 0.7;
  }

  if (input.retrievedSources.length === 0 && normalizedAnswer && !/мэдээлэл\s+олдсонгүй/i.test(answer)) {
    notes.push('legal_claim_without_retrieved_context');
    score -= 0.45;
  }

  if (input.retrievedSources.length > 0 && !hasCitationBackedWording(answer, input.citations)) {
    notes.push('missing_citation_backed_wording');
    score -= 0.2;
  }

  for (const title of extractLawTitleMentions(answer)) {
    if (title.length > 5 && !contextText.includes(title)) {
      notes.push(`unsupported_law_title:${title}`);
      score -= 0.25;
      break;
    }
  }

  for (const article of extractArticleMentions(answer)) {
    if (article.length > 0 && !contextText.includes(article)) {
      notes.push(`unsupported_article:${article}`);
      score -= 0.15;
      break;
    }
  }

  if (input.retrievedSources.length > 0 && input.citations.length === 0) {
    notes.push('no_returned_citations');
    score -= 0.15;
  }

  const faithfulnessScore = roundMetric(score);

  return {
    faithful: faithfulnessScore >= 0.7,
    faithfulnessScore,
    faithfulnessNotes: notes.length > 0 ? notes : ['ok'],
  };
}

function percentile(sortedValues: number[], percentileValue: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = Math.ceil((percentileValue / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(sortedValues.length - 1, index))];
}

export function summarizeLatency(latencies: LatencyInput[]): LatencySummary {
  // Latency summary uses total per-question latency and reports common thesis-friendly
  // aggregate values: arithmetic average, nearest-rank p50/p95, and maximum.
  const values = latencies
    .map((latency) => latency.totalLatencyMs)
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);

  if (values.length === 0) {
    return { averageLatencyMs: 0, p50LatencyMs: 0, p95LatencyMs: 0, maxLatencyMs: 0 };
  }

  const total = values.reduce((sum, value) => sum + value, 0);

  return {
    averageLatencyMs: roundMs(total / values.length),
    p50LatencyMs: roundMs(percentile(values, 50)),
    p95LatencyMs: roundMs(percentile(values, 95)),
    maxLatencyMs: roundMs(values[values.length - 1]),
  };
}
