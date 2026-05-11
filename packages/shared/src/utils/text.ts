// ────────────────────────────────────────────────────────────
// Text Utilities — Truncation, hashing, sanitization
// ────────────────────────────────────────────────────────────

import { createHash } from 'crypto';

/**
 * Truncate text to a maximum length, appending ellipsis if truncated.
 */
export function truncateText(text: string, maxLength: number = 200): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

/**
 * SHA-256 hash of a string, returned as hex.
 */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * Normalize Unicode to NFC (important for Mongolian Cyrillic text).
 */
export function normalizeUnicode(text: string): string {
  return text.normalize('NFC');
}

/**
 * Collapse multiple whitespace characters into single spaces and trim.
 */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Strip HTML tags from a string (basic implementation).
 */
export function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

/**
 * Sanitize user input to prevent common injection patterns.
 * Does NOT modify the content for storage — only for validation/flagging.
 */
export function containsInjectionPattern(text: string): boolean {
  const patterns = [
    /ignore\s+(previous|above|all)\s+instructions/i,
    /you\s+are\s+now/i,
    /reveal\s+(your|the)\s+(system|original)\s+prompt/i,
    /disregard\s+(previous|all)/i,
  ];
  return patterns.some((p) => p.test(text));
}
