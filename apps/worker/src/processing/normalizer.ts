// ────────────────────────────────────────────────────────────
// Text Normalizer — Unicode and Mongolian Cyrillic normalization
// ────────────────────────────────────────────────────────────

import { normalizeUnicode } from '@legal-chatbot/shared';

/**
 * Full text normalization pipeline for Mongolian legal text.
 *
 * Steps:
 * 1. Unicode NFC normalization (important for Mongolian Cyrillic)
 * 2. Fix common encoding issues (broken UTF-8 sequences)
 * 3. Normalize whitespace (collapse multiple spaces/newlines)
 * 4. Normalize Mongolian-specific characters
 * 5. Standardize legal reference patterns
 */
export function normalizeText(text: string): string {
  let normalized = text;

  // Step 1: Unicode NFC
  normalized = normalizeUnicode(normalized);

  // Step 2: Fix common encoding artifacts
  normalized = fixEncodingIssues(normalized);

  // Step 3: Normalize whitespace while preserving paragraph boundaries
  normalized = normalizePreservingParagraphs(normalized);

  // Step 4: Mongolian-specific normalization
  normalized = normalizeMongolianText(normalized);

  return normalized;
}

/**
 * Normalize whitespace but keep legal-document structure.
 */
function normalizePreservingParagraphs(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\t/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Fix common encoding issues in web-scraped text.
 */
function fixEncodingIssues(text: string): string {
  return text
    .replace(/\u00a0/g, ' ') // Non-breaking space → regular space
    .replace(/\u200b/g, '') // Zero-width space
    .replace(/\u200c/g, '') // Zero-width non-joiner
    .replace(/\u200d/g, '') // Zero-width joiner
    .replace(/\ufeff/g, ''); // BOM
}

/**
 * Mongolian Cyrillic-specific normalization.
 */
function normalizeMongolianText(text: string): string {
  // Normalize Mongolian quotation marks
  let normalized = text.replace(/[«»"”]/g, '"').replace(/['']/g, "'");

  // Standardize common legal abbreviations
  normalized = normalized
    .replace(/дүгээр\s+зүйл/gi, 'дүгээр зүйл')
    .replace(/дугаар\s+зүйл/gi, 'дугаар зүйл')
    .replace(/\s*\.\s*/g, '. ')
    .replace(/\s*:\s*/g, ': ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n\s+\n/g, '\n\n');

  return normalized;
}
