// ────────────────────────────────────────────────────────────
// Document / Chunk / Embedding Types — Data models for indexing
// ────────────────────────────────────────────────────────────

import type { SourceType } from './source.types';

/** Legal domain classification */
export type LegalDomain = 'criminal' | 'civil' | 'administrative' | 'constitutional' | 'other';

/** Document status in the system */
export type DocumentStatus = 'active' | 'archived' | 'error';

/**
 * Represents a single crawled legal document.
 * One court decision from shuukh.mn or one legal act from legalinfo.mn.
 */
export interface Document {
  id: string;
  source: SourceType;
  externalId: string;
  url: string;
  title: string;
  date: string;
  domain: LegalDomain;
  metadata: DocumentMetadata;
  rawContentHash: string;
  crawledAt: string;
  updatedAt: string;
  status: DocumentStatus;
}

/** Source-specific metadata fields for a Document */
export interface DocumentMetadata {
  /** Court case number (shuukh only) */
  caseId?: string;
  /** Court decision number (shuukh only) */
  caseNumber?: string;
  /** Law registry ID (legalinfo only) */
  lawId?: string;
  /** Article number if applicable */
  articleNo?: string;
  /** Article numbers extracted from legal text */
  articleNumbers?: string[];
  /** Number of extracted articles */
  articleCount?: number;
  /** Court name (shuukh only) */
  court?: string;
  /** Involved parties (shuukh only) */
  parties?: string[];
  /** Short decision summary (shuukh only) */
  decisionSummary?: string;
  /** Decision/dispute type (shuukh only) */
  decisionType?: string;
  /** Legislature session info (legalinfo only) */
  legislatureSession?: string;
}

/**
 * A text chunk derived from a Document, ready for embedding.
 */
export interface Chunk {
  id: string;
  documentId: string;
  chunkIndex: number;
  text: string;
  tokenCount: number;
  charOffset: CharOffset;
  metadata: ChunkMetadata;
  contentHash: string;
  createdAt: string;
}

/** Character offset range within the original document text */
export interface CharOffset {
  start: number;
  end: number;
}

/** Metadata attached to each chunk for retrieval and citation building */
export interface ChunkMetadata {
  source: SourceType;
  sourceId?: string;
  law?: string;
  article?: string;
  category?: string;
  documentTitle: string;
  documentUrl: string;
  documentDate: string;
  caseId?: string;
  lawId?: string;
  articleNo?: string;
  clauseNo?: string;
  subclauseNo?: string;
  articleTitle?: string;
  section?: string;
  chapter?: string;
  subsection?: string;
  headingPath?: string;
  chunkType?: 'article' | 'clause' | 'subclause' | 'section' | 'fallback';
  amendments?: string[];
  references?: string[];
  sourceUrl?: string;
  charCount?: number;
  wordCount?: number;
  keywords?: string[];
}

/**
 * Chunk with a relevance score, returned by retrieval service.
 */
export interface ScoredChunk extends Chunk {
  score: number;
}

/**
 * A vector embedding for a Chunk.
 */
export interface Embedding {
  id: string;
  chunkId: string;
  vector: number[];
  model: string;
  dimensions: number;
  createdAt: string;
}

/** Result of a single chunk embedding operation */
export interface EmbeddedChunk {
  chunk: Chunk;
  embedding: Embedding;
}

/**
 * Parsed document output from the parser/cleaner stage.
 * This is the intermediate format before chunking.
 */
export interface ParsedDocument {
  externalId: string;
  source: SourceType;
  url: string;
  title: string;
  date: string;
  domain: LegalDomain;
  cleanedText: string;
  metadata: DocumentMetadata;
  structured?: Record<string, unknown>;
  rawHtml?: string;
}
