import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import pino from 'pino';
import { LegalinfoCrawler } from '../crawlers/legalinfo.crawler.js';

type PriorityCategory = 'civil' | 'constitution' | 'election' | 'traffic';

type PriorityHit = {
  category: PriorityCategory;
  url: string;
  lawId: string;
  title: string;
  score: number;
};

type PriorityHitMap = Record<PriorityCategory, PriorityHit[]>;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: resolve(__dirname, '../../.env') });

const logger = pino({ name: 'generate-priority-seed' });
const workspaceRoot = resolve(__dirname, '../../../..');

const BASE_SEED_PATH = resolve(workspaceRoot, 'data/seed/legalinfo_urls.txt');
const PRIORITY_SEED_PATH = resolve(workspaceRoot, 'data/seed/legalinfo_priority_urls.txt');
const REPORT_PATH = resolve(workspaceRoot, 'data/processed/index/priority_law_report.json');

const REQUIRED_COUNTS: Record<PriorityCategory, number> = {
  civil: 1,
  constitution: 1,
  election: 1,
  traffic: 2,
};

const KNOWN_PRIORITY_URLS = [
  'https://legalinfo.mn/mn/detail?lawId=299',
  'https://legalinfo.mn/mn/detail?lawId=367',
  'https://legalinfo.mn/mn/detail?lawId=29',
  'https://legalinfo.mn/mn/detail?lawId=12656',
  'https://legalinfo.mn/mn/detail?lawId=15701',
  'https://legalinfo.mn/mn/detail?lawId=135',
];

function parseIntSafe(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseLawId(url: string): string {
  try {
    const parsed = new URL(url);
    const lawId = parsed.searchParams.get('lawId') ?? '';
    return lawId.trim();
  } catch {
    return '';
  }
}

function extractTitle(rawHtml: string): string {
  if (!rawHtml) {
    return '';
  }

  const og = rawHtml.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
  if (og?.[1]) {
    return og[1].replace(/\s+/g, ' ').trim();
  }

  const title = rawHtml.match(/<title>([^<]+)<\/title>/i);
  if (title?.[1]) {
    return title[1].replace(/\s+/g, ' ').trim();
  }

  return '';
}

function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().toUpperCase();
}

function isElectionLawTitle(normalizedTitle: string): boolean {
  if (!normalizedTitle.includes('СОНГУУЛИЙН ТУХАЙ')) {
    return false;
  }

  const excluded = [
    'ЗАРИМ ЗААЛТ',
    'ТАЙЛБАРЛАХ',
    'МАРГААН',
    'ӨРШӨӨЛ',
    'ОЙГ ТОХИОЛДУУЛАН',
    'ДАГАЖ МӨРДӨХ ЖУРАМ',
    'БУЦААХ',
    'ТӨСӨЛ',
    'ДҮГНЭЛТ',
    'ТОГТООЛ',
  ];

  return !excluded.some((token) => normalizedTitle.includes(token));
}

function isTrafficLawTitle(normalizedTitle: string): boolean {
  const positives = [
    'ЗАМЫН ХӨДӨЛГӨӨНИЙ АЮУЛГҮЙ БАЙДЛЫН ТУХАЙ',
    'ЗӨРЧЛИЙН ТУХАЙ',
    'АВТОТЭЭВРИЙН ТУХАЙ',
    'АВТО ЗАМЫН ТУХАЙ',
  ];

  if (!positives.some((token) => normalizedTitle.includes(token))) {
    return false;
  }

  const excluded = [
    'ЗАРИМ ЗҮЙЛ',
    'ЗАРИМ ЗААЛТ',
    'ТАЙЛБАРЛАХ',
    'ЖУРАМ',
    'ХЭМЖЭЭГ ТОГТООХ',
    'АЛБАН ТАТВАР',
    'ХӨТӨЛБӨР',
    'ДҮГНЭЛТ',
    'ТОГТООЛ',
  ];

  return !excluded.some((token) => normalizedTitle.includes(token));
}

