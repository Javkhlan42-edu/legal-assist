// ────────────────────────────────────────────────────────────
// URL Builder — Construct canonical source URLs from IDs
// ────────────────────────────────────────────────────────────

import type { SourceType } from '../types/source.types';
import { SOURCE_BASE_URLS } from '../constants/sources';

/**
 * Build a canonical URL for a shuukh.mn court decision.
 */
export function buildShuukhUrl(decisionId: string): string {
  return `${SOURCE_BASE_URLS.shuukh}/decision/detail/${decisionId}`;
}

/**
 * Build a canonical URL for a legalinfo.mn legal act.
 */
export function buildLegalinfoUrl(lawId: string): string {
  return `${SOURCE_BASE_URLS.legalinfo}/law/details/${lawId}`;
}

/**
 * Build a source URL based on type and external ID.
 */
export function buildSourceUrl(type: SourceType, externalId: string): string {
  switch (type) {
    case 'shuukh':
      return buildShuukhUrl(externalId);
    case 'legalinfo':
      return buildLegalinfoUrl(externalId);
    default:
      throw new Error(`Unknown source type: ${type}`);
  }
}
