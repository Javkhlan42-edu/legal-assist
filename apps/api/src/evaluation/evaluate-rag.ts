import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, type AppEnv } from '../config/env.js';
import { generate } from '../services/generation.service.js';
import { search } from '../services/retrieval.service.js';
import { planChatWorkflow } from '../services/chat-workflow.service.js';
import { LEGAL_EVAL_DATASET, type LegalEvalCase } from './legal-eval-dataset.js';
import {
  evaluateAnswerFaithfulness,
  evaluateCitationCorrectness,
  evaluateRetrievalAccuracy,
  summarizeLatency,
  toCitationSnapshots,
  toRetrievedSourceSnapshots,
  type CitationMetricResult,
  type EvaluationCitationSnapshot,
  type FaithfulnessMetricResult,
  type RetrievalMetricResult,
  type RetrievedSourceSnapshot,
} from './rag-eval-metrics.js';

interface CaseLatency {
  retrievalLatencyMs: number | null;
  rerankLatencyMs: number | null;
  generationLatencyMs: number | null;
  totalLatencyMs: number;
  firstTokenLatencyMs: number | null;
}

interface CaseMetrics {
  retrieval: RetrievalMetricResult;
  citation: CitationMetricResult;
  faithfulness: FaithfulnessMetricResult;
}

interface EvaluationCaseResult {
  id: string;
  category: LegalEvalCase['category'];
  question: string;
  expectedLawTitle?: string;
  expectedSourceKeywords?: string[];
  expectedCitationKeywords: string[];
  expectedAnswerKeywords?: string[];
  retrievedSources: RetrievedSourceSnapshot[];
  answer: string;
  citations: EvaluationCitationSnapshot[];
  metrics: CaseMetrics;
  latency: CaseLatency;
  error?: string;
}

interface EvaluationSummary {
  retrievalHitAt5: number;
  citationCorrectness: number;
  answerFaithfulness: number;
  faithfulRate: number;
  averageLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  maxLatencyMs: number;
  failedCases: number;
}

