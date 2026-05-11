// ────────────────────────────────────────────────────────────
// Article Search Service — PostgreSQL-backed legal article lookup
// ────────────────────────────────────────────────────────────

import { dbQuery } from '../lib/db.js';
import type { AppEnv } from '../config/env.js';

export interface ArticleSearchResult {
  articleNum: string;
  lawId: string;
  title: string;
  content: string;
  subsections: Array<{ num: string; content: string }>;
  score: number;
  lawUrl: string;
}

interface ArticleRow {
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}

export class ArticleSearchService {
  constructor(env: AppEnv) {
    void env;
  }

  async searchArticle(
    query: string,
    lawSource: 'legalinfo' | 'shuukh' = 'legalinfo',
  ): Promise<ArticleSearchResult[]> {
    const articleNum = extractArticleNumber(query);
    if (!articleNum) {
      return [];
    }

    const [main, ...rest] = articleNum.split('.');
    return this.searchByArticleNumber(main, rest.join('.') || undefined, lawSource);
  }

  async searchByArticleNumber(
    mainArticle: string,
    subsection?: string,
    lawSource: 'legalinfo' | 'shuukh' = 'legalinfo',
  ): Promise<ArticleSearchResult[]> {
    const articlePattern = `${mainArticle}${subsection ? `.${subsection}` : ''}`;
    const likePattern = `%${articlePattern}%`;

    const rows = await dbQuery<ArticleRow>(
      `SELECT
         c.text AS content,
         GREATEST(
           ts_rank(to_tsvector('simple', c.text), plainto_tsquery('simple', $2::text)),
           CASE
             WHEN c.metadata->>'articleNo' = $2 THEN 1.0
             WHEN c.text ILIKE $3 THEN 0.6
             ELSE 0.1
           END
         ) AS score,
         c.metadata
       FROM chunks c
       INNER JOIN documents d ON d.id = c.document_id
       WHERE d.source::text = $1
         AND (
           c.metadata->>'articleNo' = $2
           OR c.text ILIKE $3
           OR to_tsvector('simple', c.text) @@ plainto_tsquery('simple', $2::text)
         )
       ORDER BY score DESC
       LIMIT 10`,
      [lawSource, articlePattern, likePattern],
    );

    const seen = new Set<string>();
    const results: ArticleSearchResult[] = [];

    for (const row of rows) {
      const metadata = row.metadata || {};
      const articleNo = String(metadata.articleNo ?? articlePattern);
      const key = `${metadata.sourceId ?? metadata.lawId ?? 'unknown'}:${articleNo}:${row.content.slice(0, 60)}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      results.push({
        articleNum: articleNo,
        lawId: String(metadata.sourceId ?? metadata.lawId ?? 'Unknown'),
        title: String(metadata.title ?? metadata.documentTitle ?? 'Untitled'),
        content: row.content,
        subsections: this.extractSubsectionsFromContent(row.content),
        score: Number(row.score),
        lawUrl: String(metadata.url ?? metadata.documentUrl ?? ''),
      });
    }

    return results.slice(0, 5);
  }

  private extractSubsectionsFromContent(content: string): Array<{ num: string; content: string }> {
    const subsections: Array<{ num: string; content: string }> = [];
    const regex = /(^|\n)(\d+(?:\.\d+)*)\s*(?:заалт|хэсэг)?\s*[:.)-]?\s*([^\n]+)/g;

    let match: RegExpExecArray | null = null;
    while ((match = regex.exec(content)) !== null) {
      const num = match[2];
      const subsectionText = match[3]?.trim();
      if (!num || !subsectionText) {
        continue;
      }

      subsections.push({ num, content: subsectionText });
    }

    return subsections;
  }

  buildArticleExplanation(result: ArticleSearchResult): string {
    let explanation = '';

    explanation += `## ${result.articleNum} дүгээр зүйл\n\n`;
    explanation += `**${result.title}**\n\n`;

    if (result.content) {
      explanation += `${result.content}\n\n`;
    }

    if (result.subsections.length > 0) {
      explanation += `### Дэлгэрэнгүй\n\n`;
      for (const sub of result.subsections) {
        explanation += `- **${sub.num}:** ${sub.content}\n`;
      }
      explanation += '\n';
    }

    if (result.lawUrl) {
      explanation += `\n**Эх сурвалж:** [${result.lawId}](${result.lawUrl})\n`;
    }

    return explanation;
  }
}

function extractArticleNumber(query: string): string | null {
  const normalized = query.replace(/,/g, '.');

  const explicit = normalized.match(/(\d+(?:\.\d+)*)\s*(?:дугаар|дүгээр)?\s*(?:зүйл|заалт|хэсэг)/i);
  if (explicit?.[1]) {
    return explicit[1];
  }

  const generic = normalized.match(/\b(\d+(?:\.\d+)*)\b/);
  return generic?.[1] ?? null;
}

let service: ArticleSearchService;

export function createArticleSearchService(env: AppEnv): ArticleSearchService {
  if (!service) {
    service = new ArticleSearchService(env);
  }
  return service;
}

export function getArticleSearchService(): ArticleSearchService {
  if (!service) {
    throw new Error('ArticleSearchService not initialized. Call createArticleSearchService first.');
  }
  return service;
}
