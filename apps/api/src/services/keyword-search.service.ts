// ────────────────────────────────────────────────────────────
// Keyword Search Service — BM25 via PostgreSQL Full-Text Search
// ────────────────────────────────────────────────────────────

import { dbQuery } from '../lib/db.js';

export interface KeywordSearchResult {
  chunkId: string;
  documentId: string;
  text: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface KeywordSearchOptions {
  source?: 'legalinfo' | 'shuukh';
}

const KEYWORD_SEARCH_CACHE_TTL_MS = 60_000;
const KEYWORD_SEARCH_CACHE_MAX_ENTRIES = 256;

interface KeywordSearchCacheEntry {
  expiresAt: number;
  results: KeywordSearchResult[];
}

const keywordSearchCache = new Map<string, KeywordSearchCacheEntry>();

function buildKeywordCacheKey(
  method: 'fts' | 'trgm',
  query: string,
  topK: number,
  options: KeywordSearchOptions,
): string {
  return `${method}:${options.source ?? 'all'}:${topK}:${query.trim().toLowerCase()}`;
}

function cloneKeywordResults(results: KeywordSearchResult[]): KeywordSearchResult[] {
  return results.map((result) => ({
    ...result,
    metadata: { ...(result.metadata ?? {}) },
  }));
}

function getCachedKeywordResults(cacheKey: string): KeywordSearchResult[] | null {
  const cached = keywordSearchCache.get(cacheKey);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    keywordSearchCache.delete(cacheKey);
    return null;
  }

  return cloneKeywordResults(cached.results);
}

function getReusableCachedKeywordResults(
  method: 'fts' | 'trgm',
  query: string,
  topK: number,
  options: KeywordSearchOptions,
): KeywordSearchResult[] | null {
  const normalizedQuery = query.trim().toLowerCase();
  const prefix = `${method}:${options.source ?? 'all'}:`;

  for (const [cacheKey, cached] of keywordSearchCache.entries()) {
    if (!cacheKey.startsWith(prefix)) {
      continue;
    }

    if (cached.expiresAt <= Date.now()) {
      keywordSearchCache.delete(cacheKey);
      continue;
    }

    const rest = cacheKey.slice(prefix.length);
    const separatorIndex = rest.indexOf(':');
    if (separatorIndex <= 0) {
      continue;
    }

    const cachedTopK = Number(rest.slice(0, separatorIndex));
    const cachedQuery = rest.slice(separatorIndex + 1);
    if (!Number.isFinite(cachedTopK) || cachedTopK < topK || cachedQuery !== normalizedQuery) {
      continue;
    }

    return cloneKeywordResults(cached.results.slice(0, topK));
  }

  return null;
}

function setCachedKeywordResults(cacheKey: string, results: KeywordSearchResult[]): void {
  if (keywordSearchCache.size >= KEYWORD_SEARCH_CACHE_MAX_ENTRIES) {
    const firstKey = keywordSearchCache.keys().next().value;
    if (typeof firstKey === 'string') {
      keywordSearchCache.delete(firstKey);
    }
  }

  keywordSearchCache.set(cacheKey, {
    expiresAt: Date.now() + KEYWORD_SEARCH_CACHE_TTL_MS,
    results: cloneKeywordResults(results),
  });
}

/**
 * Keyword Search Service using PostgreSQL full-text search.
 * Provides BM25-like ranking for legal queries.
 *
 * Prerequisites:
 * - chunks table with: id, document_id, text, metadata
 * - CREATE INDEX chunks_ftsidx ON chunks USING GIN(to_tsvector('simple', text));
 * - For Mongolian: CREATE EXTENSION IF NOT EXISTS pg_trgm;
 */
