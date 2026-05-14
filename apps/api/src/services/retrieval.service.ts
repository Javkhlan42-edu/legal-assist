// ────────────────────────────────────────────────────────────
// Retrieval Service — Hybrid search: Vector + Keyword + RRF
// ────────────────────────────────────────────────────────────

import type { AppEnv } from '../config/env.js';
import {
  getOpenAIClient,
  embedQueriesOpenAI,
  embedQueryLocal,
} from '../lib/llm-client.js';
import { queryVectorStore, type ChromaQueryResult } from '../lib/vector-db.js';
import { dbQuery } from '../lib/db.js';
import { rrfService } from './rrf.service.js';
import { keywordSearchService, type KeywordSearchResult } from './keyword-search.service.js';
import {
  classifyLegalIntent,
  detectQueryMode,
  getIntentPreferredLawIds,
  isAdministrativeReviewQuery,
  isCivilServiceDisciplineQuery,
  isDefamationQuery,
  isLandRegistrationDisputeQuery,
  isPropertyDamageCrimeQuery,
  isPublicNoiseComplaintQuery,
  isTrafficInsuranceClaimQuery,
  rewriteQuery,
  type QueryIntent,
  type QueryMode,
} from './query-rewrite.service.js';
import { rerankerService } from './reranker.service.js';
import { buildLawUrl, buildLawUrlWithSword, getLawUrl } from '../lib/law-mapping.js';
import { extractArticle } from '@legal-chatbot/shared';
import type { Source } from '@legal-chatbot/shared';

// ── Result types ────────────────────────────────────────────

export interface RelatedLaw {
  title: string;
  articleNo: string;
  url: string;
  score: number;
  displayScore?: number;
}

export interface RelatedCase {
  title: string;
  caseNumber: string;
  url: string;
  score: number;
  displayScore?: number;
  summary?: string;
  court?: string;
  decisionType?: string;
}

export interface RetrievalStageTiming {
  embeddingMs: number;
  vectorSearchMs: number;
  keywordSearchMs: number;
  fallbackAndFilterMs: number;
  caseSearchMs: number;
  rerankMs: number;
  buildMs: number;
}

export interface RetrievalResult {
  /** All unique chunks used for context (sorted by score desc) */
  contextChunks: ChromaQueryResult[];
  /** Source list for UI citation cards */
  sources: Source[];
  /** Deduplicated laws extracted from legalinfo results */
  relatedLaws: RelatedLaw[];
  /** Deduplicated cases extracted from shuukh results */
  relatedCases: RelatedCase[];
  /** Total unique sources used */
  sourcesUsed: number;
  retrievalQuality: RetrievalQuality;
  /** Detailed retrieval latency breakdown for debugging production slowdowns */
  retrievalTiming: RetrievalStageTiming;
}

export interface SearchOptions {
  preferredLawIds?: string[];
  intentOverride?: QueryIntent;
  enrichmentTerms?: string[];
  carryForwardChunks?: ChromaQueryResult[];
  carryForwardMode?: string;
  keywordProfile?: unknown;
}

export interface RetrievalQuality {
  overall: number;
  intentPrecision: number;
  canonicalCoverage: number;
  topScore: number;
  qualityBand: 'low' | 'medium' | 'high';
}

interface PreferredLawFallbackRow {
  id: string;
  document: string;
  metadata: Record<string, unknown>;
  score: number;
}

// ── Search config ───────────────────────────────────────────

const OVERALL_TOP_K = 20;
const SHORT_QUERY_TOP_K = 40;
const VERY_SHORT_QUERY_TOP_K = 60; // For 1-2 word queries, retrieve even more
const RETRIEVAL_TOP_RESULTS = 20;
const FINAL_TOP_RESULTS = 8;
const CASE_VECTOR_TOP_K = 24;
const CASE_KEYWORD_TOP_K = 24;
const ARTICLE_SCORE_BOOST = 0.15;
const MIN_ARTICLE_SIGNAL_RATIO = 0.67;
/** Minimum score for chunks to be included in context — keep low for Mongolian local embeddings */
const MIN_SCORE = 0.03;
/** Minimum score for laws/cases to be shown in relatedLaws */
const MIN_LAW_CASE_SCORE = 0.03;
/** Maximum number of related laws to show in UI (1 primary + 10 secondary) */
const MAX_RELATED_LAWS = 11;
const MAX_RELATED_CASES = 6;
/** Whether to use hybrid search (vector + keyword) */
const ENABLE_HYBRID_SEARCH = true;
const SHUUKH_BASE_URL = 'https://shuukh.mn';
const TRAFFIC_CASE_QUERY_PATTERN =
  /(замын\s+хөдөлгөөн|тээврийн\s+хэрэгсэл|жолоо|жолоод|жолооч|осол|мөргө|мөргөлд|шүрг|шүргэ|согтуур|согтуу|зугт|зогсоол|авто\s*даатгал|каско|ослын\s+газар)/i;
const BROAD_OVERVIEW_QUERY_PATTERN =
  /(эрх|үүрэг|дэлгэрэнгүй|мэдээлэл|тайлбар|танилцуул|ерөнхий|юу\s+зохицуулдаг|ямар\s+эрх|ямар\s+үүрэг)/i;
const CYBER_FRAUD_QUERY_PATTERN =
  /(?=.*(?:цахим|онлайн|интернет|фишинг|facebook|фэйсбүүк|чат|линк|otp|нэг\s+удаагийн\s+код|карт|данс|гүйлгээ|шилжүүлэг|апп|мөнгө))(?=.*(?:луйвар|залил|хууран\s*мэхл|мэхэл|алд(?:сан|чих|лаа|уул|ав)|шилжүүлсэн|авчих))/i;
const CYBER_FRAUD_SIGNAL_PATTERNS: RegExp[] = [
  /залилан|залилах|хууран\s*мэхл|луйвар/i,
  /цахим|онлайн|интернет|фишинг|чат|линк|otp|нэг\s+удаагийн\s+код/i,
  /данс|гүйлгээ|шилжүүлэг|карт|мөнгө|банк/i,
  /нотлох\s+баримт|гомдол|мэдээлэл|хохирогч|мөрдөн/i,
  /цагдаа|прокурор|эрэн\s+сурвалж/i,
];
const CYBER_FRAUD_ALLOWED_TITLE_PATTERNS: RegExp[] = [
  /эрүүгийн\s+хууль/i,
  /эрүүгийн\s+хэрэг\s+хянан\s+шийдвэрлэх/i,
  /цагдаагийн\s+албаны\s+тухай/i,
  /харилцаа\s+холбооны\s+тухай/i,
  /кибер\s+аюулгүй\s+байдлын\s+тухай/i,
  /хүний\s+хувийн\s+мэдээлэл/i,
  /зөрчлийн\s+тухай/i,
];
const CYBER_FRAUD_BAD_PROCESS_PATTERN =
  /(ямар\s+хэрэгт\s+яллагдаж|дуудан\s+ирүүлэх|хэрэг\s+хянан\s+шийдвэрлэх\s+ажиллагааг\s+цахимаар|барьцаа\s+авах|хавтаст\s+хэрэг|баримт\s+бичиг\s+хүргэх|хамтран\s+ажиллах\s+этгээд|цахим\s+гарын\s+үсгийн\s+тухай)/i;

interface RetrievalRuntimeConfig {
  speedMode: AppEnv['RETRIEVAL_SPEED_MODE'];
  useVectorSearch: boolean;
  maxQueryVariants: number;
  vectorTopK: number;
  keywordTopK: number;
  keywordFallbackTopK: number;
  caseVectorTopK: number;
  caseKeywordTopK: number;
  retrieveRelatedCases: boolean;
  rerankCandidateLimit: number;
  finalTopResults: number;
  relatedLawCandidateLimit: number;
}

type TrafficIncidentSubtype =
  | 'parking_hit_and_run'
  | 'minor_collision'
  | 'insurance_claim'
  | 'dui_or_injury'
  | 'general_traffic';

type ContractSubtype =
  | 'bank_loan_overdue'
  | 'bank_loan_application'
  | 'bank_loan_collateral'
  | 'credit_information'
  | 'generic_contract';

const DOMAIN_PATTERNS: Record<Exclude<QueryIntent, 'unknown'>, RegExp[]> = {
  crime: [
    /эрүүгийн/i,
    /гэмт\s+хэрэг/i,
    /хулгай|залилан|авлига|дээрэм|ял/i,
    /цагдаа|мөрдөн\s+байцаа|эрэн\s+сурвалж/i,
    /харилцаа\s+холбоо|утас|IMEI|төхөөрөмж/i,
    /зөрчил/i,
  ],
  traffic: [
    /замын\s+хөдөлгөөн|тээврийн\s+хэрэгсэл|жолоо|жолоод|жолооч|жолооны\s+эрх|осол|автотээвэр|авто\s*зам|зам\s*тээврийн\s*осол|мөргө|мөргөлд|шүрг|шүргэ/i,
    /согтуур|согтуу|мансуурал|зөрчил|эрхийн\s+хасалт|торгууль|зугт|ослын\s+газар|эсрэг\s+урсгал|зогсоол|паркинг|авто\s*даатгал|каско/i,
  ],
  election: [
    /сонгууль|сонгогч|сонгох\s+эрх|санал\s+өгөх|сонгуулийн/i,
    /үндсэн\s+хууль|18\s*нас|арван\s*найм\s*нас/i,
  ],
  contract: [
    /иргэний|гэрээ|худалдах|худалдан|зарах|шилжүүл|хөрөнгө|үл\s*хөдлөх|өмчлөх/i,
    /үүрэг|өр|төлбөр|нэхэмжлэл|биелүүл|өмчлөл|шилжилт|хэлцэл/i,
    /даатгал|даатгагч|даатгуулагч|нөхөн\s*төлбөр|татгалз/i,
  ],
  tax: [/татвар/i, /албан\s+татвар/i, /алданги|нөат|татварын\s+алба/i],
  socialInsurance: [/нийгмийн\s+даатгал/i, /шимтгэл|даатгуулагч|ндш|тэтгэвэр/i],
  labor: [/хөдөлмөр/i, /ажилтн|ажилч|ажил\s+олгогч|цалин|хөдөлмөрийн\s+гэрээ/i],
  family: [
    /гэр\s+бүл/i,
    /гэрлэлт|салалт|тэтгэлэг|хүүхэд|асран\s+хамгаалах|эцэг\s*эх/i,
    /уулз|уулзуулах|харилцах\s+эрх|асрамж|хамт\s+амьдрах|асран\s+хүмүүжүүлэх/i,
  ],
};

const DOMAIN_MIN_SCORE: Record<Exclude<QueryIntent, 'unknown'>, number> = {
  crime: 1,
  traffic: 1,
  election: 1,
  contract: 1,
  tax: 1,
  socialInsurance: 1,
  labor: 1,
  family: 1,
};

const CANONICAL_LAW_TITLE_PATTERNS: Record<Exclude<QueryIntent, 'unknown'>, RegExp[]> = {
  crime: [
    /эрүүгийн\s+хууль/i,
    /зөрчлийн\s+тухай/i,
    /цагдаагийн\s+албаны\s+тухай/i,
    /эрүүгийн\s+хэрэг\s+хянан\s+шийдвэрлэх/i,
    /харилцаа\s+холбооны\s+тухай/i,
  ],
  traffic: [
    /замын\s+хөдөлгөөний\s+аюулгүй\s+байдлын\s+тухай/i,
    /зөрчлийн\s+тухай/i,
    /эрүүгийн\s+хууль/i,
    /автотээврийн\s+тухай/i,
    /даатгалын\s+тухай/i,
    /жолоочийн\s+даатгалын\s+тухай/i,
  ],
  election: [/үндсэн\s+хууль/i, /сонгуулийн\s+тухай/i],
  contract: [
    /иргэний\s+хууль/i,
    /гэрээ/i,
    /даатгалын\s+тухай/i,
    /жолоочийн\s+даатгалын\s+тухай/i,
    /банк\s+эрх\s+бүхий.*зээлийн\s+үйл\s+ажиллагаа/i,
    /банкны\s+тухай/i,
  ],
  tax: [/татвар/i],
  socialInsurance: [/нийгмийн\s+даатгал/i],
  labor: [/хөдөлмөр/i],
  family: [/гэр\s+бүлийн\s+тухай/i, /хүүхдийн\s+эрхийн\s+тухай/i],
};

const STRICT_DOMAIN_TITLE_PATTERNS: Record<Exclude<QueryIntent, 'unknown'>, RegExp[]> = {
  crime: [
    /эрүүгийн|гэмт\s+хэрэг|ял|цагдаа|мөрдөн\s+байцаа|эрэн\s+сурвалж|зөрчил|харилцаа\s+холбоо/i,
  ],
  traffic: [
    /замын\s+хөдөлгөөн|тээврийн\s+хэрэгсэл|жолоо|жолоод|жолооч|согтуур|согтуу|зөрчил|автотээвэр/i,
  ],
  election: [/сонгууль|сонгогч|санал\s+өгөх|үндсэн\s+хууль|сонгох\s+эрх/i],
  contract: [
    /иргэний|гэрээ|үл\s*хөдлөх|эд\s*хөрөнгө|өмч|өмчлөх|барьца|худалдах|худалдан|шилжүүл/i,
    /даатгал|даатгагч|даатгуулагч|нөхөн\s*төлбөр|зээлийн\s+үйл\s+ажиллагаа/i,
  ],
  tax: [/татвар|албан\s+татвар|нөат|төсөв/i],
  socialInsurance: [/нийгмийн\s+даатгал|шимтгэл|ндш/i],
  labor: [/хөдөлмөр|ажилтн|ажилч|ажил\s+олгогч|цалин/i],
  family: [
    /гэр\s+бүл|гэрлэлт|салалт|тэтгэлэг|хүүхэд|эцэг\s*эх/i,
    /уулз|уулзуулах|харилцах\s+эрх|асрамж|хамт\s+амьдрах|асран\s+хүмүүжүүлэх/i,
  ],
};

const CONTRACT_STRICT_SIGNAL_PATTERNS: RegExp[] = [
  /гэрээ/i,
  /даатгал|даатгагч|даатгуулагч|нөхөн\s*төлбөр/i,
  /худалдах|худалдан|зарах/i,
  /шилжүүл/i,
  /үл\s*хөдлөх/i,
  /эд\s*хөрөнгө/i,
  /өмч|өмчлөх|өмчлөл/i,
  /барьца/i,
  /нотариат/i,
];

const TRAFFIC_STRICT_SIGNAL_PATTERNS: RegExp[] = [
  /согтуур|согтуу/i,
  /жолоо|жолоод|жолооч|жолооны\s+эрх/i,
  /тээврийн\s+хэрэгсэл|замын\s+хөдөлгөөн|автотээвэр|авто\s*зам/i,
  /зөрчил|эрхийн\s+хасалт|торгууль/i,
  /осол|зам\s*тээврийн\s*осол|мөргө|мөргөлд|шүрг|шүргэ/i,
  /зугт|ослын\s+газар|эсрэг\s+урсгал|зогсоол|паркинг/i,
];

const ELECTION_STRICT_SIGNAL_PATTERNS: RegExp[] = [
  /сонгууль|сонгуулийн/i,
  /сонгогч|сонгох\s+эрх|санал\s+өгөх/i,
  /үндсэн\s+хууль/i,
  /18\s*нас|арван\s*найм\s*нас/i,
];

const FAMILY_STRICT_SIGNAL_PATTERNS: RegExp[] = [
  /гэр\s+бүл|гэрлэл|салалт/i,
  /эцэг\s*эх|хүүхэд|тэтгэлэг|асран\s+хамгаалах|асран\s+хүмүүжүүлэх/i,
  /уулз|уулзуулах|харилцах\s+эрх|асрамж|хамт\s+амьдрах/i,
];

// ── Service ─────────────────────────────────────────────────

/**
 * Execute Hybrid RAG search:
 *   1. Vector search: 3-way Chroma search (overall + source-specific)
 *   2. Keyword search: BM25 via PostgreSQL full-text search (optional, if enabled)
 *   3. RRF fusion: Combine results using Reciprocal Rank Fusion
 * Then deduplicate by chunk ID and build structured outputs.
 */
