// ────────────────────────────────────────────────────────────
// legalinfo.mn Crawler — Resilient legal acts crawler adapter
// ────────────────────────────────────────────────────────────

import type { LegalDomain, ParsedDocument } from '@legal-chatbot/shared';
import type { ICrawler, CrawlerConfig, CrawlResult } from './base.crawler.js';
import { createLogger } from '../lib/logger.js';
import { normalizeText } from '../processing/normalizer.js';
import { findWorkspaceRoot } from '../lib/workspace-path.js';
import axios, { AxiosError } from 'axios';
import * as cheerio from 'cheerio';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const logger = createLogger('crawler:legalinfo');

const DEFAULT_CONFIG: CrawlerConfig = {
  delayMs: Number(process.env.CRAWL_DELAY_MS ?? 1200),
  maxConcurrent: Number(process.env.CRAWL_MAX_CONCURRENT ?? 1),
  userAgent: process.env.CRAWL_USER_AGENT ?? 'LegalRAGBot/0.2',
  cacheDir: process.env.CRAWL_CACHE_DIR ?? 'data/raw',
  limit: Number(process.env.CRAWL_DISCOVERY_LIMIT ?? 5000),
};

/**
 * Crawler adapter for legalinfo.mn (Mongolian legal acts).
 * Implements resilient discovery/fetch and structured extraction.
 */
export class LegalinfoCrawler implements ICrawler {
  readonly source = 'legalinfo' as const;

  private readonly config: CrawlerConfig;
  private readonly baseUrl = 'https://legalinfo.mn';
  private readonly timeoutMs = Number(process.env.CRAWL_TIMEOUT_MS ?? 20000);
  private readonly maxRetries = Number(process.env.CRAWL_MAX_RETRIES ?? 4);
  private readonly workspaceRoot: string;
  private readonly failureLogPath: string;
  private readonly defaultCategoryIds = [
    27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 26, 186, 180, 390,
  ];

