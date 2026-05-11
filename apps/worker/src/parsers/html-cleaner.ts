// ────────────────────────────────────────────────────────────
// HTML Cleaner — Strip HTML to extract clean text
// ────────────────────────────────────────────────────────────

import * as cheerio from 'cheerio';

/**
 * Clean raw HTML to extract readable text content.
 * Removes scripts, styles, navigation, and boilerplate elements.
 * Preserves paragraph structure and handles Mongolian encoding.
 */
export function cleanHtml(rawHtml: string): string {
  try {
    const $ = cheerio.load(rawHtml);

    // 1. Remove unwanted elements
    $('script, style, noscript, svg, iframe, meta, link, head, nav, header, footer').remove();
    $('.nav, .navigation, .sidebar, .advertisement, .ad, .ads').remove();
    $('[class*="banner"], [class*="widget"], [class*="hidden"]').remove();

    // 2. Extract content from main container or fall back to body
    let content = '';
    const mainContent = $('main, article, [role="main"], .content, .main').html();

    if (mainContent && mainContent.trim().length > 100) {
      content = mainContent;
    } else {
      content = $('body').html() || rawHtml;
    }

    // 3. Parse text with cheerio and preserve structure
    const $content = cheerio.load(`<div>${content}</div>`);
    const paragraphs: string[] = [];

    // Get all block elements and paragraphs
    $content('p, div, section, article, h1, h2, h3, h4, h5, h6, li').each((_i, el) => {
      const text = $content(el).text().trim().replace(/\s+/g, ' ');

      // Only include non-empty paragraphs with reasonable length
      if (text.length > 10 && text.length < 5000) {
        paragraphs.push(text);
      }
    });

    // 4. Deduplicate consecutive identical lines
    const deduped: string[] = [];
    for (let i = 0; i < paragraphs.length; i++) {
      if (i === 0 || paragraphs[i] !== paragraphs[i - 1]) {
        deduped.push(paragraphs[i]);
      }
    }

    // 5. Join with double newlines to preserve structure
    const cleanText = deduped.join('\n\n');

    // 6. Final cleanup: normalize whitespace while preserving structure
    return cleanText
      .replace(/\n\n\n+/g, '\n\n') // Remove excessive blank lines
      .replace(/\r\n/g, '\n') // Normalize line endings
      .trim();
  } catch (err) {
    // Fallback to basic regex if cheerio fails
    console.error('Cheerio parsing failed, using fallback regex:', err);
    return rawHtml
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
