// ────────────────────────────────────────────────────────────
// Chat Zod Schemas — Runtime validation for /v1/chat
// ────────────────────────────────────────────────────────────

import { z } from 'zod';

/** Schema for a single chat message in history */
export const chatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1, 'Message content cannot be empty'),
});

/** Schema for POST /v1/chat request body */
export const chatRequestSchema = z.object({
  conversationId: z
    .string()
    .min(1, 'conversationId must not be empty')
    .max(128, 'conversationId too long')
    .optional(),
  message: z
    .string()
    .min(1, 'message is required')
    .max(8000, 'message exceeds maximum length of 8000 characters'),
  history: z.array(chatMessageSchema).max(50, 'history cannot exceed 50 messages').default([]),
});

/** Schema for POST /v1/feedback request body */
export const feedbackRequestSchema = z.object({
  conversationId: z.string().min(1),
  messageIndex: z.number().int().nonnegative(),
  rating: z.enum(['helpful', 'not_helpful', 'incorrect']),
  comment: z.string().max(2000).optional(),
});

/** Inferred types from schemas (use these if you want schema-derived types) */
export type ChatRequestInput = z.infer<typeof chatRequestSchema>;
export type ChatMessageInput = z.infer<typeof chatMessageSchema>;
export type FeedbackRequestInput = z.infer<typeof feedbackRequestSchema>;
