// ────────────────────────────────────────────────────────────
// Source Zod Schemas — Runtime validation for Source objects
// ────────────────────────────────────────────────────────────

import { z } from 'zod';

/** Schema for the SourceType enum */
export const sourceTypeSchema = z.enum(['shuukh', 'legalinfo']);

/** Schema for a Source citation object */
export const sourceSchema = z.object({
  type: sourceTypeSchema,
  title: z.string().min(1),
  url: z.string().url(),
  snippet: z.string().optional(),
  caseId: z.string().optional(),
  lawId: z.string().optional(),
  articleNo: z.string().optional(),
  date: z.string().optional(),
});

export type SourceInput = z.infer<typeof sourceSchema>;
