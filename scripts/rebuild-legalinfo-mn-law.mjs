import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const workspaceRoot = resolve(__dirname, '..');
const workerCwd = resolve(workspaceRoot, 'apps/worker');
const requireFromWorker = createRequire(resolve(workerCwd, 'package.json'));
const { Client } = requireFromWorker('pg');

const seedDir = resolve(workspaceRoot, 'data/seed');
const seedFileName = 'legalinfo_mn_law_urls.txt';
const seedFilePath = resolve(seedDir, seedFileName);

const TOTAL_PAGES = Number.parseInt(process.env.LEGALINFO_MN_LAW_TOTAL_PAGES ?? '47', 10);
const MAX_LIMIT = Number.parseInt(process.env.LEGALINFO_MN_LAW_LIMIT ?? '938', 10);
const CATEGORY_ID = process.env.LEGALINFO_MN_LAW_CATEGORY_ID ?? '27';
const START_DATE = process.env.LEGALINFO_MN_LAW_STARTDATE?.trim() || '';
const CRAWL_DELAY_MS = process.env.CRAWL_DELAY_MS ?? '500';
const DISCOVER_ONLY = /^(true|1|yes)$/i.test(process.env.LEGALINFO_REBUILD_DISCOVER_ONLY ?? '');
const SKIP_DELETE = /^(true|1|yes)$/i.test(process.env.LEGALINFO_REBUILD_SKIP_DELETE ?? '');

function stripQuotes(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function loadEnvFile(relativePath) {
  const envPath = resolve(workspaceRoot, relativePath);
  if (!existsSync(envPath)) {
    return;
  }

  const content = await readFile(envPath, 'utf-8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }

    const key = line.slice(0, eq).trim();
    const value = stripQuotes(line.slice(eq + 1));
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

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
      'user-agent': 'LegalRAGBot/0.4 legalinfo-mn-law-rebuild',
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
  return typeof data === 'string' ? data : String(data.Html || data.html || '');
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
        stage: 'discover',
        categoryId: CATEGORY_ID,
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

async function tableExists(client, tableName) {
  const result = await client.query('SELECT to_regclass($1) AS name', [`public.${tableName}`]);
  return Boolean(result.rows[0]?.name);
}

async function columnExists(client, tableName, columnName) {
  const result = await client.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND column_name = $2
     LIMIT 1`,
    [tableName, columnName],
  );
  return result.rowCount > 0;
}

async function deleteLegalinfoRows() {
  if (SKIP_DELETE) {
    console.log(JSON.stringify({ stage: 'delete', skipped: true, reason: 'LEGALINFO_REBUILD_SKIP_DELETE=true' }));
    return;
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to delete old legalinfo rows before rebuild.');
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await client.query('BEGIN');

    const deleted = {
      crawlLogs: 0,
      deadLetters: 0,
      documents: 0,
    };

    if (await tableExists(client, 'crawl_logs')) {
      const result = await client.query("DELETE FROM crawl_logs WHERE source = 'legalinfo'");
      deleted.crawlLogs = result.rowCount ?? 0;
    }

    if (await tableExists(client, 'dead_letter_queue')) {
      const result = await client.query("DELETE FROM dead_letter_queue WHERE source = 'legalinfo'");
      deleted.deadLetters = result.rowCount ?? 0;
    }

    const hasSourceType = await columnExists(client, 'documents', 'source_type');
    const documentWhere = hasSourceType
      ? "source = 'legalinfo' OR source_type = 'legalinfo'"
      : "source = 'legalinfo'";
    const documentResult = await client.query(`DELETE FROM documents WHERE ${documentWhere}`);
    deleted.documents = documentResult.rowCount ?? 0;

    await client.query('COMMIT');
    console.log(JSON.stringify({ stage: 'delete', source: 'legalinfo', deleted }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

function spawnIngest(limit) {
  const childEnv = {
    ...process.env,
    CRAWL_LEGALINFO_DISABLE_AJAX: 'true',
    CRAWL_LEGALINFO_DISABLE_LISTING: 'true',
    CRAWL_LEGALINFO_SEED_FILE: seedFileName,
    CRAWL_LEGALINFO_ONLY_MONGOLIAN_LAW: 'true',
    CRAWL_LEGALINFO_CATEGORY_IDS: CATEGORY_ID,
    PIPELINE_FAIL_FAST: 'false',
    CRAWL_DELAY_MS,
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER ?? 'openai',
    OPENAI_EMBEDDING_MODEL: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
    EMBEDDING_DIMENSION: process.env.EMBEDDING_DIMENSION ?? '3072',
  };

  console.log('Starting clean legalinfo Mongolian-law rebuild');
  console.log(
    JSON.stringify(
      {
        categoryId: CATEGORY_ID,
        totalPages: TOTAL_PAGES,
        startDate: START_DATE || null,
        seedFile: seedFilePath,
        limit,
        crawlDelayMs: childEnv.CRAWL_DELAY_MS,
        embeddingProvider: childEnv.EMBEDDING_PROVIDER,
        embeddingModel:
          childEnv.EMBEDDING_PROVIDER === 'local'
            ? childEnv.LOCAL_EMBEDDING_MODEL
            : childEnv.OPENAI_EMBEDDING_MODEL,
        embeddingDimension: childEnv.EMBEDDING_DIMENSION,
        mongolianLawOnly: true,
      },
      null,
      2,
    ),
  );

  const args = [
    'exec',
    'tsx',
    'src/index.ts',
    'ingest',
    '--source',
    'legalinfo',
    '--limit',
    String(limit),
    '--fresh',
  ];

  return process.platform === 'win32'
    ? spawn('cmd.exe', ['/c', 'pnpm', ...args], {
        cwd: workerCwd,
        env: childEnv,
        stdio: 'inherit',
      })
    : spawn('pnpm', args, {
        cwd: workerCwd,
        env: childEnv,
        stdio: 'inherit',
      });
}

async function main() {
  await loadEnvFile('apps/api/.env');
  await loadEnvFile('apps/worker/.env');

  const discoveredUrls = await discoverListingUrls();
  const limitedUrls = discoveredUrls.slice(0, MAX_LIMIT);
  await writeSeedFile(limitedUrls);

  console.log(
    JSON.stringify(
      {
        stage: 'seed',
        discoveredTotal: discoveredUrls.length,
        limitedTotal: limitedUrls.length,
        seedFile: seedFilePath,
        note: 'Only legalinfo cate=27 Mongolian-law listing pages are seeded.',
      },
      null,
      2,
    ),
  );

  if (DISCOVER_ONLY) {
    console.log('Discover-only mode finished. Set LEGALINFO_REBUILD_DISCOVER_ONLY=false to ingest.');
    return;
  }

  await deleteLegalinfoRows();

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
