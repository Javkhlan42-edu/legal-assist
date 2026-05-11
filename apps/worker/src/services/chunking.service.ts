import { extractCaseIds, nowISO, sha256 } from '@legal-chatbot/shared';
import type { Chunk as SharedChunk, ChunkMetadata, SourceType } from '@legal-chatbot/shared';

interface ChunkPiece {
  text: string;
  articleNo?: string;
  articleTitle?: string;
  clauseNo?: string;
  subclauseNo?: string;
  chapter?: string;
  subsection?: string;
  headingPath?: string;
  chunkType: NonNullable<ChunkMetadata['chunkType']> | 'preamble';
  references?: string[];
  amendments?: string[];
}

interface ArticleBlock {
  lineIndex: number;
  articleNo: string;
  articleTitle?: string;
  heading: string;
  chapter?: string;
}

interface SectionHeading {
  lineIndex: number;
  heading: string;
}

export type Chunk = SharedChunk;

export interface ChunkingResult {
  documentId: string;
  chunks: SharedChunk[];
  totalChunks: number;
  totalCharacters: number;
  averageChunkSize: number;
}

const MIN_MERGE_CHARS = 200;
const MAX_CHUNK_CHARS = 600;
const OVERLAP_CHARS = 120;
const DEDUP_PREFIX_CHARS = 200;

const ARTICLE_HEADING_RE =
  /^(?:#{1,6}\s*)?(\d+(?:\.\d+)*)\s*(?:дүгээр|дугаар)\s+зүйл\.?\s*(.*)$/iu;

const CHAPTER_HEADING_RE =
  /^(?:(?:[А-ЯЁӨҮ0-9]+)\s+)?(?:БҮЛЭГ|ДЭД БҮЛЭГ|ХЭСЭГ)\b.*$/iu;

const CLAUSE_PREFIX_RE = /^(\d+(?:\.\d+){1,3})\.?\s+/u;
const LOCAL_NUMBERED_RE = /^(\d+)[.)]\s+/u;
const ALPHA_PREFIX_RE = /^([а-яёөүa-z])(?:\/|\.|\))\s+/iu;

const KEYWORD_STOPWORDS = new Set([
  'бол',
  'ба',
  'болон',
  'эсхүл',
  'энэ',
  'тухай',
  'хуулийн',
  'хууль',
  'зүйл',
  'заалт',
  'дугаар',
  'дүгээр',
  'байна',
  'байх',
  'тэр',
  'нь',
  'ийг',
  'ыг',
  'д',
  'т',
  'аар',
  'ээр',
]);

export class ChunkingService {
  private readonly maxChunkChars: number;

  private readonly overlapChars: number;

  constructor(chunkSizeTokens: number = 512, overlapTokens: number = 64) {
    // Legacy configuration is token-based; this chunker keeps article boundaries
    // stable by using approximate character windows for Mongolian legal text.
    this.maxChunkChars = Math.min(MAX_CHUNK_CHARS, Math.max(350, chunkSizeTokens));
    this.overlapChars = Math.min(Math.max(OVERLAP_CHARS, overlapTokens * 2), Math.floor(this.maxChunkChars / 3));
  }

  private countTokens(text: string): number {
    return text.match(/\S+/g)?.length ?? 0;
  }

