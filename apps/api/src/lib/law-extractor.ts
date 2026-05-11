// ────────────────────────────────────────────────────────────
// Law Extractor — Extract law references from legal text
// ────────────────────────────────────────────────────────────

/**
 * Extract law IDs from text (pattern: YYYY/NNN or YYYY-NNN)
 * Examples: 2001/75, 2015-34
 */
export function extractLawIds(text: string): string[] {
  const lawIdPattern = /(\d{4})[\/\-](\d{2,3})/g;
  const matches = text.matchAll(lawIdPattern);
  const lawIds = new Set<string>();

  for (const match of matches) {
    lawIds.add(`${match[1]}/${match[2]}`);
  }

  return Array.from(lawIds);
}

/**
 * Extract article numbers from text
 * Examples: "1 дүгээр зүйл", "2 дугаар зүйл", "Article 5"
 */
export function extractArticles(text: string): string[] {
  const articles = new Set<string>();

  // Mongolian format: "N дүгээр/дугаар зүйл"
  const mongolianArticles = /(\d+)\s*(?:дүгээр|дугаар)\s+зүйл/g;
  let match;
  while ((match = mongolianArticles.exec(text)) !== null) {
    articles.add(`Article ${match[1]}`);
  }

  // English format
  const englishArticles = /[Aa]rticle\s+(\d+)/g;
  while ((match = englishArticles.exec(text)) !== null) {
    articles.add(`Article ${match[1]}`);
  }

  return Array.from(articles);
}

/**
 * Extract case IDs (Mongolian court cases)
 * Pattern: "Хэрэг № 213350" or similar
 */
export function extractCaseIds(text: string): string[] {
  const casePattern = /Хэрэг\s+№\s*(\d+)/gi;
  const matches = text.matchAll(casePattern);
  const caseIds = new Set<string>();

  for (const match of matches) {
    caseIds.add(match[1]);
  }

  return Array.from(caseIds);
}

/**
 * Extract court names
 */
export function extractCourts(text: string): string[] {
  const courtPatterns = [
    /([^,\n]+)\s+(?:аппеляцийн|апелляцийн|дээд)\s+(?:цэцэг|шүүх)/gi,
    /([^,\n]+)\s+(?:түүний?)\s+(?:цэцэг|шүүх)/gi,
    /Монголын\s+дээд\s+шүүх/gi,
  ];

  const courts = new Set<string>();

  for (const pattern of courtPatterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      if (match[1]) {
        courts.add(match[1].trim());
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
