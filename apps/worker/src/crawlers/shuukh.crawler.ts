// ────────────────────────────────────────────────────────────
// shuukh.mn Crawler — Resilient court decisions crawler adapter
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

const logger = createLogger('crawler:shuukh');

const DEFAULT_CONFIG: CrawlerConfig = {
  delayMs: Number(process.env.CRAWL_DELAY_MS ?? 1200),
  maxConcurrent: Number(process.env.CRAWL_MAX_CONCURRENT ?? 1),
  userAgent: process.env.CRAWL_USER_AGENT ?? 'LegalRAGBot/0.2',
  cacheDir: process.env.CRAWL_CACHE_DIR ?? 'data/raw',
  limit: Number(process.env.CRAWL_DISCOVERY_LIMIT ?? 5000),
};

const MAX_DISCOVERY_PAGE_VISITS = Number(process.env.SHUUKH_MAX_DISCOVERY_PAGES ?? 300);
const DEFAULT_RECENT_MONTH_WINDOW = Number(process.env.SHUUKH_RECENT_MONTHS ?? 4);
const SHUUKH_LISTING_BY_CATEGORY = {
  '1': { id: '1', courtCat: '1', bb: '1', label: 'civil' },
  '2': { id: '1', courtCat: '2', bb: '1', label: 'criminal' },
  '3': { id: '1', courtCat: '3', bb: '1', label: 'administrative' },
} as const;

type ShuukhListingConfig = (typeof SHUUKH_LISTING_BY_CATEGORY)[keyof typeof SHUUKH_LISTING_BY_CATEGORY];

const SHUUKH_TOPIC_KEYWORDS_BY_CATEGORY = {
  '1': ['зам тээвэр', 'даатгал', 'осол', 'гэрээ', 'зээл', 'хөдөлмөр', 'нөхөн төлбөр'],
  '2': ['хулгай', 'залилан', 'хүчирхийлэл', 'мансууруулах', 'осол', 'авлига'],
  '3': ['татвар', 'төрийн алба', 'ашигт малтмал'],
} as const;

interface ShuukhDiscoveryBucket {
  listing: ShuukhListingConfig;
  label: string;
  query?: string;
  weight: number;
}

interface ShuukhCaseAjaxResponse {
  count?: number | string;
  view?: string;
  pagination_link?: string;
}

/**
 * Crawler adapter for shuukh.mn (Mongolian court decisions).
 * Implements resilient discovery/fetch and structured extraction.
 */
export class ShuukhCrawler implements ICrawler {
  readonly source = 'shuukh' as const;

  private readonly config: CrawlerConfig;
  private readonly baseUrl = 'https://shuukh.mn';
  private readonly timeoutMs = Number(process.env.CRAWL_TIMEOUT_MS ?? 20000);
  private readonly maxRetries = Number(process.env.CRAWL_MAX_RETRIES ?? 4);
  private readonly workspaceRoot: string;
  private readonly failureLogPath: string;

