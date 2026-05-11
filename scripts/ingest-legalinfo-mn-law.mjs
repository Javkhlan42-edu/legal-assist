import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const workspaceRoot = resolve(__dirname, '..');
const workerCwd = resolve(workspaceRoot, 'apps/worker');
const seedDir = resolve(workspaceRoot, 'data/seed');
const seedFileName = 'legalinfo_mn_law_urls.txt';
const seedFilePath = resolve(seedDir, seedFileName);

const TOTAL_PAGES = Number.parseInt(process.env.LEGALINFO_MN_LAW_TOTAL_PAGES ?? '47', 10);
const MAX_LIMIT = Number.parseInt(process.env.LEGALINFO_MN_LAW_LIMIT ?? '938', 10);
const CATEGORY_ID = process.env.LEGALINFO_MN_LAW_CATEGORY_ID ?? '27';
const START_DATE = process.env.LEGALINFO_MN_LAW_STARTDATE?.trim() || '';
const CRAWL_DELAY_MS = process.env.CRAWL_DELAY_MS ?? '500';

function buildListingUrl(pageNumber) {
  const base = 'https://legalinfo.mn/mn/law';
  const startDateParam = START_DATE ? `&startdate=${encodeURIComponent(START_DATE)}` : '';
  return `${base}?page=law&cate=${CATEGORY_ID}${startDateParam}&page=${pageNumber}&active=1&sort=title&page=${pageNumber}`;
}

async function sleep(ms) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function fetchAjaxHtml(pageNumber) {
  const response = await fetch('https://legalinfo.mn/mn/ajaxList/', {
    method: 'POST',
    headers: {
      'user-agent': 'LegalRAGBot/0.3',
      accept: 'application/json,text/plain,*/*',
      'accept-language': 'mn,en;q=0.8',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      referer: buildListingUrl(pageNumber),
    },
    body: new URLSearchParams({
      filtercategorytypeid: CATEGORY_ID,
      page: String(pageNumber),
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ajax page ${pageNumber}`);
  }

  const data = await response.json();
  return typeof data === 'string' ? data : String(data.Html || '');
}

function extractDetailUrls(html) {
  const urls = new Set();
  const detailRegex = /\/mn\/detail\?[^"'\\s>]*lawId=(\d+)/gi;
  let match = null;

  while ((match = detailRegex.exec(html)) !== null) {
    urls.add(`https://legalinfo.mn/mn/detail?lawId=${match[1]}`);
  }

  return Array.from(urls);
}

async function discoverListingUrls() {
  const discovered = new Set();

  for (let page = 1; page <= TOTAL_PAGES; page += 1) {
    const url = buildListingUrl(page);
    const html = await fetchAjaxHtml(page);
    const detailUrls = extractDetailUrls(html);

    for (const detailUrl of detailUrls) {
      discovered.add(detailUrl);
    }

    console.log(
      JSON.stringify({
        page,
        totalPages: TOTAL_PAGES,
        discoveredOnPage: detailUrls.length,
        uniqueDiscovered: discovered.size,
        url,
      }),
    );

    if (page < TOTAL_PAGES) {
      await sleep(250);
    }
  }

  return Array.from(discovered);
}

async function writeSeedFile(urls) {
  await mkdir(seedDir, { recursive: true });
  await writeFile(seedFilePath, `${urls.join('\n')}\n`, 'utf-8');
}

function spawnIngest(limit) {
  const childEnv = {
    ...process.env,
    CRAWL_LEGALINFO_DISABLE_AJAX: 'true',
    CRAWL_LEGALINFO_DISABLE_LISTING: 'true',
    CRAWL_LEGALINFO_SEED_FILE: seedFileName,
    CRAWL_LEGALINFO_ONLY_MONGOLIAN_LAW: 'true',
    PIPELINE_FAIL_FAST: 'false',
    CRAWL_DELAY_MS,
  };

  console.log('Starting legalinfo Mongolian-law ingestion from seeded listing pages');
  console.log(
    JSON.stringify(
      {
        categoryId: CATEGORY_ID,
        totalPages: TOTAL_PAGES,
        startDate: START_DATE || null,
        seedFile: seedFilePath,
        limit,
        crawlDelayMs: childEnv.CRAWL_DELAY_MS,
      },
      null,
      2,
    ),
  );

  return process.platform === 'win32'
    ? spawn(
        'cmd.exe',
        ['/c', 'pnpm', 'exec', 'tsx', 'src/index.ts', 'ingest', '--source', 'legalinfo', '--limit', String(limit), '--fresh'],
        {
          cwd: workerCwd,
          env: childEnv,
          stdio: 'inherit',
        },
      )
    : spawn(
        'pnpm',
        ['exec', 'tsx', 'src/index.ts', 'ingest', '--source', 'legalinfo', '--limit', String(limit), '--fresh'],
        {
          cwd: workerCwd,
          env: childEnv,
          stdio: 'inherit',
        },
      );
}

async function main() {
  const discoveredUrls = await discoverListingUrls();
  const limitedUrls = discoveredUrls.slice(0, MAX_LIMIT);
  await writeSeedFile(limitedUrls);

  console.log(
    JSON.stringify(
      {
        discoveredTotal: discoveredUrls.length,
        limitedTotal: limitedUrls.length,
        seedFile: seedFilePath,
      },
      null,
      2,
    ),
  );

  const child = spawnIngest(limitedUrls.length);

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 1);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
