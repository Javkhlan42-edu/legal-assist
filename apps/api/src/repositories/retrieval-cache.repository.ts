import { createHash } from 'node:crypto';
import type { RelatedCase, RelatedLaw, Source } from '@legal-chatbot/shared';
import { dbQuery } from '../lib/db.js';
import type { ChromaQueryResult } from '../lib/vector-db.js';
import type { QueryIntent } from '../services/query-rewrite.service.js';
import type {
  RetrievalQuality,
  RetrievalStageTiming,
} from '../services/retrieval.service.js';

export interface RetrievalCachePayload {
  normalizedQuestion: string;
  intent: QueryIntent;
  contextChunks: ChromaQueryResult[];
  sources: Source[];
  relatedLaws: RelatedLaw[];
  relatedCases: RelatedCase[];
  sourcesUsed: number;
  retrievalQuality?: RetrievalQuality;
  retrievalTiming?: RetrievalStageTiming;
  cacheVersion: string;
  retrievalSpeedMode: string;
}

export interface RetrievalCacheEntry extends RetrievalCachePayload {
  cacheKey: string;
  lookupMode?: 'primary' | 'fallback';
  expiresAt: string;
  createdAt: string;
  hitCount: number;
  lastHitAt?: string | null;
}

interface RetrievalCacheRow {
  cacheKey: string;
  normalizedQuestion: string;
  intent: QueryIntent;
  contextChunks: ChromaQueryResult[] | null;
  sources: Source[] | null;
  relatedLaws: RelatedLaw[] | null;
  relatedCases: RelatedCase[] | null;
  sourcesUsed: number | null;
  retrievalQuality: RetrievalQuality | null;
  retrievalTiming: RetrievalStageTiming | null;
  cacheVersion: string;
  retrievalSpeedMode: string | null;
  lookupMode?: 'primary' | 'fallback';
  expiresAt: string;
  createdAt: string;
  hitCount: number;
  lastHitAt?: string | null;
}