  private deterministicUuid(input: string): string {
    const hex = sha256(input).slice(0, 32);
    const variantNibble = ((parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variantNibble}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }

  private normalizeText(text: string): string {
    return text
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\s+(\d+(?:\.\d+)*\s*(?:дүгээр|дугаар)\s+зүйл\.?)/giu, '\n$1')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private normalizeForHash(text: string): string {
    return text.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  private compactHeading(text: string | undefined, maxChars: number = 220): string | undefined {
    const normalized = text
      ?.replace(/\s+/g, ' ')
      .replace(/\s+\d+(?:\.\d+)*\s*(?:дүгээр|дугаар)\s+зүйл\.?.*$/iu, '')
      .trim();
    if (!normalized) {
      return undefined;
    }
    return normalized.length > maxChars ? `${normalized.slice(0, maxChars).trim()}...` : normalized;
  }

  private parseArticleHeading(line: string): ArticleBlock | null {
    const trimmed = line.trim();
    const match = trimmed.match(ARTICLE_HEADING_RE);
    if (!match?.[1]) {
      return null;
    }

    return {
      lineIndex: -1,
      articleNo: match[1],
      articleTitle: this.compactHeading(match[2]),
      heading: this.compactHeading(trimmed, 260) ?? `${match[1]} дугаар зүйл`,
    };
  }

  private isChapterHeading(line: string): boolean {
    return CHAPTER_HEADING_RE.test(line.trim());
  }

  private collectSectionHeadings(lines: string[]): SectionHeading[] {
    const headings: SectionHeading[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]?.trim() ?? '';
      if (line && this.isChapterHeading(line)) {
        headings.push({ lineIndex: i, heading: line });
      }
    }
    return headings;
  }

  private findChapterForLine(headings: SectionHeading[], lineIndex: number): string | undefined {
    let current: string | undefined;
    for (const heading of headings) {
      if (heading.lineIndex > lineIndex) {
        break;
      }
      current = heading.heading;
    }
    return current;
  }

  private detectArticleBlocks(lines: string[]): ArticleBlock[] {
    const headings = this.collectSectionHeadings(lines);
    const blocks: ArticleBlock[] = [];

    for (let i = 0; i < lines.length; i += 1) {
      const parsed = this.parseArticleHeading(lines[i] ?? '');
      if (!parsed) {
        continue;
      }
      blocks.push({
        ...parsed,
        lineIndex: i,
        chapter: this.findChapterForLine(headings, i),
      });
    }

    return blocks;
  }

  private buildPreamble(lines: string[], firstArticleLine: number): ChunkPiece[] {
    if (firstArticleLine <= 0) {
      return [];
    }

    const text = lines.slice(0, firstArticleLine).join('\n').trim();
    if (text.length < MIN_MERGE_CHARS) {
      return [];
    }

    return this.splitOversized({
      text,
      chunkType: 'preamble',
      headingPath: 'preamble',
      references: this.extractReferences(text),
      amendments: this.extractAmendments(text),
    });
  }

  private splitLegalText(text: string): ChunkPiece[] {
    const lines = text.split('\n');
    const articles = this.detectArticleBlocks(lines);
    if (articles.length === 0) {
      return this.splitFallback(text);
    }

    const pieces: ChunkPiece[] = this.buildPreamble(lines, articles[0].lineIndex);

    for (let i = 0; i < articles.length; i += 1) {
      const current = articles[i];
      const next = articles[i + 1];
      const articleText = lines
        .slice(current.lineIndex, next?.lineIndex ?? lines.length)
        .join('\n')
        .trim();

      if (articleText.length < 20) {
        continue;
      }

      pieces.push(...this.splitArticle(articleText, current));
    }

    return this.dedupPieces(this.mergeSmallPieces(pieces));
  }

  private splitArticle(articleText: string, article: ArticleBlock): ChunkPiece[] {
    const lines = articleText.split('\n');
    const clauseStarts: Array<{ lineIndex: number; clauseNo: string }> = [];

    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i]?.trim() ?? '';
      const clauseNo = this.extractClauseNo(line, article.articleNo);
      if (clauseNo) {
        clauseStarts.push({ lineIndex: i, clauseNo });
      }
    }

    if (clauseStarts.length >= 3 || articleText.length > this.maxChunkChars) {
      const clausePieces = this.splitClauses(lines, article, clauseStarts);
      if (clausePieces.length > 0) {
        return clausePieces;
      }
    }

