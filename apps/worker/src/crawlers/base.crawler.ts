// ────────────────────────────────────────────────────────────
// Base Crawler — Abstract interface for source crawlers
// ────────────────────────────────────────────────────────────

import type { ParsedDocument, SourceType } from '@legal-chatbot/shared';

/**
 * Configuration for a crawler adapter.
 */
export interface CrawlerConfig {
  /** Delay between requests in ms */
  delayMs: number;
  /** Maximum concurrent requests */
  maxConcurrent: number;
  /** User-Agent string */
  userAgent: string;
  /** Cache directory for raw HTML */
  cacheDir: string;
  /** Maximum documents to crawl in one run */
  limit: number;
}

/**
 * Result of a crawl operation for a single document.
 */
export interface CrawlResult {
  url: string;
  rawHtml: string;
  statusCode: number;
  fetchedAt: string;
}

/**
 * Abstract crawler interface. Each data source implements this.
 */
export interface ICrawler {
  /** The source type this crawler handles */
  readonly source: SourceType;

  /**
   * Discover document URLs to crawl.
   * Returns a list of URLs (paginated listing pages).
   */
  discoverUrls(limit: number): Promise<string[]>;

  /**
   * Fetch a single document page.
   */
  fetchPage(url: string): Promise<CrawlResult>;

  /**
   * Parse a crawled page into a structured document.
   */
  parse(result: CrawlResult): Promise<ParsedDocument>;

  /**
   * Check if a URL should be crawled (respects robots.txt, cache, etc.).
   */
  shouldCrawl(url: string): Promise<boolean>;
}
