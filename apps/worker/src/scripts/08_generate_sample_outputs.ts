// ────────────────────────────────────────────────────────────
// Generate Sample Parsed Outputs (5 legalinfo + 5 shuukh)
// ────────────────────────────────────────────────────────────

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LegalinfoCrawler } from '../crawlers/legalinfo.crawler.js';
import { ShuukhCrawler } from '../crawlers/shuukh.crawler.js';
import type { ParsedDocument } from '@legal-chatbot/shared';

interface SampleOutput {
  source: 'legalinfo' | 'shuukh';
  file: string;
  externalId: string;
  title: string;
  date: string;
  domain: string;
  metadata: ParsedDocument['metadata'];
  structured: ParsedDocument['structured'];
  textPreview: string;
}

async function collectSamples(
  source: 'legalinfo' | 'shuukh',
  dirPath: string,
  targetCount: number,
): Promise<SampleOutput[]> {
  const crawler = source === 'legalinfo' ? new LegalinfoCrawler() : new ShuukhCrawler();

  const files = (await readdir(dirPath))
    .filter((file) => file.toLowerCase().endsWith('.html'))
    .sort((a, b) => a.localeCompare(b));

  const samples: SampleOutput[] = [];

  for (const file of files) {
    if (samples.length >= targetCount) {
      break;
    }

    const filePath = resolve(dirPath, file);
    const rawHtml = await readFile(filePath, 'utf-8');

    const externalIdFromFile = file.replace(/\.html$/i, '');
    const url =
      source === 'legalinfo'
        ? `https://legalinfo.mn/mn/detail?lawId=${externalIdFromFile}`
        : `https://shuukh.mn/single_case/${externalIdFromFile}`;

    const parsed = await crawler.parse({
      url,
      rawHtml,
      statusCode: 200,
      fetchedAt: new Date().toISOString(),
    });

    if (!parsed.cleanedText || parsed.cleanedText.length < 120) {
      continue;
    }

    samples.push({
      source,
      file,
      externalId: parsed.externalId,
      title: parsed.title,
      date: parsed.date,
      domain: parsed.domain,
      metadata: parsed.metadata,
      structured: parsed.structured,
      textPreview: parsed.cleanedText.slice(0, 600),
    });
  }

  return samples;
}

async function main(): Promise<void> {
  const repoRoot = resolve(process.cwd(), '..', '..');
  const rawLegalinfoDir = resolve(repoRoot, 'data/raw/legalinfo');
  const rawShuukhDir = resolve(repoRoot, 'data/raw/shuukh');

  const legalinfoSamples = await collectSamples('legalinfo', rawLegalinfoDir, 5);
  const shuukhSamples = await collectSamples('shuukh', rawShuukhDir, 5);

  const output = {
    generatedAt: new Date().toISOString(),
    legalinfoCount: legalinfoSamples.length,
    shuukhCount: shuukhSamples.length,
    legalinfoSamples,
    shuukhSamples,
  };

  const outputPath = resolve(repoRoot, 'data/processed/sample-parsed-outputs.json');
  await mkdir(resolve(outputPath, '..'), { recursive: true });
  await writeFile(outputPath, JSON.stringify(output, null, 2), 'utf-8');

  console.log(`Sample output written: ${outputPath}`);
  console.log(`legalinfo samples: ${legalinfoSamples.length}`);
  console.log(`shuukh samples: ${shuukhSamples.length}`);
}

main().catch((err) => {
  console.error('Failed to generate sample parsed outputs:', err);
  process.exit(1);
});