    return this.splitOversized({
      text: articleText,
      articleNo: article.articleNo,
      articleTitle: article.articleTitle,
      chapter: article.chapter,
      headingPath: this.joinPath(article.chapter, article.heading),
      chunkType: 'article',
      references: this.extractReferences(articleText),
      amendments: this.extractAmendments(articleText),
    });
  }

  private splitClauses(
    lines: string[],
    article: ArticleBlock,
    clauseStarts: Array<{ lineIndex: number; clauseNo: string }>,
  ): ChunkPiece[] {
    const pieces: ChunkPiece[] = [];
    const articleHeading = lines[0]?.trim() || article.heading;

    for (let i = 0; i < clauseStarts.length; i += 1) {
      const current = clauseStarts[i];
      const next = clauseStarts[i + 1];
      const clauseText = lines
        .slice(current.lineIndex, next?.lineIndex ?? lines.length)
        .join('\n')
        .trim();

      if (clauseText.length < 10) {
        continue;
      }

      const subsectionPieces = this.splitSubsections(clauseText, article, current.clauseNo, articleHeading);
      if (subsectionPieces.length > 0) {
        pieces.push(...subsectionPieces);
        continue;
      }

      pieces.push(
        ...this.splitOversized({
          text: `${articleHeading}\n${clauseText}`.trim(),
          articleNo: article.articleNo,
          articleTitle: article.articleTitle,
          clauseNo: current.clauseNo,
          chapter: article.chapter,
          subsection: current.clauseNo,
          headingPath: this.joinPath(article.chapter, article.heading, current.clauseNo),
          chunkType: 'clause',
          references: this.extractReferences(clauseText),
          amendments: this.extractAmendments(clauseText),
        }),
      );
    }

    return pieces;
  }

  private splitSubsections(
    clauseText: string,
    article: ArticleBlock,
    clauseNo: string,
    articleHeading: string,
  ): ChunkPiece[] {
    const lines = clauseText.split('\n');
    const starts: Array<{ lineIndex: number; label: string }> = [];

    for (let i = 1; i < lines.length; i += 1) {
      const label = this.extractSubsectionLabel(lines[i] ?? '');
      if (label) {
        starts.push({ lineIndex: i, label });
      }
    }

    if (starts.length === 0) {
      return [];
    }

    const pieces: ChunkPiece[] = [];
    const clauseLead = lines[0]?.trim() ?? clauseNo;
    for (let i = 0; i < starts.length; i += 1) {
      const current = starts[i];
      const next = starts[i + 1];
      const text = lines.slice(current.lineIndex, next?.lineIndex ?? lines.length).join('\n').trim();
      if (text.length < 8) {
        continue;
      }

      const subclauseNo = `${clauseNo}.${current.label}`;
      pieces.push(
        ...this.splitOversized({
          text: `${articleHeading}\n${clauseLead}\n${text}`.trim(),
          articleNo: article.articleNo,
          articleTitle: article.articleTitle,
          clauseNo,
          subclauseNo,
          chapter: article.chapter,
          subsection: subclauseNo,
          headingPath: this.joinPath(article.chapter, article.heading, clauseNo, current.label),
          chunkType: 'subclause',
          references: this.extractReferences(text),
          amendments: this.extractAmendments(text),
        }),
      );
    }

    return pieces;
  }

  private extractClauseNo(line: string, articleNo: string): string | undefined {
    const match = line.match(CLAUSE_PREFIX_RE);
    if (!match?.[1]) {
      return undefined;
    }

    return match[1].startsWith(`${articleNo}.`) ? match[1] : undefined;
  }

  private extractSubsectionLabel(line: string): string | undefined {
    return line.match(LOCAL_NUMBERED_RE)?.[1] ?? line.match(ALPHA_PREFIX_RE)?.[1]?.toLowerCase();
  }

  private splitFallback(text: string): ChunkPiece[] {
    const sectionPieces = this.splitBySection(text);
    if (sectionPieces.length > 0) {
      return this.dedupPieces(this.mergeSmallPieces(sectionPieces));
    }

    return this.splitOversized({
      text,
      chunkType: 'fallback',
      references: this.extractReferences(text),
      amendments: this.extractAmendments(text),
    });
  }

  private splitBySection(text: string): ChunkPiece[] {
    const lines = text.split('\n');
    const headings = this.collectSectionHeadings(lines);
    if (headings.length === 0) {
      return [];
    }

    const pieces: ChunkPiece[] = [];
    for (let i = 0; i < headings.length; i += 1) {
      const current = headings[i];
      const next = headings[i + 1];
      const sectionText = lines.slice(current.lineIndex, next?.lineIndex ?? lines.length).join('\n').trim();
      pieces.push(
        ...this.splitOversized({
          text: sectionText,
          chapter: current.heading,
          headingPath: current.heading,
          chunkType: 'section',
          references: this.extractReferences(sectionText),
          amendments: this.extractAmendments(sectionText),
        }),
      );
    }

    return pieces;
  }

  private splitOversized(piece: ChunkPiece): ChunkPiece[] {
    if (piece.text.length <= this.maxChunkChars) {
      return [piece];
    }

    const sentences = piece.text
      .replace(/([.!?。])\s+/g, '$1\n')
      .split(/\n+/)
      .map((part) => part.trim())
      .filter(Boolean);

    const parts: ChunkPiece[] = [];
    let current = '';

    for (const sentence of sentences.length > 0 ? sentences : [piece.text]) {
      if (sentence.length > this.maxChunkChars) {
        if (current.trim()) {
          parts.push({ ...piece, text: current.trim() });
          current = '';
        }

        parts.push(...this.splitLongSpan(piece, sentence));
        continue;
      }

      const candidate = current ? `${current}\n${sentence}` : sentence;
      if (candidate.length > this.maxChunkChars && current.length > 0) {
        parts.push({ ...piece, text: current.trim() });
        const overlap = current.slice(-this.overlapChars);
        current = `${overlap}\n${sentence}`.trim();
      } else {
        current = candidate;
      }
    }

    if (current.trim()) {
      parts.push({ ...piece, text: current.trim() });
    }

    return parts;
  }

  private splitLongSpan(piece: ChunkPiece, text: string): ChunkPiece[] {
    const parts: ChunkPiece[] = [];
    const stride = Math.max(1, this.maxChunkChars - this.overlapChars);

    for (let start = 0; start < text.length; start += stride) {
      const end = Math.min(start + this.maxChunkChars, text.length);
      const part = text.slice(start, end).trim();
      if (part) {
        parts.push({ ...piece, text: part });
      }

      if (end >= text.length) {
        break;
      }
    }

    return parts;
  }

  private mergeSmallPieces(pieces: ChunkPiece[]): ChunkPiece[] {
    const merged: ChunkPiece[] = [];

    for (const piece of pieces) {
      const previous = merged[merged.length - 1];
      const canMerge =
        previous &&
        piece.text.length < MIN_MERGE_CHARS &&
        previous.articleNo === piece.articleNo &&
        previous.text.length + piece.text.length < this.maxChunkChars;

      if (canMerge) {
        previous.text = `${previous.text}\n${piece.text}`.trim();
        previous.references = Array.from(new Set([...(previous.references ?? []), ...(piece.references ?? [])]));
        previous.amendments = Array.from(new Set([...(previous.amendments ?? []), ...(piece.amendments ?? [])]));
      } else {
        merged.push({ ...piece });
      }
    }

    return merged;
  }

  private dedupPieces(pieces: ChunkPiece[]): ChunkPiece[] {
    const seen = new Set<string>();
    const deduped: ChunkPiece[] = [];

    for (const piece of pieces) {
      const key = sha256(
        `${piece.articleNo ?? ''}:${piece.subclauseNo ?? piece.clauseNo ?? ''}:${this.normalizeForHash(piece.text).slice(0, DEDUP_PREFIX_CHARS)}`,
      );
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push(piece);
    }

    return deduped;
  }

  private extractReferences(text: string): string[] {
    const refs = new Set<string>();
    const referenceRe = /\b\d+(?:\.\d+)*\s*(?:дугаар|дүгээр)?\s*(?:зүйл|заалт)\b/giu;
    for (const match of text.matchAll(referenceRe)) {
      refs.add(match[0].replace(/\s+/g, ' ').trim());
    }
    return Array.from(refs).slice(0, 12);
  }

  private extractAmendments(text: string): string[] {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /(нэмэлт|өөрчлөлт|хүчингүй|шинэчлэн)/iu.test(line))
      .slice(0, 8);
  }

  private extractKeywords(text: string, title: string): string[] {
    const counts = new Map<string, number>();
    const corpus = `${title}\n${text}`.toLowerCase();
    const tokens = corpus.match(/[a-zа-яёөү0-9.]{3,}/giu) ?? [];

    for (const token of tokens) {
      const normalized = token
        .replace(/(ийн|ын|ийг|ыг|аар|ээр|оор|өөр|тай|тэй|гүй|ууд|үүд|нууд|нүүд)$/iu, '')
        .trim();
      if (normalized.length < 3 || KEYWORD_STOPWORDS.has(normalized)) {
        continue;
      }
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }

    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 12)
      .map(([keyword]) => keyword);
  }

  private joinPath(...segments: Array<string | undefined>): string | undefined {
    const parts = segments.map((segment) => segment?.trim()).filter((segment): segment is string => Boolean(segment));
    return parts.length > 0 ? parts.join(' > ') : undefined;
  }

  private buildContextualText(piece: ChunkPiece, lawTitle: string): string {
    const articleTitle = this.compactHeading(piece.articleTitle, 180);
    const context = [
      `Хууль: ${this.compactHeading(lawTitle, 180) ?? lawTitle}`,
      piece.chapter ? `Бүлэг: ${this.compactHeading(piece.chapter, 180)}` : undefined,
      piece.articleNo
        ? `Зүйл: ${piece.articleNo}${articleTitle ? ` ${articleTitle}` : ''}`
        : undefined,
      piece.subsection ? `Дэд хэсэг: ${piece.subsection}` : piece.clauseNo ? `Хэсэг: ${piece.clauseNo}` : undefined,
    ]
      .filter(Boolean)
      .join('\n');

    return context ? `${context}\n\n${piece.text}`.trim() : piece.text.trim();
  }

  private locateChunkStart(fullText: string, chunkText: string, searchFrom: number): number {
    const rawChunk = chunkText.includes('\n\n') ? chunkText.split('\n\n').slice(-1)[0] : chunkText;
    const probe = rawChunk.trim().slice(0, Math.min(120, rawChunk.length));
    const index = probe ? fullText.indexOf(probe, searchFrom) : -1;
    if (index >= 0) {
      return index;
    }
    const fallbackIndex = probe ? fullText.indexOf(probe) : -1;
    return fallbackIndex >= 0 ? fallbackIndex : searchFrom;
  }

  splitByParagraph(text: string): string[] {
    return this.splitFallback(this.normalizeText(text)).map((piece) => piece.text);
  }

  splitWithOverlap(text: string): string[] {
    return this.splitFallback(this.normalizeText(text)).map((piece) => piece.text);
  }

  processDocument(
    documentId: string,
    text: string,
    metadata: {
      source: SourceType;
      sourceId: string;
      title: string;
      url: string;
      date?: string;
      caseId?: string;
      lawId?: string;
      articleNo?: string;
    },
  ): ChunkingResult {
    const normalizedText = this.normalizeText(text);
    if (!normalizedText) {
      return {
        documentId,
        chunks: [],
        totalChunks: 0,
        totalCharacters: 0,
        averageChunkSize: 0,
      };
    }

    const pieces =
      metadata.source === 'legalinfo'
        ? this.splitLegalText(normalizedText)
        : this.dedupPieces(this.mergeSmallPieces(this.splitFallback(normalizedText)));

    const chunks: SharedChunk[] = [];
    let searchCursor = 0;

    for (const piece of pieces) {
      const contextualText = this.buildContextualText(piece, metadata.title);
      if (contextualText.length < 20) {
        continue;
      }

      const startChar = this.locateChunkStart(normalizedText, contextualText, searchCursor);
      const endChar = Math.min(startChar + piece.text.length, normalizedText.length);
      searchCursor = Math.max(startChar + 1, endChar - this.overlapChars);
      const inferredLawId = metadata.lawId ?? (metadata.source === 'legalinfo' ? metadata.sourceId : undefined);
      const inferredCaseId =
        metadata.caseId ??
        (metadata.source === 'shuukh' ? metadata.sourceId || extractCaseIds(contextualText)[0] : undefined);
      const wordCount = this.countTokens(contextualText);
      const keywords = this.extractKeywords(contextualText, metadata.title);

      const chunkMetadata: ChunkMetadata = {
        source: metadata.source,
        sourceId: metadata.sourceId,
        law: metadata.title,
        article: piece.articleNo,
        category: metadata.source === 'legalinfo' ? 'mongolian_law' : metadata.source,
        documentTitle: metadata.title,
        documentUrl: metadata.url,
        documentDate: metadata.date ?? '',
        sourceUrl: metadata.url,
        ...(inferredCaseId && { caseId: inferredCaseId }),
        ...(inferredLawId && { lawId: inferredLawId }),
        ...(piece.articleNo && { articleNo: piece.articleNo }),
        ...(piece.articleTitle && { articleTitle: piece.articleTitle }),
        ...(piece.clauseNo && { clauseNo: piece.clauseNo }),
        ...(piece.subclauseNo && { subclauseNo: piece.subclauseNo }),
        ...(piece.chapter && { chapter: piece.chapter }),
        ...(piece.subsection && { subsection: piece.subsection }),
        ...(piece.headingPath && { headingPath: piece.headingPath }),
        ...(piece.headingPath && { section: piece.headingPath }),
        chunkType: piece.chunkType === 'preamble' ? 'section' : piece.chunkType,
        amendments: piece.amendments ?? [],
        references: piece.references ?? [],
        charCount: contextualText.length,
        wordCount,
        keywords,
      };

      const contentHash = sha256(contextualText);
      const chunkIndex = chunks.length;
      chunks.push({
        id: this.deterministicUuid(`${documentId}:${chunkIndex}:${contentHash}`),
        documentId,
        chunkIndex,
        text: contextualText,
        tokenCount: wordCount,
        charOffset: {
          start: startChar,
          end: endChar,
        },
        metadata: chunkMetadata,
        contentHash,
        createdAt: nowISO(),
      });
    }

    const totalChars = normalizedText.length;
    return {
      documentId,
      chunks,
      totalChunks: chunks.length,
      totalCharacters: totalChars,
      averageChunkSize: chunks.length > 0 ? Math.round(totalChars / chunks.length) : 0,
    };
  }

  async processDocuments(
    documents: Array<{
      id: string;
      text: string;
      source: SourceType;
      sourceId: string;
      title: string;
      url: string;
      date?: string;
    }>,
  ): Promise<ChunkingResult[]> {
    return documents.map((doc) =>
      this.processDocument(doc.id, doc.text, {
        source: doc.source,
        sourceId: doc.sourceId,
        title: doc.title,
        url: doc.url,
        date: doc.date,
      }),
    );
  }
}

const chunkSizeTokens = Number(process.env.CHUNK_SIZE_TOKENS ?? 512);
const chunkOverlapTokens = Number(process.env.CHUNK_OVERLAP_TOKENS ?? 64);

export const chunkingService = new ChunkingService(
  Number.isFinite(chunkSizeTokens) && chunkSizeTokens > 0 ? chunkSizeTokens : 512,
  Number.isFinite(chunkOverlapTokens) &&
    chunkOverlapTokens >= 0 &&
    chunkOverlapTokens < chunkSizeTokens
    ? chunkOverlapTokens
    : 64,
);