export async function search(
  env: AppEnv,
  query: string,
  options: SearchOptions = {},
): Promise<RetrievalResult> {
  const startTime = Date.now();
  const timing: RetrievalStageTiming = {
    embeddingMs: 0,
    vectorSearchMs: 0,
    keywordSearchMs: 0,
    fallbackAndFilterMs: 0,
    caseSearchMs: 0,
    rerankMs: 0,
    buildMs: 0,
  };
  const baseQuery = extractPrimaryQuery(query);
  const mode = detectQueryMode(baseQuery);
  const intentFromPrimary = classifyLegalIntent(baseQuery);
  const intentFromFull = classifyLegalIntent(query);
  const intent =
    options.intentOverride && options.intentOverride !== 'unknown'
      ? options.intentOverride
      : intentFromPrimary !== 'unknown'
        ? intentFromPrimary
        : intentFromFull;
  const caseIntent = resolveRelatedCaseIntent(baseQuery, intent);
  const rewrittenQuery = rewriteQuery(baseQuery);
  const shortQuery = isShortQuery(baseQuery);
  const words = normalizeText(baseQuery).split(/\s+/).filter(Boolean);
  const isSingleWord = words.length <= 1 || baseQuery.length <= 10;
  const runtimeConfig = getRetrievalRuntimeConfig(
    env,
    baseQuery,
    shortQuery,
    isSingleWord,
    intent,
    mode,
  );
  const searchQueries = buildSearchQueries(baseQuery, shortQuery, rewrittenQuery).slice(
    0,
    runtimeConfig.maxQueryVariants,
  );
  const preferredLawIds = Array.from(
    new Set([...getIntentPreferredLawIds(intent), ...(options.preferredLawIds ?? [])]),
  );
  const shouldPreferCanonicalOverview =
    mode === 'document' || mode === 'article' || isBroadOverviewQuery(baseQuery, mode);

  console.info(
    {
      query: baseQuery.slice(0, 100),
      mode,
      intent,
      caseIntent,
      rewrittenQuery: rewrittenQuery.slice(0, 180),
      speedMode: runtimeConfig.speedMode,
      searchQueryVariants: searchQueries.length,
      retrieveRelatedCases: runtimeConfig.retrieveRelatedCases,
      useVectorSearch: runtimeConfig.useVectorSearch,
    },
    'Search initiated',
  );

  // ── 1. VECTOR SEARCH (LEGALINFO ONLY) ──────────────────────────────────────

  // Determine retrieval size based on query length
  // Single word queries need more aggressive retrieval due to sparse signals
  const vectorSearchTopK = runtimeConfig.vectorTopK;

  const vectorEnv = {
    VECTOR_DB_PROVIDER: env.VECTOR_DB_PROVIDER,
    CHROMA_URL: env.CHROMA_URL,
    CHROMA_COLLECTION: env.CHROMA_COLLECTION,
    EMBEDDING_DIMENSION: env.EMBEDDING_DIMENSION,
  } as const;
  const hasCyrillic = /[А-Яа-яӨөҮүЁё]/.test(baseQuery);
  const keywordQuery = rewrittenQuery || baseQuery;
  const initialKeywordSearchPromise = ENABLE_HYBRID_SEARCH
    ? searchLegalKeywordWithMongolianFallback(
        keywordQuery,
        runtimeConfig.keywordTopK,
        hasCyrillic,
      )
    : Promise.resolve([]);

  // Embed + vector search can fail when local embedding models are unavailable.
  // In that case, continue with keyword-only retrieval instead of failing the request.
  let embeddings: number[][] = [];
  let vectorResults: ChromaQueryResult[] = [];
  let caseVectorResults: ChromaQueryResult[] = [];
  try {
    if (!runtimeConfig.useVectorSearch) {
      console.info(
        {
          speedMode: runtimeConfig.speedMode,
          query: baseQuery.slice(0, 100),
        },
        'Skipping vector retrieval for fast lexical scenario',
      );
    } else if (env.EMBEDDING_PROVIDER === 'local') {
      const embeddingStart = Date.now();
      console.debug({ searchQueries }, 'Embedding query variants using local model');
      embeddings = await Promise.all(
        searchQueries.map((q) =>
          embedQueryLocal(env.LOCAL_EMBEDDING_MODEL, env.EMBEDDING_DIMENSION, q),
        ),
      );
      timing.embeddingMs += Date.now() - embeddingStart;
      console.debug(
        {
          variants: embeddings.length,
          embeddingDim: embeddings[0]?.length ?? 0,
        },
        'Query embeddings generated (local)',
      );
    } else {
      const embeddingStart = Date.now();
      console.debug({ searchQueries }, 'Embedding query variants using OpenAI');
      const openai = getOpenAIClient(env.OPENAI_API_KEY, env.OPENAI_TIMEOUT_MS);
      embeddings = await embedQueriesOpenAI(
        openai,
        env.OPENAI_EMBEDDING_MODEL,
        env.EMBEDDING_DIMENSION,
        searchQueries,
      );
      timing.embeddingMs += Date.now() - embeddingStart;
      console.debug(
        { variants: embeddings.length, embeddingDim: embeddings[0]?.length ?? 0 },
        'Query embeddings generated (OpenAI)',
      );
    }

    const vectorSearchStart = Date.now();
    const vectorVariantResults = await Promise.all(
      embeddings.map((embedding) =>
        queryVectorStore(vectorEnv, embedding, vectorSearchTopK, { source: 'legalinfo' }),
      ),
    );

    vectorResults = mergeVectorResults(vectorVariantResults.flat());
    timing.vectorSearchMs += Date.now() - vectorSearchStart;
  } catch (error) {
    console.warn(
      {
        error: error instanceof Error ? error.message : String(error),
        embeddingProvider: env.EMBEDDING_PROVIDER,
      },
      'Vector retrieval unavailable; falling back to keyword-only search',
    );
    vectorResults = [];
  }

  try {
    if (runtimeConfig.retrieveRelatedCases && embeddings.length > 0 && runtimeConfig.caseVectorTopK > 0) {
      const caseVectorStart = Date.now();
      const caseVectorVariantResults = await Promise.all(
        embeddings.map((embedding) =>
          queryVectorStore(vectorEnv, embedding, runtimeConfig.caseVectorTopK, { source: 'shuukh' }),
        ),
      );

      caseVectorResults = mergeVectorResults(caseVectorVariantResults.flat());
      timing.caseSearchMs += Date.now() - caseVectorStart;
    }
  } catch (error) {
    console.warn(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      'Case vector retrieval unavailable; continuing without shuukh vector matches',
    );
    caseVectorResults = [];
  }

  console.info(
    {
      vectorProvider: env.VECTOR_DB_PROVIDER,
      vectorResults: vectorResults.length,
      caseVectorResults: caseVectorResults.length,
      isSingleWord,
      vectorSearchTopK,
      legalinfoCount: vectorResults.length,
      shuukhCount: caseVectorResults.length,
      preferredLawIds,
      topScores: vectorResults.slice(0, 5).map((r) => ({ id: r.id.slice(0, 10), score: r.score })),
    },
    'Vector search complete',
  );

  // ── 2. OPTIONAL KEYWORD SEARCH + RRF FUSION ───────────────
  let fusedResults: ChromaQueryResult[] = vectorResults;

  if (ENABLE_HYBRID_SEARCH) {
    const keywordStart = Date.now();
    // Increase keyword search for single-word or very weak vector results
    const avgVectorScore =
      vectorResults.length > 0
        ? vectorResults.reduce((sum, r) => sum + r.score, 0) / vectorResults.length
        : 0;
    const isWeakVectorSignal = avgVectorScore < 0.5; // Lower threshold for weak signal detection
    const isVeryWeakSignal = avgVectorScore < 0.2; // Very poor vector matches

    // Aggressive keyword search with fallback strategy
    const keywordTopK = isWeakVectorSignal
      ? Math.min(runtimeConfig.keywordFallbackTopK, runtimeConfig.keywordTopK + 8)
      : runtimeConfig.keywordTopK;
    let keywordResults = await initialKeywordSearchPromise;

    if (keywordTopK > runtimeConfig.keywordTopK && keywordResults.length < keywordTopK) {
      const expandedKeywordResults = await searchLegalKeywordWithMongolianFallback(
        keywordQuery,
        keywordTopK,
        hasCyrillic,
      );
      if (expandedKeywordResults.length > keywordResults.length) {
        keywordResults = expandedKeywordResults;
      }
    }

    // FALLBACK: If keyword search returns few results, try with simpler query
    if (keywordResults.length < 3 && searchQueries.length > 1) {
      const firstQuery = searchQueries[0];
      const fallbackKeywordTopK = Math.min(keywordTopK + 8, runtimeConfig.keywordFallbackTopK);
      let fallbackResults = await keywordSearchService.search(firstQuery, fallbackKeywordTopK, {
        source: 'legalinfo',
      });
      if (fallbackResults.length === 0 && hasCyrillic) {
        fallbackResults = await keywordSearchService.searchMongolian(
          firstQuery,
          fallbackKeywordTopK,
          { source: 'legalinfo' },
        );
      }

      if (fallbackResults.length > keywordResults.length) {
        keywordResults = fallbackResults;
        console.debug(
          { fallbackUsed: true, originalCount: keywordResults.length },
          'Using keyword search fallback',
        );
      }
    }

    if (keywordResults.length > 0) {
      if (vectorResults.length === 0) {
        fusedResults = keywordResults.map((row) => ({
          id: row.chunkId,
          document: row.text,
          metadata: row.metadata || {},
          score: Math.min(1, Math.max(row.score || 0, 0.5)),
          rawScore: Math.min(1, Math.max(row.score || 0, 0)),
        }));

        console.debug(
          {
            vectorCount: 0,
            keywordCount: keywordResults.length,
            fusedCount: fusedResults.length,
          },
          'Using keyword-only search (vector unavailable)',
        );
      } else {
        const rrfResults = rrfService.fuse(vectorResults, keywordResults);
        fusedResults = rrfResults.map((r) => ({
          id: r.id,
          document: r.text,
          metadata: r.metadata,
          // Smart weighting: keyword-heavy when vectors weak, balanced otherwise
          score: isVeryWeakSignal
            ? Math.max(r.keywordScore * 1.5, r.vectorScore * 0.5, Math.min(r.rrfScore * 15, 1))
            : isWeakVectorSignal
              ? Math.max(r.keywordScore * 1.3, r.vectorScore, Math.min(r.rrfScore * 12, 1))
              : Math.max(r.vectorScore * 1.1, r.keywordScore, Math.min(r.rrfScore * 10, 1)),
          rawScore: Math.max(r.vectorScore, r.keywordScore, Math.min(r.rrfScore * 10, 0.85)),
        }));

        console.debug(
          {
            vectorCount: vectorResults.length,
            keywordCount: keywordResults.length,
            fusedCount: fusedResults.length,
            avgVectorScore,
            isWeakVectorSignal,
            isVeryWeakSignal,
          },
          'Using hybrid search with RRF fusion',
        );
      }
    } else {
      console.debug(
        { vectorCount: vectorResults.length, avgVectorScore },
        'Keyword search returned no results, using vector-only ranking',
      );
    }
    timing.keywordSearchMs += Date.now() - keywordStart;
  }

  const fallbackStart = Date.now();
  fusedResults = await applyAdaptiveFallbacksAndFilters({
    query: baseQuery,
    intent,
    mode,
    preferredLawIds,
    shouldPreferCanonicalOverview,
    results: fusedResults,
  });
  timing.fallbackAndFilterMs += Date.now() - fallbackStart;

  let relatedCaseResults = runtimeConfig.retrieveRelatedCases ? caseVectorResults : [];
  if (ENABLE_HYBRID_SEARCH && runtimeConfig.retrieveRelatedCases && runtimeConfig.caseKeywordTopK > 0) {
    const caseKeywordStart = Date.now();
    let caseKeywordResults = await keywordSearchService.search(keywordQuery, runtimeConfig.caseKeywordTopK, {
      source: 'shuukh',
    });

    if (caseKeywordResults.length === 0 && hasCyrillic) {
      caseKeywordResults = await keywordSearchService.searchMongolian(
        keywordQuery,
        runtimeConfig.caseKeywordTopK,
        { source: 'shuukh' },
      );
    }

    if (caseKeywordResults.length < 3 && searchQueries.length > 1) {
      const fallbackCaseQuery = searchQueries[0];
      const fallbackCaseTopK = Math.min(runtimeConfig.caseKeywordTopK + 8, 24);
      let fallbackCaseResults = await keywordSearchService.search(
        fallbackCaseQuery,
        fallbackCaseTopK,
        { source: 'shuukh' },
      );

      if (fallbackCaseResults.length === 0 && hasCyrillic) {
        fallbackCaseResults = await keywordSearchService.searchMongolian(
          fallbackCaseQuery,
          fallbackCaseTopK,
          { source: 'shuukh' },
        );
      }

      if (fallbackCaseResults.length > caseKeywordResults.length) {
        caseKeywordResults = fallbackCaseResults;
      }
    }

    if (caseKeywordResults.length > 0) {
      relatedCaseResults = mergeVectorResults([
        ...caseVectorResults,
        ...caseKeywordResults.map((result) => keywordResultToQueryResult(result, 0.45)),
      ]);
    }
    timing.caseSearchMs += Date.now() - caseKeywordStart;
  }

  relatedCaseResults = applyRelatedCaseFiltering(baseQuery, caseIntent, relatedCaseResults);

  // ── 4. DEDUPLICATION & FILTERING ──────────────────────────

  const seen = new Set<string>();
  const allChunks: ChromaQueryResult[] = [];

  // Log score distribution before filtering
  const scoreDistribution = fusedResults.map((r) => r.score);
  const hasScores = scoreDistribution.length > 0;
  console.debug(
    {
      beforeFilterCount: fusedResults.length,
      scoreRange: {
        min: hasScores ? Math.min(...scoreDistribution) : 0,
        max: hasScores ? Math.max(...scoreDistribution) : 0,
        avg: hasScores
          ? scoreDistribution.reduce((a, b) => a + b, 0) / scoreDistribution.length
          : 0,
      },
      scores: scoreDistribution.slice(0, 10),
      minScoreThreshold: MIN_SCORE,
    },
    'Score analysis before filtering',
  );

  for (const result of fusedResults) {
    if (seen.has(result.id)) continue;
    if (result.score < MIN_SCORE) continue;
    seen.add(result.id);
    allChunks.push(result);
  }

  // Sort by score descending (already sorted but ensure it)
  allChunks.sort((a, b) => b.score - a.score);
  const topCandidates = allChunks.slice(0, runtimeConfig.rerankCandidateLimit);
  const rerankStart = Date.now();
  const topChunks = await rerankerService.rerank(
    baseQuery,
    topCandidates,
    runtimeConfig.finalTopResults,
  );
  timing.rerankMs += Date.now() - rerankStart;
  const relatedLawCandidates = allChunks.slice(0, runtimeConfig.relatedLawCandidateLimit);

  // ── 5. BUILD STRUCTURED OUTPUTS ───────────────────────────

  const buildStart = Date.now();
  const retrievedRelatedLaws = buildRelatedLaws(baseQuery, mode, relatedLawCandidates);
  const relatedLaws = selectRelatedLawsWithFallback(
    intent,
    baseQuery,
    retrievedRelatedLaws,
  );
  const relatedCases = buildRelatedCases(baseQuery, caseIntent, relatedCaseResults);
  const sources = buildSources(baseQuery, mode, topChunks);
  const retrievalQuality = assessRetrievalQuality(intent, topChunks, relatedLaws);
  timing.buildMs += Date.now() - buildStart;

  const duration = Date.now() - startTime;
  console.info(
    {
      duration,
      vectorCount: vectorResults.length,
      caseVectorCount: caseVectorResults.length,
      candidatesCount: topCandidates.length,
      fusedCount: topChunks.length,
      intent,
      caseIntent,
      sourcesCount: sources.length,
      lawsCount: relatedLaws.length,
      casesCount: relatedCases.length,
      retrievalQuality,
      speedMode: runtimeConfig.speedMode,
      searchQueryVariants: searchQueries.length,
      retrieveRelatedCases: runtimeConfig.retrieveRelatedCases,
      useVectorSearch: runtimeConfig.useVectorSearch,
      timing,
    },
    'Search complete',
  );

  return {
    contextChunks: topChunks,
    sources,
    relatedLaws,
    relatedCases,
    sourcesUsed: topChunks.length,
    retrievalQuality,
    retrievalTiming: timing,
  };
}

/**
 * Format URL - use the URL directly from metadata as-is
 * (Should already be https://legalinfo.mn/... from ingestion)
 */
function formatUrl(url: string): string {
  if (!url) return '';
  return String(url);
}

function getMetaTitle(meta: Record<string, unknown>): string {
  const title = String(meta.title ?? meta.documentTitle ?? '').trim();
  return title || 'Эх сурвалж';
}

function getMetaUrl(meta: Record<string, unknown>): string {
  return formatUrl(String(meta.url ?? meta.documentUrl ?? ''));
}

function getResultLawId(result: ChromaQueryResult): string {
  return String(result.metadata.sourceId ?? result.metadata.lawId ?? '').trim();
}

function getResultTitle(result: ChromaQueryResult): string {
  return String(result.metadata.title ?? result.metadata.documentTitle ?? '').trim();
}

function getResultCorpus(result: ChromaQueryResult): string {
  return `${getResultTitle(result)} ${String(result.document ?? '')}`.toLowerCase();
}

async function searchLegalKeywordWithMongolianFallback(
  query: string,
  topK: number,
  hasCyrillic: boolean,
): Promise<KeywordSearchResult[]> {
  let keywordResults = await keywordSearchService.search(query, topK, {
    source: 'legalinfo',
  });

  if (keywordResults.length === 0 && hasCyrillic) {
    keywordResults = await keywordSearchService.searchMongolian(query, topK, {
      source: 'legalinfo',
    });
  }

  return keywordResults;
}

interface AdaptiveFallbackParams {
  query: string;
  intent: QueryIntent;
  mode: QueryMode;
  preferredLawIds: string[];
  shouldPreferCanonicalOverview: boolean;
  results: ChromaQueryResult[];
}

async function applyAdaptiveFallbacksAndFilters(
  params: AdaptiveFallbackParams,
): Promise<ChromaQueryResult[]> {
  const {
    query,
    intent,
    mode,
    preferredLawIds,
    shouldPreferCanonicalOverview,
  } = params;
  const bankLoan = isBankLoanQuery(query);
  const cyberFraud = isCyberFraudQuery(query);
  const insuranceClaim = isTrafficInsuranceClaimQuery(query);
  const consumerRefund = isConsumerRefundQuery(query);
  const laborDismissal = isLaborDismissalOrWageQuery(query);
  const publicNoise = isPublicNoiseComplaintQuery(query);
  const trafficIncident = isTrafficIncidentQuestion(query);

  let results = applyFocusedFiltering(query, params.results);
  const strongInitialCoverage = hasStrongAdaptiveCoverage(query, intent, preferredLawIds, results);

  if (!strongInitialCoverage) {
    results = await augmentWithSignalKeywordFallback(query, intent, results);
  }

  if (bankLoan) {
    results = await augmentWithBankLoanFallback(query, results);
  } else if (cyberFraud) {
    results = await augmentWithCyberFraudFallback(query, results);
  } else if (insuranceClaim) {
    results = await augmentWithInsuranceClaimFallback(query, results);
  } else if (consumerRefund) {
    results = await augmentWithConsumerRefundFallback(query, results);
  } else if (laborDismissal) {
    results = await augmentWithLaborDismissalFallback(query, results);
  } else if (publicNoise) {
    results = await augmentWithPublicNoiseFallback(query, results);
  } else if (trafficIncident) {
    results = await augmentWithTrafficIncidentFallback(query, results);
  }

  if (shouldPreferCanonicalOverview) {
    results = applyCanonicalLawFiltering(intent, results);
  }

  const hasScenarioCoverage = hasStrongAdaptiveCoverage(query, intent, preferredLawIds, results);
  if (!hasScenarioCoverage) {
    results = await augmentWithPreferredLawFallback(query, preferredLawIds, results);
  }

  if (mode === 'article' || extractRequestedArticleNumber(query)) {
    results = await augmentWithFocusedClauses(query, results);
  }

  results = applyTopicSignalFiltering(query, results);
  results = applyDomainFiltering(intent, results);

  if (bankLoan) {
    results = applyBankLoanFiltering(query, results);
  } else if (cyberFraud) {
    results = applyCyberFraudFiltering(query, results);
  } else if (insuranceClaim) {
    results = applyInsuranceClaimFiltering(query, results);
  } else if (consumerRefund) {
    results = applyConsumerRefundFiltering(query, results);
  } else if (laborDismissal) {
    results = applyLaborDismissalFiltering(query, results);
  } else if (publicNoise) {
    results = applyPublicNoiseFiltering(query, results);
  } else if (trafficIncident) {
    results = applyTrafficIncidentFiltering(query, results);
  }

  results = applyPreferredLawBoost(query, intent, mode, preferredLawIds, results);
  if (shouldPreferCanonicalOverview) {
    results = applyCanonicalLawFiltering(intent, results);
  }

  results = applyPropertyTransferBoost(query, results);
  results = applyFamilyContactBoost(query, results);

  if (mode === 'article') {
    results = applyArticleBoost(query, results);
    results = applyRequestedArticleFilter(query, results);
  }

  return results;
}

function hasStrongAdaptiveCoverage(
  query: string,
  intent: QueryIntent,
  preferredLawIds: string[],
  results: ChromaQueryResult[],
): boolean {
  if (results.length === 0) {
    return false;
  }

  const topResults = results.slice(0, 10);
  const topScore = Number(topResults[0]?.score ?? 0);
  const preferredHits = topResults.filter((result) => preferredLawIds.includes(getResultLawId(result))).length;

  if (isBankLoanQuery(query)) {
    const bankHits = topResults.filter((result) => isBankLoanRelevantResult(query, result));
    const hasCoreArticle = bankHits.some((result) => {
      const articleNo = String(result.metadata.articleNo ?? '').trim();
      return ['451', '452', '453'].includes(articleNo);
    });
    return hasCoreArticle && bankHits.length >= 2 && topScore >= 0.65;
  }

  if (isTrafficIncidentQuestion(query)) {
    const trafficHits = topResults.filter(isTrafficIncidentRelevantResult);
    return trafficHits.length >= 2 && topScore >= 0.62;
  }

  if (isLaborDismissalOrWageQuery(query)) {
    const laborHits = topResults.filter((result) => /хөдөлмөр|ажил|цалин|ажлаас|халах/i.test(getResultCorpus(result)));
    return laborHits.length >= 2 && topScore >= 0.62;
  }

  if (isConsumerRefundQuery(query)) {
    const consumerHits = topResults.filter((result) => /хэрэглэгч|худалда|доголдол|буцаалт|бараа/i.test(getResultCorpus(result)));
    return consumerHits.length >= 2 && topScore >= 0.62;
  }

  const canonicalPatterns: RegExp[] =
    intent === 'unknown' ? [] : CANONICAL_LAW_TITLE_PATTERNS[intent] ?? [];
  const canonicalHits = canonicalPatterns.length > 0
    ? topResults.filter((result) => canonicalPatterns.some((pattern) => pattern.test(getResultTitle(result)))).length
    : 0;
  return topScore >= 0.7 && (preferredHits >= 2 || canonicalHits >= 2);
}

function isBroadOverviewQuery(query: string, mode: QueryMode): boolean {
  if (mode !== 'qa') {
    return mode === 'document';
  }

  if (extractRequestedArticleNumber(query)) {
    return false;
  }

  return BROAD_OVERVIEW_QUERY_PATTERN.test(normalizeText(query));
}

function isCanonicalIntentResult(intent: QueryIntent, result: ChromaQueryResult): boolean {
  if (intent === 'unknown') {
    return false;
  }

  const title = getMetaTitle(result.metadata);
  const patterns = CANONICAL_LAW_TITLE_PATTERNS[intent] ?? [];
  return patterns.some((pattern) => pattern.test(title));
}

function pickPreferredLawAnchor(query: string): string {
  const signalTerms = extractArticleBoostSignalTerms(query).filter((term) => term.length >= 4);
  return signalTerms[0] ?? '';
}

function applyPreferredLawBoost(
  query: string,
  intent: QueryIntent,
  mode: QueryMode,
  preferredLawIds: string[],
  results: ChromaQueryResult[],
): ChromaQueryResult[] {
  if (results.length === 0 || preferredLawIds.length === 0) {
    return results;
  }

  const broadOverview = isBroadOverviewQuery(query, mode);
  const preferredSet = new Set(preferredLawIds);

  return results
    .map((result) => {
      const title = getMetaTitle(result.metadata);
      const lawId = getResultLawId(result);
      const chunkType = String(result.metadata.chunkType ?? '');
      const isPreferredLaw = preferredSet.has(lawId);
      const isCanonical = isCanonicalIntentResult(intent, result);
      let score = result.score;

      if (isPreferredLaw) {
        score += broadOverview ? 0.24 : 0.12;
      } else if (isCanonical) {
        score += broadOverview ? 0.12 : 0.06;
      }

      if (broadOverview && (chunkType === 'clause' || chunkType === 'subclause')) {
        score += 0.06;
      }

      if (broadOverview && !isPreferredLaw && !isCanonical) {
        score *= 0.76;
      }

      if (isLowAuthorityTitle(title) && !isPreferredLaw) {
        score *= broadOverview ? 0.5 : 0.72;
      }

      return {
        ...result,
        score: Math.max(0, Math.min(1, score)),
      };
    })
    .sort((a, b) => b.score - a.score);
}

async function augmentWithPreferredLawFallback(
  query: string,
  preferredLawIds: string[],
  results: ChromaQueryResult[],
): Promise<ChromaQueryResult[]> {
  const bankLoanQuery = isBankLoanQuery(query);
  const effectivePreferredLawIds = bankLoanQuery
    ? preferredLawIds.filter((lawId) => lawId === '299')
    : preferredLawIds;

  if (effectivePreferredLawIds.length === 0) {
    return results;
  }

  const preferredSet = new Set(effectivePreferredLawIds);
  const preferredHits = results
    .slice(0, 8)
    .filter((result) => preferredSet.has(getResultLawId(result))).length;

  if (preferredHits >= 2) {
    return results;
  }

  const anchor = pickPreferredLawAnchor(query).toLowerCase();

  try {
    const rows = await dbQuery<PreferredLawFallbackRow>(
      `SELECT
         c.id,
         SUBSTRING(c.text, 1, 2400) AS document,
         c.metadata || jsonb_build_object(
           'title', COALESCE(NULLIF(c.metadata->>'title', ''), d.title),
           'source', COALESCE(NULLIF(c.metadata->>'source', ''), d.source::text),
           'sourceId', COALESCE(NULLIF(c.metadata->>'sourceId', ''), d.source_id),
           'lawId', COALESCE(NULLIF(c.metadata->>'lawId', ''), d.source_id),
           'url', COALESCE(NULLIF(c.metadata->>'url', ''), d.url)
         ) AS metadata,
         LEAST(
           1::double precision,
           GREATEST(
             CASE
               WHEN c.metadata->>'chunkType' = 'subclause' THEN 0.92
               WHEN c.metadata->>'chunkType' = 'clause' THEN 0.88
               WHEN c.metadata->>'chunkType' = 'article' THEN 0.84
               ELSE 0.78
             END,
             CASE
               WHEN plainto_tsquery('simple', $1::text) @@ (
                 setweight(to_tsvector('simple', COALESCE(d.title, '')), 'A') ||
                 setweight(to_tsvector('simple', c.text), 'B')
               )
               THEN 0.72 + ts_rank(
                 setweight(to_tsvector('simple', COALESCE(d.title, '')), 'A') ||
                 setweight(to_tsvector('simple', c.text), 'B'),
                 plainto_tsquery('simple', $1::text)
               ) * 0.35
               ELSE 0.0
             END
             + CASE
                 WHEN $2::text <> '' AND (
                   LOWER(COALESCE(d.title, '')) LIKE '%' || $2::text || '%' OR
                   LOWER(c.text) LIKE '%' || $2::text || '%'
                 )
                 THEN 0.08
                 ELSE 0.0
               END
           )
         ) AS score
       FROM chunks c
       INNER JOIN documents d ON d.id = c.document_id
       WHERE d.source::text = 'legalinfo'
         AND d.source_id = ANY(string_to_array($3::text, ','))
         AND (
           $5::boolean = false
           OR (
             d.source_id = '299'
             AND (
               c.metadata->>'articleNo' LIKE '451%' OR
               c.metadata->>'articleNo' LIKE '452%' OR
               c.metadata->>'articleNo' LIKE '453%' OR
               (c.metadata->>'articleNo' LIKE '222%' AND (
                 c.text ILIKE '%хугацаа хэтр%' OR c.text ILIKE '%үүрэг%' OR c.text ILIKE '%төлбөр%'
               ))
             )
           )
         )
       ORDER BY score DESC, LENGTH(c.text) ASC, c.id ASC
       LIMIT $4`,
      [query, anchor, effectivePreferredLawIds.join(','), 18, bankLoanQuery],
    );

    if (rows.length === 0) {
      return results;
    }

    const safeRows = bankLoanQuery
      ? rows.filter((row) =>
          isBankLoanRelevantResult(query, {
            id: row.id,
            document: row.document || '',
            metadata: row.metadata || {},
            score: Number(row.score) || 0,
            rawScore: Number(row.score) || 0,
          }),
        )
      : rows;

    if (safeRows.length === 0) {
      return results;
    }

    const merged = new Map<string, ChromaQueryResult>();
    for (const result of results) {
      merged.set(result.id, result);
    }

    for (const row of safeRows) {
      const mapped: ChromaQueryResult = {
        id: row.id,
        document: row.document || '',
        metadata: row.metadata || {},
        score: Number(row.score) || 0,
        rawScore: Number(row.score) || 0,
      };

      const existing = merged.get(mapped.id);
      if (!existing || mapped.score > existing.score) {
        merged.set(mapped.id, mapped);
      }
    }

    return Array.from(merged.values()).sort((a, b) => b.score - a.score);
  } catch (error) {
    console.warn(
      {
        error: error instanceof Error ? error.message : String(error),
        preferredLawIds: effectivePreferredLawIds,
      },
      'Preferred-law fallback retrieval failed',
    );
    return results;
  }
}

function mergeFallbackRows(
  results: ChromaQueryResult[],
  rows: PreferredLawFallbackRow[],
): ChromaQueryResult[] {
  if (rows.length === 0) {
    return results;
  }

  const merged = new Map<string, ChromaQueryResult>();
  for (const result of results) {
    merged.set(result.id, result);
  }

  for (const row of rows) {
    const mapped: ChromaQueryResult = {
      id: row.id,
      document: row.document || '',
      metadata: row.metadata || {},
      score: Number(row.score) || 0,
      rawScore: Number(row.score) || 0,
    };

    const existing = merged.get(mapped.id);
    if (!existing || mapped.score > existing.score) {
      merged.set(mapped.id, mapped);
    }
  }

  return Array.from(merged.values()).sort((a, b) => b.score - a.score);
}