function classifyPriorityTitle(title: string): PriorityCategory | null {
  const normalized = normalizeTitle(title);

  if (normalized === 'ИРГЭНИЙ ХУУЛЬ') {
    return 'civil';
  }

  if (normalized === 'МОНГОЛ УЛСЫН ҮНДСЭН ХУУЛЬ') {
    return 'constitution';
  }

  if (isElectionLawTitle(normalized)) {
    return 'election';
  }

  if (isTrafficLawTitle(normalized)) {
    return 'traffic';
  }

  return null;
}

function scoreHit(category: PriorityCategory, title: string): number {
  const normalized = normalizeTitle(title);

  if (category === 'civil' && normalized === 'ИРГЭНИЙ ХУУЛЬ') {
    return 100;
  }

  if (category === 'constitution' && normalized === 'МОНГОЛ УЛСЫН ҮНДСЭН ХУУЛЬ') {
    return 100;
  }

  if (category === 'election') {
    if (normalized === 'СОНГУУЛИЙН ТУХАЙ ХУУЛЬ') {
      return 100;
    }

    if (normalized.includes('МОНГОЛ УЛСЫН ИХ ХУРЛЫН СОНГУУЛИЙН ТУХАЙ')) {
      return 95;
    }

    return 80;
  }

  if (category === 'traffic') {
    if (normalized.includes('ЗАМЫН ХӨДӨЛГӨӨНИЙ АЮУЛГҮЙ БАЙДЛЫН ТУХАЙ')) {
      return 100;
    }

    if (normalized.includes('ЗӨРЧЛИЙН ТУХАЙ')) {
      return 95;
    }

    if (normalized.includes('АВТОТЭЭВРИЙН ТУХАЙ')) {
      return 90;
    }

    if (normalized.includes('АВТО ЗАМЫН ТУХАЙ')) {
      return 85;
    }

    return 70;
  }

  return 50;
}

async function readSeedUrls(filePath: string): Promise<string[]> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return Array.from(
      new Set(
        content
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      ),
    );
  } catch {
    return [];
  }
}

function mergeSeedUrls(base: string[], additional: string[]): string[] {
  const merged = new Set(base);
  for (const url of additional) {
    merged.add(url);
  }

  return Array.from(merged);
}

function requirementsSatisfied(hitsByCategory: PriorityHitMap): boolean {
  return (Object.keys(REQUIRED_COUNTS) as PriorityCategory[]).every(
    (category) => hitsByCategory[category].length >= REQUIRED_COUNTS[category],
  );
}

function essentialRequirementsSatisfied(hitsByCategory: PriorityHitMap): boolean {
  return (
    hitsByCategory.civil.length >= 1 &&
    hitsByCategory.constitution.length >= 1 &&
    hitsByCategory.traffic.length >= 2
  );
}

function takeUrlsForCategory(category: PriorityCategory, hits: PriorityHit[]): string[] {
  if (hits.length === 0) {
    return [];
  }

  const sorted = [...hits].sort((a, b) => b.score - a.score);
  const baseline = REQUIRED_COUNTS[category];
  const maxExtra = category === 'traffic' ? 4 : 2;
  const takeCount = Math.max(baseline, Math.min(maxExtra, sorted.length));

  return sorted.slice(0, takeCount).map((hit) => hit.url);
}

async function writeTextFile(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
}