export class KeywordSearchService {
  /**
   * Search for keywords in chunks using PostgreSQL full-text search.
   * Returns results ranked by ts_rank () score.
   */
  async search(
    query: string,
    topK: number = 10,
    options: KeywordSearchOptions = {},
  ): Promise<KeywordSearchResult[]> {
    if (!query.trim()) {
      return [];
    }

    const cacheKey = buildKeywordCacheKey('fts', query, topK, options);
    const cached =
      getCachedKeywordResults(cacheKey) ??
      getReusableCachedKeywordResults('fts', query, topK, options);
    if (cached) {
      return cached;
    }

    const startedAt = Date.now();

    try {
      const values: Array<string | number> = [query];
      let sourceFilter = '';
      if (options.source) {
        values.push(options.source);
        sourceFilter = ` AND d.source::text = $${values.length}`;
      }
      values.push(topK);
      const limitParam = `$${values.length}`;

      // PostgreSQL full-text search query with ts_rank scoring
      // plainto_tsquery: converts text to tsquery, ignoring most punctuation
      const sqlQuery = `
        SELECT 
          c.id as "chunkId",
          c.document_id as "documentId",
          SUBSTRING(c.text, 1, 500) as text,
          ts_rank(
            setweight(to_tsvector('simple', COALESCE(d.title, '')), 'A') ||
            setweight(to_tsvector('simple', c.text), 'B'),
            plainto_tsquery('simple', $1::text)
          ) as score,
          c.metadata || jsonb_build_object(
            'title', COALESCE(NULLIF(c.metadata->>'title', ''), d.title),
            'documentTitle', COALESCE(NULLIF(c.metadata->>'documentTitle', ''), d.title),
            'source', COALESCE(NULLIF(c.metadata->>'source', ''), d.source::text),
            'sourceId', COALESCE(NULLIF(c.metadata->>'sourceId', ''), d.source_id),
            'url', COALESCE(NULLIF(c.metadata->>'url', ''), NULLIF(c.metadata->>'documentUrl', ''), d.url),
            'documentUrl', COALESCE(NULLIF(c.metadata->>'documentUrl', ''), d.url),
            'caseId', COALESCE(NULLIF(c.metadata->>'caseId', ''), d.metadata->>'caseId', d.source_id),
            'caseNumber', COALESCE(NULLIF(c.metadata->>'caseNumber', ''), d.metadata->>'caseNumber'),
            'court', COALESCE(NULLIF(c.metadata->>'court', ''), d.metadata->>'court'),
            'decisionSummary', COALESCE(NULLIF(c.metadata->>'decisionSummary', ''), d.metadata->>'decisionSummary'),
            'decisionType', COALESCE(NULLIF(c.metadata->>'decisionType', ''), d.metadata->>'decisionType')
          ) as metadata
        FROM chunks c
        INNER JOIN documents d ON d.id = c.document_id
        WHERE (
          setweight(to_tsvector('simple', COALESCE(d.title, '')), 'A') ||
          setweight(to_tsvector('simple', c.text), 'B')
        ) @@ plainto_tsquery('simple', $1::text)
        ${sourceFilter}
        ORDER BY score DESC
        LIMIT ${limitParam}
      `;

      const results = await dbQuery<any>(sqlQuery, values);

      const mapped = results.map((row) => ({
        chunkId: row.chunkId,
        documentId: row.documentId,
        text: row.text || '',
        score: Math.min((row.score || 0) / 10, 1.0), // ts_rank returns 0-1 scale, normalize further
        metadata: row.metadata || {},
      }));

      setCachedKeywordResults(cacheKey, mapped);

      const duration = Date.now() - startedAt;
      if (duration > 750) {
        console.warn(
          { duration, topK, source: options.source ?? 'all', resultCount: mapped.length },
          'Slow keyword FTS search',
        );
      }

      return mapped;
    } catch (err) {
      console.error('BM25 search failed:', err);
      return []; // Graceful fallback
    }
  }

