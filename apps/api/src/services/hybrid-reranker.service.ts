import type { AppEnv } from '../config/env.js';
import type { ChromaQueryResult } from '../lib/vector-db.js';
import type { QueryIntent } from './query-rewrite.service.js';
import {
  countKeywordOverlap,
  extractRetrievalKeywordProfile,
  type RetrievalKeywordProfile,
} from './keyword-extraction.service.js';

interface HybridRerankOptions {
  intent?: QueryIntent;
  enrichmentTerms?: string[];
  preferredLawIds?: string[];
  keywordProfile?: RetrievalKeywordProfile;
  topN?: number;
}

interface HybridScoreParts {
  cosine: number;
  keywordBonus: number;
  titleBonus: number;
  lawBonus: number;
  knowledgeBonus: number;
  enrichmentBonus: number;
  storedKeywordBonus: number;
}

const MONGOLIAN_SUFFIX_PATTERN =
  /(ийн|ын|ийнх|ийнг|ыг|ийг|тай|тэй|гүй|аар|ээр|оор|өөр|аас|ээс|оос|өөс|ууд|үүд|нууд|нүүд|д|т)$/iu;

const LAW_NAME_HINTS = [
  'иргэний хууль',
  'эрүүгийн хууль',
  'зөрчлийн тухай хууль',
  'замын хөдөлгөөний аюулгүй байдлын тухай хууль',
  'даатгалын тухай',
  'банкны тухай',
  'банк, эрх бүхий хуулийн этгээдийн мөнгөн хадгаламж, мөнгөн хөрөнгийн шилжүүлэг, зээлийн үйл ажиллагааны тухай',
  'зээлийн мэдээллийн тухай',
  'гэр бүлийн тухай',
  'хөдөлмөрийн тухай',
  'иргэний хэрэг шүүхэд хянан шийдвэрлэх тухай',
  'эрүүгийн хэрэг хянан шийдвэрлэх тухай',
  'хувь хүний мэдээлэл хамгаалах тухай',
  'кибер аюулгүй байдлын тухай',
  'хэрэглэгчийн эрхийг хамгаалах тухай',
  'газрын тухай',
  'эд хөрөнгийн эрхийн улсын бүртгэлийн тухай',
  'захиргааны ерөнхий хууль',
  'зөвшөөрлийн тухай',
];

const DOMAIN_KNOWLEDGE_TERMS: Record<Exclude<QueryIntent, 'unknown'>, string[]> = {
  crime: [
    'эрүү',
    'гэмт',
    'ял',
    'цагдаа',
    'прокурор',
    'шүүх',
    'мөрдөн',
    'хулгай',
    'залилан',
    'луйвар',
    'кибер',
    'фишинг',
    'хувийн мэдээлэл',
  ],
  traffic: [
    'жолоо',
    'жолооч',
    'тээврийн',
    'замын',
    'осол',
    'согтууруулах',
    'даатгал',
    'хохирол',
  ],
  election: ['сонгууль', 'сонгогч', 'санал', 'үндсэн', 'мандат'],
  contract: [
    'гэрээ',
    'үүрэг',
    'төлбөр',
    'зээл',
    'барьцаа',
    'даатгал',
    'нөхөн',
    'хохирол',
    'хэрэглэгч',
    'бараа',
    'өв',
    'газар',
    'кадастр',
    'бүртгэл',
    'зөвшөөрөл',
  ],
  tax: ['татвар', 'алданги', 'торгууль', 'нөат', 'тайлан'],
  socialInsurance: ['шимтгэл', 'даатгал', 'тэтгэвэр', 'тэтгэмж', 'ажилгүйдэл'],
  labor: ['ажил', 'ажилтан', 'ажил олгогч', 'цалин', 'амралт', 'ажлаас', 'халах'],
  family: ['гэр бүл', 'хүүхэд', 'салалт', 'асрамж', 'тэтгэлэг', 'уулзуулах'],
};

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function stemToken(token: string): string {
  return token.replace(MONGOLIAN_SUFFIX_PATTERN, '');
}

