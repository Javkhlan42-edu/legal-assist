// ────────────────────────────────────────────────────────────
// Law Explanation Service — Generate detailed explanations for laws/articles
// ────────────────────────────────────────────────────────────

import type { Chunk } from '@legal-chatbot/shared';

export interface ArticleExplanation {
  article: string;
  title: string;
  mainContent: string;
  subsections: Array<{
    num: string;
    content: string;
  }>;
  relatedArticles: string[];
}

/**
 * Extract subsections from article text (e.g., 1.1, 1.2, 2.3)
 */
export function extractSubsections(text: string): Array<{ num: string; content: string }> {
  const subsections: Array<{ num: string; content: string }> = [];

  // Pattern: "1.1 дахь заалт" or "1.2.дэх хэсэг" or "2.1 хэсэг"
  const subsectionRegex =
    /(\d+\.\d+)(?:\s*(?:дахь|дэх)\s*(?:заалт|хэсэг)|:)\s*([^\n]*(?:\n(?!\d+\.|\d+\s+(?:дүгээр|дугаар))[^\n]*)*)/g;

  let match;
  while ((match = subsectionRegex.exec(text)) !== null) {
    const num = match[1];
    const content = match[2].trim();
    if (content.length > 0) {
      subsections.push({ num, content });
    }
  }

  return subsections;
}

/**
 * Extract related articles from cross-references
 * Patterns: "Үзнэ үү: 2.1 зүйл", "энэ хуулийн 3 дүгээр зүйл"
 */
export function extractRelatedArticles(text: string): string[] {
  const related = new Set<string>();

  // Pattern 1: "N дүгээр/дугаар зүйл"
  const articleRefs = /(\d+)\s*(?:дүгээр|дугаар)\s+зүйл/g;
  let match;
  while ((match = articleRefs.exec(text)) !== null) {
    related.add(`Зүйл ${match[1]}`);
  }

  // Pattern 2: "N.M дахь заалт"
  const subsectionRefs = /(\d+\.\d+)\s*(?:дахь|дэх)\s+(?:заалт|хэсэг)/g;
  while ((match = subsectionRefs.exec(text)) !== null) {
    related.add(`${match[1]} заалт`);
  }

  return Array.from(related).slice(0, 5); // Limit to 5
}

/**
 * Parse article structure from legal text
 */
export function parseArticleStructure(articleNum: string, text: string): ArticleExplanation {
  // Extract title (first sentence/line after article number)
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  let title = '';
  let mainContent = '';

  // Find the title - usually ends with period or is first non-empty line
  for (let i = 0; i < Math.min(3, lines.length); i++) {
    const line = lines[i].trim();
    if (line.length > 10 && line.length < 200) {
      title = line.replace(/[:.]/g, '').trim();
      mainContent = lines.slice(i + 1).join('\n');
      break;
    }
  }

  // Extract subsections
  const subsections = extractSubsections(text);

  // Extract related articles
  const relatedArticles = extractRelatedArticles(text);

  return {
    article: articleNum,
    title,
    mainContent,
    subsections,
    relatedArticles,
  };
}

/**
 * Generate markdown explanation for an article
 */
export function generateArticleExplanation(explanation: ArticleExplanation): string {
  let md = '';

  // Header
  md += `## ${explanation.article} дүгээр зүйл\n\n`;

  // Title
  if (explanation.title) {
    md += `**${explanation.title}**\n\n`;
  }

  // Main content
  if (explanation.mainContent) {
    md += `${explanation.mainContent}\n\n`;
  }

  // Subsections
  if (explanation.subsections.length > 0) {
    md += `### Дэлгэрэнгүй\n\n`;
    for (const sub of explanation.subsections) {
      md += `**${sub.num}.**  ${sub.content}\n\n`;
    }
  }

  // Related articles
  if (explanation.relatedArticles.length > 0) {
    md += `### Холбогдох зүйлүүд\n\n`;
    for (const related of explanation.relatedArticles) {
      md += `- ${related}\n`;
    }
    md += '\n';
  }

  return md;
}

/**
 * Create comprehensive explanation from chunks
 * Useful when article content is split across multiple chunks
 */
export function createComprehensiveExplanation(
  articleNum: string,
  chunks: Chunk[],
): ArticleExplanation {
  // Combine all chunk texts for this article
  const combinedText = chunks.map((c) => c.text).join('\n\n');

  return parseArticleStructure(articleNum, combinedText);
}

/**
 * Extract article number from natural language query
 * e.g., "Criminal Law Article 1.1" → "1.1"
 * e.g., "Уголовном кодекс статья 1" → "1"
 * e.g., "Эрүүгийн хууль 1.1 зүйл" → "1.1"
 */
export function extractArticleNumberFromQuery(query: string): string | null {
  // Pattern 1: "Article N.M" or "Article N"
  let match = query.match(/[Aa]rticle\s+(\d+(?:\.\d+)*)/i);
  if (match) return match[1];

  // Pattern 2: "N.M дүгээр зүйл" or "N дүгээр зүйл"
  match = query.match(/(\d+(?:\.\d+)*)\s+(?:дүгээр|дугаар)\s+зүйл/);
  if (match) return match[1];

  // Pattern 3: "N.M заалт" or "N.M хэсэг"
  match = query.match(/(\d+(?:\.\d+)*)\s+(?:заалт|хэсэг)/);
  if (match) return match[1];

  // Pattern 4: Just numbers like "1.1" or "11"
  match = query.match(/\b(\d+(?:\.\d+)*)\b/);
  if (match) {
    const num = match[1];
    // Only return if it looks like a valid article number (1-500, with optional subsection)
    const main = parseInt(num.split('.')[0], 10);
    if (main >= 1 && main <= 500) {
      return num;
    }
  }

  return null;
}
