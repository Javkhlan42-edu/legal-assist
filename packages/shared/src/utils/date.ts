// ────────────────────────────────────────────────────────────
// Date Utilities — Formatting helpers for dates
// ────────────────────────────────────────────────────────────

/**
 * Format an ISO date string to a human-readable Mongolian date.
 * Example: "2024-03-15" → "2024 оны 03 сарын 15"
 */
export function formatMongolianDate(isoDate: string): string {
  const date = new Date(isoDate);
  if (isNaN(date.getTime())) return isoDate;

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year} оны ${month} сарын ${day}`;
}

/**
 * Get current ISO 8601 timestamp.
 */
export function nowISO(): string {
  return new Date().toISOString();
}

/**
 * Parse a date string and return ISO date (YYYY-MM-DD) or null if invalid.
 */
export function toISODate(dateStr: string): string | null {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return null;
  return date.toISOString().split('T')[0];
}
