// ────────────────────────────────────────────────────────────
// Document Zod Schemas — Validation for Document/Chunk models
// ────────────────────────────────────────────────────────────

import { z } from 'zod';
import { sourceTypeSchema } from './source.schema';

/** Schema for legal domain classification */
export const legalDomainSchema = z.enum([
  'criminal',
  'civil',
  'administrative',
  'constitutional',
  'other',
]);

/** Schema for document metadata */
export const documentMetadataSchema = z.object({
  caseId: z.string().optional(),
  caseNumber: z.string().optional(),
  lawId: z.string().optional(),
  articleNo: z.string().optional(),
  articleNumbers: z.array(z.string()).optional(),
  articleCount: z.number().int().nonnegative().optional(),
  court: z.string().optional(),
  parties: z.array(z.string()).optional(),
  decisionSummary: z.string().optional(),
  decisionType: z.string().optional(),
  legislatureSession: z.string().optional(),
});

/** Schema for a Document record */
export const documentSchema = z.object({
  id: z.string().uuid(),
  source: sourceTypeSchema,
  externalId: z.string().min(1),
  url: z.string().url(),
  title: z.string().min(1),
  date: z.string(),
  domain: legalDomainSchema,
  metadata: documentMetadataSchema,
  rawContentHash: z.string().length(64),
  crawledAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  status: z.enum(['active', 'archived', 'error']),
});

/** Schema for chunk character offset */
export const charOffsetSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
});

/** Schema for chunk metadata */
export const chunkMetadataSchema = z.object({
  source: sourceTypeSchema,
  sourceId: z.string().optional(),
  documentTitle: z.string(),
  documentUrl: z.string().url(),
  documentDate: z.string(),
  caseId: z.string().optional(),
  lawId: z.string().optional(),
  articleNo: z.string().optional(),
  clauseNo: z.string().optional(),
  subclauseNo: z.string().optional(),
  articleTitle: z.string().optional(),
  section: z.string().optional(),
  headingPath: z.string().optional(),
  chunkType: z.enum(['article', 'clause', 'subclause', 'section', 'fallback']).optional(),
});

/** Schema for a Chunk record */
export const chunkSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  chunkIndex: z.number().int().nonnegative(),
  text: z.string().min(1),
  tokenCount: z.number().int().positive(),
  charOffset: charOffsetSchema,
  metadata: chunkMetadataSchema,
  contentHash: z.string().length(64),
  createdAt: z.string().datetime(),
});

export type DocumentInput = z.infer<typeof documentSchema>;
export type ChunkInput = z.infer<typeof chunkSchema>;
