import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LAWS_TO_DOWNLOAD = [
  8928, 11278, 9287, 315, 7106, 9242, 9437, 445, 464, 475, 14696, 554, 11950, 58, 12172, 11634,
  12694, 226, 12393, 11223, 102, 107, 9022, 128, 211, 230, 231, 232, 244, 12658, 8668, 13540, 299,
  11707, 311, 310, 16147372514771, 348, 11225, 419, 123, 13524, 16230623797791, 15356,
  16231043766001, 447, 492, 501, 13538, 13537, 118, 23, 8772, 9056, 11220, 11221, 571, 529, 13592,
  13591, 551, 13589,
  // ── Additional laws for improved citation coverage ──
  12469,  // ЦАТ — Цагдаагийн албаны тухай
  12695,  // ЗТ — Зөрчлийн тухай
  11224,  // ЗХАБТХ — Замын хөдөлгөөний аюулгүй байдлын тухай
  523,    // ХХТ — Харилцаа холбооны тухай
  29,     // АТ — Автотээврийн тухай
  101004, // ХЭХТХ — Хэрэглэгчийн эрхийг хамгаалах тухай
];

const OUTPUT_DIR = path.join(__dirname, '..', 'data', 'raw', 'legalinfo');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function downloadLaw(lawId: number, index: number, total: number) {
  const url = `https://legalinfo.mn/mn/detail?lawId=${lawId}`;
  const filename = `${lawId}.html`;
  const filepath = path.join(OUTPUT_DIR, filename);

  // Skip if already exists
  if (fs.existsSync(filepath)) {
    console.log(`[${index + 1}/${total}] ⏭️  Already exists: ${filename}`);
    return true;
  }

  try {
    console.log(`[${index + 1}/${total}] ⬇️  Downloading: ${filename}`);

    const response = await fetch(url);

    if (!response.ok) {
      console.log(`[${index + 1}/${total}] ❌ Failed (HTTP ${response.status}): ${filename}`);
      return false;
    }

    const html = await response.text();

    fs.writeFileSync(filepath, html, 'utf-8');

    const size = (html.length / 1024).toFixed(2);
    console.log(`[${index + 1}/${total}] ✅ Downloaded (${size} KB): ${filename}`);

    // Add delay to be respectful to the server
    await new Promise((resolve) => setTimeout(resolve, 500));

    return true;
  } catch (error) {
    console.error(
      `[${index + 1}/${total}] ❌ Error downloading ${filename}:`,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

async function main() {
  console.log(`\n📂 Output directory: ${OUTPUT_DIR}`);
  console.log(`📑 Total laws to download: ${LAWS_TO_DOWNLOAD.length}\n`);

  const uniqueLaws = Array.from(new Set(LAWS_TO_DOWNLOAD)); // Remove duplicates
  console.log(`📑 Unique laws to download: ${uniqueLaws.length}\n`);

  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < uniqueLaws.length; i++) {
    const success = await downloadLaw(uniqueLaws[i], i, uniqueLaws.length);
    if (success) {
      succeeded++;
    } else {
      failed++;
    }
  }

  console.log(`\n📊 Download Summary:`);
  console.log(`   ✅ Succeeded: ${succeeded}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log(`   📂 Output: ${OUTPUT_DIR}\n`);
}

main().catch(console.error);
