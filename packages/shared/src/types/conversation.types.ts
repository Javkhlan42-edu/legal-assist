// ────────────────────────────────────────────────────────────
// Conversation Types — Models for conversation persistence
// ────────────────────────────────────────────────────────────

import type { Source } from './source.types';
import type { MessageRole, ChatUsage, RelatedCase, RelatedLaw } from './chat.types';

/** A stored conversation */
export interface Conversation {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

/** A stored message within a conversation */
export interface StoredMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  sources?: Source[];
  relatedCases?: RelatedCase[];
  relatedLaws?: RelatedLaw[];
  confidence?: number;
  sourcesUsed?: number;
  suggestedQuestions?: string[];
  usage?: ChatUsage;
  latencyMs?: number;
  createdAt: string;
}

/** GET /v1/conversations — Response */
export interface ConversationsResponse {
  conversations: Conversation[];
  total?: number;
  limit?: number;
  offset?: number;
}

export interface ConversationDetailResponse {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  messages: StoredMessage[];
}

/** Audit log entry for monitoring and compliance */
export interface AuditLogEntry {
  id: string;
  conversationId?: string;
  query: string;
  responseLength: number;
  sourcesCount: number;
  latencyMs: number;
  ipAddress: string;
  createdAt: string;
}

/** Crawl job record */
export interface CrawlJob {
  id: string;
  source: string;
  status: 'running' | 'completed' | 'failed';
  documentsFound: number;
  documentsNew: number;
  documentsUpdated: number;
  chunksCreated: number;
  startedAt: string;
  finishedAt?: string;
  errorMessage?: string;
}
