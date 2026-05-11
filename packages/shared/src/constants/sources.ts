// ────────────────────────────────────────────────────────────
// Source Constants — Data source domains and base URLs
// ────────────────────────────────────────────────────────────

import type { SourceType } from '../types/source.types';

/** Base URLs for each data source */
export const SOURCE_BASE_URLS: Record<SourceType, string> = {
  shuukh: 'https://shuukh.mn',
  legalinfo: 'https://legalinfo.mn',
};

/** Human-readable names for sources */
export const SOURCE_DISPLAY_NAMES: Record<SourceType, string> = {
  shuukh: 'Шүүхийн шийдвэрийн сан',
  legalinfo: 'Эрх зүйн мэдээллийн нэгдсэн систем',
};

/** Source types as array (for iteration) */
export const SOURCE_TYPES: SourceType[] = ['shuukh', 'legalinfo'];
