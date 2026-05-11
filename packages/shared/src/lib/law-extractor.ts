// ────────────────────────────────────────────────────────────
// Law Extractor — Extract law references from legal text
// ────────────────────────────────────────────────────────────

/**
 * Extract law IDs from text (pattern: YYYY/NNN or YYYY-NNN)
 * Examples: 2001/75, 2015-34
 * Filters for valid Mongolian law years (1990-2050)
 */
export function extractLawIds(text: string): string[] {
  const lawIdPattern = /(\d{4})[\/\-](\d{2,3})/g;
  const matches = text.matchAll(lawIdPattern);
  const lawIds = new Set<string>();

  for (const match of matches) {
    const year = parseInt(match[1], 10);
    const num = parseInt(match[2], 10);

    // Filter for valid Mongolian law years (1990-2050) and reasonable law numbers (1-999)
    if (year >= 1990 && year <= 2050 && num >= 1 && num <= 999) {
      lawIds.add(`${match[1]}/${match[2]}`);
    }
  }

  return Array.from(lawIds);
}

/**
 * Extract article numbers from text with context
 * Examples: "1 дүгээр зүйл", "2 дугаар зүйл", "Article 5"
 */
export function extractArticle(text: string): string | null {
  if (!text || text.trim().length === 0) {
    return null;
  }

  const patterns = [
    /(\d+(?:\.\d+)*)\s*(?:дүгээр|дугаар)?\s*зүйл/iu,
    /зүйл\s*(\d+(?:\.\d+)*)/iu,
    /article\s*(\d+(?:\.\d+)*)/iu,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) {
      continue;
    }

    const normalized = match[1].trim();
    if (normalized.length > 0) {
      return normalized;
    }
  }

  return null;
}

export function extractArticles(text: string): string[] {
  const articles = new Set<string>();

  // Mongolian format: "N дүгээр/дугаар зүйл" with context
  const mongolianArticles = /(?:^|\s)(\d+)\s*(?:дүгээр|дугаар)\s+зүйл/gm;
  let match;
  while ((match = mongolianArticles.exec(text)) !== null) {
    const num = parseInt(match[1], 10);
    if (num >= 1 && num <= 500) {
      // Reasonable article range
      articles.add(`Article ${match[1]}`);
    }
  }

  // English format
  const englishArticles = /[Aa]rticle\s+(\d+)/g;
  while ((match = englishArticles.exec(text)) !== null) {
    const num = parseInt(match[1], 10);
    if (num >= 1 && num <= 500) {
      articles.add(`Article ${match[1]}`);
    }
  }

  // Format: "Зүйл 3"
  const reverseMongolianArticles = /Зүйл\s*(\d+)/gim;
  while ((match = reverseMongolianArticles.exec(text)) !== null) {
    const num = parseInt(match[1], 10);
    if (num >= 1 && num <= 500) {
      articles.add(`Article ${match[1]}`);
    }
  }

  return Array.from(articles);
}

/**
 * Extract case IDs (Mongolian court cases)
 * Pattern: "Хэрэг № 213350" in proper context
 */
export function extractCaseIds(text: string): string[] {
  const casePattern = /Хэрэг\s+№\s*(\d{5,6})/gi;
  const matches = text.matchAll(casePattern);
  const caseIds = new Set<string>();

  for (const match of matches) {
    const caseNum = parseInt(match[1], 10);
    // Only include if it's a reasonable case number (5-6 digits)
    if (caseNum >= 100000 && caseNum <= 999999) {
      caseIds.add(match[1]);
    }
  }

  return Array.from(caseIds);
}

/**
 * Extract court names with validation
 */
export function extractCourts(text: string): string[] {
  const courtPatterns = [
    /([^,\n.!?]{3,50}?)\s+(?:аппеляцийн|апелляцийн|дээд)\s+(?:цэцэг|шүүх)/gi,
    /([^,\n.!?]{3,50}?)\s+нийтийн\s+шүүх/gi,
    /Монголын\s+дээд\s+шүүх/gi,
  ];

  const courts = new Set<string>();

  for (const pattern of courtPatterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      if (match[1]) {
        const court = match[1].trim();
        // Filter out too short or too long names
        if (court.length > 3 && court.length < 100) {
          courts.add(court);
        }
      }
    }
  }

  return Array.from(courts);
}

/**
 * Extract all legal references from text
 */
export interface LegalReferences {
  lawIds: string[];
  articles: string[];
  caseIds: string[];
  courts: string[];
  keywords: string[];
}

export function extractLegalReferences(text: string): LegalReferences {
  return {
    lawIds: extractLawIds(text),
    articles: extractArticles(text),
    caseIds: extractCaseIds(text),
    courts: extractCourts(text),
    keywords: extractKeywords(text),
  };
}

/**
 * Extract legal keywords
 */
function extractKeywords(text: string): string[] {
  const keywords = [
    'нэн',
    'төлбөрөлөх',
    'хүнгүүлэх',
    'ялын хид',
    'үүрэг',
    'эрх',
    'хүлээлцүүлэх',
    'баримтлах',
    'өмнөд',
    'эсүүлэх',
    'шийтгэл',
    'сэргээх',
    'өөрчлөх',
    'цуцлах',
    'гүйцэтгэх',
    'нэмэх',
  ];

  const found = new Set<string>();
  const lowerText = text.toLowerCase();

  for (const keyword of keywords) {
    if (lowerText.includes(keyword)) {
      found.add(keyword);
    }
  }

  return Array.from(found);
}
