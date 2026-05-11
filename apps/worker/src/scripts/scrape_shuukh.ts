/**
 * apps/worker/src/scripts/scrape_shuukh.ts
 * ESM горимд зориулж засагдсан хувилбар
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import pLimit from 'p-limit';

// ── ESM-д __dirname орлуулах ──────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ══════════════════════════════════════════════
// ТОХИРГОО — энд тоог өөрчилж болно
// ══════════════════════════════════════════════

const START_ID = 213350;
const END_ID = 213450;
const CONCURRENCY = 3;
const DELAY_MS = 800;
const RETRY_COUNT = 3;

// monorepo root → data/raw/shuukh
const OUT_DIR = path.join(__dirname, '../../../../data/raw/shuukh');

const makeUrl = (id: number) => `https://shuukh.mn/single_case/${id}?%20&id=1&court_cat=1&bb=2`;

// ══════════════════════════════════════════════
// HTTP CLIENT
// ══════════════════════════════════════════════

const http = axios.create({
  timeout: 20000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/120.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'mn,en-US;q=0.9,en;q=0.8',
    Connection: 'keep-alive',
    Referer: 'https://shuukh.mn/',
  },
  maxRedirects: 5,
});

// ══════════════════════════════════════════════
// НЭГ ХЭРЭГ ТАТАХ
// ══════════════════════════════════════════════

async function fetchCase(id: number): Promise<'saved' | 'skipped' | 'empty' | 'error'> {
  const outPath = path.join(OUT_DIR, `${id}.html`);

  // Аль хэдийн татсан бол алгасах
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 500) {
    return 'skipped';
  }

  for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
    try {
      const res = await http.get<string>(makeUrl(id), { responseType: 'text' });
      const html = res.data as string;

      const isEmpty =
        html.length < 1000 ||
        html.includes('Хэрэг олдсонгүй') ||
        html.includes('404') ||
        !html.includes('shuukh.mn');

      if (isEmpty) return 'empty';

      fs.writeFileSync(outPath, html, 'utf-8');
      return 'saved';
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 404) return 'empty';
      if (status === 429) {
        console.warn(`\n  [${id}] Rate limit — 10s хүлээж байна...`);
        await sleep(10000);
        continue;
      }
      if (attempt === RETRY_COUNT) return 'error';
      await sleep(DELAY_MS * attempt * 2);
    }
  }
  return 'error';
}

// ══════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const ids = Array.from({ length: END_ID - START_ID + 1 }, (_, i) => START_ID + i);
  const total = ids.length;
  const limit = pLimit(CONCURRENCY);
  const stats = { saved: 0, skipped: 0, empty: 0, error: 0 };
  let done = 0;

  console.log(`\n🏛  shuukh.mn хэрэг татаж байна`);
  console.log(`   Дугаар: ${START_ID} → ${END_ID} (${total} хэрэг)`);
  console.log(`   Хадгалах: ${OUT_DIR}\n`);

  const errorLog = path.join(OUT_DIR, '_errors.txt');
  if (!fs.existsSync(errorLog)) fs.writeFileSync(errorLog, '');

  const tasks = ids.map((id) =>
    limit(async () => {
      await sleep(DELAY_MS);
      const result = await fetchCase(id);
      stats[result]++;
      done++;
      if (result === 'error') fs.appendFileSync(errorLog, `${id}\n`);

      const pct = Math.round((done / total) * 100);
      const filled = Math.round(pct / 2);
      const bar = '█'.repeat(filled) + '░'.repeat(50 - filled);
      process.stdout.write(
        `\r[${bar}] ${pct}% | ✓${stats.saved} ⏭${stats.skipped} ○${stats.empty} ✗${stats.error} | ${done}/${total}`,
      );
    }),
  );

  await Promise.all(tasks);

  console.log('\n\n══════════════════════════════════');
  console.log(`✅  Дууслаа!`);
  console.log(`   Татсан:   ${stats.saved}`);
  console.log(`   Алгассан: ${stats.skipped}`);
  console.log(`   Хоосон:   ${stats.empty}`);
  console.log(`   Алдаа:    ${stats.error}`);
  console.log('══════════════════════════════════\n');

  if (stats.error > 0) {
    console.log(`💡 Алдаатай хэргийг retry хийх:`);
    console.log(`   pnpm exec tsx src/scripts/scrape_shuukh.ts --retry\n`);
  }
}

// ══════════════════════════════════════════════
// RETRY
// ══════════════════════════════════════════════

async function retryErrors(): Promise<void> {
  const errorLog = path.join(OUT_DIR, '_errors.txt');
  if (!fs.existsSync(errorLog)) {
    console.log('Retry файл байхгүй.');
    return;
  }

  const ids = fs
    .readFileSync(errorLog, 'utf-8')
    .split('\n')
    .map((l) => parseInt(l.trim()))
    .filter((n) => !isNaN(n));

  if (!ids.length) {
    console.log('Retry хийх алдаа байхгүй.');
    return;
  }

  console.log(`\n🔄  ${ids.length} хэрэг retry...\n`);
  fs.writeFileSync(errorLog, '');

  const limit = pLimit(2);
  let done = 0;
  const stats = { saved: 0, empty: 0, error: 0 };

  await Promise.all(
    ids.map((id) =>
      limit(async () => {
        await sleep(1500);
        const r = await fetchCase(id);
        if (r === 'saved') stats.saved++;
        else if (r === 'empty') stats.empty++;
        else {
          stats.error++;
          fs.appendFileSync(errorLog, `${id}\n`);
        }
        done++;
        process.stdout.write(
          `\r  ${done}/${ids.length} | ✓${stats.saved} ○${stats.empty} ✗${stats.error}`,
        );
      }),
    ),
  );
  console.log(`\n✅  Retry дууслаа: ${stats.saved} амжилттай`);
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// ── Entry point ───────────────────────────────
const isRetry = process.argv.includes('--retry');
(isRetry ? retryErrors() : main()).catch((err) => {
  console.error('\n❌  Алдаа:', err.message);
  process.exit(1);
});