async function augmentWithTrafficIncidentFallback(
  query: string,
  results: ChromaQueryResult[],
): Promise<ChromaQueryResult[]> {
  if (!isTrafficIncidentQuestion(query)) {
    return results;
  }

  const relevantHits = results
    .slice(0, 12)
    .filter((result) => isTrafficIncidentRelevantResult(result));
  const hasCoreTrafficLaw = relevantHits.some((result) => {
    const lawId = getResultLawId(result);
    const articleNo = normalizeArticleNo(String(result.metadata.articleNo ?? ''));
    return (
      (lawId === '12695' && /^14\.?7/.test(articleNo)) ||
      lawId === '11224' ||
      (lawId === '299' && /^497/.test(articleNo))
    );
  });

  if (hasCoreTrafficLaw && relevantHits.length >= 3) {
    return results;
  }

  const includeInsurance = /даатгал|нөхөн\s*төлбөр|каско/i.test(normalizeText(query));

  try {
    const rows = await dbQuery<PreferredLawFallbackRow>(
      `SELECT
         c.id,
         SUBSTRING(c.text, 1, 2400) AS document,
         c.metadata || jsonb_build_object(
           'title', COALESCE(NULLIF(c.metadata->>'title', ''), d.title),
           'source', COALESCE(NULLIF(c.metadata->>'source', ''), d.source::text),
           'sourceId', COALESCE(NULLIF(c.metadata->>'sourceId', ''), d.source_id),
           'lawId', COALESCE(NULLIF(c.metadata->>'lawId', ''), d.source_id),
           'url', COALESCE(NULLIF(c.metadata->>'url', ''), d.url)
         ) AS metadata,
         CASE
           WHEN d.source_id = '12695' AND (
             c.metadata->>'articleNo' LIKE '14.7%' OR
             c.text ILIKE '%14.7%' OR
             c.text ILIKE '%замын хөдөлгөөний дүрэм%'
           ) THEN 0.93
           WHEN d.source_id = '11224' AND c.text ILIKE '%жолооч%' AND (
             c.text ILIKE '%үүрэг%' OR c.text ILIKE '%осол%' OR c.text ILIKE '%замын хөдөлгөөн%'
           ) THEN 0.88
           WHEN d.source_id = '299' AND (
             c.metadata->>'articleNo' LIKE '497%' OR
             c.text ILIKE '%гэм хор%' OR
             c.text ILIKE '%эд хөрөнгөд хохирол%' OR
             c.text ILIKE '%хохирол нөхөн%'
           ) THEN 0.84
           WHEN $1::boolean AND (
             d.title ILIKE '%ЖОЛООЧИЙН ДААТГАЛ%' OR d.title ILIKE '%ДААТГАЛЫН%'
           ) AND (
             c.text ILIKE '%нөхөн төлбөр%' OR c.text ILIKE '%даатгалын тохиолдол%'
           ) THEN 0.80
           ELSE 0.0
         END AS score
       FROM chunks c
       INNER JOIN documents d ON d.id = c.document_id
       WHERE d.source::text = 'legalinfo'
         AND (
           (d.source_id = '12695' AND (
             c.metadata->>'articleNo' LIKE '14.7%' OR
             c.text ILIKE '%14.7%' OR
             c.text ILIKE '%замын хөдөлгөөний дүрэм%'
           ))
           OR (d.source_id = '11224' AND c.text ILIKE '%жолооч%' AND (
             c.text ILIKE '%үүрэг%' OR c.text ILIKE '%осол%' OR c.text ILIKE '%замын хөдөлгөөн%'
           ))
           OR (d.source_id = '299' AND (
             c.metadata->>'articleNo' LIKE '497%' OR
             c.text ILIKE '%гэм хор%' OR
             c.text ILIKE '%эд хөрөнгөд хохирол%' OR
             c.text ILIKE '%хохирол нөхөн%'
           ))
           OR ($1::boolean AND (
             d.title ILIKE '%ЖОЛООЧИЙН ДААТГАЛ%' OR d.title ILIKE '%ДААТГАЛЫН%'
           ) AND (
             c.text ILIKE '%нөхөн төлбөр%' OR c.text ILIKE '%даатгалын тохиолдол%'
           ))
         )
       ORDER BY score DESC, LENGTH(c.text) ASC, c.id ASC
       LIMIT 16`,
      [includeInsurance],
    );

    const validRows = rows.filter((row) =>
      isTrafficIncidentRelevantResult({
        id: row.id,
        document: row.document || '',
        metadata: row.metadata || {},
        score: Number(row.score) || 0,
        rawScore: Number(row.score) || 0,
      }),
    );

    return mergeFallbackRows(results, validRows);
  } catch (error) {
    console.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'Traffic incident fallback retrieval failed',
    );
    return results;
  }
}

function applyFocusedFiltering(query: string, results: ChromaQueryResult[]): ChromaQueryResult[] {
  if (results.length === 0) {
    return results;
  }

  const stopTerms = new Set([
    'тухай',
    'хууль',
    'хуулийн',
    'хуульд',
    'журам',
    'дүрэм',
    'заалт',
    'зүйл',
    'дагуулж',
    'мөрдөх',
    'болон',
    'бол',
    'нь',
  ]);

  const signalTerms = Array.from(
    new Set(
      normalizeText(query)
        .split(' ')
        .map((term) => term.replace(/(ийн|ын|ийг|ыг|д|т|аар|ээр|оор|өөр)$/iu, ''))
        .filter((term) => term.length >= 4 && !stopTerms.has(term)),
    ),
  ).slice(0, 4);

  if (signalTerms.length === 0) {
    return results;
  }

  const focused = results.filter((result) => {
    const corpus =
      `${getMetaTitle(result.metadata)} ${result.document?.slice(0, 1400) ?? ''}`.toLowerCase();
    return signalTerms.some((term) => corpus.includes(term));
  });

  if (focused.length === 0) {
    return results;
  }

  const asksForRepeal = /хүчингүй|болсонд\s+тооцох|цуцлах\s+тухай\s+хууль/i.test(query);
  const nonRepeal = asksForRepeal
    ? focused
    : focused.filter(
        (result) => !/хүчингүй\s+болсонд\s+тооцох/i.test(getMetaTitle(result.metadata)),
      );

  const prioritized = nonRepeal.length > 0 ? nonRepeal : focused;
  return prioritized.sort((a, b) => b.score - a.score);
}

function applyTopicSignalFiltering(
  query: string,
  results: ChromaQueryResult[],
): ChromaQueryResult[] {
  if (results.length === 0) {
    return results;
  }

  const topicPatterns = getTopicSignalPatterns(query);
  if (topicPatterns.length === 0) {
    return results;
  }

  const filtered = results.filter((result) => {
    const corpus = normalizeText(
      `${getMetaTitle(result.metadata)} ${String(result.document ?? '').slice(0, 1800)}`,
    );
    return topicPatterns.some((pattern) => pattern.test(corpus));
  });

  if (filtered.length === 0) {
    return results;
  }

  return filtered.sort((a, b) => b.score - a.score);
}

function getTopicSignalPatterns(query: string): RegExp[] {
  if (isConsumerRefundQuery(query)) {
    return [
      /хэрэглэгч|хэрэглэгчийн\s+эрх/i,
      /бараа|бүтээгдэхүүн|үйлчилгээ|доголдол|чанаргүй|баталгаа/i,
      /буцаалт|буцаах|солих|мөнгө\s+буца|нөхөн\s*төлбөр/i,
      /иргэний\s+хууль|худалдах|худалдан\s+авах\s+гэрээ/i,
    ];
  }

  if (isLaborDismissalOrWageQuery(query)) {
    return [
      /хөдөлмөрийн\s+тухай|хөдөлмөр/i,
      /ажлаас|халах|халагд|цуцлах|дуусгавар|ажил\s+хүлээлцэх/i,
      /цалин|олговор|ажилгүй\s+байсан\s+хугацаа|ажил\s+олгогч/i,
      /маргаан|нэхэмжлэл|шүүх/i,
    ];
  }

  if (isTrafficInsuranceClaimQuery(query)) {
    return [
      /даатгал|даатгагч|даатгуулагч/i,
      /нөхөн\s*төлбөр|даатгалын\s+тохиолдол|татгалз|хохирол/i,
      /иргэний\s+хууль|даатгалын\s+тухай|жолоочийн\s+даатгал/i,
      /нотлох\s+баримт|нэхэмжлэл|шүүх|санхүүгийн\s+зохицуулах/i,
    ];
  }

  if (
    /согтуур|согтуу|жолоод|жолооны\s*эрх|тээврийн\s*хэрэгсэл|замын\s*хөдөлгөөн|осол|мөргө|мөргөлд|шүрг|шүргэ|зугт|ослын\s*газар|эсрэг\s*урсгал|зогсоол|паркинг|авто\s*даатгал|каско/i.test(
      query,
    )
  ) {
    return [
      /согтуур|согтуу/i,
      /жолоо|жолоод|жолооч|жолооны\s+эрх/i,
      /тээврийн\s+хэрэгсэл|замын\s+хөдөлгөөн|автотээвэр|авто\s*зам/i,
      /зөрчил|эрхийн\s+хасалт|торгууль|эрүүгийн\s+хууль/i,
      /осол|зам\s*тээврийн\s*осол|мөргө|мөргөлд|шүрг|шүргэ/i,
      /зугт|ослын\s+газар|эсрэг\s+урсгал|зогсоол|паркинг|авто\s*даатгал|каско/i,
    ];
  }

  if (/сонгуул|сонгогч|санал\s*өгөх|сонгох\s*эрх|18\s*нас|арван\s*найм/i.test(query)) {
    return [
      /сонгууль|сонгуулийн/i,
      /сонгогч|сонгох\s+эрх|санал\s+өгөх/i,
      /үндсэн\s+хууль|18\s*нас|арван\s*найм\s*нас/i,
    ];
  }

  if (/эд\s*хөрөнгө|үл\s*хөдлөх|өмч|өмчлөх|шилжүүл|худалдах|худалдан/i.test(query)) {
    return [
      /эд\s*хөрөнгө|үл\s*хөдлөх|өмч|өмчлөх|өмчлөл/i,
      /шилжүүл|худалдах|худалдан|зарах|гэрээ/i,
      /иргэний\s+хууль|улсын\s+бүртгэл|нотариат|барьца/i,
    ];
  }

  if (
    /гэр\s*бүл|эцэг\s*эх|хүүхэд|уулзуулах|уулзах|харилцах\s*эрх|асрамж|асран\s+хамгаалах|хамт\s+амьдрах/i.test(
      query,
    )
  ) {
    return [
      /гэр\s+бүл|гэрлэл|салалт/i,
      /эцэг\s*эх|хүүхэд|тэтгэлэг|асран\s+хамгаалах|асран\s+хүмүүжүүлэх/i,
      /уулз|уулзуулах|харилцах\s+эрх|асрамж|хамт\s+амьдрах|шүүхийн\s+шийдвэр/i,
    ];
  }

  return [];
}

function applyArticleBoost(query: string, results: ChromaQueryResult[]): ChromaQueryResult[] {
  if (results.length === 0) {
    return results;
  }

  const requestedArticle = extractRequestedArticleNumber(query);

  const boosted = results.map((result) => {
    const alignedArticleNo = extractQueryAlignedArticleNumber(
      query,
      result.document,
      String(result.metadata.articleNo ?? ''),
    );
    if (!alignedArticleNo) {
      return result;
    }

    if (requestedArticle && alignedArticleNo !== requestedArticle) {
      return result;
    }

    return {
      ...result,
      metadata: {
        ...result.metadata,
        articleNo: alignedArticleNo,
      },
      score: Math.min(1, result.score + ARTICLE_SCORE_BOOST),
    };
  });

  return boosted.sort((a, b) => b.score - a.score);
}

function applyRequestedArticleFilter(
  query: string,
  results: ChromaQueryResult[],
): ChromaQueryResult[] {
  const requestedArticle = extractRequestedArticleNumber(query);
  if (!requestedArticle || results.length === 0) {
    return results;
  }

  const filtered = results.filter((result) => {
    const aligned = extractQueryAlignedArticleNumber(
      query,
      result.document,
      String(result.metadata.articleNo ?? ''),
    );
    return aligned === requestedArticle;
  });

  if (filtered.length === 0) {
    return [];
  }

  return filtered.sort((a, b) => b.score - a.score);
}

async function augmentWithSignalKeywordFallback(
  query: string,
  intent: QueryIntent,
  results: ChromaQueryResult[],
): Promise<ChromaQueryResult[]> {
  const signalTerms = extractArticleBoostSignalTerms(query);
  if (signalTerms.length === 0) {
    return results;
  }

  const alreadyHasSignalMatch = results.some((result) => {
    const corpus = normalizeText(
      `${String(result.metadata.title ?? result.metadata.documentTitle ?? '')} ${result.document}`,
    );
    return signalTerms.some((term) => corpus.includes(term));
  });

  if (alreadyHasSignalMatch) {
    return results;
  }

  const fallbackQuery = buildSignalFallbackQuery(intent, signalTerms);
  let keywordResults = await keywordSearchService.search(fallbackQuery, 24, {
    source: 'legalinfo',
  });
  if (keywordResults.length === 0) {
    keywordResults = await keywordSearchService.searchMongolian(fallbackQuery, 24, {
      source: 'legalinfo',
    });
  }

  if (keywordResults.length === 0) {
    return results;
  }

  const merged = new Map<string, ChromaQueryResult>();
  for (const item of results) {
    merged.set(item.id, item);
  }

  for (const row of keywordResults) {
    const fallbackScore = Math.min(1, Math.max(row.score || 0, 0.52));
    const existing = merged.get(row.chunkId);
    if (!existing || fallbackScore > existing.score) {
      merged.set(row.chunkId, {
        id: row.chunkId,
        document: row.text,
        metadata: row.metadata || {},
        score: fallbackScore,
        rawScore: Math.min(1, Math.max(row.score || 0, 0)),
      });
    }
  }

  return Array.from(merged.values()).sort((a, b) => b.score - a.score);
}

async function augmentWithInsuranceClaimFallback(
  query: string,
  results: ChromaQueryResult[],
): Promise<ChromaQueryResult[]> {
  if (!isTrafficInsuranceClaimQuery(query)) {
    return results;
  }

  const relevantCount = results
    .slice(0, 12)
    .filter((result) => isInsuranceClaimRelevantResult(query, result)).length;

  if (relevantCount >= 3) {
    return results;
  }

  const fallbackQuery =
    'даатгалын тухай хууль нөхөн төлбөр татгалзсан үндэслэл иргэний хууль даатгалын гэрээ жолоочийн даатгал';
  let keywordResults = await keywordSearchService.search(fallbackQuery, 28, {
    source: 'legalinfo',
  });
  if (keywordResults.length === 0) {
    keywordResults = await keywordSearchService.searchMongolian(fallbackQuery, 28, {
      source: 'legalinfo',
    });
  }

  if (keywordResults.length === 0) {
    return results;
  }

  const merged = new Map<string, ChromaQueryResult>();
  for (const item of results) {
    merged.set(item.id, item);
  }

  for (const row of keywordResults) {
    const mapped = keywordResultToQueryResult(row, 0.56);
    if (!isInsuranceClaimRelevantResult(query, mapped)) {
      continue;
    }

    const boostedScore = Math.min(1, mapped.score + 0.12);
    const existing = merged.get(mapped.id);
    if (!existing || boostedScore > existing.score) {
      merged.set(mapped.id, {
        ...mapped,
        score: boostedScore,
      });
    }
  }

  return Array.from(merged.values()).sort((a, b) => b.score - a.score);
}

async function augmentWithConsumerRefundFallback(
  query: string,
  results: ChromaQueryResult[],
): Promise<ChromaQueryResult[]> {
  if (!isConsumerRefundQuery(query)) {
    return results;
  }

  const relevantCount = results
    .slice(0, 12)
    .filter((result) => isConsumerRefundRelevantResult(result)).length;

  if (relevantCount >= 3) {
    return results;
  }

  const fallbackQuery =
    'хэрэглэгчийн эрхийг хамгаалах тухай хууль доголдолтой бараа бүтээгдэхүүн буцаалт иргэний хууль худалдах худалдан авах гэрээ';
  let keywordResults = await keywordSearchService.search(fallbackQuery, 28, {
    source: 'legalinfo',
  });
  if (keywordResults.length === 0) {
    keywordResults = await keywordSearchService.searchMongolian(fallbackQuery, 28, {
      source: 'legalinfo',
    });
  }

  if (keywordResults.length === 0) {
    return results;
  }

  const merged = new Map<string, ChromaQueryResult>();
  for (const item of results) {
    merged.set(item.id, item);
  }

  for (const row of keywordResults) {
    const mapped = keywordResultToQueryResult(row, 0.56);
    if (!isConsumerRefundRelevantResult(mapped)) {
      continue;
    }

    const boostedScore = Math.min(1, mapped.score + 0.12);
    const existing = merged.get(mapped.id);
    if (!existing || boostedScore > existing.score) {
      merged.set(mapped.id, {
        ...mapped,
        score: boostedScore,
      });
    }
  }

  return Array.from(merged.values()).sort((a, b) => b.score - a.score);
}

async function augmentWithLaborDismissalFallback(
  query: string,
  results: ChromaQueryResult[],
): Promise<ChromaQueryResult[]> {
  if (!isLaborDismissalOrWageQuery(query)) {
    return results;
  }

  const relevantCount = results
    .slice(0, 12)
    .filter((result) => isLaborDismissalRelevantResult(result)).length;

  if (relevantCount >= 3) {
    return results;
  }

  const fallbackQuery =
    'хөдөлмөрийн тухай хууль ажлаас халах хөдөлмөр эрхлэлтийн харилцаа дуусгавар цалин хөлс ажилгүй байсан хугацаа маргаан';
  let keywordResults = await keywordSearchService.search(fallbackQuery, 28, {
    source: 'legalinfo',
  });
  if (keywordResults.length === 0) {
    keywordResults = await keywordSearchService.searchMongolian(fallbackQuery, 28, {
      source: 'legalinfo',
    });
  }

  if (keywordResults.length === 0) {
    return results;
  }

  const merged = new Map<string, ChromaQueryResult>();
  for (const item of results) {
    merged.set(item.id, item);
  }

  for (const row of keywordResults) {
    const mapped = keywordResultToQueryResult(row, 0.56);
    if (!isLaborDismissalRelevantResult(mapped)) {
      continue;
    }

    const boostedScore = Math.min(1, mapped.score + 0.12);
    const existing = merged.get(mapped.id);
    if (!existing || boostedScore > existing.score) {
      merged.set(mapped.id, {
        ...mapped,
        score: boostedScore,
      });
    }
  }

  return Array.from(merged.values()).sort((a, b) => b.score - a.score);
}

async function augmentWithPublicNoiseFallback(
  query: string,
  results: ChromaQueryResult[],
): Promise<ChromaQueryResult[]> {
  if (!isPublicNoiseComplaintQuery(query)) {
    return results;
  }

  const relevantCount = results
    .slice(0, 12)
    .filter((result) => isPublicNoiseRelevantResult(result)).length;

  if (relevantCount >= 3) {
    return results;
  }

  const fallbackQuery =
    'зөрчлийн тухай хууль амгалан тайван байдал алдагдуулах дуу чимээ цагдаагийн албаны тухай гомдол мэдээлэл';
  let keywordResults = await keywordSearchService.search(fallbackQuery, 24, {
    source: 'legalinfo',
  });
  if (keywordResults.length === 0) {
    keywordResults = await keywordSearchService.searchMongolian(fallbackQuery, 24, {
      source: 'legalinfo',
    });
  }

  if (keywordResults.length === 0) {
    return results;
  }

  const merged = new Map<string, ChromaQueryResult>();
  for (const item of results) {
    merged.set(item.id, item);
  }

  for (const row of keywordResults) {
    const mapped = keywordResultToQueryResult(row, 0.54);
    if (!isPublicNoiseRelevantResult(mapped)) {
      continue;
    }

    const boostedScore = Math.min(1, mapped.score + 0.1);
    const existing = merged.get(mapped.id);
    if (!existing || boostedScore > existing.score) {
      merged.set(mapped.id, {
        ...mapped,
        score: boostedScore,
      });
    }
  }

  return Array.from(merged.values()).sort((a, b) => b.score - a.score);
}

async function augmentWithCyberFraudFallback(
  query: string,
  results: ChromaQueryResult[],
): Promise<ChromaQueryResult[]> {
  if (!isCyberFraudQuery(query)) {
    return results;
  }

  const relevantCount = results
    .slice(0, 12)
    .filter((result) => isCyberFraudRelevantResult(result)).length;

  if (relevantCount >= 3) {
    return results;
  }

  const fallbackQuery =
    'эрүүгийн хууль залилах цахим залилан хууран мэхлэх данс мөнгө шилжүүлэг нотлох баримт цагдаагийн албаны тухай гомдол мэдээлэл';
  let keywordResults = await keywordSearchService.search(fallbackQuery, 24, {
    source: 'legalinfo',
  });
  if (keywordResults.length === 0) {
    keywordResults = await keywordSearchService.searchMongolian(fallbackQuery, 24, {
      source: 'legalinfo',
    });
  }

  if (keywordResults.length === 0) {
    return results;
  }

  const merged = new Map<string, ChromaQueryResult>();
  for (const item of results) {
    merged.set(item.id, item);
  }

  for (const row of keywordResults) {
    const mapped = keywordResultToQueryResult(row, 0.54);
    if (!isCyberFraudRelevantResult(mapped)) {
      continue;
    }

    const boostedScore = Math.min(1, mapped.score + getCyberFraudBoost(mapped));
    const existing = merged.get(mapped.id);
    if (!existing || boostedScore > existing.score) {
      merged.set(mapped.id, {
        ...mapped,
        score: boostedScore,
      });
    }
  }

  return Array.from(merged.values()).sort((a, b) => b.score - a.score);
}

function applyCyberFraudFiltering(
  query: string,
  results: ChromaQueryResult[],
): ChromaQueryResult[] {
  if (!isCyberFraudQuery(query) || results.length === 0) {
    return results;
  }

  const filtered = results
    .filter((result) => isCyberFraudRelevantResult(result))
    .map((result) => ({
      ...result,
      score: Math.min(1, result.score + getCyberFraudBoost(result)),
    }))
    .sort((a, b) => b.score - a.score);

  return filtered;
}

function isCyberFraudRelevantResult(result: ChromaQueryResult): boolean {
  const title = normalizeText(getMetaTitle(result.metadata));
  const articleTitle = normalizeText(
    String(result.metadata.articleTitle ?? result.metadata.sectionTitle ?? ''),
  );
  const corpus = normalizeText(
    `${title} ${articleTitle} ${String(result.document ?? '').slice(0, 1800)}`,
  );
  const lawId = getResultLawId(result);
  const articleNo = normalizeArticleNumber(String(result.metadata.articleNo ?? ''));

  if (CYBER_FRAUD_BAD_PROCESS_PATTERN.test(corpus)) {
    return false;
  }

  const allowedTitle = CYBER_FRAUD_ALLOWED_TITLE_PATTERNS.some((pattern) => pattern.test(title));
  const signalMatches = CYBER_FRAUD_SIGNAL_PATTERNS.filter((pattern) => pattern.test(corpus)).length;

  if (lawId === '12172' || /эрүүгийн\s+хууль/i.test(title)) {
    return (
      /17\.?3|148|залилах|залилан|хууран\s*мэхл|бусдын\s+эд\s+хөрөнгийг\s+залилан/i.test(
        corpus,
      ) || signalMatches >= 2
    );
  }

  if (lawId === '12694' || /эрүүгийн\s+хэрэг\s+хянан\s+шийдвэрлэх/i.test(title)) {
    return (
      /(нотлох\s+баримт|гомдол|мэдээлэл|хохирогч|мөрдөн\s+шалгах|эд\s+мөрийн\s+баримт|хураан\s+авах)/i.test(
        corpus,
      ) && !CYBER_FRAUD_BAD_PROCESS_PATTERN.test(articleTitle)
    );
  }

  if (lawId === '12469' || /цагдаагийн\s+албаны\s+тухай/i.test(title)) {
    return /(гомдол|мэдээлэл|гэмт\s+хэрэг|дуудлага|шалгах|мөрдөн)/i.test(corpus);
  }

  if (lawId === '523' || /харилцаа\s+холбооны\s+тухай/i.test(title)) {
    return /(сүлжээ|харилцаа\s+холбоо|байршил|мэдээлэл|хэрэглэгч|цахим)/i.test(corpus);
  }

  if (allowedTitle && signalMatches >= 2) {
    return true;
  }

  return signalMatches >= 3 && Boolean(articleNo);
}