interface EvaluationReport {
  createdAt: string;
  totalCases: number;
  summary: EvaluationSummary;
  cases: EvaluationCaseResult[];
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const API_ROOT = resolve(__dirname, '../..');
const RESULTS_DIR = resolve(API_ROOT, 'evaluation-results');
const JSON_REPORT_PATH = resolve(RESULTS_DIR, 'rag-eval-result.json');
const MARKDOWN_REPORT_PATH = resolve(RESULTS_DIR, 'rag-eval-report.md');

function assertLiveEvaluationEnv(env: AppEnv): void {
  const missing: string[] = [];

  if (!env.OPENAI_API_KEY.trim()) {
    missing.push('OPENAI_API_KEY');
  }

  if (env.EMBEDDING_PROVIDER === 'openai' && !env.OPENAI_API_KEY.trim()) {
    missing.push('OPENAI_API_KEY for EMBEDDING_PROVIDER=openai');
  }

  if (env.VECTOR_DB_PROVIDER === 'pgvector' && !env.DATABASE_URL?.trim()) {
    missing.push('DATABASE_URL for VECTOR_DB_PROVIDER=pgvector');
  }

  if (env.VECTOR_DB_PROVIDER === 'chroma' && (!env.CHROMA_URL.trim() || !env.CHROMA_COLLECTION.trim())) {
    missing.push('CHROMA_URL/CHROMA_COLLECTION for VECTOR_DB_PROVIDER=chroma');
  }

  if (missing.length > 0) {
    throw new Error(`Live RAG evaluation requires configured runtime services. Missing: ${missing.join(', ')}`);
  }
}

function compactText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function buildContextualGenerationQuery(message: string, relevantHistory: Array<{ role: string; content: string }>): string {
  const previousUserQuestion = relevantHistory
    .slice()
    .reverse()
    .find((item) => item.role === 'user')?.content;

  if (!previousUserQuestion) {
    return message;
  }

  const current = compactText(message);
  const previous = compactText(previousUserQuestion);

  if (!previous || previous.includes(current)) {
    return message;
  }

  return [compactText(`${previous} ${current}`).slice(0, 700), `Одоогийн тодруулга: ${current}`].join('\n');
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function writeLine(message = ''): void {
  process.stdout.write(`${message}\n`);
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function isCaseFailed(result: EvaluationCaseResult): boolean {
  return Boolean(
    result.error ||
      !result.metrics.retrieval.hitAt5 ||
      !result.metrics.citation.citationCorrect ||
      !result.metrics.faithfulness.faithful,
  );
}

function summarizeResults(cases: EvaluationCaseResult[]): EvaluationSummary {
  const completedCases = cases.filter((item) => !item.error);
  const latencySummary = summarizeLatency(completedCases.map((item) => ({ totalLatencyMs: item.latency.totalLatencyMs })));

  return {
    retrievalHitAt5: average(completedCases.map((item) => (item.metrics.retrieval.hitAt5 ? 1 : 0))),
    citationCorrectness: average(completedCases.map((item) => item.metrics.citation.citationAccuracy)),
    answerFaithfulness: average(completedCases.map((item) => item.metrics.faithfulness.faithfulnessScore)),
    faithfulRate: average(completedCases.map((item) => (item.metrics.faithfulness.faithful ? 1 : 0))),
    averageLatencyMs: latencySummary.averageLatencyMs,
    p50LatencyMs: latencySummary.p50LatencyMs,
    p95LatencyMs: latencySummary.p95LatencyMs,
    maxLatencyMs: latencySummary.maxLatencyMs,
    failedCases: cases.filter(isCaseFailed).length,
  };
}

async function runCase(env: AppEnv, testCase: LegalEvalCase): Promise<EvaluationCaseResult> {
  const totalStart = Date.now();
  let retrievalLatencyMs: number | null = null;
  let generationLatencyMs: number | null = null;

  try {
    const workflowPlan = planChatWorkflow({
      message: testCase.question,
      history: [],
      messageRecords: [],
    });

    if (workflowPlan.earlyResponse || workflowPlan.shouldSkipRetrieval) {
      const retrievedSources: RetrievedSourceSnapshot[] = [];
      const citations: EvaluationCitationSnapshot[] = [];
      const answer = workflowPlan.earlyResponse?.answer ?? '';
      const metrics = {
        retrieval: evaluateRetrievalAccuracy(testCase, retrievedSources),
        citation: evaluateCitationCorrectness(testCase, citations, retrievedSources),
        faithfulness: evaluateAnswerFaithfulness({ answer, retrievedSources, citations }),
      };

      return {
        id: testCase.id,
        category: testCase.category,
        question: testCase.question,
        expectedLawTitle: testCase.expectedLawTitle,
        expectedSourceKeywords: testCase.expectedSourceKeywords,
        expectedCitationKeywords: testCase.expectedCitationKeywords,
        expectedAnswerKeywords: testCase.expectedAnswerKeywords,
        retrievedSources,
        answer,
        citations,
        metrics,
        latency: {
          retrievalLatencyMs,
          rerankLatencyMs: null,
          generationLatencyMs,
          totalLatencyMs: Date.now() - totalStart,
          firstTokenLatencyMs: null,
        },
        error: 'Workflow skipped retrieval/generation for this evaluation question.',
      };
    }

    const retrievalStart = Date.now();
    const retrievalResult = await search(env, workflowPlan.query, {
      preferredLawIds: workflowPlan.preferredLawIds,
      intentOverride: workflowPlan.intent,
      enrichmentTerms: workflowPlan.keywordProfile.topicalTerms,
      carryForwardChunks: workflowPlan.carryForwardChunks,
      carryForwardMode: workflowPlan.carryForwardMode,
      keywordProfile: workflowPlan.keywordProfile,
    });
    retrievalLatencyMs = Date.now() - retrievalStart;

    const generationQuery = workflowPlan.usesHistoryContext
      ? buildContextualGenerationQuery(testCase.question, workflowPlan.relevantHistory)
      : testCase.question;
    const generationStart = Date.now();
    const generationResult = await generate(
      env,
      generationQuery,
      retrievalResult.contextChunks,
      workflowPlan.relevantHistory,
      retrievalResult.relatedCases,
      {
        alreadyReranked: true,
        detailSubIntent: workflowPlan.detailSubIntent,
      },
    );
    generationLatencyMs = Date.now() - generationStart;

    const retrievedSources = toRetrievedSourceSnapshots({
      contextChunks: retrievalResult.contextChunks,
      sources: retrievalResult.sources,
      relatedLaws: retrievalResult.relatedLaws,
      relatedCases: retrievalResult.relatedCases,
    });
    const citations = toCitationSnapshots({
      sources: retrievalResult.sources,
      relatedLaws: retrievalResult.relatedLaws,
      relatedCases: retrievalResult.relatedCases,
    });
    const metrics = {
      retrieval: evaluateRetrievalAccuracy(testCase, retrievedSources),
      citation: evaluateCitationCorrectness(testCase, citations, retrievedSources),
      faithfulness: evaluateAnswerFaithfulness({
        answer: generationResult.answer,
        retrievedSources,
        citations,
      }),
    };

    return {
      id: testCase.id,
      category: testCase.category,
      question: testCase.question,
      expectedLawTitle: testCase.expectedLawTitle,
      expectedSourceKeywords: testCase.expectedSourceKeywords,
      expectedCitationKeywords: testCase.expectedCitationKeywords,
      expectedAnswerKeywords: testCase.expectedAnswerKeywords,
      retrievedSources,
      answer: generationResult.answer,
      citations,
      metrics,
      latency: {
        retrievalLatencyMs,
        rerankLatencyMs: null,
        generationLatencyMs,
        totalLatencyMs: Date.now() - totalStart,
        firstTokenLatencyMs: null,
      },
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const retrievedSources: RetrievedSourceSnapshot[] = [];
    const citations: EvaluationCitationSnapshot[] = [];
    const answer = '';

    return {
      id: testCase.id,
      category: testCase.category,
      question: testCase.question,
      expectedLawTitle: testCase.expectedLawTitle,
      expectedSourceKeywords: testCase.expectedSourceKeywords,
      expectedCitationKeywords: testCase.expectedCitationKeywords,
      expectedAnswerKeywords: testCase.expectedAnswerKeywords,
      retrievedSources,
      answer,
      citations,
      metrics: {
        retrieval: evaluateRetrievalAccuracy(testCase, retrievedSources),
        citation: evaluateCitationCorrectness(testCase, citations, retrievedSources),
        faithfulness: evaluateAnswerFaithfulness({ answer, retrievedSources, citations }),
      },
      latency: {
        retrievalLatencyMs,
        rerankLatencyMs: null,
        generationLatencyMs,
        totalLatencyMs: Date.now() - totalStart,
        firstTokenLatencyMs: null,
      },
      error: errorMessage,
    };
  }
}

function printCaseTable(cases: EvaluationCaseResult[]): void {
  writeLine('\nPer-question Results');
  writeLine('id | category | retrieval | citation | faithfulness | latencyMs | status');
  writeLine('--- | --- | --- | --- | --- | ---: | ---');
  for (const item of cases) {
    writeLine(
      [
        item.id,
        item.category,
        item.metrics.retrieval.hitAt5 ? 'hit' : 'miss',
        item.metrics.citation.citationCorrect ? 'ok' : 'fail',
        item.metrics.faithfulness.faithful ? 'ok' : 'fail',
        String(item.latency.totalLatencyMs),
        item.error ? 'error' : isCaseFailed(item) ? 'failed' : 'passed',
      ].join(' | '),
    );
  }
}

function printSummary(report: EvaluationReport): void {
  writeLine('\nEvaluation Summary');
  writeLine(`Total cases: ${report.totalCases}`);
  writeLine(`Retrieval Hit@5: ${formatPercent(report.summary.retrievalHitAt5)}`);
  writeLine(`Citation Correctness: ${formatPercent(report.summary.citationCorrectness)}`);
  writeLine(`Answer Faithfulness: ${formatPercent(report.summary.answerFaithfulness)}`);
  writeLine(`Average latency: ${report.summary.averageLatencyMs}ms`);
  writeLine(`p95 latency: ${report.summary.p95LatencyMs}ms`);
  writeLine(`Failed cases: ${report.summary.failedCases}`);

  const failedCases = report.cases.filter(isCaseFailed);
  if (failedCases.length > 0) {
    writeLine('\nFailed Cases');
    for (const item of failedCases) {
      writeLine(
        `- ${item.id}: retrieval=${item.metrics.retrieval.hitAt5}, citation=${item.metrics.citation.citationCorrect}, faithful=${item.metrics.faithfulness.faithful}${item.error ? `, error=${item.error}` : ''}`,
      );
    }
  }
}

function markdownTable(cases: EvaluationCaseResult[]): string {
  const rows = cases.map((item) =>
    [
      item.id,
      item.category,
      item.metrics.retrieval.hitAt5 ? 'Тийм' : 'Үгүй',
      formatPercent(item.metrics.citation.citationAccuracy),
      formatPercent(item.metrics.faithfulness.faithfulnessScore),
      `${item.latency.totalLatencyMs}ms`,
      item.error ? 'Алдаа' : isCaseFailed(item) ? 'Сайжруулах' : 'Амжилттай',
    ].join(' | '),
  );

  return [
    '| ID | Ангилал | Retrieval Hit@5 | Citation | Faithfulness | Latency | Төлөв |',
    '|---|---|---:|---:|---:|---:|---|',
    ...rows.map((line) => `| ${line} |`),
  ].join('\n');
}

function buildMarkdownReport(report: EvaluationReport): string {
  const failedCases = report.cases.filter(isCaseFailed);
  const failedCaseLines = failedCases.length
    ? failedCases
        .map((item) => {
          const notes = item.metrics.faithfulness.faithfulnessNotes.join(', ');
          const reason = item.error ?? `retrieval=${item.metrics.retrieval.hitAt5}, citation=${item.metrics.citation.citationCorrect}, notes=${notes}`;
          return `- **${item.id}** (${item.category}): ${reason}`;
        })
        .join('\n')
    : '- Ноцтой алдаатай кейс илрээгүй.';

  return `# RAG үнэлгээний тайлан

## Evaluation Purpose

Энэхүү үнэлгээний зорилго нь Монгол Улсын хууль зүйн RAG чатботын хайлтын нарийвчлал, ишлэлийн зөв байдал, хариултын эх сурвалжид тулгуурласан эсэх болон хариу өгөх хугацааг дипломын ажлын тайланд ашиглахуйц байдлаар хэмжихэд оршино. Үнэлгээ нь хэрэглэгчийн бодит асуултыг системийн query rewrite, hybrid retrieval, rerank, answer generation, citation pipeline-аар дамжуулж хэмждэг live-only туршилт юм.

## Dataset Description

Үнэлгээнд нийт **${report.totalCases}** монгол хэл дээрх хууль зүйн асуулт ашиглав. Асуултууд нь иргэний эрх зүй, эрүүгийн эрх зүй, захиргааны эрх зүй, замын хөдөлгөөний зөрчил, хөдөлмөрийн эрх зүй, гэр бүлийн эрх зүйн түгээмэл хэрэглээний нөхцөлүүдийг хамарсан. Кейс бүрт хүлээгдэж буй хуулийн нэр, эх сурвалжийн түлхүүр үг, ишлэлийн түлхүүр үг болон шаардлагатай үед хариултын түлхүүр үгийг урьдчилан тодорхойлсон.

## Metrics

- **Retrieval Accuracy**: Эхний 5 retrieved source/chunk дотор хүлээгдэж буй хуулийн нэр эсвэл эх сурвалжийн түлхүүр үг байгаа эсэхийг шалгаж Hit@5 болон Precision@5-ийг тооцсон.
- **Citation Correctness**: Буцаасан citations нь хүлээгдэж буй citation keywords-тэй таарах эсэх, мөн retrieval-ээр олдсон эх сурвалжтай URL/гарчиг/зүйлийн дугаараар давхцаж байгаа эсэхийг хэмжсэн.
- **Answer Faithfulness**: Хариулт retrieved context байхгүй үед хууль зүйн баттай claim хийхгүй байх, эх сурвалжид тулгуурласан хэллэгтэй байх, context-д байхгүй хуулийн нэр эсвэл зүйл дугаар зохиогоогүй байх дүрэмд суурилсан шалгалт хийсэн.
- **Response Latency**: Нийт latency, retrieval latency, generation latency-г хэмжиж дундаж, p50, p95, хамгийн их утгыг тооцсон. Streaming first-token latency нь энэхүү non-stream evaluator-д хэмжигдээгүй тул null байна.

## Result Summary

- **Нийт кейс**: ${report.totalCases}
- **Retrieval Hit@5**: ${formatPercent(report.summary.retrievalHitAt5)}
- **Citation Correctness**: ${formatPercent(report.summary.citationCorrectness)}
- **Answer Faithfulness**: ${formatPercent(report.summary.answerFaithfulness)}
- **Faithful Rate**: ${formatPercent(report.summary.faithfulRate)}
- **Average Latency**: ${report.summary.averageLatencyMs}ms
- **P50 Latency**: ${report.summary.p50LatencyMs}ms
- **P95 Latency**: ${report.summary.p95LatencyMs}ms
- **Max Latency**: ${report.summary.maxLatencyMs}ms
- **Failed Cases**: ${report.summary.failedCases}

${markdownTable(report.cases)}

## Failed Case Analysis

${failedCaseLines}

Алдаатай кейсүүдийг ерөнхийд нь дараах байдлаар тайлбарлаж болно: retrieval miss гарсан бол асуултын rewrite болон keyword/vector index-ийн хамрах хүрээ сул байж болно; citation correctness бага бол final response-д буцсан эх сурвалжийн нэр, зүйл дугаар dataset-ийн хүлээлттэй бүрэн давхцахгүй байна; faithfulness оноо буурсан бол хариулт context-д байхгүй хуулийн нэр эсвэл зүйл дугаар дурдсан, эсвэл эх сурвалжид тулгуурласан хэллэг хангалтгүй байна.

## Limitations

Энэхүү үнэлгээ нь дүрэмд суурилсан автомат шалгалт тул хүний хуульчийн нарийвчилсан чанарын үнэлгээг бүрэн орлохгүй. Dataset нь seed хэмжээтэй тул бүх хууль, бүх төрлийн маргааныг төлөөлөхгүй. Citation keyword match нь хэлбэрийн өөрчлөлт, товчлол, ижил утгатай нэршлийг бүрэн ойлгохгүй байж болно. Rerank latency нь retrieval service-ийн дотоод timing-аас тусдаа export хийгдээгүй тул одоогоор null; streaming first-token latency мөн non-stream runner-д хэмжигдэхгүй. Live-only горим учраас үр дүн нь тухайн үеийн vector index, database, LLM model, network latency болон API availability-аас хамаарч өөрчлөгдөнө.
`;
}

async function writeReports(report: EvaluationReport): Promise<void> {
  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(JSON_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(MARKDOWN_REPORT_PATH, buildMarkdownReport(report), 'utf8');
}

export async function runRagEvaluation(env: AppEnv = loadEnv()): Promise<EvaluationReport> {
  assertLiveEvaluationEnv(env);
  const cases: EvaluationCaseResult[] = [];

  for (const [index, testCase] of LEGAL_EVAL_DATASET.entries()) {
    writeLine(`[${index + 1}/${LEGAL_EVAL_DATASET.length}] ${testCase.id}: ${testCase.question}`);
    cases.push(await runCase(env, testCase));
  }

  const report: EvaluationReport = {
    createdAt: new Date().toISOString(),
    totalCases: LEGAL_EVAL_DATASET.length,
    summary: summarizeResults(cases),
    cases,
  };

  await writeReports(report);
  printCaseTable(cases);
  printSummary(report);
  writeLine(`\nJSON report: ${JSON_REPORT_PATH}`);
  writeLine(`Markdown report: ${MARKDOWN_REPORT_PATH}`);

  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runRagEvaluation().catch((err) => {
    console.error('RAG evaluation failed');
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