export function normalizeRetrievalCacheQuestion(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function hasRetrievalCachePiiRisk(text: string): boolean {
  const normalized = text.trim();
  return (
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(normalized) ||
    /(?:\+?976[-\s]?)?\b[89]\d{7}\b/.test(normalized) ||
    /\b\d{9,16}\b/.test(normalized) ||
    /[А-ЯӨҮЁ]{2}\d{8}/i.test(normalized) ||
    /\b\d{4}\s?[А-ЯӨҮЁ]{3}\b/i.test(normalized) ||
    /(данс(?:ны)?\s*дугаар|регистр|утас(?:ны)?\s*дугаар|улсын\s+дугаар|имэйл|email)/i.test(
      normalized,
    )
  );
}

export function isRetrievalCacheEligibleQuestion(text: string): boolean {
  const normalized = normalizeRetrievalCacheQuestion(text);
  return normalized.length >= 12 && !hasRetrievalCachePiiRisk(text);
}

export function buildRetrievalCacheKey(params: {
  normalizedQuestion: string;
  intent: QueryIntent;
  cacheVersion: string;
  retrievalSpeedMode: string;
}): string {
  return createHash('sha256')
    .update([params.normalizedQuestion, params.cacheVersion].join('\u001f'))
    .digest('hex');
}

export async function getRetrievalCacheEntry(params: {
  normalizedQuestion: string;
  intent: QueryIntent;
  cacheVersion: string;
  retrievalSpeedMode: string;
}): Promise<RetrievalCacheEntry | null> {
  const cacheKey = buildRetrievalCacheKey(params);
  const rows = await dbQuery<RetrievalCacheRow>(
    `
      WITH selected AS (
        SELECT cache_key
        FROM retrieval_cache
        WHERE expires_at > NOW()
          AND (
            cache_key = $1
            OR (
              normalized_question = $2
              AND cache_version = $3
            )
          )
        ORDER BY
          (cache_key = $1) DESC,
          created_at DESC
        LIMIT 1
      )
      UPDATE retrieval_cache AS cache
      SET hit_count = cache.hit_count + 1,
          last_hit_at = NOW()
      FROM selected
      WHERE cache.cache_key = selected.cache_key
        AND cache.expires_at > NOW()
      RETURNING
        cache.cache_key AS "cacheKey",
        cache.normalized_question AS "normalizedQuestion",
        cache.intent,
        cache.context_chunks AS "contextChunks",
        cache.sources,
        cache.related_laws AS "relatedLaws",
        cache.related_cases AS "relatedCases",
        cache.sources_used AS "sourcesUsed",
        cache.retrieval_quality AS "retrievalQuality",
        cache.retrieval_timing AS "retrievalTiming",
        cache.cache_version AS "cacheVersion",
        cache.retrieval_speed_mode AS "retrievalSpeedMode",
        CASE WHEN cache.cache_key = $1 THEN 'primary' ELSE 'fallback' END AS "lookupMode",
        cache.expires_at AS "expiresAt",
        cache.created_at AS "createdAt",
        cache.hit_count AS "hitCount",
        cache.last_hit_at AS "lastHitAt"
    `,
    [cacheKey, params.normalizedQuestion, params.cacheVersion],
  );

  return rows[0] ? mapRetrievalCacheRow(rows[0], params.retrievalSpeedMode) : null;
}

export async function upsertRetrievalCacheEntry(
  payload: RetrievalCachePayload,
  ttlSeconds: number,
): Promise<void> {
  const cacheKey = buildRetrievalCacheKey(payload);
  await dbQuery(
    `
      INSERT INTO retrieval_cache (
        cache_key,
        normalized_question,
        intent,
        context_chunks,
        sources,
        related_laws,
        related_cases,
        sources_used,
        retrieval_quality,
        retrieval_timing,
        cache_version,
        retrieval_speed_mode,
        expires_at
      )
      VALUES (
        $1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb,
        $8, $9::jsonb, $10::jsonb, $11, $12, NOW() + ($13::int * INTERVAL '1 second')
      )
      ON CONFLICT (cache_key) DO UPDATE
      SET intent = EXCLUDED.intent,
          context_chunks = EXCLUDED.context_chunks,
          sources = EXCLUDED.sources,
          related_laws = EXCLUDED.related_laws,
          related_cases = EXCLUDED.related_cases,
          sources_used = EXCLUDED.sources_used,
          retrieval_quality = EXCLUDED.retrieval_quality,
          retrieval_timing = EXCLUDED.retrieval_timing,
          cache_version = EXCLUDED.cache_version,
          retrieval_speed_mode = EXCLUDED.retrieval_speed_mode,
          expires_at = EXCLUDED.expires_at,
          created_at = NOW()
    `,
    [
      cacheKey,
      payload.normalizedQuestion,
      payload.intent,
      JSON.stringify(payload.contextChunks),
      JSON.stringify(payload.sources),
      JSON.stringify(payload.relatedLaws),
      JSON.stringify(payload.relatedCases),
      payload.sourcesUsed,
      JSON.stringify(payload.retrievalQuality ?? {}),
      JSON.stringify(payload.retrievalTiming ?? {}),
      payload.cacheVersion,
      payload.retrievalSpeedMode,
      ttlSeconds,
    ],
  );
}

function mapRetrievalCacheRow(
  row: RetrievalCacheRow,
  retrievalSpeedMode: string,
): RetrievalCacheEntry {
  return {
    cacheKey: row.cacheKey,
    lookupMode: row.lookupMode,
    normalizedQuestion: row.normalizedQuestion,
    intent: row.intent,
    contextChunks: row.contextChunks ?? [],
    sources: row.sources ?? [],
    relatedLaws: row.relatedLaws ?? [],
    relatedCases: row.relatedCases ?? [],
    sourcesUsed: row.sourcesUsed ?? row.sources?.length ?? 0,
    retrievalQuality: row.retrievalQuality ?? undefined,
    retrievalTiming: row.retrievalTiming ?? undefined,
    cacheVersion: row.cacheVersion,
    retrievalSpeedMode: row.retrievalSpeedMode ?? retrievalSpeedMode,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    hitCount: row.hitCount,
    lastHitAt: row.lastHitAt,
  };
}