  constructor(config: Partial<CrawlerConfig> = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      limit: config.limit ?? DEFAULT_CONFIG.limit,
    };
    this.workspaceRoot = findWorkspaceRoot();
    this.failureLogPath = resolve(
      this.workspaceRoot,
      'data/processed/failures/legalinfo-failed.jsonl',
    );
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
  }

  private resolveMaxDocs(limit: number): number {
    const configuredLimit =
      Number.isFinite(this.config.limit) && this.config.limit > 0 ? this.config.limit : limit;

    return Math.max(1, Math.min(limit, configuredLimit));
  }

  private getDiscoveryCategoryIds(): number[] {
    const raw = process.env.CRAWL_LEGALINFO_CATEGORY_IDS?.trim();
    if (!raw) {
      return this.defaultCategoryIds;
    }

    const parsed = raw
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value > 0);

    return parsed.length > 0 ? Array.from(new Set(parsed)) : this.defaultCategoryIds;
  }

  private async recordFailure(stage: string, url: string, error: string): Promise<void> {
    try {
      await mkdir(resolve(this.workspaceRoot, 'data/processed/failures'), { recursive: true });
      await appendFile(
        this.failureLogPath,
        `${JSON.stringify({ source: this.source, stage, url, error, at: new Date().toISOString() })}\n`,
        'utf-8',
      );
    } catch (writeError) {
      logger.debug(
        { err: writeError instanceof Error ? writeError.message : String(writeError), stage, url },
        'Failed to persist failure log line',
      );
    }
  }

  private isRetryableError(err: unknown): boolean {
    if (err instanceof AxiosError) {
      const status = err.response?.status;
      if (status && (status === 429 || status === 408 || status >= 500)) {
        return true;
      }

      const code = err.code ?? '';
      return ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(code);
    }

    return false;
  }

  private async fetchHtmlWithRetry(url: string): Promise<{ statusCode: number; html: string }> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await axios.get(url, {
          timeout: this.timeoutMs,
          maxRedirects: 5,
          responseType: 'arraybuffer',
          validateStatus: () => true,
          headers: {
            'User-Agent': this.config.userAgent,
            Accept: 'text/html,application/xhtml+xml',
            'Accept-Language': 'mn,en;q=0.8',
          },
        });

        const statusCode = response.status;
        const body = response.data;
        const html =
          typeof body === 'string'
            ? body
            : Buffer.isBuffer(body)
              ? body.toString('utf-8')
              : body instanceof ArrayBuffer
                ? Buffer.from(body).toString('utf-8')
                : '';

        if (statusCode >= 200 && statusCode < 300 && html.length > 100) {
          return { statusCode, html };
        }

        const statusError = new Error(`HTTP ${statusCode} or empty body (${html.length} bytes)`);
        if (!(statusCode === 429 || statusCode === 408 || statusCode >= 500)) {
          throw statusError;
        }

        lastError = statusError;
      } catch (err) {
        lastError = err;
        if (!this.isRetryableError(err) || attempt >= this.maxRetries) {
          throw err;
        }
      }

      if (attempt < this.maxRetries) {
        const backoffMs = Math.min(12000, 600 * 2 ** attempt + Math.floor(Math.random() * 300));
        await this.sleep(backoffMs);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private normalizeUrl(href: string, fromUrl: string): string | null {
    if (!href || href.startsWith('javascript:') || href.startsWith('#')) {
      return null;
    }

    try {
      const absolute = new URL(href, fromUrl);
      if (!absolute.hostname.endsWith('legalinfo.mn')) {
        return null;
      }
      absolute.hash = '';
      return absolute.toString();
    } catch {
      return null;
    }
  }

  private extractLawIdFromAnyUrl(url: string): string {
    try {
      const parsed = new URL(url, this.baseUrl);
      const fromQuery = parsed.searchParams.get('lawId') ?? parsed.searchParams.get('id');
      if (fromQuery && /^\d+$/.test(fromQuery)) {
        return fromQuery;
      }

      const pathMatch = parsed.pathname.match(/(?:detail|law)\/(\d+)/i);
      return pathMatch?.[1] ?? '';
    } catch {
      return '';
    }
  }

  private extractLawIdFromDetailUrl(url: string): string {
    try {
      const parsed = new URL(url, this.baseUrl);
      const path = parsed.pathname.toLowerCase();

      // legalinfo document pages are detail views.
      if (!path.includes('/detail')) {
        return '';
      }

      const fromQuery = parsed.searchParams.get('lawId') ?? parsed.searchParams.get('id');
      if (fromQuery && /^\d+$/.test(fromQuery)) {
        return fromQuery;
      }

      const pathMatch = parsed.pathname.match(/detail\/(\d+)/i);
      return pathMatch?.[1] ?? '';
    } catch {
      return '';
    }
  }

  private toCanonicalLawUrl(url: string): string | null {
    const lawId = this.extractLawIdFromDetailUrl(url);
    if (!lawId) {
      return null;
    }

    return `${this.baseUrl}/mn/detail?lawId=${lawId}`;
  }

  private extractDetailUrlsFromHtml(html: string, fromUrl: string): string[] {
    const urls = new Set<string>();
    if (!html || html.length === 0) {
      return [];
    }

    try {
      const $ = cheerio.load(html);
      $('a[href]').each((_, elem) => {
        const href = $(elem).attr('href');
        if (!href) {
          return;
        }

        const normalized = this.normalizeUrl(href, fromUrl);
        if (!normalized) {
          return;
        }

        const canonical = this.toCanonicalLawUrl(normalized);
        if (canonical) {
          urls.add(canonical);
        }
      });
    } catch {
      // Continue with regex fallback.
    }

    const detailRegex = /\/mn\/detail\?[^"'\s>]*lawId=(\d+)/gi;
    let match: RegExpExecArray | null;
    while ((match = detailRegex.exec(html)) !== null) {
      const canonical = `${this.baseUrl}/mn/detail?lawId=${match[1]}`;
      urls.add(canonical);
    }

    return Array.from(urls);
  }

  private extractMaxAjaxPage(html: string): number {
    const pageRegex = /ajaxPage\((\d+)\)/g;
    let maxPage = 1;
    let match: RegExpExecArray | null;

    while ((match = pageRegex.exec(html)) !== null) {
      const value = Number(match[1]);
      if (Number.isInteger(value) && value > maxPage) {
        maxPage = value;
      }
    }

    return Math.max(1, maxPage);
  }

  private async fetchAjaxListPageWithRetry(categoryId: number, page: number): Promise<string> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const payload = new URLSearchParams({
          filtercategorytypeid: String(categoryId),
          page: String(page),
        });

        const response = await axios.post(`${this.baseUrl}/mn/ajaxList/`, payload.toString(), {
          timeout: this.timeoutMs,
          validateStatus: () => true,
          headers: {
            'User-Agent': this.config.userAgent,
            Accept: 'application/json,text/plain,*/*',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            Referer: `${this.baseUrl}/mn/law/${categoryId}`,
          },
        });

        const statusCode = response.status;
        const body = response.data;
        const html =
          typeof body === 'string'
            ? body
            : body &&
                typeof body === 'object' &&
                'Html' in body &&
                typeof (body as { Html?: unknown }).Html === 'string'
              ? String((body as { Html: string }).Html)
              : '';

        if (statusCode >= 200 && statusCode < 300) {
          return html;
        }

        const statusError = new Error(`AJAX list HTTP ${statusCode}`);
        if (!(statusCode === 429 || statusCode === 408 || statusCode >= 500)) {
          throw statusError;
        }

        lastError = statusError;
      } catch (err) {
        lastError = err;
        if (!this.isRetryableError(err) || attempt >= this.maxRetries) {
          throw err;
        }
      }

      if (attempt < this.maxRetries) {
        const backoffMs = Math.min(10000, 500 * 2 ** attempt + Math.floor(Math.random() * 250));
        await this.sleep(backoffMs);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async discoverFromAjaxList(maxDocs: number): Promise<string[]> {
    const discovered = new Set<string>();
    const categoryIds = this.getDiscoveryCategoryIds();
    const maxPagesPerCategoryRaw = Number(process.env.CRAWL_LEGALINFO_MAX_PAGES_PER_CATEGORY ?? 0);
    const maxPagesPerCategory =
      Number.isFinite(maxPagesPerCategoryRaw) && maxPagesPerCategoryRaw > 0
        ? Math.floor(maxPagesPerCategoryRaw)
        : 0;

    const requestBudget = Math.max(40, Math.ceil(maxDocs / 8) * 2);
    let ajaxRequests = 0;

    const states = categoryIds.map((categoryId) => ({
      categoryId,
      nextPage: 1,
      maxPage: 1,
      initialized: false,
    }));

    while (discovered.size < maxDocs && ajaxRequests < requestBudget) {
      let active = false;

      for (const state of states) {
        if (discovered.size >= maxDocs || ajaxRequests >= requestBudget) {
          break;
        }

        if (state.initialized && state.nextPage > state.maxPage) {
          continue;
        }

        active = true;
        const pageToFetch = state.nextPage;

        try {
          const html = await this.fetchAjaxListPageWithRetry(state.categoryId, pageToFetch);
          ajaxRequests++;

          if (!state.initialized) {
            const detectedMaxPage = this.extractMaxAjaxPage(html);
            state.maxPage =
              maxPagesPerCategory > 0
                ? Math.min(detectedMaxPage, maxPagesPerCategory)
                : detectedMaxPage;
            state.initialized = true;
          }

          const urls = this.extractDetailUrlsFromHtml(
            html,
            `${this.baseUrl}/mn/law/${state.categoryId}`,
          );
          for (const url of urls) {
            if (discovered.size >= maxDocs) {
              break;
            }

            discovered.add(url);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(
            { categoryId: state.categoryId, page: pageToFetch, err: message },
            'Failed to fetch ajax discovery page',
          );
          await this.recordFailure(
            'discover-ajax',
            `${this.baseUrl}/mn/law/${state.categoryId}?page=${pageToFetch}`,
            message,
          );
        }

        state.nextPage += 1;

        if (discovered.size < maxDocs) {
          await this.sleep(Math.max(150, Math.floor(this.config.delayMs * 0.5)));
        }
      }

      if (!active) {
        break;
      }
    }

    logger.info(
      {
        discovered: discovered.size,
        categories: categoryIds.length,
        ajaxRequests,
        requestBudget,
      },
      'Legalinfo AJAX discovery complete',
    );

    return Array.from(discovered).slice(0, maxDocs);
  }

  private async buildListingQueue(): Promise<string[]> {
    const queue = new Set<string>([
      `${this.baseUrl}/mn/law/27`,
      `${this.baseUrl}/mn/latestlaw`,
      `${this.baseUrl}/mn/dislaw/27`,
      `${this.baseUrl}/mn/overlaw/27`,
    ]);

    try {
      const { html } = await this.fetchHtmlWithRetry(`${this.baseUrl}/mn/law`);
      const $ = cheerio.load(html);

      $('a[href]').each((_, elem) => {
        const href = $(elem).attr('href');
        if (!href) {
          return;
        }

        const normalized = this.normalizeUrl(href, `${this.baseUrl}/mn/law`);
        if (!normalized || !this.isListingUrl(normalized)) {
          return;
        }

        queue.add(normalized);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err: message }, 'Failed to expand listing queue from /mn/law');
      await this.recordFailure('discover-seeds', `${this.baseUrl}/mn/law`, message);
    }

    return Array.from(queue);
  }

  private isListingUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      if (!parsed.hostname.endsWith('legalinfo.mn')) {
        return false;
      }

      const path = parsed.pathname.toLowerCase();
      return (
        path.startsWith('/mn/law') ||
        path.startsWith('/mn/latestlaw') ||
        path.startsWith('/mn/dislaw') ||
        path.startsWith('/mn/overlaw') ||
        parsed.searchParams.has('page')
      );
    } catch {
      return false;
    }
  }

  private async loadSeedFallback(limit: number): Promise<string[]> {
    const explicitSeedFiles = (process.env.CRAWL_LEGALINFO_SEED_FILE ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

    const candidates = [
      ...explicitSeedFiles.flatMap((seedFile) => [
        resolve(this.workspaceRoot, 'data/seed', seedFile),
        resolve(this.workspaceRoot, 'seed', seedFile),
      ]),
      resolve(this.workspaceRoot, 'data/seed/legalinfo_urls.txt'),
      resolve(this.workspaceRoot, 'seed/legalinfo_urls.txt'),
    ];

    for (const seedPath of candidates) {
      try {
        const content = await readFile(seedPath, 'utf-8');
        const urls = content
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map((line) => this.toCanonicalLawUrl(line) ?? line)
          .filter((line): line is string => Boolean(line));

        if (urls.length > 0) {
          return Array.from(new Set(urls)).slice(0, limit);
        }
      } catch {
        continue;
      }
    }

    return [];
  }

  async discoverUrls(limit: number): Promise<string[]> {
    const maxDocs = this.resolveMaxDocs(limit);
    const discovered = new Set<string>();
    const visitedListingPages = new Set<string>();

    const disableAjax = /^(true|1|yes)$/i.test(process.env.CRAWL_LEGALINFO_DISABLE_AJAX ?? '');
    if (!disableAjax) {
      const ajaxDiscovered = await this.discoverFromAjaxList(maxDocs);
      ajaxDiscovered.forEach((url) => discovered.add(url));
    } else {
      logger.info('Legalinfo AJAX discovery disabled by environment flag');
    }

    const disableListing = /^(true|1|yes)$/i.test(
      process.env.CRAWL_LEGALINFO_DISABLE_LISTING ?? '',
    );
    const queue: string[] = disableListing ? [] : await this.buildListingQueue();
    if (disableListing) {
      logger.info('Legalinfo listing-page discovery disabled by environment flag');
    }
    const maxListingVisits = Math.max(120, Math.min(1000, maxDocs * 4));

    while (
      queue.length > 0 &&
      discovered.size < maxDocs &&
      visitedListingPages.size < maxListingVisits
    ) {
      const listingUrl = queue.shift()!;
      if (visitedListingPages.has(listingUrl)) {
        continue;
      }
      visitedListingPages.add(listingUrl);

      try {
        const { html } = await this.fetchHtmlWithRetry(listingUrl);
        this.extractDetailUrlsFromHtml(html, listingUrl).forEach((url) => discovered.add(url));
        const $ = cheerio.load(html);

        $('a[href]').each((_, elem) => {
          const href = $(elem).attr('href');
          if (!href) {
            return;
          }

          const normalized = this.normalizeUrl(href, listingUrl);
          if (!normalized) {
            return;
          }

          const canonicalLawUrl = this.toCanonicalLawUrl(normalized);
          if (canonicalLawUrl) {
            discovered.add(canonicalLawUrl);
            return;
          }

          if (this.isListingUrl(normalized) && !visitedListingPages.has(normalized)) {
            queue.push(normalized);
          }
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ listingUrl, err: message }, 'Failed to crawl listing page');
        await this.recordFailure('discover', listingUrl, message);
      }

      await this.sleep(this.config.delayMs);
    }

    if (discovered.size < maxDocs) {
      const seedFallback = await this.loadSeedFallback(maxDocs);
      let topUpCount = 0;

      for (const url of seedFallback) {
        if (discovered.size >= maxDocs) {
          break;
        }

        if (!discovered.has(url)) {
          discovered.add(url);
          topUpCount++;
        }
      }

      if (topUpCount > 0) {
        logger.info(
          { fallbackCount: topUpCount, discovered: discovered.size },
          'Used seed URL top-up for legalinfo',
        );
      }
    }

    const discoveredUrls = Array.from(discovered).slice(0, maxDocs);
    logger.info(
      { discovered: discoveredUrls.length, visitedListingPages: visitedListingPages.size },
      'Legalinfo discovery complete',
    );

    return discoveredUrls;
  }

  async fetchPage(url: string): Promise<CrawlResult> {
    const fetchedAt = new Date().toISOString();

    try {
      const { statusCode, html } = await this.fetchHtmlWithRetry(url);
      await this.sleep(this.config.delayMs);

      return {
        url,
        rawHtml: html,
        statusCode,
        fetchedAt,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ url, err: message }, 'Failed to fetch legalinfo page');
      await this.recordFailure('fetch', url, message);

      return {
        url,
        rawHtml: '',
        statusCode: 0,
        fetchedAt,
      };
    }
  }

  private toIsoDate(text: string): string {
    const compact = text.replace(/\s+/g, ' ');

    const isoMatch = compact.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
    if (isoMatch) {
      return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
    }

    const dottedMatch = compact.match(/\b(20\d{2})\.(\d{1,2})\.(\d{1,2})\b/);
    if (dottedMatch) {
      return `${dottedMatch[1]}-${dottedMatch[2].padStart(2, '0')}-${dottedMatch[3].padStart(2, '0')}`;
    }

    const mongolianMatch = compact.match(
      /(20\d{2})\s*оны\s*(\d{1,2})\s*(?:дугаар\s*)?сарын?\s*(\d{1,2})/i,
    );
    if (mongolianMatch) {
      return `${mongolianMatch[1]}-${mongolianMatch[2].padStart(2, '0')}-${mongolianMatch[3].padStart(2, '0')}`;
    }

    return '';
  }

  private classifyDomain(title: string, text: string): LegalDomain {
    const full = `${title} ${text}`.toUpperCase();

    if (full.includes('ЭРҮҮГ')) {
      return 'criminal';
    }
    if (full.includes('ИРГЭН')) {
      return 'civil';
    }
    if (full.includes('ЗАХИРГА')) {
      return 'administrative';
    }
    if (full.includes('ҮНДСЭН ХУУЛ')) {
      return 'constitutional';
    }

    return 'other';
  }

  private fallbackExternalId(url: string): string {
    const lawId = this.extractLawIdFromAnyUrl(url);
    if (lawId) {
      return lawId;
    }

    return (
      url
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 64) || 'legalinfo'
    );
  }

  private isStructuralHeading(line: string): boolean {
    return (
      /\b\d+(?:\.\d+)?\s*(?:дүгээр|дугаар)\s+зүйл\b/i.test(line) ||
      /\b(БҮЛЭГ|АНГИ|ХЭСЭГ)\b/i.test(line)
    );
  }

  async parse(result: CrawlResult): Promise<ParsedDocument> {
    const today = new Date().toISOString().slice(0, 10);

    if (!result.rawHtml || result.rawHtml.length < 50) {
      const externalId = this.fallbackExternalId(result.url);
      return {
        externalId,
        source: 'legalinfo',
        url: result.url,
        title: 'Хууль',
        date: today,
        domain: 'other',
        cleanedText: '',
        metadata: {
          lawId: this.extractLawIdFromAnyUrl(result.url) || undefined,
        },
        structured: {
          law_id: this.extractLawIdFromAnyUrl(result.url) || null,
          title: 'Хууль',
          date: today,
          article_no: null,
          text_body: '',
        },
        rawHtml: result.rawHtml,
      };
    }

    try {
      const $ = cheerio.load(result.rawHtml);

      const lawIdFromUrl = this.extractLawIdFromAnyUrl(result.url);
      const lawIdFromScript = result.rawHtml.match(/var\s+lawId\s*=\s*['"]?(\d+)['"]?/i)?.[1] ?? '';
      const lawIdFromInline = result.rawHtml.match(/lawId\s*:\s*(\d+)/i)?.[1] ?? '';
      const lawId = lawIdFromUrl || lawIdFromScript || lawIdFromInline;

      const title =
        $('meta[property="og:title"]').attr('content')?.trim() ||
        $('h1').first().text().trim() ||
        $('ul.uk-breadcrumb li').last().text().trim() ||
        'Хууль';

      const lawContentLines = $('#law-content')
        .find('h1, h2, h3, h4, p, li')
        .map((_, elem) => $(elem).text().trim())
        .get();

      const treeLines = $('form.sanal-form label.line-clamp-1')
        .map((_, elem) => $(elem).text().trim())
        .get();

      const fallbackBodyLines = $('main, article, .tw-shine-huuli-container')
        .first()
        .find('h1, h2, h3, h4, p, li')
        .map((_, elem) => $(elem).text().trim())
        .get();

      const rawLines =
        lawContentLines.length > 0
          ? lawContentLines
          : treeLines.length > 0
            ? treeLines
            : fallbackBodyLines;

      const filteredLines: string[] = [];
      const seen = new Set<string>();
      for (const line of rawLines) {
        const normalizedLine = line.replace(/\s+/g, ' ').trim();
        if (!normalizedLine) {
          continue;
        }
        if (/^(Бүгд|Шүүлтүүр|Нүүр|Тусламж|Хайлт)$/i.test(normalizedLine)) {
          continue;
        }
        if (/^[\d\s.,;:()\-]+$/.test(normalizedLine)) {
          continue;
        }
        if (seen.has(normalizedLine)) {
          continue;
        }

        seen.add(normalizedLine);
        filteredLines.push(normalizedLine);
      }

      const articleNumbers: string[] = [];
      const formattedLines: string[] = [];
      for (const line of filteredLines) {
        if (this.isStructuralHeading(line)) {
          if (formattedLines.length > 0 && formattedLines[formattedLines.length - 1] !== '') {
            formattedLines.push('');
          }
          formattedLines.push(line);
          formattedLines.push('');

          const articleMatch = line.match(/^(\d+(?:\.\d+)?)\s*(?:дүгээр|дугаар)\s+зүйл\b/i);
          if (articleMatch) {
            articleNumbers.push(articleMatch[1]);
          }
          continue;
        }

        formattedLines.push(line);
      }

      const compactLines = formattedLines.filter(
        (line, index) => !(line === '' && formattedLines[index - 1] === ''),
      );

      let cleanedText = normalizeText(compactLines.join('\n'))
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (cleanedText.length < 200) {
        cleanedText = normalizeText($('body').text()).slice(0, 50000);
      }

      // Guard against list/filter pages accidentally parsed as legal documents.
      if (
        articleNumbers.length === 0 &&
        cleanedText.length < 1200 &&
        /Хүчинтэй\s+эсэх|Шүүлтүүр|Хайлтын\s+үр\s+дүн/i.test(cleanedText)
      ) {
        throw new Error('Detected non-document legalinfo page during parse');
      }

      const date =
        this.toIsoDate(`${result.rawHtml}\n${filteredLines.slice(0, 30).join('\n')}`) || today;
      const firstArticleNo = articleNumbers[0] ?? '';
      const domain = this.classifyDomain(title, cleanedText);
      const externalId = lawId || this.fallbackExternalId(result.url);

      return {
        externalId,
        source: 'legalinfo',
        url: result.url,
        title,
        date,
        domain,
        cleanedText,
        metadata: {
          lawId: lawId || undefined,
          articleNo: firstArticleNo || undefined,
          articleNumbers: articleNumbers.length > 0 ? articleNumbers : undefined,
          articleCount: articleNumbers.length || undefined,
        },
        structured: {
          law_id: lawId || null,
          title,
          date,
          article_no: firstArticleNo || null,
          article_numbers: articleNumbers,
          article_count: articleNumbers.length,
          text_body: cleanedText,
        },
        rawHtml: result.rawHtml,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ url: result.url, err: message }, 'Failed to parse legalinfo document');
      await this.recordFailure('parse', result.url, message);

      const externalId = this.fallbackExternalId(result.url);
      return {
        externalId,
        source: 'legalinfo',
        url: result.url,
        title: 'Хууль',
        date: today,
        domain: 'other',
        cleanedText: '',
        metadata: {
          lawId: this.extractLawIdFromAnyUrl(result.url) || undefined,
        },
        structured: {
          law_id: this.extractLawIdFromAnyUrl(result.url) || null,
          title: 'Хууль',
          date: today,
          article_no: null,
          text_body: '',
          parse_error: message,
        },
        rawHtml: result.rawHtml,
      };
    }
  }

  async shouldCrawl(url: string): Promise<boolean> {
    return Boolean(this.toCanonicalLawUrl(url));
  }
}
