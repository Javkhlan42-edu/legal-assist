// ────────────────────────────────────────────────────────────
// Document Matcher — Smart matching of laws and cases to queries
// ────────────────────────────────────────────────────────────

/**
 * Calculate relevance score based on query-document similarity
 * Considers:
 * - Vector similarity (base score)
 * - Number of law/case references found
 * - Article coverage
 * - Court relevance (for cases)
 */
export interface MatchScore {
  baseScore: number;
  referenceBonus: number;
  articleBonus: number;
  finalScore: number;
}

export function calculateRelevanceScore(
  vectorScore: number,
  lawIds: string[],
  articles: string[],
  _courts: string[],
  _queryTokens: string[],
): MatchScore {
  // Base score from vector similarity
  const baseScore = vectorScore;

  // Bonus for having explicit law/case references
  const referenceBonus = lawIds.length > 0 ? 0.1 : 0;

  // Bonus for article mentions (suggests specific statute reference)
  const articleBonus = articles.length > 0 ? Math.min(articles.length * 0.05, 0.15) : 0;

  // Calculate final score (capped at 1.0)
  const finalScore = Math.min(baseScore + referenceBonus + articleBonus, 1.0);

  return {
    baseScore,
    referenceBonus,
    articleBonus,
    finalScore,
  };
}

/**
 * Check if a law/case is relevant to the query
 * Based on:
 * - String similarity between law title and query
 * - Presence of law ID in query or vice versa
 * - Article numbers mentioned in both query and document
 */
export function isRelevantToQuery(
  lawId: string | string[],
  title: string,
  articles: string[],
  query: string,
  score: number,
): boolean {
  // Minimum vector score threshold
  if (score < 0.3) return false;

  const lawIds = Array.isArray(lawId) ? lawId : [lawId];
  const queryLower = query.toLowerCase();
  const titleLower = title.toLowerCase();

  // Check if any law ID is in the query
  const hasLawIdMatch = lawIds.some(
    (id) => queryLower.includes(id) || queryLower.includes(id.replace('/', '-')),
  );

  // Check if title words overlap with query
  const titleWords = titleLower.split(/\s+/).filter((w) => w.length > 3);
  const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 3);
  const wordOverlap = titleWords.filter((w) => queryWords.includes(w)).length;
  const titleRelevance = wordOverlap > 0;

  // Check for article number matches
  const hasArticleMatch = articles.some((art) => queryLower.includes(art.toLowerCase()));

  // Accept if:
  // 1. Law ID is mentioned in query, OR
  // 2. Title has word overlap AND score is decent, OR
  // 3. Article matches found
  return hasLawIdMatch || (titleRelevance && score > 0.35) || hasArticleMatch;
}

/**
 * Filter and rank related items for quality
 */
export function rankByRelevance<T extends { score: number }>(
  items: T[],
  maxItems: number = 5,
): T[] {
  return items
    .filter((item) => item.score >= 0.3) // Minimum threshold
    .sort((a, b) => b.score - a.score)
    .slice(0, maxItems);
}