function getCyberFraudBoost(result: ChromaQueryResult): number {
  const title = normalizeText(getMetaTitle(result.metadata));
  const corpus = normalizeText(`${title} ${String(result.document ?? '').slice(0, 1200)}`);

  if (/эрүүгийн\s+хууль/i.test(title) && /(17\.?3|148|залилан|залилах)/i.test(corpus)) {
    return 0.22;
  }

  if (/цагдаагийн\s+албаны\s+тухай/i.test(title)) {
    return 0.12;
  }

  if (/эрүүгийн\s+хэрэг\s+хянан\s+шийдвэрлэх/i.test(title) && /нотлох\s+баримт|гомдол/i.test(corpus)) {
    return 0.1;
  }

  return 0.06;
}

function buildSignalFallbackQuery(intent: QueryIntent, signalTerms: string[]): string {
  const core = signalTerms.slice(0, 3).join(' ');
  switch (intent) {
    case 'crime':
      return `${core} эрүүгийн хууль`;
    case 'traffic':
      return `${core} замын хөдөлгөөний аюулгүй байдлын тухай хууль зөрчлийн тухай хууль`;
    case 'election':
      return `${core} сонгуулийн тухай хууль үндсэн хууль сонгогчийн эрх`;
    case 'contract':
      return `${core} иргэний хууль гэрээ`;
    case 'tax':
      return `${core} татварын тухай хууль`;
    case 'socialInsurance':
      return `${core} нийгмийн даатгалын тухай хууль`;
    case 'labor':
      return `${core} хөдөлмөрийн тухай хууль`;
    case 'family':
      return `${core} гэр бүлийн тухай хууль хүүхдийн эрхийн тухай хууль эцэг эх хүүхэдтэй харилцах эрх`;
    default:
      return core;
  }
}

function extractArticleBoostSignalTerms(query: string): string[] {
  const stopTerms = new Set([
    'тухай',
    'хууль',
    'хуулийн',
    'хуульд',
    'зүйл',
    'заалт',
    'бол',
    'вэ',
    'яах',
    'яавал',
    'эрүүгийн',
    'иргэний',
    'татвар',
    'нийгмийн',
    'даатгал',
    'хөдөлмөр',
    'гэрээ',
    'гэр',
    'бүл',
    'эх',
    'аль',
    'нэг',
    'байвал',
    'гэмт',
    'хэрэг',
  ]);

  return Array.from(
    new Set(
      normalizeText(query)
        .split(' ')
        .map((term) => term.replace(/(ийн|ын|ийг|ыг|аа|ээ|оо|өө|аас|ээс|д|т)$/iu, ''))
        .filter((term) => term.length >= 3 && !stopTerms.has(term)),
    ),
  ).slice(0, 6);
}

function extractRequestedArticleNumber(query: string): string {
  const match = query.match(
    /(?:([0-9]+(?:\.[0-9]+)*)\s*(?:дугаар|дүгээр)\s*(?:зүйл|заалт|хэсэг)|(?:зүйл|заалт)\s*([0-9]+(?:\.[0-9]+)*))/iu,
  );
  const raw = match?.[1] ?? match?.[2] ?? '';
  return normalizeArticleNumber(raw);
}

function applyDomainFiltering(
  intent: QueryIntent,
  results: ChromaQueryResult[],
): ChromaQueryResult[] {
  if (results.length === 0 || intent === 'unknown') {
    return results;
  }

  const filtered = results.filter((result) => {
    const title = getMetaTitle(result.metadata);
    const corpus = normalizeText(`${title} ${result.document?.slice(0, 1800) ?? ''}`);
    if (isInternationalOrUnrelatedTreaty(corpus)) {
      return false;
    }

    const domain = inferDomainFromCorpus(corpus);
    if (domain !== intent) {
      return false;
    }

    const strictTitlePatterns = STRICT_DOMAIN_TITLE_PATTERNS[intent];
    const strictTitleMatch = strictTitlePatterns.some((pattern) => pattern.test(title));

    if (intent === 'contract') {
      return strictTitleMatch || countRegexMatches(corpus, CONTRACT_STRICT_SIGNAL_PATTERNS) >= 2;
    }

    if (intent === 'traffic') {
      return strictTitleMatch || countRegexMatches(corpus, TRAFFIC_STRICT_SIGNAL_PATTERNS) >= 2;
    }

    if (intent === 'election') {
      return strictTitleMatch || countRegexMatches(corpus, ELECTION_STRICT_SIGNAL_PATTERNS) >= 2;
    }

    if (intent === 'family') {
      return strictTitleMatch || countRegexMatches(corpus, FAMILY_STRICT_SIGNAL_PATTERNS) >= 2;
    }

    return true;
  });

  console.debug(
    {
      intent,
      before: results.length,
      after: filtered.length,
    },
    'Domain filtering complete',
  );

  if (filtered.length === 0) {
    return results;
  }

  return filtered.sort((a, b) => b.score - a.score);
}

function applyCanonicalLawFiltering(
  intent: QueryIntent,
  results: ChromaQueryResult[],
): ChromaQueryResult[] {
  if (intent === 'unknown' || results.length === 0) {
    return results;
  }

  const patterns = CANONICAL_LAW_TITLE_PATTERNS[intent];
  if (!patterns || patterns.length === 0) {
    return results;
  }

  const filtered = results.filter((result) => {
    const title = getMetaTitle(result.metadata);
    return patterns.some((pattern) => pattern.test(title));
  });

  if (filtered.length === 0) {
    return results;
  }

  return filtered.sort((a, b) => b.score - a.score);
}

function countRegexMatches(text: string, patterns: RegExp[]): number {
  let count = 0;
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      count += 1;
    }
  }

  return count;
}

const BANK_LOAN_QUERY_PATTERN =
  /(?:банк|банкны|банкнаас).{0,50}зээл|зээл.{0,50}(?:банк|банкны|банкнаас)|зээлийн\s+гэрээ/i;
const BANK_LOAN_OVERDUE_PATTERN =
  /(?:төлөөгүй|төлсөнгүй|төлж\s+чадаагүй|барагдуулаагүй|хугацаа\s+хэтэр|хоцор|алданги|нэмэгдүүлсэн\s+хүү|торгууль|3\s*сар|2-?3\s*сар|өр)/i;
const BANK_LOAN_APPLICATION_PATTERN =
  /(?:авах|авахдаа|олгуулах|анхаарах|шалгах|гэрээ\s+байгуулах|нөхцөл|хүү|шимтгэл)/i;
const BANK_LOAN_COLLATERAL_PATTERN = /(?:барьцаа|ипотек|үл\s+хөдлөх|хөдлөх\s+эд\s+хөрөнгө|батлан\s+даагч)/i;
const BANK_LOAN_CREDIT_INFO_PATTERN =
  /(?:зээлийн\s+мэдээлэл|хар\s+жагсаалт|сөрөг\s+түүх|зээлийн\s+түүх|лавлагаа|мэдээллийн\s+сан)/i;

const BANK_LOAN_ALLOWED_TITLE_PATTERNS: RegExp[] = [
  /иргэний\s+хууль/i,
  /банк\s+эрх\s+бүхий.*зээлийн\s+үйл\s+ажиллагаа/i,
  /банкны\s+тухай/i,
  /зээлийн\s+мэдээллийн\s+тухай/i,
  /үл\s+хөдлөх.*барьцаа/i,
  /хөдлөх.*барьцаа/i,
  /барьцааны\s+тухай/i,
];

const BANK_LOAN_CORE_TEXT_PATTERNS: RegExp[] = [
  /банк|банкны|банкнаас/i,
  /зээл|зээлийн\s+гэрээ|зээлийн\s+үйл\s+ажиллагаа/i,
  /зээлийн\s+хүү|нэмэгдүүлсэн\s+хүү|хугацаа\s+хэтр/i,
  /үүрэг|төлбөр|үлдэгдэл|барагдуулах/i,
  /барьцаа|батлан\s+даалт|батлан\s+даагч/i,
  /зээлийн\s+мэдээлэл|зээлийн\s+түүх/i,
];

const BANK_LOAN_EXCLUDED_TITLE_PATTERNS: RegExp[] = [
  /даатгалын\s+тухай/i,
  /жолоочийн\s+даатгал/i,
  /хадгаламжийн\s+даатгал/i,
  /малын\s+индексжүүлсэн\s+даатгал/i,
  /хөрөнгө\s+оруулалтын\s+төрөлжсөн\s+банк/i,
  /дагаж\s+мөрдөх|хүчингүй\s+болсон|хүчингүйд\s+тооцох/i,
  /франчайз/i,
  /өв|гэр\s+бүлийн|сонгуулийн|татвар|хөдөлмөр|эрүүгийн|зөрчлийн/i,
];

const BANK_LOAN_NOISY_TEXT_PATTERN =
  /(?:хамаарахгүй|нэгэн\s+адил\s+хамаарна|д\s+заасан\s+журмаар\s+тоолно|өв\s+нээгдэнэ|франчайзийн\s+гэрээ)/i;

function resolveContractSubtype(query: string): ContractSubtype {
  const normalized = normalizeText(query);

  if (!BANK_LOAN_QUERY_PATTERN.test(normalized)) {
    return 'generic_contract';
  }

  if (BANK_LOAN_CREDIT_INFO_PATTERN.test(normalized)) {
    return 'credit_information';
  }

  if (BANK_LOAN_COLLATERAL_PATTERN.test(normalized)) {
    return 'bank_loan_collateral';
  }

  if (BANK_LOAN_OVERDUE_PATTERN.test(normalized)) {
    return 'bank_loan_overdue';
  }

  if (BANK_LOAN_APPLICATION_PATTERN.test(normalized)) {
    return 'bank_loan_application';
  }

  return 'bank_loan_overdue';
}

function isBankLoanQuery(query: string): boolean {
  return resolveContractSubtype(query) !== 'generic_contract';
}

function hasBankLoanCoreLaw(result: ChromaQueryResult): boolean {
  const title = normalizeText(getMetaTitle(result.metadata));
  const lawId = getResultLawId(result);
  const articleNo = normalizeArticleNo(String(result.metadata.articleNo ?? ''));

  return (
    (lawId === '299' && /^(451|452|453)(?:\.|$)?/.test(articleNo)) ||
    (/иргэний\s+хууль/i.test(title) && /^(451|452|453)(?:\.|$)?/.test(articleNo)) ||
    /банк\s+эрх\s+бүхий.*зээлийн\s+үйл\s+ажиллагаа/i.test(title)
  );
}

function isBankLoanRelevantResult(query: string, result: ChromaQueryResult): boolean {
  const subtype = resolveContractSubtype(query);
  if (subtype === 'generic_contract') {
    return true;
  }

  const title = normalizeText(getMetaTitle(result.metadata));
  const articleTitle = normalizeText(
    String(result.metadata.articleTitle ?? result.metadata.sectionTitle ?? ''),
  );
  const lawId = getResultLawId(result);
  const articleNo = normalizeArticleNo(String(result.metadata.articleNo ?? ''));
  const corpus = normalizeText(
    `${title} ${articleTitle} ${articleNo} ${String(result.document ?? '').slice(0, 2200)}`,
  );

  if (BANK_LOAN_EXCLUDED_TITLE_PATTERNS.some((pattern) => pattern.test(title))) {
    return false;
  }

  if (BANK_LOAN_NOISY_TEXT_PATTERN.test(corpus)) {
    return false;
  }

  if (!BANK_LOAN_ALLOWED_TITLE_PATTERNS.some((pattern) => pattern.test(title))) {
    return false;
  }

  if (lawId === '299' || /иргэний\s+хууль/i.test(title)) {
    if (/^(451|452|453)(?:\.|$)?/.test(articleNo)) {
      return true;
    }

    if (/^(222|225)(?:\.|$)?/.test(articleNo)) {
      return /(зээл|банк|үүрэг|хугацаа\s+хэтр|төлбөр|нэмэгдүүлсэн\s+хүү)/i.test(corpus);
    }

    return false;
  }

  if (/банк\s+эрх\s+бүхий.*зээлийн\s+үйл\s+ажиллагаа/i.test(title)) {
    return /(зээлийн\s+гэрээ|зээлийн\s+хүү|зээлийн\s+хувийн\s+хэрэг|зээлийн\s+үйл\s+ажиллагаа|зээл\s+олгох|хугацаа\s+хэтр)/i.test(
      corpus,
    );
  }

  if (/банкны\s+тухай/i.test(title)) {
    return (
      subtype === 'bank_loan_application' &&
      /(банк(?:ны)?\s+эрхлэх\s+үйл\s+ажиллагаа|зээл\s+олгох|зээлийн\s+үйл\s+ажиллагаа)/i.test(
        corpus,
      )
    );
  }

  if (/зээлийн\s+мэдээллийн\s+тухай/i.test(title)) {
    return subtype === 'credit_information' || BANK_LOAN_CREDIT_INFO_PATTERN.test(corpus);
  }

  if (/барьцаа/i.test(title)) {
    return subtype === 'bank_loan_collateral' || BANK_LOAN_COLLATERAL_PATTERN.test(corpus);
  }

  return countRegexMatches(corpus, BANK_LOAN_CORE_TEXT_PATTERNS) >= 3;
}

function getBankLoanBoost(query: string, result: ChromaQueryResult): number {
  if (!isBankLoanQuery(query)) {
    return 0;
  }

  const title = normalizeText(getMetaTitle(result.metadata));
  const articleNo = normalizeArticleNo(String(result.metadata.articleNo ?? ''));
  const corpus = normalizeText(`${title} ${String(result.document ?? '').slice(0, 1600)}`);

  if (/иргэний\s+хууль/i.test(title) && /^452(?:\.|$)?/.test(articleNo)) {
    return 0.26;
  }

  if (/иргэний\s+хууль/i.test(title) && /^451(?:\.|$)?/.test(articleNo)) {
    return 0.24;
  }

  if (/иргэний\s+хууль/i.test(title) && /^453(?:\.|$)?/.test(articleNo)) {
    return 0.2;
  }

  if (/банк\s+эрх\s+бүхий.*зээлийн\s+үйл\s+ажиллагаа/i.test(title)) {
    return 0.2;
  }

  if (/зээлийн\s+мэдээллийн\s+тухай|барьцаа/i.test(title)) {
    return 0.12;
  }

  if (/(зээлийн\s+гэрээ|зээлийн\s+хүү|нэмэгдүүлсэн\s+хүү|хугацаа\s+хэтр)/i.test(corpus)) {
    return 0.08;
  }

  return 0.04;
}

function applyBankLoanFiltering(
  query: string,
  results: ChromaQueryResult[],
): ChromaQueryResult[] {
  if (!isBankLoanQuery(query) || results.length === 0) {
    return results;
  }

  const filtered = results
    .filter((result) => isBankLoanRelevantResult(query, result))
    .map((result) => ({
      ...result,
      score: Math.min(1, result.score + getBankLoanBoost(query, result)),
    }))
    .sort((a, b) => b.score - a.score);

  return filtered;
}

async function augmentWithBankLoanFallback(
  query: string,
  results: ChromaQueryResult[],
): Promise<ChromaQueryResult[]> {
  const subtype = resolveContractSubtype(query);
  if (subtype === 'generic_contract') {
    return results;
  }

  const relevantHits = results
    .slice(0, 12)
    .filter((result) => isBankLoanRelevantResult(query, result));

  if (relevantHits.length >= 3 && relevantHits.some((result) => hasBankLoanCoreLaw(result))) {
    return results;
  }

  const includeCollateral = subtype === 'bank_loan_collateral';
  const includeCreditInfo = subtype === 'credit_information';
  const includeApplication = subtype === 'bank_loan_application';

  try {
    const rows = await dbQuery<PreferredLawFallbackRow>(
      `SELECT
         c.id,
         SUBSTRING(c.text, 1, 2400) AS document,
         c.metadata || jsonb_build_object(
           'title', COALESCE(NULLIF(c.metadata->>'title', ''), d.title),
           'documentTitle', COALESCE(NULLIF(c.metadata->>'documentTitle', ''), d.title),
           'source', COALESCE(NULLIF(c.metadata->>'source', ''), d.source::text),
           'sourceId', COALESCE(NULLIF(c.metadata->>'sourceId', ''), d.source_id),
           'lawId', COALESCE(NULLIF(c.metadata->>'lawId', ''), d.source_id),
           'url', COALESCE(NULLIF(c.metadata->>'url', ''), NULLIF(c.metadata->>'documentUrl', ''), d.url),
           'documentUrl', COALESCE(NULLIF(c.metadata->>'documentUrl', ''), d.url)
         ) AS metadata,
         CASE
           WHEN d.source_id = '299' AND c.metadata->>'articleNo' LIKE '452%' THEN 0.96
           WHEN d.source_id = '299' AND c.metadata->>'articleNo' LIKE '451%' THEN 0.94
           WHEN d.source_id = '299' AND c.metadata->>'articleNo' LIKE '453%' THEN 0.88
           WHEN d.source_id = '299' AND c.metadata->>'articleNo' LIKE '222%' THEN 0.76
           WHEN d.source_id = '16230554816671' AND (
             c.text ILIKE '%зээлийн гэрээ%' OR
             c.text ILIKE '%зээлийн хүү%' OR
             c.text ILIKE '%зээлийн хувийн хэрэг%' OR
             c.text ILIKE '%зээлийн үйл ажиллагаа%'
           ) THEN 0.9
           WHEN $1::boolean AND d.title ILIKE '%БАРЬЦАА%' THEN 0.78
           WHEN $2::boolean AND d.title ILIKE '%ЗЭЭЛИЙН МЭДЭЭЛЛИЙН%' THEN 0.78
           WHEN $3::boolean AND d.title ILIKE '%БАНКНЫ ТУХАЙ%' AND c.text ILIKE '%зээл%' THEN 0.7
           ELSE 0.0
         END AS score
       FROM chunks c
       INNER JOIN documents d ON d.id = c.document_id
       WHERE d.source::text = 'legalinfo'
         AND (
           (d.source_id = '299' AND (
             c.metadata->>'articleNo' LIKE '451%' OR
             c.metadata->>'articleNo' LIKE '452%' OR
             c.metadata->>'articleNo' LIKE '453%' OR
             (c.metadata->>'articleNo' LIKE '222%' AND (
               c.text ILIKE '%хугацаа хэтр%' OR c.text ILIKE '%үүрэг%' OR c.text ILIKE '%төлбөр%'
             ))
           ))
           OR (d.source_id = '16230554816671' AND (
             c.text ILIKE '%зээлийн гэрээ%' OR
             c.text ILIKE '%зээлийн хүү%' OR
             c.text ILIKE '%зээлийн хувийн хэрэг%' OR
             c.text ILIKE '%зээлийн үйл ажиллагаа%'
           ))
           OR ($1::boolean AND d.title ILIKE '%БАРЬЦАА%' AND (
             c.text ILIKE '%барьцаа%' OR c.text ILIKE '%барьцааны эрх%'
           ))
           OR ($2::boolean AND d.title ILIKE '%ЗЭЭЛИЙН МЭДЭЭЛЛИЙН%' AND (
             c.text ILIKE '%зээлийн мэдээлэл%' OR c.text ILIKE '%зээлийн түүх%'
           ))
           OR ($3::boolean AND d.title ILIKE '%БАНКНЫ ТУХАЙ%' AND c.text ILIKE '%зээл%')
         )
       ORDER BY score DESC, LENGTH(c.text) ASC, c.id ASC
       LIMIT 18`,
      [includeCollateral, includeCreditInfo, includeApplication],
    );

    const validRows = rows.filter((row) =>
      isBankLoanRelevantResult(query, {
        id: row.id,
        document: row.document || '',
        metadata: row.metadata || {},
        score: Number(row.score) || 0,
        rawScore: Number(row.score) || 0,
      }),
    );

    return mergeFallbackRows(results, validRows);
  } catch (error) {
    console.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'Bank loan fallback retrieval failed',
    );
    return results;
  }
}

const INSURANCE_CLAIM_LAW_TITLE_PATTERNS: RegExp[] = [
  /даатгалын\s+тухай/i,
  /жолоочийн\s+даатгалын\s+тухай/i,
  /иргэний\s+хууль/i,
  /иргэний\s+хэрэг\s+шүүхэд\s+хянан\s+шийдвэрлэх/i,
];

const INSURANCE_CLAIM_TEXT_PATTERNS: RegExp[] = [
  /даатгал|даатгагч|даатгуулагч/i,
  /нөхөн\s*төлбөр|даатгалын\s+тохиолдол|татгалз|хохирол/i,
  /гэрээ|үүрэг|нэхэмжлэл|шүүх/i,
];

const INSURANCE_CLAIM_EXCLUDED_TITLE_PATTERNS: RegExp[] = [
  /малын\s+индексжүүлсэн\s+даатгал/i,
  /хадгаламжийн\s+даатгал/i,
  /нийгмийн\s+даатгал/i,
  /эрүүгийн\s+хууль/i,
  /зөрчлийн\s+тухай/i,
  /цэргийн|сонгуулийн|татвар|хөдөлмөр|гэр\s+бүлийн/i,
];

function hasTrafficCriminalEscalation(query: string): boolean {
  return /согтуу|согтуур|мансуур|зугт|орхиод\s+яв|гэмтэл|бэртэл|амь\s*нас|нас\s*бар|эрүүгийн|ял|торгууль|эрхийн\s+хас/i.test(
    normalizeText(query),
  );
}

function isInsuranceClaimRelevantResult(query: string, result: ChromaQueryResult): boolean {
  const title = getMetaTitle(result.metadata);
  const corpus = normalizeText(`${title} ${result.document?.slice(0, 1800) ?? ''}`);
  const allowCriminal = hasTrafficCriminalEscalation(query);

  if (!allowCriminal && INSURANCE_CLAIM_EXCLUDED_TITLE_PATTERNS.some((pattern) => pattern.test(title))) {
    return false;
  }

  const titleRelevant = INSURANCE_CLAIM_LAW_TITLE_PATTERNS.some((pattern) => pattern.test(title));
  const textSignalCount = countRegexMatches(corpus, INSURANCE_CLAIM_TEXT_PATTERNS);

  if (/иргэний\s+хууль/i.test(title)) {
    return textSignalCount >= 1 || /431|497|510|511/i.test(String(result.metadata.articleNo ?? ''));
  }

  if (/иргэний\s+хэрэг\s+шүүхэд\s+хянан\s+шийдвэрлэх/i.test(title)) {
    return /нэхэмжлэл|нотлох\s+баримт|шүүх/i.test(corpus);
  }

  return titleRelevant || textSignalCount >= 2;
}

function applyInsuranceClaimFiltering(
  query: string,
  results: ChromaQueryResult[],
): ChromaQueryResult[] {
  if (!isTrafficInsuranceClaimQuery(query) || results.length === 0) {
    return results;
  }

  const filtered = results.filter((result) => isInsuranceClaimRelevantResult(query, result));

  if (filtered.length === 0) {
    return [];
  }

  return filtered.sort((a, b) => b.score - a.score);
}

const CONSUMER_REFUND_TITLE_PATTERNS: RegExp[] = [
  /хэрэглэгчийн\s+эрхийг\s+хамгаалах/i,
  /иргэний\s+хууль/i,
];

const CONSUMER_REFUND_TEXT_PATTERNS: RegExp[] = [
  /хэрэглэгч|худалдан\s+авагч|худалдагч/i,
  /бараа|бүтээгдэхүүн|үйлчилгээ|доголдол|чанаргүй|баталгаа/i,
  /буцаалт|буцаах|солих|үнийг\s+бууруулах|мөнгө\s+буца|нөхөн\s*төлбөр/i,
  /худалдах|худалдан\s+авах\s+гэрээ/i,
];

const CONSUMER_REFUND_EXCLUDED_TITLE_PATTERNS: RegExp[] = [
  /эрүүгийн\s+хууль/i,
  /даатгал/i,
  /банк|зээл|хадгаламж/i,
  /хөдөлмөр|гэр\s+бүлийн|татвар|сонгуулийн/i,
];

function isConsumerRefundRelevantResult(result: ChromaQueryResult): boolean {
  const title = getMetaTitle(result.metadata);
  if (CONSUMER_REFUND_EXCLUDED_TITLE_PATTERNS.some((pattern) => pattern.test(title))) {
    return false;
  }

  const corpus = normalizeText(`${title} ${result.document?.slice(0, 1800) ?? ''}`);
  const titleRelevant = CONSUMER_REFUND_TITLE_PATTERNS.some((pattern) => pattern.test(title));
  const textSignalCount = countRegexMatches(corpus, CONSUMER_REFUND_TEXT_PATTERNS);

  return titleRelevant || textSignalCount >= 2;
}

