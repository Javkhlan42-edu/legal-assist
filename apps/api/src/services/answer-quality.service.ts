import type { ChatQualityMetrics, RelatedLaw, Source } from '@legal-chatbot/shared';
import type { RetrievalQuality } from './retrieval.service.js';

interface EvaluateAnswerQualityInput {
  query: string;
  answer: string;
  sources: Source[];
  relatedLaws: RelatedLaw[];
  retrievalQuality?: RetrievalQuality;
  latencyMs: number;
  latencyBudgetMs: number;
  retrievalTimedOut?: boolean;
  generationTimedOut?: boolean;
  generationMode?: 'context' | 'fallback-general' | 'no-info';
}

const INTERNAL_LEAK_PATTERNS = [
  /\bretrieval\b/i,
  /\brerank/i,
  /\bchunk\b/i,
  /\bscore\b/i,
  /контекстэд\s+давтагдсан/i,
  /retrieval\s+quality/i,
  /source\s+score/i,
  /системийн\s+дотоод/i,
];

const NO_INFO_PATTERN = /мэдээлэл\s+олдсонгүй/i;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

function roundMetric(value: number): number {
  return Math.round(clamp01(value) * 1000) / 1000;
}

function normalize(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function isValidSourceUrl(source: Source): boolean {
  if (!source.url) {
    return false;
  }

  try {
    const url = new URL(source.url);
    if (source.type === 'legalinfo') {
      return url.hostname === 'legalinfo.mn' || url.hostname.endsWith('.legalinfo.mn');
    }

    if (source.type === 'shuukh') {
      return url.hostname === 'shuukh.mn' || url.hostname.endsWith('.shuukh.mn');
    }

    return false;
  } catch {
    return false;
  }
}

function scoreCitationCorrectness(
  sources: Source[],
  relatedLaws: RelatedLaw[],
  issues: string[],
): number {
  const citationItems = sources.length > 0 ? sources : [];
  const lawItems = relatedLaws.length > 0 ? relatedLaws : [];

  if (citationItems.length === 0 && lawItems.length === 0) {
    issues.push('no_citations');
    return 0.55;
  }

  const validSourceRatio =
    citationItems.length === 0
      ? 0.75
      : citationItems.filter(isValidSourceUrl).length / citationItems.length;

  const validLawRatio =
    lawItems.length === 0
      ? 0.75
      : lawItems.filter((law) => law.title.trim() && law.url.trim()).length / lawItems.length;

  const articleRatio =
    lawItems.length === 0
      ? 0.75
      : lawItems.filter((law) => String(law.articleNo ?? '').trim()).length / lawItems.length;

  const score = validSourceRatio * 0.45 + validLawRatio * 0.35 + articleRatio * 0.2;

  if (validSourceRatio < 0.8) {
    issues.push('invalid_source_url');
  }
  if (articleRatio < 0.5) {
    issues.push('weak_article_citation');
  }

  return score;
}

function scoreAnswerFaithfulness(answer: string, issues: string[]): number {
  const normalized = normalize(answer);
  let score = 1;

  if (!normalized || normalized.length < 80) {
    issues.push('answer_too_short');
    score -= 0.35;
  }

  if (NO_INFO_PATTERN.test(normalized)) {
    issues.push('no_info_answer');
    score -= 0.35;
  }

  for (const pattern of INTERNAL_LEAK_PATTERNS) {
    if (pattern.test(answer)) {
      issues.push('internal_word_leak');
      score -= 0.25;
      break;
    }
  }

  const incompleteEnding = /(?:нь|бол|болон|эсхүл|гэсэн|тул|учир)$/i.test(normalized);
  if (incompleteEnding) {
    issues.push('possibly_incomplete_sentence');
    score -= 0.2;
  }

  return score;
}

function scoreRetrievalAccuracy(input: EvaluateAnswerQualityInput, issues: string[]): number {
  if (input.retrievalTimedOut) {
    issues.push('retrieval_timeout_fallback');
    return Math.max(0.45, input.retrievalQuality?.overall ?? 0.45);
  }

  if (input.generationMode === 'no-info') {
    return 1;
  }

  const retrievalScore = input.retrievalQuality?.overall;
  if (typeof retrievalScore === 'number') {
    if (retrievalScore < 0.5) {
      issues.push('low_retrieval_quality');
    }
    return retrievalScore;
  }

  if (input.relatedLaws.length > 0 || input.sources.length > 0) {
    return 0.7;
  }

  issues.push('no_retrieval_signal');
  return 0.45;
}

function scoreLatency(latencyMs: number, budgetMs: number, issues: string[]): number {
  const safeBudget = Math.max(1000, budgetMs);
  if (latencyMs <= safeBudget) {
    return 1;
  }

  issues.push('latency_budget_exceeded');
  return safeBudget / Math.max(latencyMs, safeBudget);
}

export function evaluateAnswerQuality(input: EvaluateAnswerQualityInput): ChatQualityMetrics {
  const issues: string[] = [];
  const retrievalAccuracy = scoreRetrievalAccuracy(input, issues);
  const citationCorrectness = scoreCitationCorrectness(input.sources, input.relatedLaws, issues);
  const answerFaithfulness = scoreAnswerFaithfulness(input.answer, issues);
  const responseLatency = scoreLatency(input.latencyMs, input.latencyBudgetMs, issues);

  if (input.generationTimedOut) {
    issues.push('generation_timeout_fallback');
  }

  const overall =
    retrievalAccuracy * 0.3 +
    citationCorrectness * 0.25 +
    answerFaithfulness * 0.3 +
    responseLatency * 0.15;

  return {
    retrievalAccuracy: roundMetric(retrievalAccuracy),
    citationCorrectness: roundMetric(citationCorrectness),
    answerFaithfulness: roundMetric(answerFaithfulness),
    responseLatency: roundMetric(responseLatency),
    overall: roundMetric(overall),
    issues: Array.from(new Set(issues)),
  };
}
