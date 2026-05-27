// ────────────────────────────────────────────────────────────
// Chat Types — Request/Response contracts for /v1/chat
// ────────────────────────────────────────────────────────────

import type { Source } from './source.types';

export interface RelatedLaw {
  title: string;
  articleNo: string;
  url: string;
  score: number;
  displayScore?: number;
}

export interface RelatedCase {
  title: string;
  caseNumber: string;
  url: string;
  score: number;
  displayScore?: number;
  summary?: string;
  court?: string;
  decisionType?: string;
}

/** Role of a message in conversation history */
export type MessageRole = 'user' | 'assistant';

/** A single message in the conversation history */
export interface ChatMessage {
  role: MessageRole;
  content: string;
}

/** POST /v1/chat — Request body */
export interface ChatRequest {
  /** Client-generated conversation identifier */
  conversationId?: string;

  /** The user's current message / question */
  message: string;

  /** Previous messages for context (most recent last) */
  history: ChatMessage[];
}

/** POST /v1/chat — Successful response */
export interface ChatResponse {
  /** Server-issued conversation identifier (UUID) */
  conversationId: string;

  /** LLM-generated answer grounded in retrieved sources */
  answer: string;

  /** Citations — always non-empty for a successful answer */
  sources?: Source[];

  /** Related law matches retrieved for the answer */
  relatedLaws?: RelatedLaw[];

  /** Related court case matches retrieved for the answer */
  relatedCases?: RelatedCase[];

  /** Model confidence for the final answer */
  confidence?: number;

  /** Number of sources used while grounding the answer */
  sourcesUsed?: number;

  /** Suggested follow-up questions for the user */
  suggestedQuestions?: string[];

  /** Optional performance metrics */
  usage?: ChatUsage;

  /** Optional automated quality metrics for regression/evaluation */
  quality?: ChatQualityMetrics;
}

/** Performance usage info returned with chat response */
export interface ChatUsage {
  /** Total wall-clock latency in milliseconds */
  latencyMs: number;

  /** Time spent planning scope, intent, and history carry-forward */
  workflowMs?: number;

  /** Time spent retrieving and reranking legal sources */
  retrievalMs?: number;

  /** Breakdown of retrieval stage timings for debugging latency regressions */
  retrievalStages?: RetrievalStageTiming;

  /** Time spent generating or synthesizing the final answer */
  generationMs?: number;

  /** Time spent saving conversation history */
  persistenceMs?: number;

  /** Whether source retrieval exceeded the configured latency budget */
  retrievalTimedOut?: boolean;

  /** Whether LLM generation exceeded the configured latency budget */
  generationTimedOut?: boolean;

  /** Whether the answer was returned from the current conversation/session cache */
  cacheHit?: boolean;

  /** Cache source, when cacheHit is true */
  cacheKind?: 'session_retrieval_exact_question' | 'global_retrieval_exact_question';
}

export interface RetrievalStageTiming {
  embeddingMs: number;
  vectorSearchMs: number;
  keywordSearchMs: number;
  fallbackAndFilterMs: number;
  caseSearchMs: number;
  rerankMs: number;
  buildMs: number;
}

/** Automated answer quality metrics in the 0..1 range */
export interface ChatQualityMetrics {
  /** How well retrieved laws/sources match the detected intent */
  retrievalAccuracy: number;

  /** Whether citations/related laws are valid and source-backed */
  citationCorrectness: number;

  /** Whether the final answer stays grounded and avoids internal/system wording */
  answerFaithfulness: number;

  /** Latency score against the configured response budget */
  responseLatency: number;

  /** Weighted overall quality score */
  overall: number;

  /** Machine-readable quality warnings */
  issues: string[];
}

export type ChatStreamStage = 'retrieval' | 'generation' | 'persisting';

export interface ChatStreamConversationEvent {
  type: 'conversation';
  conversationId: string;
}

export interface ChatStreamStatusEvent {
  type: 'status';
  stage: ChatStreamStage;
  message: string;
}

/**
 * Emitted once the retrieval phase finishes (before the LLM finishes generating
 * the final answer). Lets the UI render Related Laws / Cases / Sources cards
 * immediately while the answer text streams in afterwards, reducing perceived
 * latency. Hosts that have not been updated to handle this event can safely
 * ignore it — the final `complete` event still carries the authoritative
 * snapshot.
 */
export interface ChatStreamRetrievalEvent {
  type: 'retrieval';
  sources: Source[];
  relatedLaws: RelatedLaw[];
  relatedCases: RelatedCase[];
  sourcesUsed: number;
  retrievalMs?: number;
  retrievalStages?: RetrievalStageTiming;
}

export interface ChatStreamDeltaEvent {
  type: 'delta';
  delta: string;
}

export interface ChatStreamCompleteEvent {
  type: 'complete';
  response: ChatResponse;
}

export interface ChatStreamErrorEvent {
  type: 'error';
  error: ApiError;
}

export type ChatStreamEvent =
  | ChatStreamConversationEvent
  | ChatStreamStatusEvent
  | ChatStreamRetrievalEvent
  | ChatStreamDeltaEvent
  | ChatStreamCompleteEvent
  | ChatStreamErrorEvent;

/** Rating options for user feedback */
export type FeedbackRating = 'helpful' | 'not_helpful' | 'incorrect';

/** POST /v1/feedback — Request body */
export interface FeedbackRequest {
  conversationId: string;
  messageIndex: number;
  rating: FeedbackRating;
  comment?: string;
}

/** POST /v1/feedback — Response */
export interface FeedbackResponse {
  success: boolean;
}

/** Standard API error response */
export interface ApiError {
  error: string;
  message: string;
  retryAfterMs?: number;
}
