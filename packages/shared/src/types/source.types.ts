// ────────────────────────────────────────────────────────────
// Source Types — Citation/reference types for legal documents
// ────────────────────────────────────────────────────────────

/**
 * The origin of a legal document.
 * - `shuukh`    — Court decisions from shuukh.mn
 * - `legalinfo` — Legal acts from legalinfo.mn
 */
export type SourceType = 'shuukh' | 'legalinfo';

/**
 * A citation source returned alongside a chat answer.
 * Every response MUST include at least one Source to ensure grounded answers.
 */
export interface Source {
  /** Origin site */
  type: SourceType;

  /** Display title (Mongolian) */
  title: string;

  /** Canonical URL on the source site */
  url: string;

  /** Relevant text snippet from the source (for preview) */
  snippet?: string;

  /** Court case identifier (shuukh.mn only) */
  caseId?: string;

  /** Law registry identifier (legalinfo.mn only) */
  lawId?: string;

  /** Article or section number within the law */
  articleNo?: string;

  /** Publication or decision date (ISO 8601 date string) */
  date?: string;
}
