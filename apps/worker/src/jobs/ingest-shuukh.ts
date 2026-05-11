// ────────────────────────────────────────────────────────────
// shuukh-only Ingestion Job — Convenience wrapper
// ────────────────────────────────────────────────────────────

import { runIngestionJob } from './ingest.js';

export async function ingestShuukh(limit: number = 100): Promise<void> {
  await runIngestionJob({ sources: ['shuukh'], limit });
}
