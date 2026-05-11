// ────────────────────────────────────────────────────────────
// legalinfo-only Ingestion Job — Convenience wrapper
// ────────────────────────────────────────────────────────────

import { runIngestionJob } from './ingest.js';

export async function ingestLegalinfo(limit: number = 100): Promise<void> {
  await runIngestionJob({ sources: ['legalinfo'], limit });
}