function applyConsumerRefundFiltering(
  query: string,
  results: ChromaQueryResult[],
): ChromaQueryResult[] {
  if (!isConsumerRefundQuery(query) || results.length === 0) {
    return results;
  }

  const filtered = results.filter((result) => isConsumerRefundRelevantResult(result));

  if (filtered.length === 0) {
    return [];
  }

  return filtered.sort((a, b) => b.score - a.score);
}

const LABOR_DISMISSAL_TITLE_PATTERNS: RegExp[] = [
  /хөдөлмөрийн\s+тухай/i,
  /хөдөлмөр/i,
];

const LABOR_DISMISSAL_TEXT_PATTERNS: RegExp[] = [
  /ажлаас|халах|халагд|цуцлах|дуусгавар|ажил\s+хүлээлцэх/i,
  /цалин|олговор|ажилгүй\s+байсан\s+хугацаа|ажил\s+олгогч|ажилтан/i,
  /хөдөлмөрийн\s+маргаан|нэхэмжлэл|шүүх/i,
];

const LABOR_DISMISSAL_EXCLUDED_TEXT_PATTERNS: RegExp[] = [
  /ажил\s+үүрэг\s+гүйцэтгэхийг\s+түдгэлзүүлэх/i,
  /хамтын\s+хэлэлцээр/i,
  /дарамт|бэлгийн\s+дарамт/i,
];

function isLaborDismissalRelevantResult(result: ChromaQueryResult): boolean {
  const title = getMetaTitle(result.metadata);
  const corpus = normalizeText(`${title} ${result.document?.slice(0, 1800) ?? ''}`);

  if (!LABOR_DISMISSAL_TITLE_PATTERNS.some((pattern) => pattern.test(title))) {
    return false;
  }

  if (LABOR_DISMISSAL_EXCLUDED_TEXT_PATTERNS.some((pattern) => pattern.test(corpus))) {
    const articleNo = String(result.metadata.articleNo ?? '');
    if (!/78|79|80|82|83|110|111|112|123|124|125|126|127|128/i.test(articleNo)) {
      return false;
    }
  }

  const textSignalCount = countRegexMatches(corpus, LABOR_DISMISSAL_TEXT_PATTERNS);
  const articleNo = String(result.metadata.articleNo ?? '');
  return textSignalCount >= 1 || /78|79|80|82|83|110|111|112|123|124|125|126|127|128/i.test(articleNo);
}

function applyLaborDismissalFiltering(
  query: string,
  results: ChromaQueryResult[],
): ChromaQueryResult[] {
  if (!isLaborDismissalOrWageQuery(query) || results.length === 0) {
    return results;
  }

  const filtered = results.filter((result) => isLaborDismissalRelevantResult(result));

  if (filtered.length === 0) {
    return [];
  }

  return filtered.sort((a, b) => b.score - a.score);
}

const PUBLIC_NOISE_TITLE_PATTERNS: RegExp[] = [
  /зөрчлийн\s+тухай/i,
  /цагдаагийн\s+албаны\s+тухай/i,
  /сууц\s+өмчлөгч/i,
];

const PUBLIC_NOISE_TEXT_PATTERNS: RegExp[] = [
  /амгалан\s+тайван|нийтийн\s+хэв\s+журам/i,
  /дуу\s*чимээ|шуугиан|шөнө|оршин\s+суугч|хөрш/i,
  /цагдаа|дуудлага|гомдол|мэдээлэл/i,
];

const PUBLIC_NOISE_EXCLUDED_TITLE_PATTERNS: RegExp[] = [
  /даатгал/i,
  /банк|зээл|хадгаламж/i,
  /татвар|хөдөлмөр|сонгуулийн|гэр\s+бүлийн/i,
  /эрүүгийн\s+хууль/i,
];

function isPublicNoiseRelevantResult(result: ChromaQueryResult): boolean {
  const title = getMetaTitle(result.metadata);
  if (PUBLIC_NOISE_EXCLUDED_TITLE_PATTERNS.some((pattern) => pattern.test(title))) {
    return false;
  }

  const corpus = normalizeText(`${title} ${result.document?.slice(0, 1800) ?? ''}`);
  const titleRelevant = PUBLIC_NOISE_TITLE_PATTERNS.some((pattern) => pattern.test(title));
  const textSignalCount = countRegexMatches(corpus, PUBLIC_NOISE_TEXT_PATTERNS);

  return titleRelevant || textSignalCount >= 2;
}

function applyPublicNoiseFiltering(
  query: string,
  results: ChromaQueryResult[],
): ChromaQueryResult[] {
  if (!isPublicNoiseComplaintQuery(query) || results.length === 0) {
    return results;
  }

  const filtered = results.filter((result) => isPublicNoiseRelevantResult(result));

  if (filtered.length === 0) {
    return [];
  }

  return filtered.sort((a, b) => b.score - a.score);
}

function isTrafficIncidentQuestion(query: string): boolean {
  if (isTrafficInsuranceClaimQuery(query)) {
    return false;
  }

  const normalized = normalizeText(query);
  return (
    /зам\s+тээврийн\s+осол|осол\s+гар|мөргөл|мөргө|шүргэ|машинтай\s+мөргөлд|согтуу.*жолоод|ослын\s+газар|зугт/i.test(
      normalized,
    ) ||
    /(зогсоол|паркинг).{0,80}(мөргө|шүргэ|зугт|осол|хохирол|машин)|(?:мөргө|шүргэ|зугт|осол).{0,80}(зогсоол|паркинг)/i.test(
      normalized,
    )
  );
}

function resolveTrafficIncidentSubtype(query: string): TrafficIncidentSubtype {
  const normalized = normalizeText(query);

  if (isTrafficInsuranceClaimQuery(normalized)) {
    return 'insurance_claim';
  }

  if (/(согтуу|согтуур|мансуур|гэмтэл|бэртэл|нас\s*бар|амь\s*нас|эрүүгийн|ял|шийтгэл)/i.test(normalized)) {
    return 'dui_or_injury';
  }

  if (/(зогсоол|паркинг).{0,80}(мөргө|шүргэ|зугт)|(?:мөргө|шүргэ).{0,80}(зогсоол|паркинг).{0,80}зугт|зугт.{0,80}(зогсоол|паркинг)/i.test(normalized)) {
    return 'parking_hit_and_run';
  }

  if (/(мөргө|мөргөлд|шүргэ|осол)/i.test(normalized)) {
    return 'minor_collision';
  }

  return 'general_traffic';
}

function isExplicitRelatedCaseAsk(query: string): boolean {
  return /(ижил\s+кейс|төстэй\s+кейс|шүүхийн\s+кейс|case|кейс|кейсүүд|шүүхийн\s+шийдвэр|шүүхийн\s+практик|шүүхийн\s+жишиг|жишиг\s+шийдвэр|прецедент|шийтгэх\s+тогтоол|магадлал|ямар\s+ял|ял\s+авах|хэргийн\s+жишээ)/i.test(
    normalizeText(query),
  );
}

function isTrafficPracticalAdviceQuery(query: string): boolean {
  return /(яах|яаж|ямар\s+арга|арга\s+хэмжээ|шийдвэрлэх|авах\s+вэ|одоо|хэрхэн|зөвлөгөө)/i.test(
    normalizeText(query),
  );
}

function isSeriousTrafficCaseQuery(query: string): boolean {
  return /(согтуу|согтуур|мансуур|гэмтэл|бэртэл|нас\s*бар|амь\s*нас|эрүүгийн|гэмт\s*хэрэг|ял|шийтгэл)/i.test(
    normalizeText(query),
  );
}

function shouldUseCompactTrafficRetrieval(
  query: string,
  intent: QueryIntent,
  mode: QueryMode,
): boolean {
  return (
    mode === 'qa' &&
    intent === 'traffic' &&
    isTrafficIncidentQuestion(query) &&
    isTrafficPracticalAdviceQuery(query) &&
    !isExplicitRelatedCaseAsk(query)
  );
}

const TRAFFIC_INCIDENT_EXCLUDED_PATTERNS: RegExp[] = [
  /нэр\s+томьёо/i,
  /жолоочоос\s+бусад/i,
  /техникийн\s+үйлчилгээ|засвар\s+хийх/i,
  /улсын\s+бүртгэлийн\s+дугаар/i,
  /шүүрт\s+худгийн\s+таг|зам\s+дээр\s+хийгдсэн\s+үзлэг/i,
  /авто\s+зам,\s*замын\s+байгууламж|авто\s+зам\s+замын\s+байгууламж/i,
  /орц\s+гарц|зогсоолын\s+талбай|хурд\s+сааруулагч/i,
  /чиглэлийн\s+тээврийн\s+хэрэгслийн\s+чиглэл|замналын\s+зогсоол/i,
  /замын\s+байгууламж|тэмдэг,\s*тэмдэглэл|тэмдэглэл(?:ийг)?\s+гэмтээх/i,
  /тээвэрлэгчийн\s+эрх,\s*үүрэг/i,
];

const TRAFFIC_INCIDENT_SIGNAL_PATTERNS: RegExp[] = [
  /жолоочийн\s+үүрэг|жолооч/i,
  /осол|мөргөл|шүргэ|хохирол/i,
  /ослын\s+үед|ослын\s+газар|мэдэгдэх/i,
  /даатгал|нөхөн\s+төлбөр/i,
  /зөрчил|эрүүгийн|гэмтэл|согтуур/i,
];

function normalizeArticleNo(articleNo: string): string {
  return articleNo.trim().replace(/\s+/g, '').replace(/^§/, '');
}

function isTrafficZurchilCoreArticle(articleNo: string, corpus: string): boolean {
  const normalizedArticleNo = normalizeArticleNo(articleNo);

  if (/^14\.?7(?:\.|$)?/.test(normalizedArticleNo)) {
    return true;
  }

  if (/^(5|6)(?:\.|$)/.test(normalizedArticleNo)) {
    return false;
  }

  return /(14\.7|замын\s+хөдөлгөөний\s+дүрэм|ослын\s+газар|зугт|жолоодох\s+эрх|тээврийн\s+хэрэгсэл\s+жолоод)/i.test(
    corpus,
  );
}

function isTrafficIncidentRelevantResult(result: ChromaQueryResult): boolean {
  const title = getMetaTitle(result.metadata);
  const articleNo = String(result.metadata.articleNo ?? '');
  const lawId = getResultLawId(result);
  const corpus = normalizeText(`${title} ${articleNo} ${result.document?.slice(0, 1800) ?? ''}`);

  if (TRAFFIC_INCIDENT_EXCLUDED_PATTERNS.some((pattern) => pattern.test(corpus))) {
    return false;
  }

  if (/зөрчлийн\s+тухай/i.test(title) || lawId === '12695') {
    return isTrafficZurchilCoreArticle(articleNo, corpus);
  }

  if (/иргэний\s+хууль/i.test(title) || lawId === '299') {
    return /^497(?:\.|$)?/.test(normalizeArticleNo(articleNo)) || /(гэм\s+хор|эд\s+хөрөнгөд\s+хохирол|хохирол\s+нөхөн)/i.test(corpus);
  }

  if (/эрүүгийн\s+хууль/i.test(title) || lawId === '12172') {
    return /^27\.?10/.test(normalizeArticleNo(articleNo)) || /(тээврийн\s+хэрэгслийн\s+хөдөлгөөний\s+аюулгүй|согтуу|гэмтэл|нас\s*бар)/i.test(corpus);
  }

  if (/жолоочийн\s+даатгал|даатгалын\s+тухай/i.test(title)) {
    return /(нөхөн\s+төлбөр|даатгалын\s+тохиолдол|хохирол)/i.test(corpus);
  }

  if (/замын\s+хөдөлгөөний\s+аюулгүй/i.test(title)) {
    return countRegexMatches(corpus, TRAFFIC_INCIDENT_SIGNAL_PATTERNS) >= 2;
  }

  return countRegexMatches(corpus, TRAFFIC_INCIDENT_SIGNAL_PATTERNS) >= 3;
}

function applyTrafficIncidentFiltering(
  query: string,
  results: ChromaQueryResult[],
): ChromaQueryResult[] {
  if (!isTrafficIncidentQuestion(query) || results.length === 0) {
    return results;
  }

  return results
    .filter((result) => isTrafficIncidentRelevantResult(result))
    .sort((a, b) => b.score - a.score);
}

function inferDomainFromCorpus(corpus: string): QueryIntent | 'unknown' {
  let bestIntent: QueryIntent | 'unknown' = 'unknown';
  let bestScore = 0;

  for (const [intent, patterns] of Object.entries(DOMAIN_PATTERNS) as Array<
    [Exclude<QueryIntent, 'unknown'>, RegExp[]]
  >) {
    const score = patterns.reduce((sum, pattern) => sum + (pattern.test(corpus) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestIntent = intent;
    }
  }

  if (bestIntent === 'unknown') {
    return 'unknown';
  }

  return bestScore >= DOMAIN_MIN_SCORE[bestIntent] ? bestIntent : 'unknown';
}

function isInternationalOrUnrelatedTreaty(corpus: string): boolean {
  return /(олон\s+улсын|конвенц|протокол|санамж\s+бичиг|харилцан\s+ойлголцол|олимп|ойг\s+тохиолдуулан|өршөөл\s+үзүүлэх|хөтөлбөр\s+батлах|жагсаалт\s+батлах)/i.test(
    corpus,
  );
}

async function augmentWithFocusedClauses(
  query: string,
  results: ChromaQueryResult[],
): Promise<ChromaQueryResult[]> {
  if (results.length === 0) {
    return results;
  }

  const stopTerms = new Set(['тухай', 'хууль', 'хуулийн', 'журам', 'зүйл', 'заалт', 'болон']);
  const terms = Array.from(
    new Set(
      normalizeText(query)
        .split(' ')
        .map((term) => term.replace(/(ийн|ын|ийг|ыг|д|т|аар|ээр|оор|өөр)$/iu, ''))
        .filter((term) => term.length >= 4 && !stopTerms.has(term)),
    ),
  ).slice(0, 4);

  if (terms.length === 0) {
    return results;
  }

  const sourceIds = Array.from(
    new Set(
      results
        .map((result) => String(result.metadata.sourceId ?? result.metadata.lawId ?? '').trim())
        .filter((id) => id.length > 0),
    ),
  ).slice(0, 6);

  if (sourceIds.length === 0) {
    return results;
  }

  const values: string[] = [sourceIds.join(',')];
  const likeClauses: string[] = [];
  for (const term of terms) {
    values.push(`%${term}%`);
    likeClauses.push(`LOWER(c.text) LIKE $${values.length}`);
  }

  if (likeClauses.length === 0) {
    return results;
  }

  const clauseMatches = await dbQuery<{
    id: string;
    document: string;
    metadata: Record<string, unknown>;
  }>(
    `SELECT
       c.id,
       c.text AS document,
       c.metadata
     FROM chunks c
     INNER JOIN documents d ON d.id = c.document_id
     WHERE d.source::text = 'legalinfo'
       AND d.source_id = ANY(string_to_array($1, ','))
       AND (${likeClauses.join(' OR ')})
     LIMIT 24`,
    values,
  );

  if (clauseMatches.length === 0) {
    return results;
  }

  const merged = new Map<string, ChromaQueryResult>();
  for (const item of results) {
    merged.set(item.id, item);
  }

  for (const row of clauseMatches) {
    const text = row.document.toLowerCase();
    const matchedTerms = terms.filter((term) => text.includes(term)).length;
    const score = Math.min(0.72 + matchedTerms * 0.08, 0.97);

    const existing = merged.get(row.id);
    if (!existing || score > existing.score) {
      merged.set(row.id, {
        id: row.id,
        document: row.document,
        metadata: row.metadata || {},
        score,
        rawScore: score,
      });
    }
  }

  return Array.from(merged.values()).sort((a, b) => b.score - a.score);
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:"'`()\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isShortQuery(query: string): boolean {
  const normalized = normalizeText(query);
  if (!normalized) return true;
  const words = normalized.split(' ').filter(Boolean);
  return normalized.length <= 30 || words.length <= 4;
}

function isCyberFraudQuery(query: string): boolean {
  const normalized = normalizeText(query);
  if (isConsumerRefundQuery(normalized)) {
    return false;
  }
  return CYBER_FRAUD_QUERY_PATTERN.test(normalized);
}

function isConsumerRefundQuery(query: string): boolean {
  const normalized = normalizeText(query);
  const hasConsumerTransaction =
    /онлайн|интернет|дэлгүүр|худалдан|захиал|бүтээгдэхүүн|бараа|үйлчилгээ|хэрэглэгч/i.test(
      normalized,
    );
  const hasRefundOrDefect =
    /доголд|эвдэр|чанаргүй|таарахгүй|буцаалт|буцаах|мөнгө\s+буца|төлүүлэх|солих|баталгаа/i.test(
      normalized,
    );
  return hasConsumerTransaction && hasRefundOrDefect;
}

function isLaborDismissalOrWageQuery(query: string): boolean {
  const normalized = normalizeText(query);
  return /ажлаас|халагд|халуул|халсан|ажил\s+олгогч|хөдөлмөр|цалин|олговор|үндэслэлгүй/i.test(
    normalized,
  );
}

function getRetrievalRuntimeConfig(
  env: AppEnv,
  query: string,
  shortQuery: boolean,
  isSingleWord: boolean,
  intent: QueryIntent,
  mode: QueryMode,
): RetrievalRuntimeConfig {
  const speedMode = env.RETRIEVAL_SPEED_MODE ?? 'balanced';
  const retrieveRelatedCases = shouldRetrieveRelatedCasesForQuery(env, query, intent, mode);
  const compactTrafficRetrieval = shouldUseCompactTrafficRetrieval(query, intent, mode);
  const compactBankLoanRetrieval = isBankLoanQuery(query) && mode === 'qa';
  const compactLaborRetrieval = isLaborDismissalOrWageQuery(query) && mode === 'qa';
  const compactConsumerRetrieval = isConsumerRefundQuery(query) && mode === 'qa';
  const compactProfileRetrieval =
    compactTrafficRetrieval ||
    compactBankLoanRetrieval ||
    compactLaborRetrieval ||
    compactConsumerRetrieval;
  const useVectorSearch =
    !(
      speedMode === 'fast' &&
      (isCyberFraudQuery(query) ||
        isPublicNoiseComplaintQuery(query) ||
        isTrafficInsuranceClaimQuery(query))
    );

  if (speedMode === 'quality') {
    if (compactProfileRetrieval) {
      return {
        speedMode,
        useVectorSearch: true,
        maxQueryVariants: 4,
        vectorTopK: compactBankLoanRetrieval ? (isSingleWord ? 28 : shortQuery ? 22 : 16) : isSingleWord ? 24 : shortQuery ? 20 : 14,
        keywordTopK: compactBankLoanRetrieval ? (isSingleWord ? 30 : shortQuery ? 26 : 24) : isSingleWord ? 28 : shortQuery ? 24 : 22,
        keywordFallbackTopK: 30,
        caseVectorTopK: 0,
        caseKeywordTopK: 0,
        retrieveRelatedCases: false,
        rerankCandidateLimit: 12,
        finalTopResults: 6,
        relatedLawCandidateLimit: 22,
      };
    }

    return {
      speedMode,
      useVectorSearch: true,
      maxQueryVariants: 10,
      vectorTopK: isSingleWord ? VERY_SHORT_QUERY_TOP_K : shortQuery ? SHORT_QUERY_TOP_K : OVERALL_TOP_K,
      keywordTopK: isSingleWord ? 60 : shortQuery ? 40 : 45,
      keywordFallbackTopK: 60,
      caseVectorTopK: retrieveRelatedCases ? CASE_VECTOR_TOP_K : 0,
      caseKeywordTopK: retrieveRelatedCases ? CASE_KEYWORD_TOP_K : 0,
      retrieveRelatedCases,
      rerankCandidateLimit: RETRIEVAL_TOP_RESULTS,
      finalTopResults: FINAL_TOP_RESULTS,
      relatedLawCandidateLimit: Math.max(RETRIEVAL_TOP_RESULTS * 2, 30),
    };
  }

  if (speedMode === 'fast') {
    return {
      speedMode,
      useVectorSearch,
      maxQueryVariants: isCyberFraudQuery(query) ? 3 : 4,
      vectorTopK: isSingleWord ? 24 : shortQuery ? 16 : 10,
      keywordTopK: isSingleWord ? 24 : shortQuery ? 20 : 18,
      keywordFallbackTopK: 28,
      caseVectorTopK: retrieveRelatedCases ? 8 : 0,
      caseKeywordTopK: retrieveRelatedCases ? 10 : 0,
      retrieveRelatedCases,
      rerankCandidateLimit: 10,
      finalTopResults: 5,
      relatedLawCandidateLimit: 18,
    };
  }

  return {
    speedMode,
    useVectorSearch,
    maxQueryVariants: compactProfileRetrieval ? 4 : isCyberFraudQuery(query) ? 4 : 6,
    vectorTopK: compactTrafficRetrieval
      ? (isSingleWord ? 24 : shortQuery ? 20 : 14)
      : compactBankLoanRetrieval
        ? (isSingleWord ? 28 : shortQuery ? 22 : 16)
        : isSingleWord ? 36 : shortQuery ? 24 : 14,
    keywordTopK: compactTrafficRetrieval
      ? (isSingleWord ? 28 : shortQuery ? 24 : 22)
      : compactBankLoanRetrieval
        ? (isSingleWord ? 30 : shortQuery ? 26 : 24)
        : isSingleWord ? 32 : shortQuery ? 26 : 24,
    keywordFallbackTopK: compactProfileRetrieval ? 30 : 34,
    caseVectorTopK: retrieveRelatedCases ? 12 : 0,
    caseKeywordTopK: retrieveRelatedCases ? 14 : 0,
    retrieveRelatedCases,
    rerankCandidateLimit: compactProfileRetrieval ? 12 : 14,
    finalTopResults: 6,
    relatedLawCandidateLimit: compactProfileRetrieval ? 22 : 24,
  };
}

function shouldRetrieveRelatedCasesForQuery(
  env: AppEnv,
  query: string,
  intent: QueryIntent,
  mode: QueryMode,
): boolean {
  if (mode !== 'qa') {
    return false;
  }

  if (env.INCLUDE_RELATED_CASES === 'never') {
    return false;
  }

  if (env.INCLUDE_RELATED_CASES === 'always') {
    return true;
  }

  const speedMode = env.RETRIEVAL_SPEED_MODE ?? 'balanced';
  const normalized = normalizeText(query);
  const explicitCaseAsk = isExplicitRelatedCaseAsk(normalized);

  if (explicitCaseAsk) {
    return true;
  }

  if (speedMode === 'fast') {
    return false;
  }

  if (isCyberFraudQuery(query) || isPublicNoiseComplaintQuery(query) || isTrafficInsuranceClaimQuery(query)) {
    return false;
  }

  if (intent === 'traffic') {
    return TRAFFIC_CASE_QUERY_PATTERN.test(normalized) && isSeriousTrafficCaseQuery(normalized);
  }

  if (intent === 'crime') {
    return /(хулгай|дээрэм|хүн\s+ами|хүчирхийлэл|ял|шийтгэл|гэмт\s+хэрэг)/i.test(normalized);
  }

  return false;
}

function buildSearchQueries(query: string, shortQuery: boolean, rewrittenQuery: string): string[] {
  const normalized = query.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return [];
  }

  const variants = new Set<string>([normalized]);
  const insuranceClaim = isTrafficInsuranceClaimQuery(normalized);
  const trafficIncident = isTrafficIncidentQuestion(normalized);
  const trafficSubtype = resolveTrafficIncidentSubtype(normalized);
  const bankLoanSubtype = resolveContractSubtype(normalized);

  if (rewrittenQuery.trim()) {
    for (const part of rewrittenQuery
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean)) {
      variants.add(part);
    }
  }

  // Check for article number patterns (e.g., "20 дугаар зүйл", "20 дүгээр заалт")
  const articleMatch = /(\d+(?:\.\d+)*)\s+(?:дугаар|дүгээр)\s+(?:зүйл|заалт|хэсэг)/i.exec(
    normalized,
  );
  const articleNum = articleMatch?.[1];

  if (articleNum) {
    variants.add(`${articleNum} дугаар зүйл`);
    variants.add(`${articleNum} дүгээр зүйл`);
    variants.add(`${articleNum} дугаар заалт`);
  }

  if (/хөдөлмөр|ажилтн|ажилч|ажил\s*олгогч|цалин|ажлаас/i.test(normalized)) {
    variants.add('хөдөлмөрийн тухай хууль');
    variants.add('хөдөлмөрийн тухай хууль ажилтан ажил олгогч');
    variants.add('хөдөлмөрийн тухай хууль ажлаас халах хөдөлмөр эрхлэлтийн харилцаа дуусгавар');
    variants.add('хөдөлмөрийн тухай хууль цалин хөлс ажилгүй байсан хугацаа маргаан');
  }

  if (isConsumerRefundQuery(normalized)) {
    variants.add('хэрэглэгчийн эрхийг хамгаалах тухай хууль доголдолтой бараа буцаалт');
    variants.add('иргэний хууль худалдах худалдан авах гэрээ доголдолтой бүтээгдэхүүн');
    variants.add('хэрэглэгчийн эрх бараа бүтээгдэхүүн чанар буцаах солих мөнгө буцаах');
  }

  if (bankLoanSubtype !== 'generic_contract') {
    variants.add('иргэний хууль 451 банк зээлийн гэрээ');
    variants.add('иргэний хууль 452 зээлийн хүү нэмэгдүүлсэн хүү');
    variants.add('иргэний хууль 453 зээлдэгчийн үүрэг зээл буцаан төлөх');
    variants.add('банк эрх бүхий хуулийн этгээдийн зээлийн үйл ажиллагааны тухай зээлийн гэрээ зээлийн хүү');

    if (bankLoanSubtype === 'bank_loan_overdue') {
      variants.add('банкнаас авсан зээл хугацаа хэтэрсэн төлбөр алданги нэмэгдүүлсэн хүү');
    }

    if (bankLoanSubtype === 'bank_loan_collateral') {
      variants.add('барьцааны тухай хууль зээлийн барьцаа үүрэг гүйцэтгээгүй');
    }

    if (bankLoanSubtype === 'credit_information') {
      variants.add('зээлийн мэдээллийн тухай хууль зээлийн түүх мэдээллийн сан');
    }
  }

  if (insuranceClaim) {
    variants.add('даатгалын тухай хууль нөхөн төлбөр татгалзсан үндэслэл');
    variants.add('иргэний хууль даатгалын гэрээ даатгалын тохиолдол нөхөн төлбөр');
    variants.add('жолоочийн даатгалын тухай хууль нөхөн төлбөр хохирол');
  }

  if (trafficIncident) {
    variants.add('зөрчлийн тухай хууль 14.7 замын хөдөлгөөний дүрэм зөрчих жолооч ослын газар');
    variants.add('замын хөдөлгөөний аюулгүй байдлын тухай хууль жолоочийн үүрэг ослын газар зогсох цагдаад мэдэгдэх');
    variants.add('иргэний хууль 497 гэм хор эд хөрөнгийн хохирол нөхөн төлүүлэх');

    if (trafficSubtype === 'parking_hit_and_run') {
      variants.add('зогсоолд мөргөөд зугтсан жолооч камер цагдаа хохирол');
      variants.add('ослын газраас зугтсан жолооч замын хөдөлгөөний дүрэм зөрчих');
    } else if (trafficSubtype === 'minor_collision') {
      variants.add('машин мөргөлдөх шүргэх хохирол цагдаа даатгал жолоочийн үүрэг');
    } else if (trafficSubtype === 'dui_or_injury') {
      variants.add('эрүүгийн хууль 27.10 тээврийн хэрэгслийн хөдөлгөөний аюулгүй байдал гэмтэл');
    }
  }

  if (shortQuery && normalized.length > 0) {
    const hasLawKeyword = /хууль|журам|дүрэм|кодекс|зүйл|заалт/i.test(normalized);

    if (!hasLawKeyword) {
      variants.add(`${normalized} тухай хууль`);
      variants.add(`${normalized} хууль`);
      variants.add(`${normalized} журам`);
    }

    const stripped = normalized
      .replace(/(?:ийг|ыг|д|т|аас|ээс|оос|өөс|дээр|дотор|тай|тэй|той|аар|ээр|оор)$/iu, '')
      .trim();
    if (stripped.length >= 4 && stripped !== normalized) {
      variants.add(`${stripped} тухай хууль`);
    }

    if (/хөдөлмөр|ажилтан|цалин|ажил/i.test(normalized)) {
      variants.add('хөдөлмөрийн тухай хууль');
    }
    if (/даатгал/i.test(normalized)) {
      variants.add('даатгалын тухай хууль');
      variants.add('даатгалын тухай хууль нөхөн төлбөр татгалзсан үндэслэл');
      variants.add('иргэний хууль даатгалын гэрээ нөхөн төлбөр');
      variants.add('жолоочийн даатгалын тухай хууль нөхөн төлбөр');
    }
    if (/гэр бүл|хүүхэд|хүчирхийлэл|эцэг\s*эх|уулзуулах|харилцах\s*эрх|асрамж/i.test(normalized)) {
      variants.add('гэр бүлийн тухай хууль');
      variants.add('гэр бүлийн тухай хууль эцэг эх хүүхэдтэй харилцах эрх');
      variants.add('хүүхдийн эрхийн тухай хууль хүүхдийн эрх ашиг');
      variants.add('иргэний хэрэг шүүхэд хянан шийдвэрлэх тухай хүүхэд уулзуулах');
    }
    if (/татвар|санхүү/i.test(normalized)) {
      variants.add('татварын ерөнхий хууль');
    }
    if (/эрүүл|эмнэлэг|мэнд/i.test(normalized)) {
      variants.add('эрүүл мэндийн тухай хууль');
    }
    if (
      /согтуур|согтуу|жолоод|жолооны\s*эрх|тээврийн\s*хэрэгсэл|замын\s*хөдөлгөөн/i.test(normalized)
    ) {
      variants.add('замын хөдөлгөөний аюулгүй байдлын тухай хууль');
      if (!insuranceClaim) {
        variants.add('зөрчлийн тухай хууль согтуугаар жолоодох');
        variants.add('эрүүгийн хууль тээврийн хэрэгсэл жолоодох');
      }
    }
    if (/сонгуул|сонгогч|санал\s*өгөх|сонгох\s*эрх|18\s*нас|арван\s*найм/i.test(normalized)) {
      variants.add('сонгуулийн тухай хууль');
      variants.add('үндсэн хууль сонгох эрх 18 нас');
    }
    if (/эд\s*хөрөнгө|үл\s*хөдлөх|өмч|өмчлөх|шилжүүл|худалдах|худалдан/i.test(normalized)) {
      if (!isConsumerRefundQuery(normalized)) {
        variants.add('иргэний хууль өмчлөх эрх шилжүүлэх');
        variants.add('улсын бүртгэлийн ерөнхий хууль өмч шилжилт');
        variants.add('үл хөдлөх эд хөрөнгийн барьцааны тухай');
      }
    }
  }

  if (isCyberFraudQuery(normalized)) {
    variants.add('эрүүгийн хууль залилах цахим залилан хууран мэхлэх');
    variants.add('цахим луйвар данс мөнгө шилжүүлэг нотлох баримт');
    variants.add('цагдаагийн албаны тухай гомдол мэдээлэл гэмт хэрэг');
    variants.add('эрүүгийн хэрэг хянан шийдвэрлэх нотлох баримт хохирогч');
  }

  return Array.from(variants).slice(0, insuranceClaim ? 8 : bankLoanSubtype !== 'generic_contract' ? 9 : 12);
}

