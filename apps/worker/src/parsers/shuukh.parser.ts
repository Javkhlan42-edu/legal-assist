// ────────────────────────────────────────────────────────────
// shuukh.mn Parser — Extract structured fields from court decisions
// ────────────────────────────────────────────────────────────

import type { DocumentMetadata } from '@legal-chatbot/shared';

/**
 * Parse shuukh.mn-specific fields from cleaned HTML/text.
 */
export interface ShuukhParsedFields {
  caseId: string;
  court: string;
  date: string;
  title: string;
  bodyText: string;
  metadata: DocumentMetadata;
}

/**
 * Extract structured fields from a shuukh.mn court decision.
 * Handles Mongolian legal document structure.
 *
 * Expected format patterns:
 * - Case ID: "Хэрэг №" or similar
 * - Court name: "Улаанбаатарын сум...", "Монгол Улсын Их..." etc.
 * - Date: "2023 оны [month] сарын [day]"
 * - Title: Usually first meaningful line
 */
export function parseShuukhDecision(html: string): ShuukhParsedFields {
  // Extract case number with flexible pattern matching
  const caseIdMatch = html.match(/[\s\S]*?Хэрэг\s*(?:№|No)?[\s]*([0-9\-\/а-яА-Я]+)/i);
  const caseId = caseIdMatch?.[1]?.trim() || '';

  // Extract court name - usually appears early in document
  // Pattern: "Улаанбаатарын...", "...Сум\д...", "Монгол Улсын Их Хурлын..." etc.
  const courtMatch = html.match(
    /[\s\S]*?(Улаанбаатар|Аймаг|Сум)[\s\S]*?[Дд][ү|ү']?\s*[\s\S]{0,50}?(?:дүүргийн|аймгийн|зарлагадсан)/i,
  );
  const court = courtMatch
    ? courtMatch[0].match(/[А-Яа-я\s]+/)?.[0]?.trim() || 'Үл мэдэгдэх дээд шүүх'
    : '';

  // Extract decision date in format: "2023 оны 3 сарын 15"
  const dateMatch = html.match(/(\d{4})\s+оны\s+(\d{1,2})\s+сарын?\s+(\d{1,2})/);
  const date = dateMatch
    ? `${dateMatch[1]}-${String(dateMatch[2]).padStart(2, '0')}-${String(dateMatch[3]).padStart(2, '0')}`
    : '';

  // Title: First meaningful line (usually 20-200 chars)
  const lines = html.split('\n').filter((line) => line.trim().length > 20);
  const title = lines[0]?.slice(0, 200).trim() || `Шүүхийн шийдвэр №${caseId || 'үл мэдэгдэх'}`;

  // Body text: Full document content
  const bodyText = html.trim();

  // Build metadata
  const metadata: DocumentMetadata = {
    caseId,
    court,
  };

  return {
    caseId,
    court,
    date,
    title,
    bodyText,
    metadata,
  };
}
