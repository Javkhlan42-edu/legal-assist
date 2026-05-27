import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../apps/api/src/lib/db.js', () => ({
  dbQuery: vi.fn(),
}));

import { dbQuery } from '../../../apps/api/src/lib/db.js';
import {
  buildRetrievalCacheKey,
  getRetrievalCacheEntry,
  hasRetrievalCachePiiRisk,
  isRetrievalCacheEligibleQuestion,
  normalizeRetrievalCacheQuestion,
} from '../../../apps/api/src/repositories/retrieval-cache.repository.js';

const dbQueryMock = vi.mocked(dbQuery);

describe('retrieval-cache.repository', () => {
  beforeEach(() => {
    dbQueryMock.mockReset();
  });

  it('normalizes exact legal questions without losing Mongolian letters', () => {
    expect(
      normalizeRetrievalCacheQuestion('  Банкнаас зээл аваад 3 сар төлөөгүй. Яах вэ? '),
    ).toBe('банкнаас зээл аваад 3 сар төлөөгүй яах вэ');
  });

  it('builds exact-question keys that ignore intent and retrieval mode', () => {
    const base = {
      normalizedQuestion: 'банкнаас зээл аваад 3 сар төлөөгүй яах вэ',
      intent: 'contract' as const,
      cacheVersion: 'retrieval-context-v1',
      retrievalSpeedMode: 'balanced',
    };

    expect(buildRetrievalCacheKey(base)).toBe(buildRetrievalCacheKey(base));
    expect(buildRetrievalCacheKey({ ...base, intent: 'unknown' })).toBe(
      buildRetrievalCacheKey(base),
    );
    expect(buildRetrievalCacheKey({ ...base, retrievalSpeedMode: 'quality' })).toBe(
      buildRetrievalCacheKey(base),
    );
    expect(
      buildRetrievalCacheKey({ ...base, cacheVersion: 'retrieval-context-v2' }),
    ).not.toBe(buildRetrievalCacheKey(base));
  });

  it('does not allow global cache entries for obvious PII', () => {
    expect(hasRetrievalCachePiiRisk('Миний регистр АБ12345678')).toBe(true);
    expect(hasRetrievalCachePiiRisk('Миний утас 99112233')).toBe(true);
    expect(isRetrievalCacheEligibleQuestion('Банкнаас зээл аваад 3 сар төлөөгүй бол яах вэ')).toBe(
      true,
    );
    expect(isRetrievalCacheEligibleQuestion('Миний email test@example.com')).toBe(false);
  });

  it('looks up cache rows by primary key or normalized question fallback', async () => {
    dbQueryMock.mockResolvedValueOnce([
      {
        cacheKey: 'legacy-key',
        lookupMode: 'fallback',
        normalizedQuestion: 'банкнаас зээл аваад 3 сар төлөөгүй яах вэ',
        intent: 'contract',
        contextChunks: [],
        sources: [],
        relatedLaws: [],
        relatedCases: [],
        sourcesUsed: 0,
        retrievalQuality: null,
        retrievalTiming: null,
        cacheVersion: 'retrieval-context-v1',
        retrievalSpeedMode: 'quality',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        createdAt: new Date().toISOString(),
        hitCount: 2,
        lastHitAt: new Date().toISOString(),
      },
    ]);

    const entry = await getRetrievalCacheEntry({
      normalizedQuestion: 'банкнаас зээл аваад 3 сар төлөөгүй яах вэ',
      intent: 'contract',
      cacheVersion: 'retrieval-context-v1',
      retrievalSpeedMode: 'balanced',
    });

    expect(entry?.lookupMode).toBe('fallback');
    expect(entry?.retrievalSpeedMode).toBe('quality');
    expect(dbQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('normalized_question = $2'),
      expect.arrayContaining(['банкнаас зээл аваад 3 сар төлөөгүй яах вэ', 'retrieval-context-v1']),
    );
  });

  it('does not return expired cache rows', async () => {
    dbQueryMock.mockResolvedValueOnce([]);

    const entry = await getRetrievalCacheEntry({
      normalizedQuestion: 'банкнаас зээл аваад 3 сар төлөөгүй яах вэ',
      intent: 'contract',
      cacheVersion: 'retrieval-context-v1',
      retrievalSpeedMode: 'balanced',
    });

    expect(entry).toBeNull();
  });
});