function extractPrimaryQuery(query: string): string {
  const firstLine = query
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return firstLine ?? query.trim();
}

function mergeVectorResults(results: ChromaQueryResult[]): ChromaQueryResult[] {
  const bestById = new Map<string, ChromaQueryResult>();

  for (const result of results) {
    const existing = bestById.get(result.id);
    if (!existing || result.score > existing.score) {
      bestById.set(result.id, result);
    }
  }

  return Array.from(bestById.values()).sort((a, b) => b.score - a.score);
}

function keywordResultToQueryResult(
  result: KeywordSearchResult,
  minimumScore: number = 0,
): ChromaQueryResult {
  return {
    id: result.chunkId,
    document: result.text,
    metadata: result.metadata || {},
    score: Math.min(1, Math.max(result.score || 0, minimumScore)),
    rawScore: Math.min(1, Math.max(result.score || 0, 0)),
  };
}

function resolveLawUrl(meta: Record<string, unknown>): string {
  const rawUrl = getMetaUrl(meta);
  if (rawUrl) return rawUrl;

  const sourceId = String(meta.sourceId ?? meta.lawId ?? '');
  const fromSourceId = sourceId ? buildLawUrl(sourceId) : undefined;
  if (fromSourceId) return fromSourceId;

  return getLawUrl(String(meta.title ?? '')) ?? '';
}

const BOILERPLATE_ARTICLE_TITLE_PATTERN =
  /(хууль(?:\s+тогтоомж)?|зорилт|ерөнхий\s+зүйл|нийтлэг\s+үндэслэл|нэр\s+томьёо|ойлголт|тодорхойлолт|хамрах\s+хүрээ|хэрэглэх\s+хүрээ)/i;

const DEEP_LINK_STOP_TERMS = new Set([
  'тухай',
  'хууль',
  'хуулийн',
  'эрх',
  'улсын',
  'ерөнхий',
  'нийтлэг',
  'үндэслэл',
  'зүйл',
  'заалт',
  'хэсэг',
  'бүлэг',
  'болон',
  'журам',
]);

const PROPERTY_TRANSFER_QUERY_PATTERN =
  /(эд\s*хөрөнгө|үл\s*хөдлөх|өмч|өмчлөх|өмчлөл|шилжүүлэх|шилжилт|бүртгэл|бүртгүүлэх|худалдах|худалдан|бэлэглэх|өвлөх)/i;

const PROPERTY_TRANSFER_LAW_PATTERNS: RegExp[] = [
  /иргэний\s+хууль/i,
  /эд\s+хөрөнгийн\s+эрхийн\s+улсын\s+бүртгэлийн\s+тухай/i,
  /улсын\s+бүртгэлийн\s+ерөнхий\s+хууль/i,
  /газрын\s+тухай/i,
];

const PROPERTY_TRANSFER_ARTICLE_PATTERNS: RegExp[] = [
  /өмчлөх\s+эрх/i,
  /өмчлөх/i,
  /шилжүүлэх|шилжилт/i,
  /бүртгэл|бүртгүүлэх/i,
  /худалдах|худалдан|бэлэглэх|өвлөх/i,
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildLegalinfoArticleSword(articleNo: string, text: string): string {
  const normalizedArticle = normalizeArticleNumber(articleNo);
  if (!normalizedArticle) {
    return '';
  }

  const escapedArticle = escapeRegExp(normalizedArticle);
  const headingMatch = text.match(
    new RegExp(`(?:^|\\s)(${escapedArticle}\\s*(?:дүгээр|дугаар)\\s+зүйл)`, 'i'),
  );
  if (headingMatch?.[1]) {
    return headingMatch[1].replace(/\s+/g, ' ').trim();
  }

  // Clause/subclause chunks often carry values like "43.1"; legalinfo search
  // can jump closer with the exact number than with a broad query word.
  return normalizedArticle;
}

function extractBestArticleTitle(meta: Record<string, unknown>, text: string): string {
  const fromMeta = String(meta.articleTitle ?? '').trim();
  if (fromMeta) {
    return fromMeta;
  }

  return extractArticleTitle(text);
}

function isBoilerplateArticleTitle(articleTitle: string): boolean {
  const normalized = articleTitle.trim();
  if (!normalized) {
    return false;
  }

  if (PROPERTY_TRANSFER_ARTICLE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  return BOILERPLATE_ARTICLE_TITLE_PATTERN.test(normalized);
}

function pickLegalinfoSwordKeyword(
  query: string,
  articleTitle: string,
  text: string,
  articleNo: string,
): string {
  const articleSword = buildLegalinfoArticleSword(articleNo, text);
  if (articleSword) {
    return articleSword;
  }

  const titleCorpus = normalizeText(articleTitle);
  const textCorpus = normalizeText(text.slice(0, 1600));
  const querySignals = extractArticleBoostSignalTerms(query);

  for (const term of querySignals) {
    if (titleCorpus.includes(term) || textCorpus.includes(term)) {
      return term;
    }
  }

  const titleTerms = titleCorpus
    .split(' ')
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && !DEEP_LINK_STOP_TERMS.has(term));

  if (titleTerms.length > 0) {
    return titleTerms[0];
  }

  return articleNo ? `${articleNo} зүйл` : '';
}

function buildLegalinfoDeepLink(
  query: string,
  meta: Record<string, unknown>,
  articleNo: string,
  articleTitle: string,
  text: string,
): string {
  const baseUrl = resolveLawUrl(meta);
  if (!baseUrl) {
    return '';
  }

  const lawId = String(meta.sourceId ?? meta.lawId ?? '').trim();
  if (!lawId || !articleNo) {
    return baseUrl;
  }

  const swordKeyword = pickLegalinfoSwordKeyword(query, articleTitle, text, articleNo);
  if (!swordKeyword) {
    return baseUrl;
  }

  const cleanBase = baseUrl.includes('/detail') ? baseUrl.split('?')[0] : baseUrl;
  return `${cleanBase}?lawId=${lawId}&sword=${encodeURIComponent(swordKeyword)}`;
}

function isPropertyTransferQuery(query: string): boolean {
  return PROPERTY_TRANSFER_QUERY_PATTERN.test(query);
}

function applyPropertyTransferBoost(
  query: string,
  results: ChromaQueryResult[],
): ChromaQueryResult[] {
  if (results.length === 0 || !isPropertyTransferQuery(query)) {
    return results;
  }

  const querySignals = extractArticleBoostSignalTerms(query);

  return results
    .map((result) => {
      const lawTitle = getMetaTitle(result.metadata);
      const articleTitle = extractBestArticleTitle(result.metadata, result.document ?? '');
      const corpus = normalizeText(
        `${lawTitle} ${articleTitle} ${result.document?.slice(0, 1400) ?? ''}`,
      );

      let score = result.score;

      if (PROPERTY_TRANSFER_LAW_PATTERNS.some((pattern) => pattern.test(lawTitle))) {
        score += 0.18;
      }

      if (PROPERTY_TRANSFER_ARTICLE_PATTERNS.some((pattern) => pattern.test(articleTitle))) {
        score += 0.12;
      }

      const matchedSignals = querySignals.filter((term) => corpus.includes(term)).length;
      if (querySignals.length > 0) {
        if (matchedSignals === 0) {
          score *= 0.72;
        } else {
          score += Math.min(matchedSignals * 0.05, 0.15);
        }
      }

      if (isBoilerplateArticleTitle(articleTitle)) {
        score *= 0.55;
      }

      return {
        ...result,
        score: Math.max(0, Math.min(1, score)),
      };
    })
    .sort((a, b) => b.score - a.score);
}

const FAMILY_CONTACT_QUERY_PATTERN =
  /(гэр\s*бүл|эцэг\s*эх|хүүхэд|уулзуулах|уулзах|харилцах\s*эрх|асрамж|асран\s+хамгаалах|хамт\s+амьдрах|асран\s+хүмүүжүүлэх)/i;

const FAMILY_CONTACT_LAW_PATTERNS: RegExp[] = [
  /гэр\s+бүлийн\s+тухай/i,
  /хүүхдийн\s+эрхийн\s+тухай/i,
  /иргэний\s+хэрэг\s+шүүхэд\s+хянан\s+шийдвэрлэх\s+тухай/i,
];

const FAMILY_CONTACT_ARTICLE_PATTERNS: RegExp[] = [
  /эцэг\s*эх/i,
  /хүүхэд/i,
  /уулз|уулзуулах|харилцах\s+эрх/i,
  /асран\s+хамгаалах|асран\s+хүмүүжүүлэх|асрамж|тэтгэлэг/i,
];

function isFamilyContactQuery(query: string): boolean {
  return FAMILY_CONTACT_QUERY_PATTERN.test(query);
}

function applyFamilyContactBoost(query: string, results: ChromaQueryResult[]): ChromaQueryResult[] {
  if (results.length === 0 || !isFamilyContactQuery(query)) {
    return results;
  }

  const querySignals = extractArticleBoostSignalTerms(query);

  return results
    .map((result) => {
      const lawTitle = getMetaTitle(result.metadata);
      const articleTitle = extractBestArticleTitle(result.metadata, result.document ?? '');
      const corpus = normalizeText(
        `${lawTitle} ${articleTitle} ${result.document?.slice(0, 1400) ?? ''}`,
      );

      let score = result.score;

      if (FAMILY_CONTACT_LAW_PATTERNS.some((pattern) => pattern.test(lawTitle))) {
        score += 0.18;
      }

      if (FAMILY_CONTACT_ARTICLE_PATTERNS.some((pattern) => pattern.test(articleTitle))) {
        score += 0.14;
      }

      const matchedSignals = querySignals.filter((term) => corpus.includes(term)).length;
      if (querySignals.length > 0) {
        if (matchedSignals === 0) {
          score *= 0.7;
        } else {
          score += Math.min(matchedSignals * 0.05, 0.16);
        }
      }

      if (isBoilerplateArticleTitle(articleTitle)) {
        score *= 0.55;
      }

      return {
        ...result,
        score: Math.max(0, Math.min(1, score)),
      };
    })
    .sort((a, b) => b.score - a.score);
}

type ArticleMarker = {
  articleNo: string;
  index: number;
};

function normalizeArticleNumber(article: string): string {
  const match = article.trim().match(/\d+(?:\.\d+)*/);
  if (!match) {
    return '';
  }

  const value = match[0];
  if (/^\d+$/.test(value) && Number(value) > 500) {
    return '';
  }

  return value;
}

function extractArticleMarkers(document: string): ArticleMarker[] {
  if (!document) {
    return [];
  }

  const markers: ArticleMarker[] = [];
  const patterns = [
    /(\d+(?:\.\d+)*)\s+(?:дугаар|дүгээр)\s+зүйл/giu,
    /зүйл\s*(\d+(?:\.\d+)*)/giu,
    /article\s*(\d+(?:\.\d+)*)/giu,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(document)) !== null) {
      const articleNo = normalizeArticleNumber(match[1] ?? '');
      if (!articleNo) {
        continue;
      }
      markers.push({ articleNo, index: match.index });
    }
  }

  markers.sort((a, b) => a.index - b.index);

  const deduped: ArticleMarker[] = [];
  for (const marker of markers) {
    const last = deduped[deduped.length - 1];
    if (last && last.articleNo === marker.articleNo && Math.abs(last.index - marker.index) < 6) {
      continue;
    }
    deduped.push(marker);
  }

  return deduped;
}

function extractQueryAlignedArticleNumber(
  query: string,
  document: string,
  metaArticleNo?: string,
): string {
  const markers = extractArticleMarkers(document);
  const requestedArticle = extractRequestedArticleNumber(query);
  const signalTerms = extractArticleBoostSignalTerms(query).filter((term) => term.length >= 4);

  if (requestedArticle) {
    return markers.some((marker) => marker.articleNo === requestedArticle) ? requestedArticle : '';
  }

  if (markers.length === 0) {
    const fromText = normalizeArticleNumber(extractArticle(document) ?? '');
    const fromMeta = normalizeArticleNumber(metaArticleNo ?? '');
    if (!fromText) {
      return '';
    }
    if (fromMeta && fromMeta !== fromText) {
      return '';
    }
    return fromText;
  }

  if (signalTerms.length === 0) {
    return markers.length === 1 ? markers[0].articleNo : '';
  }

  let bestArticle = '';
  let bestMatched = 0;
  let bestRatio = 0;

  for (let i = 0; i < markers.length; i += 1) {
    const current = markers[i];
    const next = markers[i + 1];
    const segment = normalizeText(document.slice(current.index, next?.index ?? document.length));
    const matched = signalTerms.filter((term) => segment.includes(term)).length;
    const ratio = matched / signalTerms.length;
    if (matched > bestMatched) {
      bestMatched = matched;
      bestRatio = ratio;
      bestArticle = current.articleNo;
    }
  }

  if (bestMatched > 0 && (bestMatched >= 2 || bestRatio >= MIN_ARTICLE_SIGNAL_RATIO)) {
    return bestArticle;
  }

  // Fallback 1: If metaArticleNo matches one of the markers, return it
  if (metaArticleNo) {
    const normalizedMeta = normalizeArticleNumber(metaArticleNo);
    if (normalizedMeta && markers.some((m) => m.articleNo === normalizedMeta)) {
      return normalizedMeta;
    }
  }

  // Fallback 2: If only one marker, return it
  if (markers.length === 1) {
    return markers[0].articleNo;
  }

  return '';
}

function buildSources(query: string, _mode: QueryMode, chunks: ChromaQueryResult[]): Source[] {
  const requestedArticle = extractRequestedArticleNumber(query);
  const allowLowerAuthority =
    /олон\s+улсын|конвенц|протокол|гэрээ|хэлэлцээр|өршөөл|ой\s*тохиолдуулан/i.test(query);
  const seen = new Set<string>();
  const sources: Source[] = [];

  for (const chunk of chunks) {
    const meta = chunk.metadata;
    const sourceType = String(meta.source ?? 'legalinfo') === 'shuukh' ? 'shuukh' : 'legalinfo';
    const title = getMetaTitle(meta);
    if (
      !allowLowerAuthority &&
      (isLowAuthorityTitle(title) || isInternationalOrUnrelatedTreaty(title))
    ) {
      continue;
    }
    if (isTrafficInsuranceClaimQuery(query) && !isInsuranceClaimRelevantResult(query, chunk)) {
      continue;
    }
    if (isBankLoanQuery(query) && !isBankLoanRelevantResult(query, chunk)) {
      continue;
    }
    if (isConsumerRefundQuery(query) && !isConsumerRefundRelevantResult(chunk)) {
      continue;
    }
    if (isLaborDismissalOrWageQuery(query) && !isLaborDismissalRelevantResult(chunk)) {
      continue;
    }
    if (isPublicNoiseComplaintQuery(query) && !isPublicNoiseRelevantResult(chunk)) {
      continue;
    }
    if (isTrafficIncidentQuestion(query) && !isTrafficIncidentRelevantResult(chunk)) {
      continue;
    }
    const url =
      sourceType === 'legalinfo' ? resolveLawUrl(meta) : formatUrl(String(meta.url ?? ''));
    if (!url) continue;

    const articleNo =
      sourceType === 'legalinfo'
        ? extractQueryAlignedArticleNumber(query, chunk.document, String(meta.articleNo ?? ''))
        : '';
    const safeArticleNo = requestedArticle
      ? articleNo === requestedArticle
        ? articleNo
        : ''
      : articleNo;
    const rawArticleTitle =
      sourceType === 'legalinfo' ? extractBestArticleTitle(meta, chunk.document ?? '') : '';
    const articleTitle =
      !requestedArticle && isBoilerplateArticleTitle(rawArticleTitle) ? '' : rawArticleTitle;
    const finalUrl =
      sourceType === 'legalinfo'
        ? buildLegalinfoDeepLink(query, meta, safeArticleNo, articleTitle, chunk.document ?? '')
        : url;
    const sourceKey =
      sourceType === 'legalinfo'
        ? `${sourceType}:${String(meta.sourceId ?? meta.lawId ?? url)}:${safeArticleNo || 'general'}`
        : `${sourceType}:${finalUrl || url}`;
    if (seen.has(sourceKey)) continue;
    seen.add(sourceKey);
    const displayTitle =
      sourceType === 'legalinfo' && safeArticleNo
        ? `${title} §${safeArticleNo}${articleTitle ? `: ${articleTitle}` : ''}`
        : title;

    sources.push({
      type: sourceType,
      title: displayTitle,
      url: finalUrl || url,
      snippet: chunk.document.slice(0, 220),
      lawId:
        sourceType === 'legalinfo'
          ? String(meta.sourceId ?? meta.lawId ?? '') || undefined
          : undefined,
      caseId: sourceType === 'shuukh' ? String(meta.caseId ?? '') || undefined : undefined,
      articleNo: safeArticleNo || undefined,
    });
  }

  return sources;
}