  constructor(config: Partial<CrawlerConfig> = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      limit: config.limit ?? DEFAULT_CONFIG.limit,
    };
    this.workspaceRoot = findWorkspaceRoot();
    this.failureLogPath = resolve(
      this.workspaceRoot,
      'data/processed/failures/shuukh-failed.jsonl',
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

  private formatDiscoveryDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}/${month}/${day}`;
  }

  private resolveDiscoveryDateRange(): string {
    const explicit = process.env.SHUUKH_DATERANGE?.trim();
    if (explicit) {
      return explicit;
    }

    const today = new Date();
    const recentMonths = Math.max(1, DEFAULT_RECENT_MONTH_WINDOW);
    const start = new Date(today.getFullYear(), today.getMonth() - (recentMonths - 1), 1);

    return `${this.formatDiscoveryDate(start)} - ${this.formatDiscoveryDate(today)}`;
  }

  private resolveCaseListings(): ShuukhListingConfig[] {
    const configuredCategories = (process.env.SHUUKH_COURT_CATEGORIES ?? '2,1')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

    const listings = configuredCategories
      .map((category) => SHUUKH_LISTING_BY_CATEGORY[category as keyof typeof SHUUKH_LISTING_BY_CATEGORY])
      .filter((listing): listing is ShuukhListingConfig => Boolean(listing));

    return listings.length > 0 ? listings : [SHUUKH_LISTING_BY_CATEGORY['2'], SHUUKH_LISTING_BY_CATEGORY['1']];
  }

  private resolveTopicKeywords(courtCat: ShuukhListingConfig['courtCat']): string[] {
    const envKey =
      courtCat === '1'
        ? 'SHUUKH_TOPIC_KEYWORDS_CIVIL'
        : courtCat === '2'
          ? 'SHUUKH_TOPIC_KEYWORDS_CRIMINAL'
          : 'SHUUKH_TOPIC_KEYWORDS_ADMIN';

    const configured = process.env[envKey]
      ?.split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

    const defaults = SHUUKH_TOPIC_KEYWORDS_BY_CATEGORY[courtCat] ?? [];
    const merged = configured && configured.length > 0 ? configured : Array.from(defaults);

    return Array.from(new Set(merged.map((value) => value.trim()).filter((value) => value.length > 0)));
  }

  private resolveDiscoveryBuckets(): ShuukhDiscoveryBucket[] {
    const listings = this.resolveCaseListings();
    const buckets: ShuukhDiscoveryBucket[] = [];

    for (const listing of listings) {
      buckets.push({
        listing,
        label: `${listing.label}:recent`,
        weight: 3,
      });

      for (const keyword of this.resolveTopicKeywords(listing.courtCat)) {
        buckets.push({
          listing,
          label: `${listing.label}:${keyword}`,
          query: keyword,
          weight: 1,
        });
      }
    }

    return buckets;
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

  private decodeResponseBody(body: unknown): string {
    if (typeof body === 'string') {
      return body;
    }

    if (Buffer.isBuffer(body)) {
      return body.toString('utf-8');
    }

    if (body instanceof ArrayBuffer) {
      return Buffer.from(body).toString('utf-8');
    }

    return '';
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
        const html = this.decodeResponseBody(response.data);

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

  private async fetchJsonWithRetry<T>(url: string): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await axios.get(url, {
          timeout: Math.max(this.timeoutMs, 45000),
          maxRedirects: 5,
          responseType: 'arraybuffer',
          validateStatus: () => true,
          headers: {
            'User-Agent': this.config.userAgent,
            Accept: 'application/json, text/plain, */*',
            'Accept-Language': 'mn,en;q=0.8',
            Referer: this.baseUrl,
            'X-Requested-With': 'XMLHttpRequest',
          },
        });

        const statusCode = response.status;
        const rawBody = this.decodeResponseBody(response.data);

        if (statusCode >= 200 && statusCode < 300 && rawBody.length > 2) {
          return JSON.parse(rawBody) as T;
        }

        const statusError = new Error(`HTTP ${statusCode} or empty JSON body (${rawBody.length} bytes)`);
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
      if (!absolute.hostname.endsWith('shuukh.mn')) {
        return null;
      }
      absolute.hash = '';
      return absolute.toString();
    } catch {
      return null;
    }
  }

  private extractCaseIdFromUrl(url: string): string {
    try {
      const parsed = new URL(url, this.baseUrl);
      const fromPath = parsed.pathname.match(/(?:single_case|decisions)\/(\d+)/i)?.[1] ?? '';
      const fromParam =
        parsed.searchParams.get('case_id') ??
        parsed.searchParams.get('id') ??
        parsed.searchParams.get('court_cat');

      if (fromPath && /^\d{4,}$/.test(fromPath)) {
        return fromPath;
      }

      if (fromParam && /^\d{4,}$/.test(fromParam)) {
        return fromParam;
      }

      return '';
    } catch {
      return '';
    }
  }

  private toCanonicalCaseUrl(url: string): string | null {
    try {
      const parsed = new URL(url, this.baseUrl);
      const caseId = this.extractCaseIdFromUrl(parsed.toString());
      if (!caseId) {
        return null;
      }

      const canonical = new URL(`${this.baseUrl}/single_case/${caseId}`);
      for (const key of ['daterange', 'id', 'court_cat', 'bb']) {
        const value = parsed.searchParams.get(key);
        if (value) {
          canonical.searchParams.set(key, value);
        }
      }

      return canonical.toString();
    } catch {
      return null;
    }
  }

  private isListingUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      if (!parsed.hostname.endsWith('shuukh.mn')) {
        return false;
      }

      const path = parsed.pathname.toLowerCase();
      return (
        path === '/' ||
        path.startsWith('/search') ||
        path.startsWith('/cases/') ||
        path.startsWith('/selective/') ||
        path.startsWith('/conflict/') ||
        parsed.searchParams.has('page')
      );
    } catch {
      return false;
    }
  }

  private async loadSeedFallback(limit: number): Promise<string[]> {
    const candidates = [
      resolve(this.workspaceRoot, 'data/seed/shuukh_urls.txt'),
      resolve(this.workspaceRoot, 'seed/shuukh_urls.txt'),
    ];

    for (const seedPath of candidates) {
      try {
        const content = await readFile(seedPath, 'utf-8');
        const urls = content
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map((line) => this.toCanonicalCaseUrl(line) ?? line)
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

  private extractCaseUrlsFromHtml(htmlFragment: string, fromUrl: string): string[] {
    if (!htmlFragment.trim()) {
      return [];
    }

    const $ = cheerio.load(`<div>${htmlFragment}</div>`);
    const urls = new Set<string>();

    $('a[href]').each((_, elem) => {
      const href = $(elem).attr('href');
      if (!href) {
        return;
      }

      const normalized = this.normalizeUrl(href, fromUrl);
      if (!normalized) {
        return;
      }

      const canonicalCaseUrl = this.toCanonicalCaseUrl(normalized);
      if (canonicalCaseUrl) {
        urls.add(canonicalCaseUrl);
      }
    });

    return Array.from(urls);
  }

  private async discoverUrlsViaAjax(
    limit: number,
  ): Promise<{ urls: string[]; pagesVisited: number }> {
    const discovered = new Set<string>();
    const discoveryBuckets = this.resolveDiscoveryBuckets();
    const discoveryDateRange = this.resolveDiscoveryDateRange();
    let pagesVisited = 0;
    let remainingWeight = discoveryBuckets.reduce((sum, bucket) => sum + Math.max(1, bucket.weight), 0);

    for (
      let bucketIndex = 0;
      bucketIndex < discoveryBuckets.length &&
      discovered.size < limit &&
      pagesVisited < MAX_DISCOVERY_PAGE_VISITS;
      bucketIndex += 1
    ) {
      const bucket = discoveryBuckets[bucketIndex];
      const listing = bucket.listing;
      const remainingTarget = limit - discovered.size;
      const bucketWeight = Math.max(1, bucket.weight);
      const bucketTarget = Math.max(
        1,
        Math.ceil((remainingTarget * bucketWeight) / Math.max(1, remainingWeight)),
      );

      let page = 1;
      let totalPages = Number.POSITIVE_INFINITY;
      let discoveredForBucket = 0;

      while (
        discovered.size < limit &&
        discoveredForBucket < bucketTarget &&
        page <= totalPages &&
        pagesVisited < MAX_DISCOVERY_PAGE_VISITS
      ) {
        const ajaxUrl = new URL('/site/case_ajax', this.baseUrl);
        ajaxUrl.searchParams.set('id', listing.id);
        ajaxUrl.searchParams.set('court_cat', listing.courtCat);
        ajaxUrl.searchParams.set('bb', listing.bb);
        ajaxUrl.searchParams.set('page', String(page));
        ajaxUrl.searchParams.set('daterange', discoveryDateRange);
        if (bucket.query) {
          ajaxUrl.searchParams.set('result', bucket.query);
        }

        try {
          const payload = await this.fetchJsonWithRetry<ShuukhCaseAjaxResponse>(ajaxUrl.toString());
          pagesVisited += 1;

          const caseUrls = this.extractCaseUrlsFromHtml(String(payload.view ?? ''), ajaxUrl.toString());
          const beforeCount = discovered.size;
          for (const caseUrl of caseUrls) {
            if (discovered.size >= limit) {
              break;
            }
            discovered.add(caseUrl);
          }

          discoveredForBucket += discovered.size - beforeCount;

          const pageSize = caseUrls.length;
          const totalCount = Number.parseInt(String(payload.count ?? ''), 10);
          if (pageSize === 0) {
            break;
          }

          if (Number.isFinite(totalCount) && totalCount > 0) {
            totalPages = Math.ceil(totalCount / pageSize);
          }

          page += 1;
          if (
            page <= totalPages &&
            discovered.size < limit &&
            discoveredForBucket < bucketTarget
          ) {
            await this.sleep(this.config.delayMs);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(
            {
              ajaxUrl: ajaxUrl.toString(),
              bucket: bucket.label,
              courtCategory: listing.label,
              discoveryDateRange,
              err: message,
            },
            'Failed to crawl shuukh AJAX listing page',
          );
          await this.recordFailure('discover-ajax', ajaxUrl.toString(), message);
          break;
        }
      }

      remainingWeight -= bucketWeight;
    }

    return {
      urls: Array.from(discovered).slice(0, limit),
      pagesVisited,
    };
  }

  async discoverUrls(limit: number): Promise<string[]> {
    const maxDocs = this.resolveMaxDocs(limit);
    const discovered = new Set<string>();
    const visitedListingPages = new Set<string>();
    const ajaxDiscovery = await this.discoverUrlsViaAjax(maxDocs);
    ajaxDiscovery.urls.forEach((url) => discovered.add(url));

    if (discovered.size === 0) {
      const queue: string[] = [
        `${this.baseUrl}/search`,
        `${this.baseUrl}/selective/1/1`,
      ];

      while (
        queue.length > 0 &&
        discovered.size < maxDocs &&
        visitedListingPages.size < MAX_DISCOVERY_PAGE_VISITS
      ) {
        const listingUrl = queue.shift()!;
        if (visitedListingPages.has(listingUrl)) {
          continue;
        }
        visitedListingPages.add(listingUrl);

        try {
          const { html } = await this.fetchHtmlWithRetry(listingUrl);
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

            const canonicalCaseUrl = this.toCanonicalCaseUrl(normalized);
            if (canonicalCaseUrl) {
              discovered.add(canonicalCaseUrl);
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
    }

    if (discovered.size === 0) {
      const seedFallback = await this.loadSeedFallback(maxDocs);
      seedFallback.forEach((url) => discovered.add(url));
      logger.info({ fallbackCount: seedFallback.length }, 'Used seed URL fallback for shuukh');
    }

    const discoveredUrls = Array.from(discovered).slice(0, maxDocs);
    logger.info(
      {
        discovered: discoveredUrls.length,
        discoveryDateRange: this.resolveDiscoveryDateRange(),
        courtCategories: this.resolveCaseListings().map((listing) => listing.courtCat),
        discoveryBuckets: this.resolveDiscoveryBuckets().map((bucket) => bucket.label),
        visitedAjaxPages: ajaxDiscovery.pagesVisited,
        visitedListingPages: visitedListingPages.size,
      },
      'Shuukh discovery complete',
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
      logger.warn({ url, err: message }, 'Failed to fetch shuukh page');
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
    const caseId = this.extractCaseIdFromUrl(url);
    if (caseId) {
      return caseId;
    }

    return (
      url
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 64) || 'shuukh'
    );
  }

  private parseMetadataTable($: cheerio.CheerioAPI): Record<string, string> {
    const metadata: Record<string, string> = {};

    $('div.full-search table tr').each((_, row) => {
      const key = $(row).find('th').first().text().replace(/\s+/g, ' ').trim();
      const value = $(row).find('td').first().text().replace(/\s+/g, ' ').trim();
      if (key && value) {
        metadata[key] = value;
      }
    });

    return metadata;
  }

  private extractParties(cleanedText: string): string[] {
    const parties = new Set<string>();

    const patterns = [
      /нэхэмжлэгч\s*[:：]\s*([^\n.]+)/gi,
      /хариуцагч\s*[:：]\s*([^\n.]+)/gi,
      /хүсэлт\s+гаргагч\s*[:：]\s*([^\n.]+)/gi,
    ];

    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(cleanedText)) !== null) {
        const party = match[1].replace(/\s+/g, ' ').trim();
        if (party && party.length > 2 && party.length < 180) {
          parties.add(party);
        }
      }
    }

    return Array.from(parties).slice(0, 6);
  }

  private cleanDecisionText($: cheerio.CheerioAPI): string {
    const decisionRoot = $('#printableArea .undsen').first();
    const fallbackRoot = $('#printableArea').first();

    const rawText =
      (decisionRoot.length > 0 ? decisionRoot.text() : '') ||
      (fallbackRoot.length > 0 ? fallbackRoot.text() : '') ||
      $('body').text();

    const decoded = rawText
      .replace(/\u00a0/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\r\n/g, '\n');

    const lines = decoded
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => line.length > 0)
      .filter((line) => !/^(Site access|Contact us|©\s*20\d{2}|www\.live\.shuukh\.mn)$/i.test(line))
      .filter((line) => !/^(Алдаа мэдээлэх|Шүүхүүд|Холбоо барих|Иргэн танд)$/i.test(line))
      .filter((line) => !/^[\s.,;:()\-]{1,}$/.test(line));

    const deduped: string[] = [];
    const seenCount = new Map<string, number>();
    for (const line of lines) {
      const count = seenCount.get(line) ?? 0;
      if (count >= 2) {
        continue;
      }
      seenCount.set(line, count + 1);

      if (deduped.length > 0 && deduped[deduped.length - 1] === line) {
        continue;
      }

      deduped.push(line);
    }

    const sectionRegex =
      /^(ТОДОРХОЙЛОХ нь|ҮНДЭСЛЭХ нь|ТОГТООХ нь|ШИЙДВЭРЛЭХ нь|МОНГОЛ УЛСЫН НЭРИЙН ӨМНӨӨС)$/i;
    const formatted: string[] = [];
    for (const line of deduped) {
      if (sectionRegex.test(line)) {
        if (formatted.length > 0 && formatted[formatted.length - 1] !== '') {
          formatted.push('');
        }
        formatted.push(line);
        formatted.push('');
      } else {
        formatted.push(line);
      }
    }

    return normalizeText(formatted.join('\n'))
      .replace(/\n{3,}/g, '\n\n')
      .slice(0, 200000)
      .trim();
  }

  async parse(result: CrawlResult): Promise<ParsedDocument> {
    const today = new Date().toISOString().slice(0, 10);

    if (!result.rawHtml || result.rawHtml.length < 50) {
      const externalId = this.fallbackExternalId(result.url);
      return {
        externalId,
        source: 'shuukh',
        url: result.url,
        title: 'Шүүхийн шийдвэр',
        date: today,
        domain: 'other',
        cleanedText: '',
        metadata: {
          caseId: this.extractCaseIdFromUrl(result.url) || undefined,
        },
        structured: {
          case_id: this.extractCaseIdFromUrl(result.url) || null,
          title: 'Шүүхийн шийдвэр',
          date: today,
          text_body: '',
        },
        rawHtml: result.rawHtml,
      };
    }

    try {
      const $ = cheerio.load(result.rawHtml);
      const metadataTable = this.parseMetadataTable($);

      const caseIdFromUrl = this.extractCaseIdFromUrl(result.url);
      const caseIdFromScript = result.rawHtml.match(/court_cat'\s*:\s*(\d+)/i)?.[1] ?? '';
      const caseId = caseIdFromUrl || caseIdFromScript;

      const title =
        $('#printableArea .decisionfullimg p').first().text().trim() ||
        $('meta[property="og:title"]').attr('content')?.trim() ||
        'Шүүхийн шийдвэр';

      const court = metadataTable['Шүүх'] ?? '';
      const caseNumber = metadataTable['Дугаар'] ?? '';
      const caseIndex = metadataTable['Хэргийн индекс'] ?? '';
      const decisionType = metadataTable['Маргааны төрөл'] ?? '';

      const cleanedText = this.cleanDecisionText($);
      const date =
        this.toIsoDate(`${metadataTable['Огноо'] ?? ''} ${result.rawHtml.slice(0, 2000)}`) || today;
      const parties = this.extractParties(cleanedText);
      const decisionSummary = cleanedText
        .split(/\n+/)
        .filter((line) => line.length > 25)
        .slice(0, 3)
        .join(' ')
        .slice(0, 450);
      const domain = this.classifyDomain(title, `${decisionType} ${cleanedText}`);
      const externalId = caseId || caseIndex || caseNumber || this.fallbackExternalId(result.url);

      return {
        externalId,
        source: 'shuukh',
        url: result.url,
        title,
        date,
        domain,
        cleanedText,
        metadata: {
          caseId: caseId || undefined,
          caseNumber: caseNumber || undefined,
          court: court || undefined,
          parties: parties.length > 0 ? parties : undefined,
          decisionSummary: decisionSummary || undefined,
          decisionType: decisionType || undefined,
        },
        structured: {
          case_id: caseId || null,
          case_number: caseNumber || null,
          case_index: caseIndex || null,
          title,
          court: court || null,
          date,
          dispute_type: decisionType || null,
          parties,
          text_body: cleanedText,
        },
        rawHtml: result.rawHtml,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ url: result.url, err: message }, 'Failed to parse shuukh document');
      await this.recordFailure('parse', result.url, message);

      const externalId = this.fallbackExternalId(result.url);
      return {
        externalId,
        source: 'shuukh',
        url: result.url,
        title: 'Шүүхийн шийдвэр',
        date: today,
        domain: 'other',
        cleanedText: '',
        metadata: {
          caseId: this.extractCaseIdFromUrl(result.url) || undefined,
          decisionSummary: `parse_error: ${message}`,
        },
        structured: {
          case_id: this.extractCaseIdFromUrl(result.url) || null,
          title: 'Шүүхийн шийдвэр',
          date: today,
          text_body: '',
          parse_error: message,
        },
        rawHtml: result.rawHtml,
      };
    }
  }

  async shouldCrawl(url: string): Promise<boolean> {
    return Boolean(this.toCanonicalCaseUrl(url));
  }
}
