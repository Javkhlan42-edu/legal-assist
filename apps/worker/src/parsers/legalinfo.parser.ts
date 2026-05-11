// ────────────────────────────────────────────────────────────
// legalinfo.mn Parser — Extract structured fields from legal acts
// ────────────────────────────────────────────────────────────

import type { DocumentMetadata } from '@legal-chatbot/shared';

/**
 * Parse legalinfo.mn-specific fields from cleaned HTML/text.
 */
export interface LegalinfoParsedFields {
  lawId: string;
  title: string;
  date: string;
  articles: LegalArticle[];
  bodyText: string;
  metadata: DocumentMetadata;
}

export interface LegalArticle {
  articleNo: string;
  title: string;
  text: string;
}

/**
 * Extract structured fields from a legalinfo.mn legal act.
 * Handles Mongolian law document structure.
 *
 * Expected format patterns:
 * - Law ID: registry number like "2002/134", "2015/65" etc.
 * - Title: Law/Decree title in Mongolian
 * - Date: "2002 оны [month] сарын [day]"
 * - Articles: "1 дүгээр зүйл", "2 дугаар зүйл" etc.
 */
export function parseLegalinfoAct(html: string): LegalinfoParsedFields {
  // Extract law ID/registry number - typically at start
  const lawIdMatch = html.match(/(?:Хуульд|№|No)[\s]*(\d{4}[\/\\]?\d{2,3})/i);
  const lawId = lawIdMatch?.[1]?.replace(/\\/g, '/') || '';

  // Extract law title - usually first meaningful line
  const lines = html
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 10 && l.length < 300);

  const title =
    lines.find((line) => line.match(/(?:Хууль|Зөвлөмж|Үзэл|Дүрэм|Журам)/)) || lines[0] || '';

  // Extract date in format: "2002 оны 3 сарын 15"
  const dateMatch = html.match(/(\d{4})\s+оны\s+(\d{1,2})\s+сарын?\s+(\d{1,2})/);
  const date = dateMatch
    ? `${dateMatch[1]}-${String(dateMatch[2]).padStart(2, '0')}-${String(dateMatch[3]).padStart(2, '0')}`
    : '';

  // Extract articles - pattern like "1 дүгээр зүйл", "2 дугаар зүйл", etc.
  const articles = extractArticles(html);

  // Body text: Full document
  const bodyText = html.trim();

  // Build metadata
  const metadata: DocumentMetadata = {
    lawId,
  };

  return {
    lawId,
    title,
    date,
    articles,
    bodyText,
    metadata,
  };
}

/**
 * Extract articles from legal text.
 * Pattern: "1 дүгээр зүйл: Title\n\n1.1 Explanation..."
 */
function extractArticles(html: string): LegalArticle[] {
  const articles: LegalArticle[] = [];

  // Match article headers: "1 дүгээр зүйл", "2 дугаар зүйл", "Нэгдүгээр зүйл" etc.
  const articleRegex =
    /(?:^|\n)((?:Нэг|Хоёр|Гурав|Дөрөв|Тав|Зургаа|Долоо|Найм|Ес|Арав|\d+)\s*(?:дүгээр|дугаар|[а-я]+р))\s+зүйл[:\s]+([^\n]+)/gm;

  let match;
  while ((match = articleRegex.exec(html)) !== null) {
    articles.push({
      articleNo: match[1].trim(),
      title: match[2].trim().slice(0, 150),
      text: match[2].trim(),
    });
  }

  // If no articles found with regex, try splitting by numbered sections
  if (articles.length === 0) {
    const sections = html.split(/(?=\d+\s*(?:дүгээр|дугаар|[а-я]+р)\s+зүйл)/);
    for (let i = 1; i < sections.length && articles.length < 50; i++) {
      const section = sections[i].trim();
      const lines = section.split('\n');
      if (lines.length > 0) {
        const header = lines[0];
        const content = lines.slice(1).join('\n').slice(0, 500);
        articles.push({
          articleNo: header.slice(0, 30),
          title: header.slice(0, 100),
          text: content,
        });
      }
    }
  }

  return articles;
}