function extractArticleTitle(text: string): string {
  const match = text.match(/(\d+(?:\.\d+)*)\s*(?:дүгээр|дугаар)\s+зүйл[.:]*\s*([^\n]{0,80})/i);
  if (match) {
    const title = (match[2] ?? '').trim().replace(/^[.\s]+/, '');
    return title || '';
  }
  return '';
}

type RelatedDisplayCandidate<T extends { score: number; displayScore?: number }> = T & {
  evidenceScore: number;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function roundScore(value: number): number {
  return Math.round(clamp01(value) * 100) / 100;
}

function getEvidenceScore(result: ChromaQueryResult): number {
  return clamp01(typeof result.rawScore === 'number' ? result.rawScore : result.score);
}

function assessRetrievalQuality(
  intent: QueryIntent,
  chunks: ChromaQueryResult[],
  relatedLaws: RelatedLaw[],
): RetrievalQuality {
  const topScore = clamp01(chunks[0]?.score ?? 0);
  const intentPrecision =
    intent === 'unknown' || chunks.length === 0
      ? 0
      : chunks.filter((chunk) =>
          inferDomainFromCorpus(
            normalizeText(`${getMetaTitle(chunk.metadata)} ${chunk.document?.slice(0, 1000) ?? ''}`),
          ) === intent,
        ).length / chunks.length;
  const canonicalCoverage =
    intent === 'unknown' || relatedLaws.length === 0
      ? 0
      : relatedLaws.some((law) =>
          (CANONICAL_LAW_TITLE_PATTERNS[intent] ?? []).some((pattern) => pattern.test(law.title)),
        )
        ? 1
        : 0;
  const overall = clamp01(topScore * 0.5 + intentPrecision * 0.3 + canonicalCoverage * 0.2);

  return {
    overall: roundScore(overall),
    intentPrecision: roundScore(intentPrecision),
    canonicalCoverage: roundScore(canonicalCoverage),
    topScore: roundScore(topScore),
    qualityBand: overall >= 0.72 ? 'high' : overall >= 0.45 ? 'medium' : 'low',
  };
}

function finalizeDisplayScores<T extends { score: number; displayScore?: number }>(
  items: Array<RelatedDisplayCandidate<T>>,
): T[] {
  if (items.length === 0) {
    return [];
  }

  const evidenceScores = items.map((item) => clamp01(item.evidenceScore));
  const minEvidence = Math.min(...evidenceScores);
  const maxEvidence = Math.max(...evidenceScores);
  const evidenceRange = maxEvidence - minEvidence;

  return items.map((item, index) => {
    const evidence = clamp01(item.evidenceScore);
    const ranking = clamp01(item.score);
    const spread = evidenceRange >= 0.025 ? clamp01((evidence - minEvidence) / evidenceRange) : 0.5;
    const rankInfluence = items.length > 1 ? 1 - index / (items.length - 1) : 1;

    let displayScore = evidence * 0.72 + ranking * 0.18 + spread * 0.07 + rankInfluence * 0.03;

    if (evidence < 0.25 && ranking < 0.4) {
      displayScore = Math.min(displayScore, 0.54);
    }

    if (evidence > 0.85 && evidenceRange < 0.04) {
      displayScore = Math.min(displayScore, 0.88);
    }

    displayScore = Math.max(0.12, Math.min(0.94, displayScore));

    const { evidenceScore: _evidenceScore, ...rest } = item;
    return {
      ...rest,
      score: roundScore(item.score),
      displayScore: roundScore(displayScore),
    };
  }) as unknown as T[];
}

function buildRelatedLaws(
  query: string,
  _mode: QueryMode,
  chunks: ChromaQueryResult[],
): RelatedLaw[] {
  const requestedArticle = extractRequestedArticleNumber(query);
  const allowLowerAuthority =
    /олон\s+улсын|конвенц|протокол|гэрээ|хэлэлцээр|өршөөл|ой\s*тохиолдуулан/i.test(query);
  const seen = new Map<string, RelatedDisplayCandidate<RelatedLaw>>();

  for (const chunk of chunks) {
    const meta = chunk.metadata;
    const text = chunk.document || '';

    if (chunk.score < MIN_LAW_CASE_SCORE) continue;
    if (meta.source !== 'legalinfo') continue;

    const lawTitle = getMetaTitle(meta);
    if (
      !allowLowerAuthority &&
      (isLowAuthorityTitle(lawTitle) || isInternationalOrUnrelatedTreaty(lawTitle))
    ) {
      continue;
    }
    if (isTrafficInsuranceClaimQuery(query) && !isInsuranceClaimRelevantResult(query, chunk)) {
      continue;
    }
    if (isConsumerRefundQuery(query) && !isConsumerRefundRelevantResult(chunk)) {
      continue;
    }
    if (isLaborDismissalOrWageQuery(query) && !isLaborDismissalRelevantResult(chunk)) {
      continue;
    }
    if (isPublicNoiseComplaintQuery(query) && !isPublicNoiseRelevantResult(chunk)) {
      continue;
    }
    if (isTrafficIncidentQuestion(query) && !isTrafficIncidentRelevantResult(chunk)) {
      continue;
    }

    const lawId = String(meta.sourceId ?? meta.lawId ?? '');
    if (!lawId) continue;

    const alignedArticleNo = extractQueryAlignedArticleNumber(
      query,
      text,
      String(meta.articleNo ?? ''),
    );
    // Fallback: use metadata articleNo or extract from chunk text if alignment failed
    const fallbackArticleNo =
      alignedArticleNo ||
      normalizeArticleNumber(String(meta.articleNo ?? '')) ||
      normalizeArticleNumber(extractArticle(text) ?? '');
    const safeArticleNo = requestedArticle
      ? fallbackArticleNo === requestedArticle
        ? fallbackArticleNo
        : ''
      : fallbackArticleNo;
    const rawArticleTitle = extractBestArticleTitle(meta, text);
    const articleTitle =
      !requestedArticle && isBoilerplateArticleTitle(rawArticleTitle) ? '' : rawArticleTitle;

    const displayTitle = safeArticleNo
      ? `${lawTitle} §${safeArticleNo}${articleTitle ? `: ${articleTitle}` : ''}`
      : lawTitle;

    const key = safeArticleNo ? `${lawId}:${safeArticleNo}` : `${lawId}:general`;

    if (seen.has(key)) continue;

    const url = buildLegalinfoDeepLink(query, meta, safeArticleNo, articleTitle, text);

    seen.set(key, {
      title: displayTitle,
      articleNo: safeArticleNo,
      url: url,
      score: roundScore(chunk.score),
      evidenceScore: getEvidenceScore(chunk),
    });
  }

  return finalizeDisplayScores(
    Array.from(seen.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RELATED_LAWS),
  );
}

function hasTrafficIncidentCanonicalRelatedLaw(laws: RelatedLaw[]): boolean {
  return laws.some((law) => {
    const title = normalizeText(law.title);
    const articleNo = normalizeArticleNo(law.articleNo);
    return (
      (/зөрчлийн\s+тухай/i.test(title) && /^14\.?7/.test(articleNo)) ||
      /замын\s+хөдөлгөөний\s+аюулгүй/i.test(title) ||
      (/иргэний\s+хууль/i.test(title) && /^497/.test(articleNo))
    );
  });
}

function hasBankLoanCanonicalRelatedLaw(laws: RelatedLaw[]): boolean {
  return laws.some((law) => {
    const title = normalizeText(law.title);
    const articleNo = normalizeArticleNo(law.articleNo);
    return (
      (/иргэний\s+хууль/i.test(title) && /^(451|452|453)(?:\.|$)?/.test(articleNo)) ||
      /банк\s+эрх\s+бүхий.*зээлийн\s+үйл\s+ажиллагаа/i.test(title)
    );
  });
}

function mergeRelatedLawsByKey(primary: RelatedLaw[], fallback: RelatedLaw[]): RelatedLaw[] {
  const merged = new Map<string, RelatedLaw>();

  for (const law of [...primary, ...fallback]) {
    const key = `${normalizeText(law.title)}:${normalizeArticleNo(law.articleNo)}`;
    const existing = merged.get(key);
    if (!existing || law.score > existing.score) {
      merged.set(key, law);
    }
  }

  return Array.from(merged.values()).sort((a, b) => b.score - a.score).slice(0, MAX_RELATED_LAWS);
}

function selectRelatedLawsWithFallback(
  intent: QueryIntent,
  query: string,
  retrievedRelatedLaws: RelatedLaw[],
): RelatedLaw[] {
  if (isBankLoanQuery(query)) {
    const bankFallback = buildBankLoanFallbackRelatedLaws(query);

    if (!hasBankLoanCanonicalRelatedLaw(retrievedRelatedLaws)) {
      return bankFallback;
    }

    return mergeRelatedLawsByKey(retrievedRelatedLaws, bankFallback);
  }

  if (isTrafficIncidentQuestion(query)) {
    const trafficFallback = buildIntentFallbackRelatedLaws('traffic', query);

    if (!hasTrafficIncidentCanonicalRelatedLaw(retrievedRelatedLaws)) {
      return trafficFallback;
    }

    return mergeRelatedLawsByKey(retrievedRelatedLaws, trafficFallback);
  }

  return retrievedRelatedLaws.length > 0
    ? retrievedRelatedLaws
    : buildIntentFallbackRelatedLaws(intent, query);
}

function buildShuukhCaseUrl(caseId: string): string {
  const normalizedCaseId = String(caseId).trim();
  return normalizedCaseId ? `${SHUUKH_BASE_URL}/single_case/${normalizedCaseId}` : '';
}

function resolveRelatedCaseIntent(query: string, intent: QueryIntent): QueryIntent {
  if (intent !== 'unknown') {
    return intent;
  }

  if (TRAFFIC_CASE_QUERY_PATTERN.test(query)) {
    return 'traffic';
  }

  return intent;
}

function buildCaseSummary(summaryText: string, document: string): string {
  const raw = (summaryText || document || '').replace(/\s+/g, ' ').trim();
  if (!raw) {
    return '';
  }

  if (raw.length <= 260) {
    return raw;
  }

  return `${raw.slice(0, 257).trimEnd()}...`;
}

type ShuukhCaseTrack = 'civil' | 'criminal' | 'unknown';
type TrafficCaseSubdomain = 'insurance' | 'injury' | 'propertyDamage' | 'dui' | 'fatalAccident';

interface TrafficSubdomainRule {
  key: TrafficCaseSubdomain;
  queryPatterns: RegExp[];
  resultPatterns: RegExp[];
  civilWeight: number;
  criminalWeight: number;
  matchBoost: number;
  mismatchMultiplier: number;
}

interface TrafficCaseProfile {
  preference: ShuukhCaseTrack | 'neutral';
  subdomains: TrafficCaseSubdomain[];
  specificity: number;
}

const TRAFFIC_CIVIL_QUERY_PATTERNS: RegExp[] = [
  /даатгал|каско|даатгагч|даатгуулагч/i,
  /нөхөн\s*төлбөр|төлбөр|хохирол|гэм\s*хор/i,
  /иргэний/i,
];

const TRAFFIC_CRIMINAL_QUERY_PATTERNS: RegExp[] = [
  /согтууруулах|согтуу/i,
  /эрүүгийн|гэмт\s+хэрэг|ял|шүүгдэгч/i,
  /зөрчил|торгууль|жолоодох\s+эрх/i,
  /зугт|шийтгэх\s+тогтоол|улсын\s+яллагч/i,
  /амь\s+нас|хүнд\s+гэмтэл/i,
];

const TRAFFIC_CIVIL_RESULT_PATTERNS: RegExp[] = [
  /иргэний\s+хэрэг|шүүхийн\s+шийдвэр/i,
  /даатгал|каско|даатгагч|даатгуулагч/i,
  /нөхөн\s*төлбөр|хохирол|гэм\s*хор/i,
];

const TRAFFIC_CRIMINAL_RESULT_PATTERNS: RegExp[] = [
  /эрүүгийн\s+хэрэг|шийтгэх\s+тогтоол/i,
  /согтууруулах|согтуу/i,
  /шүүгдэгч|улсын\s+яллагч|ял/i,
  /зөрчил|жолоодох\s+эрх|торгууль|зугт/i,
];

const TRAFFIC_SUBDOMAIN_RULES: TrafficSubdomainRule[] = [
  {
    key: 'insurance',
    queryPatterns: [
      /даатгал|каско|даатгагч|даатгуулагч/i,
      /албан\s+журмын\s+даатгал|жолоочийн\s+хариуцлагын\s+даатгал/i,
    ],
    resultPatterns: [
      /даатгал|каско|даатгагч|даатгуулагч/i,
      /албан\s+журмын\s+даатгал|жолоочийн\s+хариуцлагын\s+даатгал/i,
    ],
    civilWeight: 3.2,
    criminalWeight: 0,
    matchBoost: 0.18,
    mismatchMultiplier: 0.72,
  },
  {
    key: 'injury',
    queryPatterns: [
      /гэмтэл|бэртэл|шарх|эрүүл\s*мэнд/i,
      /эмчилгээ|эмнэлэг|хөдөлмөрийн\s+чадвар|сэтгэл\s+санааны\s+хохирол/i,
    ],
    resultPatterns: [
      /гэмтэл|бэртэл|шарх|эрүүл\s*мэнд/i,
      /эмчилгээ|эмнэлэг|хөдөлмөрийн\s+чадвар|сэтгэл\s+санааны\s+хохирол/i,
    ],
    civilWeight: 0.8,
    criminalWeight: 1.2,
    matchBoost: 0.12,
    mismatchMultiplier: 0.84,
  },
  {
    key: 'propertyDamage',
    queryPatterns: [
      /эд\s*хөрөнгийн?\s+хохирол|хөрөнгийн\s+хохирол/i,
      /машин(?:ы|д)?\s+эвдрэл|тээврийн\s+хэрэгслийн\s+эвдрэл|засвар|үнэлгээ/i,
    ],
    resultPatterns: [
      /эд\s*хөрөнгийн?\s+хохирол|хөрөнгийн\s+хохирол/i,
      /машин(?:ы|д)?\s+эвдрэл|тээврийн\s+хэрэгслийн\s+эвдрэл|засвар|үнэлгээ/i,
    ],
    civilWeight: 2.4,
    criminalWeight: 0.4,
    matchBoost: 0.15,
    mismatchMultiplier: 0.78,
  },
  {
    key: 'dui',
    queryPatterns: [/согтуугаар|согтууруулах|согтуу/i, /мансуур|мансууруулах|хордлоготой/i],
    resultPatterns: [
      /согтуугаар|согтууруулах|согтуу/i,
      /мансуур|мансууруулах|хордлоготой/i,
      /жолоодох\s+эрх\s+хас/i,
    ],
    civilWeight: 0,
    criminalWeight: 3.4,
    matchBoost: 0.18,
    mismatchMultiplier: 0.7,
  },
  {
    key: 'fatalAccident',
    queryPatterns: [/нас\s+бар|амь\s+насаа\s+алд/i, /талийгаач|үхэлд\s+хүрг|хүний\s+амь/i],
    resultPatterns: [/нас\s+бар|амь\s+насаа\s+алд/i, /талийгаач|үхэлд\s+хүрг|хүний\s+амь/i],
    civilWeight: 0,
    criminalWeight: 3.6,
    matchBoost: 0.2,
    mismatchMultiplier: 0.68,
  },
];

const TRAFFIC_SUBDOMAIN_RULES_BY_KEY = new Map<TrafficCaseSubdomain, TrafficSubdomainRule>(
  TRAFFIC_SUBDOMAIN_RULES.map((rule) => [rule.key, rule]),
);

function collectTrafficSubdomainRules(
  text: string,
  patternSet: 'queryPatterns' | 'resultPatterns',
): TrafficSubdomainRule[] {
  const normalized = normalizeText(text);
  return TRAFFIC_SUBDOMAIN_RULES.filter((rule) =>
    rule[patternSet].some((pattern) => pattern.test(normalized)),
  );
}

function resolveTrafficCaseProfile(query: string): TrafficCaseProfile {
  const normalized = normalizeText(query);
  const civilSignals = countRegexMatches(normalized, TRAFFIC_CIVIL_QUERY_PATTERNS);
  const criminalSignals = countRegexMatches(normalized, TRAFFIC_CRIMINAL_QUERY_PATTERNS);
  const subdomainRules = collectTrafficSubdomainRules(normalized, 'queryPatterns');

  const weightedCivilSignals = subdomainRules.reduce(
    (sum, rule) => sum + rule.civilWeight,
    civilSignals,
  );
  const weightedCriminalSignals = subdomainRules.reduce(
    (sum, rule) => sum + rule.criminalWeight,
    criminalSignals,
  );

  let preference: ShuukhCaseTrack | 'neutral' = 'neutral';

  if (weightedCivilSignals !== 0 || weightedCriminalSignals !== 0) {
    if (weightedCivilSignals > weightedCriminalSignals + 0.6) {
      preference = 'civil';
    } else if (weightedCriminalSignals > weightedCivilSignals + 0.6) {
      preference = 'criminal';
    }
  }

  return {
    preference,
    subdomains: subdomainRules.map((rule) => rule.key),
    specificity: subdomainRules.reduce((sum, rule) => sum + rule.matchBoost, 0),
  };
}

function inferTrafficCaseSubdomains(corpus: string): Set<TrafficCaseSubdomain> {
  return new Set(collectTrafficSubdomainRules(corpus, 'resultPatterns').map((rule) => rule.key));
}

function applyTrafficSubdomainBias(
  score: number,
  profile: TrafficCaseProfile,
  caseSubdomains: Set<TrafficCaseSubdomain>,
  track: ShuukhCaseTrack,
): number {
  if (profile.subdomains.length === 0) {
    return score;
  }

  const matchedRules = profile.subdomains
    .map((key) => TRAFFIC_SUBDOMAIN_RULES_BY_KEY.get(key))
    .filter((rule): rule is TrafficSubdomainRule => Boolean(rule));
  const overlappingRules = matchedRules.filter((rule) => caseSubdomains.has(rule.key));

  if (overlappingRules.length > 0) {
    score += Math.min(
      overlappingRules.reduce((sum, rule) => sum + rule.matchBoost, 0),
      0.32,
    );
    if (overlappingRules.length > 1 && overlappingRules.length === matchedRules.length) {
      score += 0.05;
    }
  } else if (profile.specificity >= 0.12) {
    const mismatchMultiplier = matchedRules.reduce(
      (multiplier, rule) => multiplier * rule.mismatchMultiplier,
      1,
    );
    score *= Math.max(0.5, mismatchMultiplier);
    if (caseSubdomains.size > 0) {
      score *= 0.9;
    }
  }

  if (profile.subdomains.includes('insurance') && track === 'civil') {
    score += 0.05;
  }

  if (profile.subdomains.includes('propertyDamage') && track === 'civil') {
    score += 0.04;
  }

  if (
    (profile.subdomains.includes('dui') || profile.subdomains.includes('fatalAccident')) &&
    track === 'criminal'
  ) {
    score += 0.06;
  }

  return score;
}

function extractCourtCategoryFromUrl(urlValue: string): string {
  if (!urlValue) {
    return '';
  }

  try {
    const parsed = new URL(urlValue);
    return parsed.searchParams.get('court_cat')?.trim() ?? '';
  } catch {
    return '';
  }
}

function inferShuukhCaseTrack(metadata: Record<string, unknown>): ShuukhCaseTrack {
  const url = String(metadata.url ?? metadata.documentUrl ?? '').trim();
  const courtCategory = extractCourtCategoryFromUrl(url);
  if (courtCategory === '1') {
    return 'civil';
  }
  if (courtCategory === '2') {
    return 'criminal';
  }

  const corpus = normalizeText(
    `${getMetaTitle(metadata)} ${String(metadata.court ?? '')} ${String(
      metadata.decisionType ?? '',
    )}`,
  );

  const civilSignals = countRegexMatches(corpus, TRAFFIC_CIVIL_RESULT_PATTERNS);
  const criminalSignals = countRegexMatches(corpus, TRAFFIC_CRIMINAL_RESULT_PATTERNS);

  if (civilSignals > criminalSignals) {
    return 'civil';
  }

  if (criminalSignals > civilSignals) {
    return 'criminal';
  }

  return 'unknown';
}

function rerankRelatedCasesByDomain(
  query: string,
  intent: QueryIntent,
  results: ChromaQueryResult[],
  topicPatterns: RegExp[],
  signalTerms: string[],
): ChromaQueryResult[] {
  if (results.length === 0) {
    return results;
  }

  const trafficProfile = intent === 'traffic' ? resolveTrafficCaseProfile(query) : null;

  const scored = results
    .map((result) => {
      const corpus = normalizeText(
        `${getMetaTitle(result.metadata)} ${String(result.metadata.court ?? '')} ${String(
          result.metadata.decisionType ?? '',
        )} ${String(result.metadata.decisionSummary ?? '')} ${result.document?.slice(0, 1600) ?? ''}`,
      );

      let score = result.score;
      const topicMatches = countRegexMatches(corpus, topicPatterns);
      const signalMatches = signalTerms.filter((term) => corpus.includes(term)).length;

      if (topicMatches > 0) {
        score += Math.min(topicMatches * 0.05, 0.18);
      }

      if (signalTerms.length > 0) {
        if (signalMatches === 0) {
          score *= 0.82;
        } else {
          score += Math.min(signalMatches * 0.03, 0.12);
        }
      }

      if (intent === 'traffic') {
        const track = inferShuukhCaseTrack(result.metadata);
        const civilMatches = countRegexMatches(corpus, TRAFFIC_CIVIL_RESULT_PATTERNS);
        const criminalMatches = countRegexMatches(corpus, TRAFFIC_CRIMINAL_RESULT_PATTERNS);
        const caseSubdomains = inferTrafficCaseSubdomains(corpus);
        const trafficPreference = trafficProfile?.preference ?? 'neutral';

        if (trafficPreference === 'civil') {
          if (track === 'civil') score += 0.18;
          if (track === 'criminal') score *= 0.68;
          if (civilMatches > 0) score += Math.min(civilMatches * 0.04, 0.12);
          if (criminalMatches > 0) score *= 0.9;
        } else if (trafficPreference === 'criminal') {
          if (track === 'criminal') score += 0.18;
          if (track === 'civil') score *= 0.68;
          if (criminalMatches > 0) score += Math.min(criminalMatches * 0.04, 0.12);
          if (civilMatches > 0) score *= 0.9;
        } else {
          if (criminalMatches > civilMatches && track === 'criminal') {
            score += 0.08;
          }
          if (civilMatches > criminalMatches && track === 'civil') {
            score += 0.08;
          }
        }

        if (trafficProfile) {
          score = applyTrafficSubdomainBias(score, trafficProfile, caseSubdomains, track);
        }
      }

      return {
        ...result,
        score: Math.max(0, Math.min(1, score)),
      };
    })
    .sort((a, b) => b.score - a.score);

  if (intent !== 'traffic') {
    return scored;
  }

  return enforceTrafficTrackConsistency(query, trafficProfile, scored);
}

function enforceTrafficTrackConsistency(
  query: string,
  profile: TrafficCaseProfile | null,
  results: ChromaQueryResult[],
): ChromaQueryResult[] {
  if (results.length === 0) {
    return results;
  }

  const preference = profile?.preference ?? resolveTrafficCaseProfile(query).preference;
  const tracked = results.map((result) => ({
    result,
    track: inferShuukhCaseTrack(result.metadata),
  }));

  if (preference !== 'neutral') {
    const preferred = tracked
      .filter((item) => item.track === preference)
      .map((item) => item.result);
    const unknown = tracked.filter((item) => item.track === 'unknown').map((item) => item.result);
    if (preferred.length >= 3) {
      return [...preferred, ...unknown].sort((a, b) => b.score - a.score);
    }

    return results;
  }

  const topWindow = tracked.slice(0, 6);
  const civil = topWindow.filter((item) => item.track === 'civil');
  const criminal = topWindow.filter((item) => item.track === 'criminal');
  const civilScore = civil.reduce((sum, item) => sum + item.result.score, 0);
  const criminalScore = criminal.reduce((sum, item) => sum + item.result.score, 0);

  if (
    criminal.length >= 3 &&
    criminal.length >= civil.length + 2 &&
    criminalScore >= civilScore * 1.35
  ) {
    return tracked
      .filter((item) => item.track === 'criminal' || item.track === 'unknown')
      .map((item) => item.result)
      .sort((a, b) => b.score - a.score);
  }

  if (
    civil.length >= 3 &&
    civil.length >= criminal.length + 2 &&
    civilScore >= criminalScore * 1.35
  ) {
    return tracked
      .filter((item) => item.track === 'civil' || item.track === 'unknown')
      .map((item) => item.result)
      .sort((a, b) => b.score - a.score);
  }

  return results;
}

function applyRelatedCaseFiltering(
  query: string,
  intent: QueryIntent,
  results: ChromaQueryResult[],
): ChromaQueryResult[] {
  if (results.length === 0) {
    return results;
  }

  const topicPatterns = getTopicSignalPatterns(query);
  const signalTerms = extractArticleBoostSignalTerms(query).filter((term) => term.length >= 3);

  const filtered = results.filter((result) => {
    if (String(result.metadata.source ?? '') !== 'shuukh') {
      return false;
    }

    if (result.score < MIN_LAW_CASE_SCORE) {
      return false;
    }

    const corpus = normalizeText(
      `${getMetaTitle(result.metadata)} ${String(result.metadata.court ?? '')} ${String(
        result.metadata.decisionType ?? '',
      )} ${String(result.metadata.decisionSummary ?? '')} ${result.document?.slice(0, 1600) ?? ''}`,
    );

    if (intent !== 'unknown') {
      const inferredIntent = inferDomainFromCorpus(corpus);
      if (inferredIntent !== 'unknown' && inferredIntent !== intent) {
        return false;
      }
    }

    if (topicPatterns.length > 0 && topicPatterns.some((pattern) => pattern.test(corpus))) {
      return true;
    }

    if (signalTerms.length === 0) {
      return true;
    }

    return signalTerms.some((term) => corpus.includes(term));
  });

  if (filtered.length === 0) {
    const fallback = results.filter(
      (result) =>
        String(result.metadata.source ?? '') === 'shuukh' && result.score >= MIN_LAW_CASE_SCORE,
    );
    return rerankRelatedCasesByDomain(query, intent, fallback, topicPatterns, signalTerms);
  }

  return rerankRelatedCasesByDomain(query, intent, filtered, topicPatterns, signalTerms);
}

function buildRelatedCases(
  query: string,
  intent: QueryIntent,
  chunks: ChromaQueryResult[],
): RelatedCase[] {
  const seen = new Map<string, RelatedDisplayCandidate<RelatedCase>>();
  const filteredChunks = applyRelatedCaseFiltering(query, intent, chunks);

  for (const chunk of filteredChunks) {
    const meta = chunk.metadata;
    if (String(meta.source ?? '') !== 'shuukh') {
      continue;
    }

    const caseId = String(meta.caseId ?? '').trim();
    const caseNumber = String(meta.caseNumber ?? meta.case_id ?? '').trim();
    const url = getMetaUrl(meta) || buildShuukhCaseUrl(caseId);
    const title = getMetaTitle(meta);
    const summary = buildCaseSummary(
      String(meta.decisionSummary ?? ''),
      String(chunk.document ?? ''),
    );
    const court = String(meta.court ?? '').trim();
    const decisionType = String(meta.decisionType ?? '').trim();
    const key = caseId || url || `${title}:${caseNumber}`;

    if (!key || seen.has(key)) {
      continue;
    }

    seen.set(key, {
      title: title || (caseNumber ? `Шүүхийн хэрэг №${caseNumber}` : 'Шүүхийн хэрэг'),
      caseNumber,
      url,
      score: roundScore(chunk.score),
      evidenceScore: getEvidenceScore(chunk),
      summary: summary || undefined,
      court: court || undefined,
      decisionType: decisionType || undefined,
    });
  }

  return finalizeDisplayScores(
    Array.from(seen.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RELATED_CASES),
  );
}

type IntentFallbackLaw = {
  title: string;
  lawId: string;
  articleNo?: string;
  sword?: string;
  score: number;
};

function buildBankLoanFallbackRelatedLaws(query: string): RelatedLaw[] {
  const subtype = resolveContractSubtype(query);
  if (subtype === 'generic_contract') {
    return [];
  }

  const entries: IntentFallbackLaw[] = [
    {
      title: 'Иргэний хууль §452: Банк, зээлийн үйл ажиллагаа эрхлэх эрх бүхий этгээдээс олгох зээлийн хүү',
      lawId: '299',
      articleNo: '452',
      sword: 'зээлийн хүү',
      score: 0.88,
    },
    {
      title: 'Иргэний хууль §451: Банк, зээлийн үйл ажиллагаа эрхлэх эрх бүхий хуулийн этгээдээс зээл олгох гэрээ',
      lawId: '299',
      articleNo: '451',
      sword: 'зээл олгох гэрээ',
      score: 0.86,
    },
    {
      title: 'Иргэний хууль §453: Зээлдэгчийн үүрэг, хариуцлагатай холбоотой зохицуулалт',
      lawId: '299',
      articleNo: '453',
      sword: 'зээлдэгч',
      score: 0.78,
    },
    {
      title:
        'Банк, эрх бүхий хуулийн этгээдийн мөнгөн хадгаламж, мөнгөн хөрөнгийн шилжүүлэг, зээлийн үйл ажиллагааны тухай §20: Зээлийн гэрээ',
      lawId: '16230554816671',
      articleNo: '20',
      sword: 'зээлийн гэрээ',
      score: 0.76,
    },
  ];

  if (subtype === 'bank_loan_collateral') {
    entries.push(
      {
        title: 'Үл хөдлөх эд хөрөнгийн барьцааны тухай хууль',
        lawId: '118',
        sword: 'барьцаа',
        score: 0.72,
      },
      {
        title: 'Хөдлөх эд хөрөнгө болон эдийн бус хөрөнгийн барьцааны тухай хууль',
        lawId: '11220',
        sword: 'барьцааны эрх',
        score: 0.7,
      },
    );
  }

  if (subtype === 'credit_information') {
    entries.push({
      title: 'Зээлийн мэдээллийн тухай хууль',
      lawId: '9175',
      sword: 'зээлийн мэдээлэл',
      score: 0.74,
    });
  }

  return finalizeDisplayScores(
    entries
      .map((entry) => {
        const sword = entry.sword || entry.articleNo || '';
        const url = sword
          ? (buildLawUrlWithSword(entry.lawId, sword) ?? buildLawUrl(entry.lawId) ?? '')
          : (buildLawUrl(entry.lawId) ?? '');

        return {
          title: entry.title,
          articleNo: entry.articleNo ?? '',
          url,
          score: entry.score,
          evidenceScore: entry.score,
        };
      })
      .filter((law) => Boolean(law.url))
      .slice(0, MAX_RELATED_LAWS),
  );
}

function buildIntentFallbackRelatedLaws(intent: QueryIntent, query: string): RelatedLaw[] {
  const requestedArticle = extractRequestedArticleNumber(query);
  const familyPrimaryArticle = requestedArticle || '33.1';

  if (isAdministrativeReviewQuery(query)) {
    return finalizeDisplayScores([
      {
        title: 'Захиргааны ерөнхий хууль',
        articleNo: '',
        url: 'https://legalinfo.mn/mn/search?keyword=%D0%B7%D0%B0%D1%85%D0%B8%D1%80%D0%B3%D0%B0%D0%B0%D0%BD%D1%8B%20%D0%B5%D1%80%D3%A9%D0%BD%D1%85%D0%B8%D0%B9%20%D1%85%D1%83%D1%83%D0%BB%D1%8C',
        score: 0.78,
        evidenceScore: 0.78,
      },
      {
        title: 'Захиргааны хэрэг шүүхэд хянан шийдвэрлэх тухай хууль',
        articleNo: '',
        url: 'https://legalinfo.mn/mn/search?keyword=%D0%B7%D0%B0%D1%85%D0%B8%D1%80%D0%B3%D0%B0%D0%B0%D0%BD%D1%8B%20%D1%85%D1%8D%D1%80%D1%8D%D0%B3%20%D1%88%D2%AF%D2%AF%D1%85%D1%8D%D0%B4%20%D1%85%D1%8F%D0%BD%D0%B0%D0%BD%20%D1%88%D0%B8%D0%B9%D0%B4%D0%B2%D1%8D%D1%80%D0%BB%D1%8D%D1%85',
        score: 0.74,
        evidenceScore: 0.74,
      },
      {
        title: 'Иргэдээс төрийн байгууллага, албан тушаалтанд гаргасан өргөдөл, гомдлыг шийдвэрлэх тухай хууль',
        articleNo: '',
        url: 'https://legalinfo.mn/mn/search?keyword=%D3%A9%D1%80%D0%B3%D3%A9%D0%B4%D3%A9%D0%BB%20%D0%B3%D0%BE%D0%BC%D0%B4%D0%BE%D0%BB',
        score: 0.72,
        evidenceScore: 0.72,
      },
    ]);
  }

  if (isLandRegistrationDisputeQuery(query)) {
    return finalizeDisplayScores([
      {
        title: 'Газрын тухай хууль',
        articleNo: '',
        url: 'https://legalinfo.mn/mn/search?keyword=%D0%B3%D0%B0%D0%B7%D1%80%D1%8B%D0%BD%20%D1%82%D1%83%D1%85%D0%B0%D0%B9%20%D1%85%D1%83%D1%83%D0%BB%D1%8C%20%D0%BA%D0%B0%D0%B4%D0%B0%D1%81%D1%82%D1%80',
        score: 0.78,
        evidenceScore: 0.78,
      },
      {
        title: 'Эд хөрөнгийн эрхийн улсын бүртгэлийн тухай хууль',
        articleNo: '',
        url: 'https://legalinfo.mn/mn/search?keyword=%D1%8D%D0%B4%20%D1%85%D3%A9%D1%80%D3%A9%D0%BD%D0%B3%D0%B8%D0%B9%D0%BD%20%D1%8D%D1%80%D1%85%D0%B8%D0%B9%D0%BD%20%D1%83%D0%BB%D1%81%D1%8B%D0%BD%20%D0%B1%D2%AF%D1%80%D1%82%D0%B3%D1%8D%D0%BB',
        score: 0.7,
        evidenceScore: 0.7,
      },
    ]);
  }

  if (isCivilServiceDisciplineQuery(query)) {
    return finalizeDisplayScores([
      {
        title: 'Төрийн албаны тухай хууль',
        articleNo: '',
        url: 'https://legalinfo.mn/mn/search?keyword=%D1%82%D3%A9%D1%80%D0%B8%D0%B9%D0%BD%20%D0%B0%D0%BB%D0%B1%D0%B0%D0%BD%D1%8B%20%D1%82%D1%83%D1%85%D0%B0%D0%B9%20%D1%85%D1%83%D1%83%D0%BB%D1%8C%20%D1%81%D0%B0%D1%85%D0%B8%D0%BB%D0%B3%D1%8B%D0%BD',
        score: 0.78,
        evidenceScore: 0.78,
      },
      {
        title: 'Захиргааны ерөнхий хууль',
        articleNo: '',
        url: 'https://legalinfo.mn/mn/search?keyword=%D0%B7%D0%B0%D1%85%D0%B8%D1%80%D0%B3%D0%B0%D0%B0%D0%BD%D1%8B%20%D0%B5%D1%80%D3%A9%D0%BD%D1%85%D0%B8%D0%B9%20%D1%85%D1%83%D1%83%D0%BB%D1%8C',
        score: 0.68,
        evidenceScore: 0.68,
      },
    ]);
  }

  if (isDefamationQuery(query)) {
    return finalizeDisplayScores([
      {
        title: 'Эрүүгийн хууль',
        articleNo: '',
        url: buildLawUrlWithSword('12172', 'гүтгэх') ?? buildLawUrl('12172') ?? '',
        score: 0.78,
        evidenceScore: 0.78,
      },
      {
        title: 'Иргэний хууль',
        articleNo: '',
        url: buildLawUrlWithSword('299', 'нэр төр') ?? buildLawUrl('299') ?? '',
        score: 0.68,
        evidenceScore: 0.68,
      },
    ]);
  }

  if (isPropertyDamageCrimeQuery(query)) {
    return finalizeDisplayScores([
      {
        title: 'Эрүүгийн хууль',
        articleNo: '',
        url: buildLawUrlWithSword('12172', 'эд хөрөнгө гэмтээх') ?? buildLawUrl('12172') ?? '',
        score: 0.78,
        evidenceScore: 0.78,
      },
      {
        title: 'Иргэний хууль §497',
        articleNo: '497',
        url: buildLawUrlWithSword('299', '497') ?? buildLawUrl('299') ?? '',
        score: 0.7,
        evidenceScore: 0.7,
      },
    ]);
  }

  if (isCyberFraudQuery(query)) {
    return finalizeDisplayScores([
      {
        title: 'Эрүүгийн хууль §17.3: Залилах',
        articleNo: '17.3',
        url: buildLawUrlWithSword('12172', 'залилах') ?? buildLawUrl('12172') ?? '',
        score: 0.86,
        evidenceScore: 0.86,
      },
      {
        title: 'Эрүүгийн хэрэг хянан шийдвэрлэх тухай хууль §14: Нотлох баримт цуглуулж, бэхжүүлэх',
        articleNo: '14',
        url: buildLawUrlWithSword('12694', 'нотлох баримт') ?? buildLawUrl('12694') ?? '',
        score: 0.76,
        evidenceScore: 0.76,
      },
      {
        title: 'Цагдаагийн албаны тухай хууль',
        articleNo: '',
        url: buildLawUrlWithSword('12469', 'гомдол мэдээлэл') ?? buildLawUrl('12469') ?? '',
        score: 0.7,
        evidenceScore: 0.7,
      },
      {
        title: 'Харилцаа холбооны тухай хууль',
        articleNo: '',
        url: buildLawUrlWithSword('523', 'харилцаа холбоо') ?? buildLawUrl('523') ?? '',
        score: 0.62,
        evidenceScore: 0.62,
      },
    ]);
  }

  if (isPublicNoiseComplaintQuery(query)) {
    return finalizeDisplayScores([
      {
        title: 'Зөрчлийн тухай хууль',
        articleNo: '',
        url: buildLawUrlWithSword('12695', 'амгалан тайван') ?? buildLawUrl('12695') ?? '',
        score: 0.72,
        evidenceScore: 0.72,
      },
      {
        title: 'Цагдаагийн албаны тухай хууль',
        articleNo: '',
        url: buildLawUrlWithSword('12469', 'гомдол мэдээлэл') ?? buildLawUrl('12469') ?? '',
        score: 0.66,
        evidenceScore: 0.66,
      },
    ]);
  }

  if (isBankLoanQuery(query)) {
    return buildBankLoanFallbackRelatedLaws(query);
  }

  const fallbackByIntent: Record<Exclude<QueryIntent, 'unknown'>, IntentFallbackLaw[]> = {
    family: [
      {
        title: `Гэр бүлийн тухай хууль §${familyPrimaryArticle}`,
        lawId: '226',
        articleNo: familyPrimaryArticle,
        sword: 'харилцах эрх',
        score: 0.82,
      },
      {
        title: 'Гэр бүлийн тухай хууль §33.2',
        lawId: '226',
        articleNo: '33.2',
        sword: 'харилцах эрх',
        score: 0.8,
      },
      {
        title: 'Гэр бүлийн тухай хууль §31.1',
        lawId: '226',
        articleNo: '31.1',
        sword: 'хүүхдийн эрх',
        score: 0.77,
      },
      {
        title: 'Гэр бүлийн тухай хууль §32.1',
        lawId: '226',
        articleNo: '32.1',
        sword: 'асран хамгаалах',
        score: 0.75,
      },
      {
        title: 'Гэр бүлийн тухай хууль §36.1',
        lawId: '226',
        articleNo: '36.1',
        sword: 'асран хамгаалах',
        score: 0.73,
      },
      {
        title: 'Гэр бүлийн тухай хууль §26.1',
        lawId: '226',
        articleNo: '26.1',
        sword: 'эцэг эх',
        score: 0.71,
      },
      {
        title: 'Гэр бүлийн тухай хууль §14.1',
        lawId: '226',
        articleNo: '14.1',
        sword: 'гэрлэлт',
        score: 0.69,
      },
      {
        title: 'Гэр бүлийн хүчирхийлэлтэй тэмцэх тухай хууль §6.1',
        lawId: '12393',
        articleNo: '6.1',
        sword: 'хамгаалах',
        score: 0.66,
      },
      {
        title: 'Хүүхэд харах үйлчилгээний тухай хууль §5.1',
        lawId: '11223',
        articleNo: '5.1',
        sword: 'хүүхэд',
        score: 0.64,
      },
      {
        title: 'Иргэний хэрэг шүүхэд хянан шийдвэрлэх тухай хууль §65.1',
        lawId: '11220',
        articleNo: '65.1',
        sword: 'гэр бүл',
        score: 0.61,
      },
      {
        title: 'Иргэний хууль §497.1',
        lawId: '299',
        articleNo: '497.1',
        sword: 'хохирол',
        score: 0.58,
      },
    ],
    contract: [
      {
        title: 'Иргэний хууль §225.1',
        lawId: '299',
        articleNo: '225.1',
        sword: 'үүрэг',
        score: 0.74,
      },
      {
        title: 'Иргэний хууль §229.1',
        lawId: '299',
        articleNo: '229.1',
        sword: 'алданги',
        score: 0.71,
      },
      {
        title: 'Иргэний хууль §224.1',
        lawId: '299',
        articleNo: '224.1',
        sword: 'хохирол',
        score: 0.69,
      },
      {
        title: 'Иргэний хууль §240.1',
        lawId: '299',
        articleNo: '240.1',
        sword: 'цуцлах',
        score: 0.66,
      },
      {
        title: 'Иргэний хэрэг шүүхэд хянан шийдвэрлэх тухай хууль §65.1',
        lawId: '11220',
        articleNo: '65.1',
        sword: 'нэхэмжлэл',
        score: 0.6,
      },
    ],
    labor: [
      {
        title: 'Хөдөлмөрийн тухай хууль §43.1',
        lawId: '16230709635751',
        articleNo: '43.1',
        sword: 'хөдөлмөрийн гэрээ',
        score: 0.74,
      },
      {
        title: 'Хөдөлмөрийн тухай хууль §57.1',
        lawId: '16230709635751',
        articleNo: '57.1',
        sword: 'цалин',
        score: 0.72,
      },
      {
        title: 'Хөдөлмөрийн тухай хууль §80.1',
        lawId: '16230709635751',
        articleNo: '80.1',
        sword: 'цуцлах',
        score: 0.68,
      },
      {
        title: 'Хөдөлмөрийн аюулгүй байдал, эрүүл ахуйн тухай хууль §10.1',
        lawId: '564',
        articleNo: '10.1',
        sword: 'аюулгүй байдал',
        score: 0.61,
      },
    ],
    traffic: [
      {
        title: 'Зөрчлийн тухай хууль §14.7',
        lawId: '12695',
        articleNo: '14.7',
        sword: 'замын хөдөлгөөний дүрэм',
        score: 0.82,
      },
      {
        title: 'Замын хөдөлгөөний аюулгүй байдлын тухай хууль §5.1',
        lawId: '11224',
        articleNo: '5.1',
        sword: 'жолооч',
        score: 0.78,
      },
      {
        title: 'Иргэний хууль §497',
        lawId: '299',
        articleNo: '497',
        sword: 'гэм хор',
        score: 0.74,
      },
    ],
    crime: [
      {
        title: 'Эрүүгийн хууль §17.1',
        lawId: '12172',
        articleNo: '17.1',
        sword: 'гэмт хэрэг',
        score: 0.73,
      },
      {
        title: 'Цагдаагийн албаны тухай хууль §10.1',
        lawId: '12469',
        articleNo: '10.1',
        sword: 'эрэн сурвалжлах',
        score: 0.71,
      },
      {
        title: 'Эрүүгийн хэрэг хянан шийдвэрлэх тухай хууль §26.2',
        lawId: '12694',
        articleNo: '26.2',
        sword: 'мөрдөн байцаах',
        score: 0.68,
      },
      {
        title: 'Эрүүгийн хууль §13.1',
        lawId: '12172',
        articleNo: '13.1',
        sword: 'хүчин',
        score: 0.66,
      },
      {
        title: 'Зөрчлийн тухай хууль §10.1',
        lawId: '12695',
        articleNo: '10.1',
        sword: 'хулгай',
        score: 0.64,
      },
      {
        title: 'Харилцаа холбооны тухай хууль §32.1',
        lawId: '523',
        articleNo: '32.1',
        sword: 'төхөөрөмж',
        score: 0.62,
      },
      {
        title: 'Гэрч, хохирогчийг хамгаалах тухай хууль §7.1',
        lawId: '9287',
        articleNo: '7.1',
        sword: 'хохирогч',
        score: 0.59,
      },
    ],
    election: [
      {
        title: 'Монгол Улсын Үндсэн хууль',
        lawId: '367',
        score: 0.69,
      },
      {
        title: 'Иргэний хууль §9.1',
        lawId: '299',
        articleNo: '9.1',
        sword: 'эрх',
        score: 0.58,
      },
    ],
    tax: [
      {
        title: 'Татварын ерөнхий хууль',
        lawId: '13830',
        score: 0.68,
      },
      {
        title: 'Иргэний хууль §497.1',
        lawId: '299',
        articleNo: '497.1',
        sword: 'хариуцлага',
        score: 0.55,
      },
    ],
    socialInsurance: [
      {
        title: 'Нийгмийн даатгалын ерөнхий хууль',
        lawId: '12297',
        score: 0.68,
      },
      {
        title: 'Хөдөлмөрийн тухай хууль §57.1',
        lawId: '16230709635751',
        articleNo: '57.1',
        sword: 'шимтгэл',
        score: 0.56,
      },
    ],
  };

  if (intent === 'unknown') {
    return [];
  }

  const entries = fallbackByIntent[intent] ?? [];
  return finalizeDisplayScores(
    entries
      .map((entry) => {
        const sword = entry.articleNo || entry.sword || '';
        const url = sword
          ? (buildLawUrlWithSword(entry.lawId, sword) ?? buildLawUrl(entry.lawId) ?? '')
          : (buildLawUrl(entry.lawId) ?? '');

        return {
          title: entry.title,
          articleNo: entry.articleNo ?? '',
          url,
          score: entry.score,
          evidenceScore: entry.score,
        };
      })
      .filter((law) => Boolean(law.url))
      .slice(0, MAX_RELATED_LAWS),
  );
}

function isLowAuthorityTitle(title: string): boolean {
  const normalized = title.trim();
  if (!normalized) {
    return true;
  }

  return /(ойг\s+тохиолдуулан|өршөөл\s+үзүүлэх|хөтөлбөр\s+батлах|жагсаалт\s+батлах|дүгнэлт|тогтоол|журам\s+батлах|журмын\s+тухай)/i.test(
    normalized,
  );
}

export const __test__ = {
  buildSearchQueries,
  buildIntentFallbackRelatedLaws,
  getRetrievalRuntimeConfig,
  isTrafficIncidentQuestion,
  isTrafficIncidentRelevantResult,
  resolveTrafficIncidentSubtype,
  resolveContractSubtype,
  isBankLoanRelevantResult,
  applyBankLoanFiltering,
  buildBankLoanFallbackRelatedLaws,
  shouldRetrieveRelatedCasesForQuery,
};