function tokenize(text: string): string[] {
  return normalizeText(text)
    .replace(/[.,!?;:"'`()\[\]{}\\/]+/g, ' ')
    .split(/\s+/)
    .map((token) => stemToken(token.trim()))
    .filter((token) => token.length >= 2);
}

function uniqueTokens(text: string): string[] {
  return Array.from(new Set(tokenize(text)));
}

function countMatches(tokens: string[], corpus: string): number {
  if (tokens.length === 0 || !corpus) {
    return 0;
  }

  return tokens.reduce((count, token) => count + (corpus.includes(token) ? 1 : 0), 0);
}

function parseStoredKeywords(metadata: Record<string, unknown>): string[] {
  const raw = metadata.keywords ?? metadata.storedKeywords ?? metadata.keywordList ?? null;
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item));
  }

  if (typeof raw === 'string') {
    return raw
      .split(/[,;|]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function buildLawNameHints(query: string): string[] {
  const normalized = normalizeText(query);
  return LAW_NAME_HINTS.filter((hint) => normalized.includes(hint));
}

function computeHybridScoreParts(
  query: string,
  candidate: ChromaQueryResult,
  options: HybridRerankOptions,
): HybridScoreParts {
  const profile = options.keywordProfile ?? extractRetrievalKeywordProfile(query);
  const title = String(
    candidate.metadata.title ?? candidate.metadata.documentTitle ?? candidate.metadata.articleTitle ?? '',
  );
  const documentText = String(candidate.document ?? '');
  const titleCorpus = normalizeText(title);
  const fullCorpus = normalizeText(`${title} ${documentText.slice(0, 1600)}`);
  const queryTokens = Array.from(
    new Set([...profile.topicalTerms, ...profile.phrases.flatMap((phrase) => uniqueTokens(phrase))]),
  );
  const queryTokenCount = Math.max(queryTokens.length, 1);
  const cosine = Math.max(0, Math.min(1, candidate.rawScore ?? candidate.score));

  const keywordMatches = countMatches(queryTokens, fullCorpus);
  const titleMatches = countMatches(queryTokens, titleCorpus);
  const storedKeywordMatches = countKeywordOverlap(
    parseStoredKeywords(candidate.metadata),
    profile.topicalTerms,
  );
  const enrichmentTokens = uniqueTokens(
    [...(options.enrichmentTerms ?? []), ...profile.expansionTerms].join(' '),
  ).filter(
    (term) => !queryTokens.includes(term),
  );
  const enrichmentMatches = countMatches(enrichmentTokens, fullCorpus);
  const knowledgeTokens =
    options.intent && options.intent !== 'unknown'
      ? uniqueTokens(DOMAIN_KNOWLEDGE_TERMS[options.intent].join(' '))
      : [];
  const knowledgeMatches = countMatches(knowledgeTokens, fullCorpus);
  const lawNameHints = Array.from(new Set([...buildLawNameHints(query), ...profile.lawHints]));
  const lawMatch =
    lawNameHints.some((hint) => titleCorpus.includes(hint)) ||
    (options.preferredLawIds ?? []).includes(String(candidate.metadata.sourceId ?? candidate.metadata.lawId ?? ''));

  return {
    cosine,
    keywordBonus: Math.min(keywordMatches, 4) * 0.08,
    titleBonus: Math.min(1, titleMatches / queryTokenCount) * 0.2,
    lawBonus: lawMatch ? 0.15 : 0,
    knowledgeBonus: Math.min(1, knowledgeMatches / Math.max(knowledgeTokens.length, 1)) * 0.12,
    enrichmentBonus: Math.min(enrichmentMatches, 1) * 0.15,
    storedKeywordBonus: Math.min(storedKeywordMatches, 1) * 0.06,
  };
}

function applyHybridScore(
  query: string,
  candidate: ChromaQueryResult,
  options: HybridRerankOptions,
): ChromaQueryResult {
  const parts = computeHybridScoreParts(query, candidate, options);
  const hybridScore = Math.max(
    0,
    Math.min(
      1,
      parts.cosine +
        parts.keywordBonus +
        parts.titleBonus +
        parts.lawBonus +
        parts.knowledgeBonus +
        parts.enrichmentBonus +
        parts.storedKeywordBonus,
    ),
  );

  return {
    ...candidate,
    score: hybridScore,
    rawScore: parts.cosine,
  };
}

let crossEncoderPromise: Promise<unknown> | null = null;

async function getCrossEncoder(modelName: string): Promise<unknown> {
  if (!crossEncoderPromise) {
    crossEncoderPromise = (async () => {
      const { pipeline } = await import('@xenova/transformers');
      return pipeline('text-classification', modelName as any, { quantized: true } as any);
    })();
  }

  return crossEncoderPromise;
}

async function applyOptionalCrossRerank(
  env: AppEnv,
  query: string,
  candidates: ChromaQueryResult[],
  topN: number,
): Promise<ChromaQueryResult[]> {
  if (!env.USE_CROSS_RERANKER || candidates.length === 0) {
    return candidates.slice(0, topN);
  }

  const limited = candidates.slice(0, Math.min(env.CROSS_RERANKER_TOP_N, candidates.length));

  try {
    const reranker = (await getCrossEncoder(env.CROSS_RERANKER_MODEL)) as (
      inputs: string[],
      options?: Record<string, unknown>,
    ) => Promise<Array<{ label?: string; score?: number } | Array<{ label?: string; score?: number }>>>;

    const inputs = limited.map((candidate) => {
      const title = String(candidate.metadata.title ?? candidate.metadata.documentTitle ?? '');
      const body = String(candidate.document ?? '').slice(0, 800);
      return `${query} [SEP] ${title}\n${body}`;
    });

    const outputs = await reranker(inputs, { topk: 1 } as Record<string, unknown>);
    const rescored = limited.map((candidate, index) => {
      const output = outputs[index];
      const top = Array.isArray(output) ? output[0] : output;
      const crossScore = Math.max(0, Math.min(1, Number(top?.score ?? 0)));

      return {
        ...candidate,
        score: Math.max(0, Math.min(1, candidate.score * 0.6 + crossScore * 0.4)),
      };
    });

    return rescored.sort((a, b) => b.score - a.score).slice(0, topN);
  } catch (error) {
    console.warn(
      {
        error: error instanceof Error ? error.message : String(error),
        model: env.CROSS_RERANKER_MODEL,
      },
      'Cross reranker unavailable, using hybrid reranker scores only',
    );
    return candidates.slice(0, topN);
  }
}

class HybridRerankerService {
  rescore(
    query: string,
    candidates: ChromaQueryResult[],
    options: HybridRerankOptions = {},
  ): ChromaQueryResult[] {
    return candidates
      .map((candidate) => applyHybridScore(query, candidate, options))
      .sort((a, b) => b.score - a.score);
  }

  async rerank(
    env: AppEnv,
    query: string,
    candidates: ChromaQueryResult[],
    options: HybridRerankOptions = {},
  ): Promise<ChromaQueryResult[]> {
    const topN = options.topN ?? candidates.length;
    const rescored = this.rescore(query, candidates, options);
    return applyOptionalCrossRerank(env, query, rescored, topN);
  }
}

export const hybridRerankerService = new HybridRerankerService();