  /**
   * Search with Mongolian language support.
   * Uses trigram similarity (pg_trgm extension) for Cyrillic text.
   */
  async searchMongolian(
    query: string,
    topK: number = 10,
    options: KeywordSearchOptions = {},
  ): Promise<KeywordSearchResult[]> {
    if (!query.trim()) {
      return [];
    }

    const cacheKey = buildKeywordCacheKey('trgm', query, topK, options);
    const cached =
      getCachedKeywordResults(cacheKey) ??
      getReusableCachedKeywordResults('trgm', query, topK, options);
    if (cached) {
      return cached;
    }

    const startedAt = Date.now();

    try {
      const values: Array<string | number> = [query];
      let sourceFilter = '';
      if (options.source) {
        values.push(options.source);
        sourceFilter = ` AND d.source::text = $${values.length}`;
      }
      values.push(topK);
      const limitParam = `$${values.length}`;

      // Trigram similarity for Mongolian Cyrillic text
      const sqlQuery = `
        SELECT 
          c.id as "chunkId",
          c.document_id as "documentId",
          SUBSTRING(c.text, 1, 500) as text,
          similarity(c.text, $1::text) as score,
          c.metadata || jsonb_build_object(
            'title', COALESCE(NULLIF(c.metadata->>'title', ''), d.title),
            'documentTitle', COALESCE(NULLIF(c.metadata->>'documentTitle', ''), d.title),
            'source', COALESCE(NULLIF(c.metadata->>'source', ''), d.source::text),
            'sourceId', COALESCE(NULLIF(c.metadata->>'sourceId', ''), d.source_id),
            'url', COALESCE(NULLIF(c.metadata->>'url', ''), NULLIF(c.metadata->>'documentUrl', ''), d.url),
            'documentUrl', COALESCE(NULLIF(c.metadata->>'documentUrl', ''), d.url),
            'caseId', COALESCE(NULLIF(c.metadata->>'caseId', ''), d.metadata->>'caseId', d.source_id),
            'caseNumber', COALESCE(NULLIF(c.metadata->>'caseNumber', ''), d.metadata->>'caseNumber'),
            'court', COALESCE(NULLIF(c.metadata->>'court', ''), d.metadata->>'court'),
            'decisionSummary', COALESCE(NULLIF(c.metadata->>'decisionSummary', ''), d.metadata->>'decisionSummary'),
            'decisionType', COALESCE(NULLIF(c.metadata->>'decisionType', ''), d.metadata->>'decisionType')
          ) as metadata
        FROM chunks c
        INNER JOIN documents d ON d.id = c.document_id
        WHERE (c.text % $1::text OR c.text ILIKE '%' || $1::text || '%')
        ${sourceFilter}
        ORDER BY similarity(c.text, $1::text) DESC
        LIMIT ${limitParam}
      `;

      const results = await dbQuery<any>(sqlQuery, values);

      const mapped = results.map((row) => ({
        chunkId: row.chunkId,
        documentId: row.documentId,
        text: row.text || '',
        score: Math.min(row.score || 0, 1.0),
        metadata: row.metadata || {},
      }));

      setCachedKeywordResults(cacheKey, mapped);

      const duration = Date.now() - startedAt;
      if (duration > 750) {
        console.warn(
          { duration, topK, source: options.source ?? 'all', resultCount: mapped.length },
          'Slow Mongolian trigram search',
        );
      }

      return mapped;
    } catch (err) {
      console.error('Mongolian search failed:', err);
      return [];
    }
  }

  /**
   * Phrase search: find exact or near-exact phrase matches.
   * Useful for finding specific legal provisions or case numbers.
   */
  async phraseSearch(phrase: string, topK: number = 10): Promise<KeywordSearchResult[]> {
    if (!phrase.trim()) {
      return [];
    }

    try {
      // Use phraseto_tsquery which preserves phrase structure
      const sqlQuery = `
        SELECT 
          c.id as "chunkId",
          c.document_id as "documentId",
          SUBSTRING(c.text, 1, 500) as text,
          ts_rank(to_tsvector('simple', c.text), phraseto_tsquery('simple', $1::text)) as score,
          c.metadata
        FROM chunks c
        WHERE to_tsvector('simple', c.text) @@ phraseto_tsquery('simple', $1::text)
        ORDER BY score DESC
        LIMIT $2
      `;

      const results = await dbQuery<any>(sqlQuery, [phrase, topK]);

      return results.map((row) => ({
        chunkId: row.chunkId,
        documentId: row.documentId,
        text: row.text || '',
        score: Math.min((row.score || 0) / 10, 1.0),
        metadata: row.metadata || {},
      }));
    } catch (err) {
      console.error('Phrase search failed:', err);
      return [];
    }
  }

  /**
   * Simple regex-based keyword matching (fallback when DB unavailable).
   * Less efficient but works without database connection.
   */
  async searchLocal(
    chunks: Array<{
      id: string;
      documentId: string;
      text: string;
      metadata: Record<string, unknown>;
    }>,
    query: string,
    topK: number = 10,
  ): Promise<KeywordSearchResult[]> {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2);

    if (terms.length === 0) return [];

    const results: KeywordSearchResult[] = [];

    for (const chunk of chunks) {
      const text = chunk.text.toLowerCase();
      let score = 0;

      // Simple BM25-like scoring: term frequency
      for (const term of terms) {
        const regex = new RegExp(`\\b${term}\\b`, 'g');
        const matches = text.match(regex)?.length || 0;
        score += matches * term.length; // Longer terms worth more
      }

      if (score > 0) {
        results.push({
          chunkId: chunk.id,
          documentId: chunk.documentId,
          text: chunk.text,
          score: Math.min(score / 100, 1.0), // Normalize to 0-1
          metadata: chunk.metadata,
        });
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, topK);
  }
}

export const keywordSearchService = new KeywordSearchService();
