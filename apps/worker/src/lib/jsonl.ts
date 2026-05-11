// ─────────────────────────────────────────────────────────
// Streaming JSONL reader with field validation
// ─────────────────────────────────────────────────────────

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/** Required fields every chunk must have. */
const REQUIRED_FIELDS = ['chunkId', 'docId', 'source', 'url', 'title', 'text'] as const;

/** Shape of a single raw chunk from chunks.jsonl. */
export interface RawChunk {
  chunkId: string;
  docId: string;
  source: 'shuukh' | 'legalinfo';
  url: string;
  title: string;
  text: string;
  // optional
  snippet?: string;
  keywords?: string[];
  section?: string;
  date?: string;
  court?: string;
  decisionType?: string;
  caseId?: string;
  caseNumber?: string;
  lawId?: string;
  articleNo?: string;
  [key: string]: unknown;
}

export interface ParsedLine {
  lineNo: number;
  chunk: RawChunk | null;
  error: string | null;
}

/**
 * Async generator that streams a JSONL file line-by-line.
 * Validates required fields on each record.
 * Never loads the full file into memory.
 */
export async function* readJsonl(filePath: string): AsyncGenerator<ParsedLine> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  let lineNo = 0;

  for await (const line of rl) {
    lineNo++;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue; // skip blank lines

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      yield { lineNo, chunk: null, error: `Invalid JSON at line ${lineNo}` };
      continue;
    }

    // Validate required fields
    const missing = REQUIRED_FIELDS.filter(
      (f) => !(f in parsed) || typeof parsed[f] !== 'string' || (parsed[f] as string).trim() === '',
    );

    if (missing.length > 0) {
      yield { lineNo, chunk: null, error: `Missing fields [${missing.join(', ')}] at line ${lineNo}` };
      continue;
    }

    yield { lineNo, chunk: parsed as unknown as RawChunk, error: null };
  }
}
