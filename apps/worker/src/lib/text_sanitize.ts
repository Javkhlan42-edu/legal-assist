// ─────────────────────────────────────────────────────────
// Text sanitization for Mongolian legal chunks
// ─────────────────────────────────────────────────────────

/**
 * Common header/footer patterns found in scraped legal documents.
 * These add no semantic value and waste embedding tokens.
 */
const BOILERPLATE_PATTERNS: RegExp[] = [
  /хуулийн мэдээллийн нэгдсэн систем/gi,
  /©\s*\d{4}.*/g,
  /legalinfo\.mn/gi,
  /shuukh\.mn/gi,
  /нүүр\s*хуудас/gi,
  /хэвлэх\s*хуудас/gi,
  /бүх\s*эрх\s*хуулиар\s*хамгаалагдсан/gi,
  /цахим\s*хаяг\s*:?\s*\S+@\S+/gi,
];

/**
 * PII-like patterns to mask, carefully avoiding legal article numbers.
 *
 * Strategy:
 * - Phone numbers: 8-digit Mongolian mobile (starting 8/9) or with country code
 * - National register: 2 Cyrillic letters + 8 digits (e.g. УБ12345678)
 * - We do NOT mask patterns like "204.1", "12.4.2" which are law article refs.
 */
const PII_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // Mongolian phone: +976 XXXX XXXX or 8/9X XX XX XX
  { re: /\+?976[\s-]?\d{4}[\s-]?\d{4}/g, replacement: '[УТАС]' },
  { re: /\b[89]\d{3}[\s-]?\d{4}\b/g, replacement: '[УТАС]' },
  // National register number: 2 Cyrillic uppercase + 8 digits
  { re: /\b[А-ЯЁӨҮа-яёөү]{2}\d{8}\b/g, replacement: '[РД]' },
  // Email
  { re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[ИМЭЙЛ]' },
];

/** Collapse all whitespace runs to a single space and trim. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Remove known boilerplate patterns. */
function removeBoilerplate(text: string): string {
  let result = text;
  for (const pat of BOILERPLATE_PATTERNS) {
    result = result.replace(pat, '');
  }
  return result;
}

/** Mask PII-like patterns, preserving legal article references. */
function maskPII(text: string): string {
  let result = text;
  for (const { re, replacement } of PII_PATTERNS) {
    result = result.replace(re, replacement);
  }
  return result;
}

/**
 * Truncate text to maxChars at the nearest sentence boundary.
 * Falls back to word boundary if no sentence-end is found.
 */
export function truncateAtSentence(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const slice = text.slice(0, maxChars);

  // Try to find the last sentence-ending punctuation
  const sentenceEnd = Math.max(
    slice.lastIndexOf('。'),
    slice.lastIndexOf('.'),
    slice.lastIndexOf('!'),
    slice.lastIndexOf('?'),
    slice.lastIndexOf('\n'),
  );

  if (sentenceEnd > maxChars * 0.5) {
    return slice.slice(0, sentenceEnd + 1).trim();
  }

  // Fallback: break at last space
  const spaceIdx = slice.lastIndexOf(' ');
  if (spaceIdx > maxChars * 0.4) {
    return slice.slice(0, spaceIdx).trim();
  }

  return slice.trim();
}

/** Build a snippet (first ~240 chars at sentence boundary). */
export function buildSnippet(text: string, maxLen = 240): string {
  return truncateAtSentence(text, maxLen);
}

/**
 * Full sanitization pipeline.
 * Returns cleaned text ready for embedding.
 */
export function sanitizeText(raw: string, maxChars: number): string {
  let text = raw;
  text = removeBoilerplate(text);
  text = maskPII(text);
  text = collapseWhitespace(text);
  text = truncateAtSentence(text, maxChars);
  return text;
}