async function main(): Promise<void> {
  const discoveryLimit = parseIntSafe(process.env.PRIORITY_DISCOVERY_LIMIT, 900);
  const maxFetch = parseIntSafe(process.env.PRIORITY_MAX_FETCH, 220);
  const crawlDelayMs = parseIntSafe(process.env.PRIORITY_CRAWL_DELAY_MS, 120);

  const crawler = new LegalinfoCrawler({ delayMs: crawlDelayMs, limit: discoveryLimit });

  const baseSeedUrls = await readSeedUrls(BASE_SEED_PATH);
  const discoveredUrls = await crawler.discoverUrls(discoveryLimit);
  const candidates = Array.from(
    new Set([...KNOWN_PRIORITY_URLS, ...baseSeedUrls, ...discoveredUrls]),
  );

  logger.info(
    {
      baseSeedUrls: baseSeedUrls.length,
      discoveredUrls: discoveredUrls.length,
      candidates: candidates.length,
      discoveryLimit,
      maxFetch,
      crawlDelayMs,
    },
    'Priority-law discovery started',
  );

  const hitsByCategory: PriorityHitMap = {
    civil: [],
    constitution: [],
    election: [],
    traffic: [],
  };

  const inspectCount = Math.min(candidates.length, maxFetch);

  for (let index = 0; index < inspectCount; index += 1) {
    const url = candidates[index];

    try {
      const fetched = await crawler.fetchPage(url);
      if (!fetched.rawHtml || fetched.statusCode < 200 || fetched.statusCode >= 300) {
        continue;
      }

      const title = extractTitle(fetched.rawHtml);
      if (!title) {
        continue;
      }

      const category = classifyPriorityTitle(title);
      if (!category) {
        continue;
      }

      const lawId = parseLawId(url);
      const exists = hitsByCategory[category].some(
        (hit) => (lawId && hit.lawId === lawId) || hit.url === url,
      );
      if (exists) {
        continue;
      }

      const hit: PriorityHit = {
        category,
        url,
        lawId,
        title,
        score: scoreHit(category, title),
      };

      hitsByCategory[category].push(hit);

      logger.info(
        {
          index: index + 1,
          category,
          lawId: lawId || 'unknown',
          title,
          url,
        },
        'Priority law candidate found',
      );

      if (requirementsSatisfied(hitsByCategory)) {
        logger.info({ index: index + 1 }, 'All required priority-law categories found');
        break;
      }

      if (index >= 3 && essentialRequirementsSatisfied(hitsByCategory)) {
        logger.info(
          { index: index + 1 },
          'Essential priority-law categories found; using fallback URLs for remaining categories',
        );
        break;
      }
    } catch (error) {
      logger.debug(
        {
          url,
          error: error instanceof Error ? error.message : String(error),
        },
        'Skipping candidate URL due to fetch failure',
      );
    }
  }

  const selectedUrls = Array.from(
    new Set([
      ...takeUrlsForCategory('civil', hitsByCategory.civil),
      ...takeUrlsForCategory('constitution', hitsByCategory.constitution),
      ...takeUrlsForCategory('election', hitsByCategory.election),
      ...takeUrlsForCategory('traffic', hitsByCategory.traffic),
      ...KNOWN_PRIORITY_URLS,
    ]),
  );

  await writeTextFile(PRIORITY_SEED_PATH, `${selectedUrls.join('\n')}\n`);

  const mergedBaseSeed = mergeSeedUrls(baseSeedUrls, selectedUrls);
  const baseSeedChanged = mergedBaseSeed.length !== baseSeedUrls.length;
  if (baseSeedChanged) {
    await writeTextFile(BASE_SEED_PATH, `${mergedBaseSeed.join('\n')}\n`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    discoveryLimit,
    maxFetch,
    crawlDelayMs,
    selectedUrls,
    hitsByCategory,
    summary: {
      civil: hitsByCategory.civil.length,
      constitution: hitsByCategory.constitution.length,
      election: hitsByCategory.election.length,
      traffic: hitsByCategory.traffic.length,
      selectedUrlCount: selectedUrls.length,
      mergedSeedCount: mergedBaseSeed.length,
      baseSeedChanged,
    },
  };

  await writeTextFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);

  logger.info(
    {
      selectedUrlCount: selectedUrls.length,
      baseSeedChanged,
      mergedSeedCount: mergedBaseSeed.length,
      prioritySeedPath: PRIORITY_SEED_PATH,
      reportPath: REPORT_PATH,
      summary: report.summary,
    },
    'Priority-law seed generation completed',
  );
}

main().catch((error) => {
  logger.error(
    {
      error: error instanceof Error ? error.message : String(error),
    },
    'Priority-law seed generation failed',
  );
  process.exit(1);
});
