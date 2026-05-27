import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  chatRequestSchema,
  type ApiError,
  type ChatMessage,
  type ChatQualityMetrics,
  type ChatRequest,
  type ChatResponse,
  type ChatStreamEvent,
} from '@legal-chatbot/shared';
import type { Source } from '@legal-chatbot/shared';
import { chatRateLimitConfig } from '../../plugins/rate-limiter.js';
import {
  addMessage,
  createConversation,
  getConversationById,
  getConversationForUser,
  type MessageRecord,
} from '../../repositories/conversation.repository.js';
import {
  getRetrievalCacheEntry,
  isRetrievalCacheEligibleQuestion,
  normalizeRetrievalCacheQuestion,
  upsertRetrievalCacheEntry,
  type RetrievalCacheEntry,
} from '../../repositories/retrieval-cache.repository.js';
import {
  generate,
  cleanupAnswerStructure,
  type GenerationResult,
} from '../../services/generation.service.js';
import {
  classifyLegalIntent,
  rewriteQuery,
  type QueryIntent,
} from '../../services/query-rewrite.service.js';
import type { AppEnv } from '../../config/env.js';
import { search, type RetrievalQuality, type RetrievalResult, type RetrievalStageTiming } from '../../services/retrieval.service.js';
import { planChatWorkflow, type WorkflowEarlyResponse, type WorkflowPlan } from '../../services/chat-workflow.service.js';
import {
  classifyFollowUp,
  type FollowUpHint,
} from '../../services/follow-up-classifier.service.js';
import { evaluateAnswerQuality } from '../../services/answer-quality.service.js';
import type { ChromaQueryResult } from '../../lib/vector-db.js';

interface RelatedLawDto {
  title: string;
  articleNo: string;
  url: string;
  score: number;
  displayScore?: number;
}

interface RelatedCaseDto {
  title: string;
  caseNumber: string;
  url: string;
  score: number;
  displayScore?: number;
  summary?: string;
  court?: string;
  decisionType?: string;
}

interface ChatResponseDto extends ChatResponse {
  conversationId: string;
  answer: string;
  sources: Source[];
  relatedLaws: RelatedLawDto[];
  relatedCases: RelatedCaseDto[];
  confidence: number;
  sourcesUsed: number;
  suggestedQuestions: string[];
  usage: {
    latencyMs: number;
    workflowMs?: number;
    retrievalMs?: number;
    retrievalStages?: RetrievalStageTiming;
    generationMs?: number;
    persistenceMs?: number;
    retrievalTimedOut?: boolean;
    generationTimedOut?: boolean;
    cacheHit?: boolean;
    cacheKind?: 'session_retrieval_exact_question' | 'global_retrieval_exact_question';
  };
  quality: ChatQualityMetrics;
}

interface AssistantMetadataBuildParams {
  latencyMs: number;
  answer: string;
  confidence: number;
  sources: Source[];
  relatedLaws: RelatedLawDto[];
  relatedCases: RelatedCaseDto[];
  suggestedQuestions: string[];
  workflowNodes: string[];
  scope: string;
  intent: QueryIntent;
  carryForwardMode: string;
  retrievalQuery?: string;
  preferredLawIds?: string[];
  contextChunks?: ChromaQueryResult[];
  retrievalQuality?: unknown;
  retrievalTiming?: RetrievalStageTiming;
  quality?: ChatQualityMetrics;
  keywordTerms?: string[];
  primaryDomain?: string;
  followUpHint?: FollowUpHint | null;
}

/**
 * Run the LLM-driven follow-up classifier, swallowing any failures so the
 * pipeline stays resilient. Returns null when the classifier is disabled, the
 * conversation has no history, or the call fails.
 */
async function maybeClassifyFollowUp(
  env: Parameters<typeof classifyFollowUp>[0]['env'],
  message: string,
  history: ChatMessage[],
): Promise<FollowUpHint | null> {
  if (history.length === 0) {
    return null;
  }

  try {
    return await classifyFollowUp({ env, message, history });
  } catch {
    return null;
  }
}

const MIN_CASE_UI_SCORE = 0.52;
const MIN_CASE_AUTO_UI_SCORE = 0.68;
const MIN_CASE_FALLBACK_SCORE = 0.58;
const RETRIEVAL_QUALITY_WARN_THRESHOLD = 0.45;

interface RetrievalPlan {
  query: string;
  rewrittenQuery: string;
  preferredLawIds: string[];
  isFollowUp: boolean;
  usesHistoryContext: boolean;
  relevantHistory: ChatMessage[];
}

export function registerChatRoute(app: FastifyInstance) {
  const handler = async (request: FastifyRequest<{ Body: ChatRequest }>, reply: FastifyReply) => {
    const startTime = Date.now();
    const authUser = request.authUser;

    if (!authUser) {
      return reply.status(401).send({
        error: 'UNAUTHORIZED',
        message: 'Authentication required.',
      } satisfies ApiError);
    }

    const parseResult = chatRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      const error: ApiError = {
        error: 'VALIDATION_ERROR',
        message: parseResult.error.errors.map((issue) => issue.message).join('; '),
      };
      return reply.status(400).send(error);
    }

    const { message } = parseResult.data;
    const requestedConversationIdRaw = parseResult.data.conversationId?.trim();
    const requestedConversationId =
      requestedConversationIdRaw && isUuid(requestedConversationIdRaw)
        ? requestedConversationIdRaw
        : undefined;
    const conversationId = requestedConversationId ?? randomUUID();

    if (requestedConversationIdRaw && !requestedConversationId) {
      request.log.warn(
        { requestedConversationId: requestedConversationIdRaw },
        'Ignoring non-UUID conversationId from client',
      );
    }

    let history: ChatMessage[] = requestedConversationId ? parseResult.data.history : [];
    let restoredMessageRecords: MessageRecord[] = [];

    try {
      const existingConversation = requestedConversationId
        ? await getConversationById(conversationId)
        : null;

      if (existingConversation && existingConversation.userId !== authUser.id) {
        return reply.status(403).send({
          error: 'FORBIDDEN',
          message: 'Conversation does not belong to the current user.',
        } satisfies ApiError);
      }

      if (requestedConversationId && existingConversation) {
        const restoredConversation = await getConversationForUser(conversationId, authUser.id);
        restoredMessageRecords = restoredConversation.messages;
        if (history.length === 0) {
          history = toChatHistory(restoredMessageRecords);
        }
      }

      const workflowStart = Date.now();
      const followUpHint = await maybeClassifyFollowUp(app.env, message, history);
      const workflowPlan = planChatWorkflow({
        message,
        history,
        messageRecords: restoredMessageRecords,
        followUpHint: followUpHint ?? undefined,
      });
      const workflowLatencyMs = Date.now() - workflowStart;

      request.log.info(
        {
          userId: authUser.id,
          conversationId,
          messageLength: message.length,
          retrievalQueryLength: workflowPlan.query.length,
          rewrittenQueryLength: workflowPlan.rewrittenQuery.length,
          preferredLawIds: workflowPlan.preferredLawIds,
          usesHistoryContext: workflowPlan.usesHistoryContext,
          relevantHistoryMessages: workflowPlan.relevantHistory.length,
          scope: workflowPlan.scope.scope,
          intent: workflowPlan.intent,
          carryForwardMode: workflowPlan.carryForwardMode,
          workflowNodes: workflowPlan.nodes,
          restoredHistory: history.length,
          followUpHint: followUpHint ?? null,
          workflowLatencyMs,
        },
        'Chat request received',
      );

      if (workflowPlan.earlyResponse) {
        const latencyMs = Date.now() - startTime;
        const earlyResponse = buildEarlyResponseResponse(
          conversationId,
          workflowPlan.earlyResponse,
          latencyMs,
        );

        try {
          await ensureConversationExists(conversationId, authUser.id, message);
          await addMessage(conversationId, 'user', message);
          await addMessage(
            conversationId,
            'assistant',
            earlyResponse.answer,
            buildAssistantMessageMetadata({
              latencyMs,
              answer: earlyResponse.answer,
              confidence: earlyResponse.confidence,
              sources: [],
              relatedLaws: [],
              relatedCases: [],
              suggestedQuestions: earlyResponse.suggestedQuestions,
              workflowNodes: workflowPlan.nodes,
              scope: workflowPlan.scope.scope,
              intent: workflowPlan.intent,
              carryForwardMode: workflowPlan.carryForwardMode,
              followUpHint,
            }),
          );
        } catch (persistenceErr) {
          request.log.warn(
            { err: persistenceErr, userId: authUser.id, conversationId },
            'Unable to persist early workflow response',
          );
        }

        return reply.status(200).send(earlyResponse);
      }

      let retrievalResult:
        | Awaited<ReturnType<typeof search>>
        | null = null;
      let retrievalLatencyMs = 0;
      let retrievalTimedOut = false;
      let retrievalQuality: Awaited<ReturnType<typeof search>>['retrievalQuality'] | undefined;
      let retrievalCacheKind: ChatResponseDto['usage']['cacheKind'] | undefined;

      const sessionCachedRetrieval = buildSessionRetrievalCacheResult(
        message,
        restoredMessageRecords,
      );
      if (sessionCachedRetrieval) {
        retrievalResult = sessionCachedRetrieval;
        retrievalQuality = retrievalResult.retrievalQuality;
        retrievalCacheKind = 'session_retrieval_exact_question';
        request.log.info(
          {
            userId: authUser.id,
            conversationId,
            sources: retrievalResult.sources.length,
            laws: retrievalResult.relatedLaws.length,
            cases: retrievalResult.relatedCases.length,
          },
          'Session retrieval cache hit',
        );
      } else {
        const globalCachedRetrieval = await maybeGetGlobalRetrievalCache({
          env: app.env,
          message,
          workflowPlan,
          requestLog: request.log,
        });
        if (globalCachedRetrieval) {
          retrievalResult = globalCachedRetrieval;
          retrievalQuality = retrievalResult.retrievalQuality;
          retrievalCacheKind = 'global_retrieval_exact_question';
        }
      }

      if (!retrievalResult && !workflowPlan.shouldSkipRetrieval) {
        const retrievalStart = Date.now();
        const retrievalPromise = search(app.env, workflowPlan.query, {
          intentOverride: workflowPlan.intent,
          preferredLawIds: workflowPlan.preferredLawIds,
          enrichmentTerms: [
            workflowPlan.rewrittenQuery,
            ...workflowPlan.keywordProfile.expansionTerms,
            ...workflowPlan.previousKeywords,
          ],
          carryForwardChunks: workflowPlan.carryForwardChunks,
          carryForwardMode: workflowPlan.carryForwardMode,
          keywordProfile: workflowPlan.keywordProfile,
        });
        const retrievalOutcome =
          app.env.RETRIEVAL_SPEED_MODE === 'quality'
            ? { value: await retrievalPromise, timedOut: false as const }
            : await resolveWithTimeout(retrievalPromise, app.env.RETRIEVAL_TIMEOUT_MS);
        retrievalLatencyMs = Date.now() - retrievalStart;
        retrievalTimedOut = retrievalOutcome.timedOut;

        if (retrievalOutcome.timedOut) {
          request.log.warn(
            {
              userId: authUser.id,
              conversationId,
              retrievalLatencyMs,
              timeoutMs: app.env.RETRIEVAL_TIMEOUT_MS,
              retrievalQuery: workflowPlan.query.slice(0, 320),
            },
            'Retrieval timed out; continuing with fallback generation',
          );
        } else {
          retrievalResult = retrievalOutcome.value ?? null;
          retrievalQuality = retrievalResult?.retrievalQuality;
        }
      }

      request.log.info(
        {
          userId: authUser.id,
          conversationId,
          retrievalLatencyMs,
          sourcesUsed: retrievalResult?.sourcesUsed ?? 0,
          laws: retrievalResult?.relatedLaws.length ?? 0,
          cases: retrievalResult?.relatedCases.length ?? 0,
          topScore: retrievalResult?.contextChunks[0]?.score ?? 0,
          retrievalQualityOverall: retrievalQuality?.overall ?? null,
          retrievalQualityBand: retrievalQuality?.qualityBand ?? 'unknown',
          retrievalIntentPrecision: retrievalQuality?.intentPrecision ?? null,
          retrievalCanonicalCoverage: retrievalQuality?.canonicalCoverage ?? null,
          retrievalTiming: retrievalResult?.retrievalTiming ?? null,
          retrievalTimedOut,
        },
        'Retrieval complete',
      );

      if (retrievalQuality && retrievalQuality.overall < RETRIEVAL_QUALITY_WARN_THRESHOLD) {
        request.log.warn(
          {
            userId: authUser.id,
            conversationId,
            retrievalLatencyMs,
            quality: retrievalQuality,
            retrievalQuery: workflowPlan.query.slice(0, 320),
            preferredLawIds: workflowPlan.preferredLawIds,
          },
          'Low retrieval quality detected',
        );
      }

      const requestIntent = workflowPlan.intent !== 'unknown' ? workflowPlan.intent : classifyLegalIntent(message);
      const availableRelatedLawCount =
        retrievalResult?.relatedLaws.length ?? workflowPlan.carryForwardRelatedLaws.length;
      const filteredRelatedCases = retrievalResult
        ? filterRelatedCasesForResponse(retrievalResult.relatedCases, {
            hasRelatedLaws: retrievalResult.relatedLaws.length > 0,
            intent: requestIntent,
            explicitCaseAsk: isExplicitCaseQuestion(message),
          })
        : filterRelatedCasesForResponse(workflowPlan.carryForwardRelatedCases, {
            hasRelatedLaws: workflowPlan.carryForwardRelatedLaws.length > 0,
            intent: requestIntent,
            explicitCaseAsk: isExplicitCaseQuestion(message),
          });

      if (!retrievalCacheKind && retrievalResult) {
        await maybeStoreGlobalRetrievalCache({
          env: app.env,
          message,
          workflowPlan,
          retrievalResult: {
            ...retrievalResult,
            relatedCases: filteredRelatedCases,
          },
          requestLog: request.log,
        });
      }

      const generationStart = Date.now();
      const generationContextChunks =
        retrievalResult?.contextChunks ?? workflowPlan.carryForwardChunks;
      const generationQuery = buildContextualGenerationQuery(message, workflowPlan.relevantHistory);
      const generationOptions = {
        alreadyReranked: true,
        detailSubIntent: workflowPlan.detailSubIntent,
        answerStyle:
          workflowPlan.shouldSkipRetrieval && workflowPlan.carryForwardMode === 'reuse_same_law'
            ? 'follow_up_freeform'
            : 'qa_contract',
      } as const;
      let generationTimedOut = false;
      const generationOutcome = await resolveWithTimeout(
        generate(
          app.env,
          generationQuery,
          generationContextChunks,
          workflowPlan.relevantHistory,
          filteredRelatedCases,
          generationOptions,
        ),
        app.env.GENERATION_TIMEOUT_MS,
      );
      let generationResult: GenerationResult;
      if (generationOutcome.timedOut) {
        generationTimedOut = true;
        request.log.warn(
          {
            userId: authUser.id,
            conversationId,
            timeoutMs: app.env.GENERATION_TIMEOUT_MS,
            retrievalTimedOut,
            contextChunks: generationContextChunks.length,
          },
          'Generation timed out; using deterministic grounded fallback',
        );
        const fallbackGeneration = await generate(
          { ...app.env, OPENAI_API_KEY: '' },
          generationQuery,
          generationContextChunks,
          workflowPlan.relevantHistory,
          filteredRelatedCases,
          generationOptions,
        );
        generationResult = {
          ...fallbackGeneration,
          answer: cleanupAnswerStructure(fallbackGeneration.answer),
        };
      } else {
        generationResult = generationOutcome.value;
      }
      let generationLatencyMs = Date.now() - generationStart;

      if (
        generationResult.mode === 'no-info' &&
        shouldUseCaseFallback(filteredRelatedCases, {
          hasRelatedLaws: availableRelatedLawCount > 0,
          intent: requestIntent,
        })
      ) {
        generationResult = {
          ...generationResult,
          answer: buildCaseRecommendationAnswer(filteredRelatedCases),
          confidence: Math.max(generationResult.confidence, 0.32),
          mode: 'fallback-general',
          suggestedQuestions:
            generationResult.suggestedQuestions.length > 0
              ? generationResult.suggestedQuestions
              : [
                  'Эдгээр кейсүүдээс миний нөхцөлд хамгийн ойр аль нь вэ?',
                  'Эхний 3 кейсийн ялгаа юунд байна вэ?',
                  'Эдгээр кейстэй холбоотой хуулийн заалтыг тайлбарлаач',
                ],
        };
        generationLatencyMs = Date.now() - generationStart;
      }

      const latencyMs = Date.now() - startTime;

      request.log.info(
        {
          userId: authUser.id,
          conversationId,
          latencyMs,
          workflowLatencyMs,
          retrievalLatencyMs,
          generationLatencyMs,
          retrievalTimedOut,
          generationTimedOut,
          confidence: generationResult.confidence,
          promptTokens: generationResult.promptTokens,
          completionTokens: generationResult.completionTokens,
        },
        'Generation complete',
      );

      const isContextMode = generationResult.mode === 'context';
      const includeRelatedLaws = isContextMode;
      const includeRelatedCases = filteredRelatedCases.length > 0;
      const responseSources = isContextMode
        ? retrievalResult?.sources ?? workflowPlan.carryForwardSources
        : [];
      const responseRelatedLaws = includeRelatedLaws
        ? retrievalResult?.relatedLaws ?? workflowPlan.carryForwardRelatedLaws
        : [];
      const responseRelatedCases = includeRelatedCases ? filteredRelatedCases : [];
      const responseSourcesUsed = isContextMode
        ? retrievalResult?.sourcesUsed ?? responseSources.length
        : 0;
      const responseSuggestedQuestions = generationResult.suggestedQuestions ?? [];
      const quality = evaluateAnswerQuality({
        query: message,
        answer: generationResult.answer,
        sources: responseSources,
        relatedLaws: responseRelatedLaws,
        retrievalQuality,
        latencyMs,
        latencyBudgetMs: app.env.RESPONSE_LATENCY_BUDGET_MS,
        retrievalTimedOut,
        generationTimedOut,
        generationMode: generationResult.mode,
      });

      let persistenceLatencyMs = 0;
      const persistenceStart = Date.now();
      try {
        await ensureConversationExists(conversationId, authUser.id, message);
        await addMessage(conversationId, 'user', message);
        await addMessage(
          conversationId,
          'assistant',
          generationResult.answer,
          buildAssistantMessageMetadata({
            latencyMs,
            answer: generationResult.answer,
            confidence: generationResult.confidence,
            sources: responseSources,
            relatedLaws: responseRelatedLaws,
            relatedCases: responseRelatedCases,
            suggestedQuestions: responseSuggestedQuestions,
            workflowNodes: workflowPlan.nodes,
            scope: workflowPlan.scope.scope,
            intent: workflowPlan.intent,
            carryForwardMode: workflowPlan.carryForwardMode,
            retrievalQuery: workflowPlan.query,
            preferredLawIds: workflowPlan.preferredLawIds,
            contextChunks: retrievalResult?.contextChunks ?? workflowPlan.carryForwardChunks,
            retrievalQuality,
            retrievalTiming: retrievalResult?.retrievalTiming,
            quality,
            keywordTerms: workflowPlan.keywordProfile.topicalTerms,
            primaryDomain:
              workflowPlan.keywordProfile.primaryDomain !== 'unknown'
                ? workflowPlan.keywordProfile.primaryDomain
                : workflowPlan.intent,
            followUpHint,
          }),
        );
      } catch (persistenceErr) {
        request.log.warn(
          {
            err: persistenceErr,
            userId: authUser.id,
            conversationId,
          },
          'Conversation persistence unavailable; returning response without saving history',
        );
      } finally {
        persistenceLatencyMs = Date.now() - persistenceStart;
      }

      const response: ChatResponseDto = {
        conversationId,
        answer: generationResult.answer,
        sources: responseSources,
        relatedLaws: responseRelatedLaws,
        relatedCases: responseRelatedCases,
        confidence: generationResult.confidence,
        sourcesUsed: responseSourcesUsed,
        suggestedQuestions: responseSuggestedQuestions,
        usage: {
          latencyMs,
          workflowMs: workflowLatencyMs,
          retrievalMs: retrievalLatencyMs,
          retrievalStages: retrievalResult?.retrievalTiming,
          generationMs: generationLatencyMs,
          persistenceMs: persistenceLatencyMs,
          retrievalTimedOut,
          generationTimedOut,
          cacheHit: Boolean(retrievalCacheKind),
          cacheKind: retrievalCacheKind,
        },
        quality,
      };

      return reply.status(200).send(response);
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      request.log.error({ err, latencyMs, conversationId, userId: authUser.id }, 'Chat pipeline failed');

      const messageText = err instanceof Error ? err.message : 'Unknown error in chat pipeline';
      const errName = err instanceof Error ? err.constructor.name : '';

      const isVectorError =
        errName === 'ChromaConnectionError' ||
        messageText.includes('Vector') ||
        messageText.includes('pgvector') ||
        messageText.includes('ECONNREFUSED') ||
        messageText.includes('getCollection');

      const isOpenAIError =
        errName === 'RateLimitError' ||
        errName === 'AuthenticationError' ||
        errName === 'APIError' ||
        messageText.includes('OpenAI') ||
        messageText.includes('insufficient_quota') ||
        messageText.includes('exceeded your current quota');

      if (isVectorError) {
        return reply.status(503).send({
          error: 'VECTOR_DB_UNAVAILABLE',
          message: 'Vector database is temporarily unavailable. Please try again later.',
        } satisfies ApiError);
      }

      if (isOpenAIError) {
        return reply.status(502).send({
          error: 'LLM_ERROR',
          message: 'Language model service encountered an error. Please try again later.',
        } satisfies ApiError);
      }

      if (messageText.includes('CONVERSATION_OWNERSHIP_MISMATCH')) {
        return reply.status(403).send({
          error: 'FORBIDDEN',
          message: 'Conversation does not belong to the current user.',
        } satisfies ApiError);
      }

      return reply.status(500).send({
        error: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred processing your request.',
      } satisfies ApiError);
    }
  };

  const streamHandler = async (
    request: FastifyRequest<{ Body: ChatRequest }>,
    reply: FastifyReply,
  ) => {
    const startTime = Date.now();
    const authUser = request.authUser;

    if (!authUser) {
      return reply.status(401).send({
        error: 'UNAUTHORIZED',
        message: 'Authentication required.',
      } satisfies ApiError);
    }

    const parseResult = chatRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      const error: ApiError = {
        error: 'VALIDATION_ERROR',
        message: parseResult.error.errors.map((issue) => issue.message).join('; '),
      };
      return reply.status(400).send(error);
    }

    const { message } = parseResult.data;
    const requestedConversationIdRaw = parseResult.data.conversationId?.trim();
    const requestedConversationId =
      requestedConversationIdRaw && isUuid(requestedConversationIdRaw)
        ? requestedConversationIdRaw
        : undefined;
    const conversationId = requestedConversationId ?? randomUUID();

    if (requestedConversationIdRaw && !requestedConversationId) {
      request.log.warn(
        { requestedConversationId: requestedConversationIdRaw },
        'Ignoring non-UUID conversationId from client',
      );
    }

    let history: ChatMessage[] = requestedConversationId ? parseResult.data.history : [];
    let restoredMessageRecords: MessageRecord[] = [];

    reply.hijack();
    setupSseReply(reply, request.headers.origin);

    let streamClosed = false;
    request.raw.on('close', () => {
      streamClosed = true;
    });

    const sendEvent = async (event: ChatStreamEvent): Promise<void> => {
      if (streamClosed || reply.raw.destroyed || reply.raw.writableEnded) {
        throw new Error('STREAM_CLIENT_DISCONNECTED');
      }

      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      await sendEvent({
        type: 'conversation',
        conversationId,
      });

      if (requestedConversationId) {
        const [existingConversation, restoredConversation] = await Promise.all([
          getConversationById(conversationId),
          getConversationForUser(conversationId, authUser.id),
        ]);

        if (existingConversation && existingConversation.userId !== authUser.id) {
          throw new Error('CONVERSATION_OWNERSHIP_MISMATCH');
        }

        if (existingConversation) {
          restoredMessageRecords = restoredConversation.messages;
          if (history.length === 0) {
            history = toChatHistory(restoredMessageRecords);
          }
        }
      }

      const workflowStart = Date.now();
      const followUpHint = await maybeClassifyFollowUp(app.env, message, history);
      const workflowPlan = planChatWorkflow({
        message,
        history,
        messageRecords: restoredMessageRecords,
        followUpHint: followUpHint ?? undefined,
      });
      const workflowLatencyMs = Date.now() - workflowStart;

      request.log.info(
        {
          userId: authUser.id,
          conversationId,
          messageLength: message.length,
          retrievalQueryLength: workflowPlan.query.length,
          rewrittenQueryLength: workflowPlan.rewrittenQuery.length,
          preferredLawIds: workflowPlan.preferredLawIds,
          usesHistoryContext: workflowPlan.usesHistoryContext,
          relevantHistoryMessages: workflowPlan.relevantHistory.length,
          scope: workflowPlan.scope.scope,
          intent: workflowPlan.intent,
          carryForwardMode: workflowPlan.carryForwardMode,
          workflowNodes: workflowPlan.nodes,
          restoredHistory: history.length,
          followUpHint: followUpHint ?? null,
          streaming: true,
          workflowLatencyMs,
        },
        'Chat stream request received',
      );

      if (workflowPlan.earlyResponse) {
        await streamStableAnswer(workflowPlan.earlyResponse.answer, async (delta) => {
          await sendEvent({
            type: 'delta',
            delta,
          });
        });

        const latencyMs = Date.now() - startTime;
        const earlyResponse = buildEarlyResponseResponse(
          conversationId,
          workflowPlan.earlyResponse,
          latencyMs,
        );

        try {
          await ensureConversationExists(conversationId, authUser.id, message);
          await addMessage(conversationId, 'user', message);
          await addMessage(
            conversationId,
            'assistant',
            earlyResponse.answer,
            buildAssistantMessageMetadata({
              latencyMs,
              answer: earlyResponse.answer,
              confidence: earlyResponse.confidence,
              sources: [],
              relatedLaws: [],
              relatedCases: [],
              suggestedQuestions: earlyResponse.suggestedQuestions,
              workflowNodes: workflowPlan.nodes,
              scope: workflowPlan.scope.scope,
              intent: workflowPlan.intent,
              carryForwardMode: workflowPlan.carryForwardMode,
              followUpHint,
            }),
          );
        } catch (persistenceErr) {
          request.log.warn(
            { err: persistenceErr, userId: authUser.id, conversationId, streaming: true },
            'Unable to persist early streamed workflow response',
          );
        }

        await sendEvent({
          type: 'complete',
          response: earlyResponse,
        });
        return reply;
      }

      await sendEvent({
        type: 'status',
        stage: 'retrieval',
        message: 'Retrieving grounded legal sources',
      });

      let retrievalResult:
        | Awaited<ReturnType<typeof search>>
        | null = null;
      let retrievalLatencyMs = 0;
      let retrievalTimedOut = false;
      let retrievalQuality: Awaited<ReturnType<typeof search>>['retrievalQuality'] | undefined;
      let retrievalCacheKind: ChatResponseDto['usage']['cacheKind'] | undefined;

      const sessionCachedRetrieval = buildSessionRetrievalCacheResult(
        message,
        restoredMessageRecords,
      );
      if (sessionCachedRetrieval) {
        retrievalResult = sessionCachedRetrieval;
        retrievalQuality = retrievalResult.retrievalQuality;
        retrievalCacheKind = 'session_retrieval_exact_question';
        request.log.info(
          {
            userId: authUser.id,
            conversationId,
            sources: retrievalResult.sources.length,
            laws: retrievalResult.relatedLaws.length,
            cases: retrievalResult.relatedCases.length,
            streaming: true,
          },
          'Session retrieval cache hit',
        );
      } else {
        const globalCachedRetrieval = await maybeGetGlobalRetrievalCache({
          env: app.env,
          message,
          workflowPlan,
          requestLog: request.log,
        });
        if (globalCachedRetrieval) {
          retrievalResult = globalCachedRetrieval;
          retrievalQuality = retrievalResult.retrievalQuality;
          retrievalCacheKind = 'global_retrieval_exact_question';
        }
      }

      if (!retrievalResult && !workflowPlan.shouldSkipRetrieval) {
        const retrievalStart = Date.now();
        const retrievalPromise = search(app.env, workflowPlan.query, {
          intentOverride: workflowPlan.intent,
          preferredLawIds: workflowPlan.preferredLawIds,
          enrichmentTerms: [
            workflowPlan.rewrittenQuery,
            ...workflowPlan.keywordProfile.expansionTerms,
            ...workflowPlan.previousKeywords,
          ],
          carryForwardChunks: workflowPlan.carryForwardChunks,
          carryForwardMode: workflowPlan.carryForwardMode,
          keywordProfile: workflowPlan.keywordProfile,
        });
        const retrievalOutcome =
          app.env.RETRIEVAL_SPEED_MODE === 'quality'
            ? { value: await retrievalPromise, timedOut: false as const }
            : await resolveWithTimeout(retrievalPromise, app.env.RETRIEVAL_TIMEOUT_MS);
        retrievalLatencyMs = Date.now() - retrievalStart;
        retrievalTimedOut = retrievalOutcome.timedOut;

        if (retrievalOutcome.timedOut) {
          request.log.warn(
            {
              userId: authUser.id,
              conversationId,
              retrievalLatencyMs,
              timeoutMs: app.env.RETRIEVAL_TIMEOUT_MS,
              retrievalQuery: workflowPlan.query.slice(0, 320),
              streaming: true,
            },
            'Retrieval timed out; continuing streamed response with fallback generation',
          );
        } else {
          retrievalResult = retrievalOutcome.value ?? null;
          retrievalQuality = retrievalResult?.retrievalQuality;
        }
      }

      request.log.info(
        {
          userId: authUser.id,
          conversationId,
          retrievalLatencyMs,
          sourcesUsed: retrievalResult?.sourcesUsed ?? 0,
          laws: retrievalResult?.relatedLaws.length ?? 0,
          cases: retrievalResult?.relatedCases.length ?? 0,
          topScore: retrievalResult?.contextChunks[0]?.score ?? 0,
          retrievalQualityOverall: retrievalQuality?.overall ?? null,
          retrievalQualityBand: retrievalQuality?.qualityBand ?? 'unknown',
          retrievalIntentPrecision: retrievalQuality?.intentPrecision ?? null,
          retrievalCanonicalCoverage: retrievalQuality?.canonicalCoverage ?? null,
          retrievalTiming: retrievalResult?.retrievalTiming ?? null,
          retrievalTimedOut,
          streaming: true,
        },
        'Retrieval complete',
      );

      if (retrievalQuality && retrievalQuality.overall < RETRIEVAL_QUALITY_WARN_THRESHOLD) {
        request.log.warn(
          {
            userId: authUser.id,
            conversationId,
            retrievalLatencyMs,
            quality: retrievalQuality,
            retrievalQuery: workflowPlan.query.slice(0, 320),
            preferredLawIds: workflowPlan.preferredLawIds,
            streaming: true,
          },
          'Low retrieval quality detected',
        );
      }

      const requestIntent = workflowPlan.intent !== 'unknown' ? workflowPlan.intent : classifyLegalIntent(message);
      const availableRelatedLawCount =
        retrievalResult?.relatedLaws.length ?? workflowPlan.carryForwardRelatedLaws.length;
      const filteredRelatedCases = retrievalResult
        ? filterRelatedCasesForResponse(retrievalResult.relatedCases, {
            hasRelatedLaws: retrievalResult.relatedLaws.length > 0,
            intent: requestIntent,
            explicitCaseAsk: isExplicitCaseQuestion(message),
          })
        : filterRelatedCasesForResponse(workflowPlan.carryForwardRelatedCases, {
            hasRelatedLaws: workflowPlan.carryForwardRelatedLaws.length > 0,
            intent: requestIntent,
            explicitCaseAsk: isExplicitCaseQuestion(message),
          });

      if (!retrievalCacheKind && retrievalResult) {
        await maybeStoreGlobalRetrievalCache({
          env: app.env,
          message,
          workflowPlan,
          retrievalResult: {
            ...retrievalResult,
            relatedCases: filteredRelatedCases,
          },
          requestLog: request.log,
        });
      }

      // Push retrieval preview to the client so Related Laws / Cases / Sources
      // cards render immediately while the LLM is still generating the answer.
      // This is best-effort — if the generation later produces a `no-info`
      // result the final `complete` event will overwrite these previews with
      // an empty snapshot, which is the existing contract.
      const previewSources = retrievalResult?.sources ?? workflowPlan.carryForwardSources;
      const previewRelatedLaws =
        retrievalResult?.relatedLaws ?? workflowPlan.carryForwardRelatedLaws;
      const previewSourcesUsed =
        retrievalResult?.sourcesUsed ?? previewSources.length;
      if (
        previewSources.length > 0 ||
        previewRelatedLaws.length > 0 ||
        filteredRelatedCases.length > 0
      ) {
        await sendEvent({
          type: 'retrieval',
          sources: previewSources,
          relatedLaws: previewRelatedLaws,
          relatedCases: filteredRelatedCases,
          sourcesUsed: previewSourcesUsed,
          retrievalMs: retrievalLatencyMs,
          retrievalStages: retrievalResult?.retrievalTiming,
        });
      }

      await sendEvent({
        type: 'status',
        stage: 'generation',
        message: 'Generating response',
      });

      const generationStart = Date.now();
      const generationContextChunks =
        retrievalResult?.contextChunks ?? workflowPlan.carryForwardChunks;
      const generationQuery = buildContextualGenerationQuery(message, workflowPlan.relevantHistory);
      const generationOptions = {
        alreadyReranked: true,
        detailSubIntent: workflowPlan.detailSubIntent,
        answerStyle:
          workflowPlan.shouldSkipRetrieval && workflowPlan.carryForwardMode === 'reuse_same_law'
            ? 'follow_up_freeform'
            : 'qa_contract',
      } as const;
      let generationTimedOut = false;
      const generationOutcome = await resolveWithTimeout(
        generate(
          app.env,
          generationQuery,
          generationContextChunks,
          workflowPlan.relevantHistory,
          filteredRelatedCases,
          generationOptions,
        ),
        app.env.GENERATION_TIMEOUT_MS,
      );
      let generationResult: GenerationResult;
      if (generationOutcome.timedOut) {
        generationTimedOut = true;
        request.log.warn(
          {
            userId: authUser.id,
            conversationId,
            timeoutMs: app.env.GENERATION_TIMEOUT_MS,
            retrievalTimedOut,
            contextChunks: generationContextChunks.length,
            streaming: true,
          },
          'Generation timed out; streaming deterministic grounded fallback',
        );
        const fallbackGeneration = await generate(
          { ...app.env, OPENAI_API_KEY: '' },
          generationQuery,
          generationContextChunks,
          workflowPlan.relevantHistory,
          filteredRelatedCases,
          generationOptions,
        );
        generationResult = {
          ...fallbackGeneration,
          answer: cleanupAnswerStructure(fallbackGeneration.answer),
        };
      } else {
        generationResult = generationOutcome.value;
      }
      let generationLatencyMs = Date.now() - generationStart;

      if (
        generationResult.mode === 'no-info' &&
        shouldUseCaseFallback(filteredRelatedCases, {
          hasRelatedLaws: availableRelatedLawCount > 0,
          intent: requestIntent,
        })
      ) {
        generationResult = {
          ...generationResult,
          answer: buildCaseRecommendationAnswer(filteredRelatedCases),
          confidence: Math.max(generationResult.confidence, 0.32),
          mode: 'fallback-general',
          suggestedQuestions:
            generationResult.suggestedQuestions.length > 0
              ? generationResult.suggestedQuestions
              : [
                  'Эдгээр кейсүүдээс миний нөхцөлд хамгийн ойр аль нь вэ?',
                  'Эхний 3 кейсийн ялгаа юунд байна вэ?',
                  'Эдгээр кейстэй холбоотой хуулийн заалтыг тайлбарлаач',
                ],
        };
        generationLatencyMs = Date.now() - generationStart;
      }

      await streamStableAnswer(generationResult.answer, async (delta) => {
        await sendEvent({
          type: 'delta',
          delta,
        });
      });

      const latencyMs = Date.now() - startTime;

      request.log.info(
        {
          userId: authUser.id,
          conversationId,
          latencyMs,
          workflowLatencyMs,
          retrievalLatencyMs,
          generationLatencyMs,
          retrievalTimedOut,
          generationTimedOut,
          confidence: generationResult.confidence,
          promptTokens: generationResult.promptTokens,
          completionTokens: generationResult.completionTokens,
          streaming: true,
        },
        'Generation complete',
      );

      const isContextMode = generationResult.mode === 'context';
      const includeRelatedLaws = isContextMode;
      const includeRelatedCases = filteredRelatedCases.length > 0;
      const responseSources = isContextMode
        ? retrievalResult?.sources ?? workflowPlan.carryForwardSources
        : [];
      const responseRelatedLaws = includeRelatedLaws
        ? retrievalResult?.relatedLaws ?? workflowPlan.carryForwardRelatedLaws
        : [];
      const responseRelatedCases = includeRelatedCases ? filteredRelatedCases : [];
      const responseSourcesUsed = isContextMode
        ? retrievalResult?.sourcesUsed ?? responseSources.length
        : 0;
      const responseSuggestedQuestions = generationResult.suggestedQuestions ?? [];
      const quality = evaluateAnswerQuality({
        query: message,
        answer: generationResult.answer,
        sources: responseSources,
        relatedLaws: responseRelatedLaws,
        retrievalQuality,
        latencyMs,
        latencyBudgetMs: app.env.RESPONSE_LATENCY_BUDGET_MS,
        retrievalTimedOut,
        generationTimedOut,
        generationMode: generationResult.mode,
      });

      await sendEvent({
        type: 'status',
        stage: 'persisting',
        message: 'Saving conversation history',
      });

      let persistenceLatencyMs = 0;
      const persistenceStart = Date.now();
      try {
        await ensureConversationExists(conversationId, authUser.id, message);
        await addMessage(conversationId, 'user', message);
        await addMessage(
          conversationId,
          'assistant',
          generationResult.answer,
          buildAssistantMessageMetadata({
            latencyMs,
            answer: generationResult.answer,
            confidence: generationResult.confidence,
            sources: responseSources,
            relatedLaws: responseRelatedLaws,
            relatedCases: responseRelatedCases,
            suggestedQuestions: responseSuggestedQuestions,
            workflowNodes: workflowPlan.nodes,
            scope: workflowPlan.scope.scope,
            intent: workflowPlan.intent,
            carryForwardMode: workflowPlan.carryForwardMode,
            retrievalQuery: workflowPlan.query,
            preferredLawIds: workflowPlan.preferredLawIds,
            contextChunks: retrievalResult?.contextChunks ?? workflowPlan.carryForwardChunks,
            retrievalQuality,
            retrievalTiming: retrievalResult?.retrievalTiming,
            quality,
            keywordTerms: workflowPlan.keywordProfile.topicalTerms,
            primaryDomain:
              workflowPlan.keywordProfile.primaryDomain !== 'unknown'
                ? workflowPlan.keywordProfile.primaryDomain
                : workflowPlan.intent,
            followUpHint,
          }),
        );
      } catch (persistenceErr) {
        request.log.warn(
          {
            err: persistenceErr,
            userId: authUser.id,
            conversationId,
            streaming: true,
          },
          'Conversation persistence unavailable; returning streamed response without saving history',
        );
      } finally {
        persistenceLatencyMs = Date.now() - persistenceStart;
      }

      const response: ChatResponseDto = {
        conversationId,
        answer: generationResult.answer,
        sources: responseSources,
        relatedLaws: responseRelatedLaws,
        relatedCases: responseRelatedCases,
        confidence: generationResult.confidence,
        sourcesUsed: responseSourcesUsed,
        suggestedQuestions: responseSuggestedQuestions,
        usage: {
          latencyMs,
          workflowMs: workflowLatencyMs,
          retrievalMs: retrievalLatencyMs,
          retrievalStages: retrievalResult?.retrievalTiming,
          generationMs: generationLatencyMs,
          persistenceMs: persistenceLatencyMs,
          retrievalTimedOut,
          generationTimedOut,
          cacheHit: Boolean(retrievalCacheKind),
          cacheKind: retrievalCacheKind,
        },
        quality,
      };

      await sendEvent({
        type: 'complete',
        response,
      });
    } catch (err) {
      if (!isStreamDisconnectError(err)) {
        const latencyMs = Date.now() - startTime;
        request.log.error(
          { err, latencyMs, conversationId, userId: authUser.id, streaming: true },
          'Chat stream pipeline failed',
        );

        const mappedError = mapChatErrorToApiError(err);
        try {
          await sendEvent({
            type: 'error',
            error: mappedError,
          });
        } catch {
          // Ignore secondary failures once the stream is gone.
        }
      }
    } finally {
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    }

    return reply;
  };

  app.post<{ Body: ChatRequest }>(
    '/chat',
    { config: chatRateLimitConfig(), preHandler: app.authenticate },
    handler,
  );
  app.post<{ Body: ChatRequest }>(
    '/v1/chat',
    { config: chatRateLimitConfig(), preHandler: app.authenticate },
    handler,
  );
  app.post<{ Body: ChatRequest }>(
    '/chat/stream',
    { config: chatRateLimitConfig(), preHandler: app.authenticate },
    streamHandler,
  );
  app.post<{ Body: ChatRequest }>(
    '/v1/chat/stream',
    { config: chatRateLimitConfig(), preHandler: app.authenticate },
    streamHandler,
  );
}

function toChatHistory(messages: MessageRecord[]): ChatMessage[] {
  return messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      role: message.role as 'user' | 'assistant',
      content: message.content,
    }));
}

function buildContextualGenerationQuery(message: string, relevantHistory: ChatMessage[]): string {
  const previousUserQuestion = relevantHistory
    .slice()
    .reverse()
    .find((item) => item.role === 'user')?.content;

  if (!previousUserQuestion) {
    return message;
  }

  const current = compactTextForPrompt(message);
  const previous = compactTextForPrompt(previousUserQuestion);

  if (!previous || previous.includes(current)) {
    return message;
  }

  return [
    compactTextForPrompt(`${previous} ${current}`).slice(0, 700),
    `Одоогийн тодруулга: ${current}`,
  ].join('\n');
}

function compactTextForPrompt(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function trimContextChunksForSnapshot(
  chunks: ChromaQueryResult[] = [],
): Array<{
  id: string;
  document: string;
  metadata: Record<string, unknown>;
  score: number;
  rawScore?: number;
}> {
  return chunks.slice(0, 4).map((chunk) => ({
    id: chunk.id,
    document: String(chunk.document ?? '').slice(0, 1400),
    metadata: chunk.metadata ?? {},
    score: Number(chunk.score ?? 0),
    rawScore: typeof chunk.rawScore === 'number' ? Number(chunk.rawScore) : undefined,
  }));
}

function buildAssistantMessageMetadata(params: AssistantMetadataBuildParams): Record<string, unknown> {
  return {
    confidence: params.confidence,
    sourcesUsed: params.sources.length,
    sources: params.sources,
    relatedLaws: params.relatedLaws,
    relatedCases: params.relatedCases,
    suggestedQuestions: params.suggestedQuestions,
    usage: {
      latencyMs: params.latencyMs,
      retrievalStages: params.retrievalTiming,
    },
    quality: params.quality,
    laws: params.relatedLaws.length,
    cases: params.relatedCases.length,
    latencyMs: params.latencyMs,
    workflow: {
      nodes: params.workflowNodes,
      scope: params.scope,
      intent: params.intent,
      carryForwardMode: params.carryForwardMode,
      primaryDomain: params.primaryDomain ?? params.intent,
      keywords: params.keywordTerms ?? [],
      followUp: params.followUpHint
        ? {
            kind: params.followUpHint.kind,
            confidence: params.followUpHint.confidence,
            referencedTurnIndex: params.followUpHint.referencedTurnIndex ?? null,
          }
        : null,
    },
    retrievalSnapshot:
      params.contextChunks && params.contextChunks.length > 0
        ? {
            query: params.retrievalQuery,
            intent: params.intent,
            primaryDomain: params.primaryDomain ?? params.intent,
            keywords: params.keywordTerms ?? [],
            lawIds: params.preferredLawIds ?? [],
            lawTitles: params.relatedLaws.map((law) => law.title).slice(0, 6),
            sources: params.sources.slice(0, 6),
            relatedLaws: params.relatedLaws.slice(0, 10),
            relatedCases: params.relatedCases.slice(0, 6),
            contextChunks: trimContextChunksForSnapshot(params.contextChunks),
            retrievalQuality: params.retrievalQuality ?? null,
          }
        : undefined,
  };
}

function buildEarlyResponseResponse(
  conversationId: string,
  earlyResponse: WorkflowEarlyResponse,
  latencyMs: number,
): ChatResponseDto {
  return {
    conversationId,
    answer: earlyResponse.answer,
    sources: [],
    relatedLaws: [],
    relatedCases: [],
    confidence: earlyResponse.confidence,
    sourcesUsed: 0,
    suggestedQuestions: earlyResponse.suggestedQuestions,
    usage: {
      latencyMs,
    },
    quality: {
      retrievalAccuracy: 1,
      citationCorrectness: 1,
      answerFaithfulness: 1,
      responseLatency: 1,
      overall: 1,
      issues: [],
    },
  };
}

function buildSessionRetrievalCacheResult(
  message: string,
  records: MessageRecord[],
): RetrievalResult | null {
  const cachedAssistant = findSessionCachedAssistantRecord(message, records);
  if (!cachedAssistant) {
    return null;
  }

  const metadata = asRecord(cachedAssistant.metadata);
  const snapshot = asRecord(metadata.retrievalSnapshot);
  const contextChunks = readArray<ChromaQueryResult>(snapshot.contextChunks);
  if (contextChunks.length === 0) {
    return null;
  }

  const retrievalQuality = asRetrievalQuality(snapshot.retrievalQuality ?? metadata.retrievalQuality);
  if (retrievalQuality.overall < 0.45) {
    return null;
  }

  const sources = readArray<Source>(snapshot.sources).length > 0
    ? readArray<Source>(snapshot.sources)
    : readArray<Source>(metadata.sources);
  const relatedLaws = readArray<RelatedLawDto>(snapshot.relatedLaws).length > 0
    ? readArray<RelatedLawDto>(snapshot.relatedLaws)
    : readArray<RelatedLawDto>(metadata.relatedLaws);
  const relatedCases = readArray<RelatedCaseDto>(snapshot.relatedCases).length > 0
    ? readArray<RelatedCaseDto>(snapshot.relatedCases)
    : readArray<RelatedCaseDto>(metadata.relatedCases);

  return {
    contextChunks,
    sources,
    relatedLaws,
    relatedCases,
    sourcesUsed: sources.length,
    retrievalQuality,
    retrievalTiming: zeroRetrievalTiming(),
  };
}

async function maybeGetGlobalRetrievalCache(params: {
  env: AppEnv;
  message: string;
  workflowPlan: WorkflowPlan;
  requestLog: FastifyRequest['log'];
}): Promise<RetrievalResult | null> {
  const ineligibleReason = getGlobalRetrievalCacheIneligibilityReason(
    params.env,
    params.message,
    params.workflowPlan,
  );
  if (ineligibleReason) {
    params.requestLog.info(
      {
        reason: ineligibleReason,
        intent: params.workflowPlan.intent,
        scope: params.workflowPlan.scope.scope,
        carryForwardMode: params.workflowPlan.carryForwardMode,
        shouldSkipRetrieval: params.workflowPlan.shouldSkipRetrieval,
      },
      'Global retrieval cache lookup skipped',
    );
    return null;
  }

  try {
    const normalizedQuestion = normalizeRetrievalCacheQuestion(params.message);
    const entry = await getRetrievalCacheEntry({
      normalizedQuestion,
      intent: params.workflowPlan.intent,
      cacheVersion: params.env.RETRIEVAL_CACHE_VERSION,
      retrievalSpeedMode: params.env.RETRIEVAL_SPEED_MODE,
    });

    if (!entry) {
      params.requestLog.info(
        {
          intent: params.workflowPlan.intent,
          normalizedQuestion,
          cacheVersion: params.env.RETRIEVAL_CACHE_VERSION,
          retrievalSpeedMode: params.env.RETRIEVAL_SPEED_MODE,
        },
        'Global retrieval cache miss',
      );
      return null;
    }

    params.requestLog.info(
      {
        intent: params.workflowPlan.intent,
        normalizedQuestion,
        cacheVersion: params.env.RETRIEVAL_CACHE_VERSION,
        cacheKeyMode: entry.lookupMode ?? 'primary',
        retrievalSpeedMode: params.env.RETRIEVAL_SPEED_MODE,
        storedRetrievalSpeedMode: entry.retrievalSpeedMode,
        sources: entry.sources.length,
        laws: entry.relatedLaws.length,
        cases: entry.relatedCases.length,
        hitCount: entry.hitCount,
      },
      'Global retrieval cache hit',
    );
    return buildRetrievalResultFromCacheEntry(entry);
  } catch (err) {
    params.requestLog.warn(
      { err },
      'Global retrieval cache lookup failed; continuing with normal retrieval',
    );
    return null;
  }
}

async function maybeStoreGlobalRetrievalCache(params: {
  env: AppEnv;
  message: string;
  workflowPlan: WorkflowPlan;
  retrievalResult: RetrievalResult;
  requestLog: FastifyRequest['log'];
}): Promise<void> {
  const ineligibleReason = getGlobalRetrievalCacheIneligibilityReason(
    params.env,
    params.message,
    params.workflowPlan,
  );
  if (ineligibleReason) {
    params.requestLog.info(
      {
        reason: ineligibleReason,
        intent: params.workflowPlan.intent,
        scope: params.workflowPlan.scope.scope,
        carryForwardMode: params.workflowPlan.carryForwardMode,
        shouldSkipRetrieval: params.workflowPlan.shouldSkipRetrieval,
      },
      'Global retrieval cache store skipped',
    );
    return;
  }

  const qualityEligibility = getGlobalRetrievalCacheQualityEligibility(
    params.env,
    params.retrievalResult,
  );
  if (!qualityEligibility.eligible) {
    params.requestLog.info(
      {
        reason: qualityEligibility.reason,
        retrievalQualityOverall: params.retrievalResult.retrievalQuality?.overall ?? null,
        minQuality: params.env.RETRIEVAL_CACHE_MIN_QUALITY,
        contextChunks: params.retrievalResult.contextChunks.length,
        sources: params.retrievalResult.sources.length,
        laws: params.retrievalResult.relatedLaws.length,
      },
      'Global retrieval cache store skipped because retrieval quality is too low',
    );
    return;
  }

  try {
    await upsertRetrievalCacheEntry(
      {
        normalizedQuestion: normalizeRetrievalCacheQuestion(params.message),
        intent: params.workflowPlan.intent,
        contextChunks: params.retrievalResult.contextChunks,
        sources: params.retrievalResult.sources,
        relatedLaws: params.retrievalResult.relatedLaws,
        relatedCases: params.retrievalResult.relatedCases,
        sourcesUsed: params.retrievalResult.sourcesUsed,
        retrievalQuality: params.retrievalResult.retrievalQuality,
        retrievalTiming: params.retrievalResult.retrievalTiming,
        cacheVersion: params.env.RETRIEVAL_CACHE_VERSION,
        retrievalSpeedMode: params.env.RETRIEVAL_SPEED_MODE,
      },
      params.env.RETRIEVAL_CACHE_TTL_SECONDS,
    );
    params.requestLog.info(
      {
        intent: params.workflowPlan.intent,
        normalizedQuestion: normalizeRetrievalCacheQuestion(params.message),
        cacheVersion: params.env.RETRIEVAL_CACHE_VERSION,
        cacheKeyMode: 'primary',
        retrievalSpeedMode: params.env.RETRIEVAL_SPEED_MODE,
        eligibilityReason: qualityEligibility.reason,
        retrievalQualityOverall: params.retrievalResult.retrievalQuality?.overall ?? null,
        contextChunks: params.retrievalResult.contextChunks.length,
        sources: params.retrievalResult.sources.length,
        laws: params.retrievalResult.relatedLaws.length,
        cases: params.retrievalResult.relatedCases.length,
      },
      'Global retrieval cache stored',
    );
  } catch (err) {
    params.requestLog.warn(
      { err },
      'Global retrieval cache write failed; response already generated',
    );
  }
}

function getGlobalRetrievalCacheIneligibilityReason(
  env: AppEnv,
  message: string,
  workflowPlan: WorkflowPlan,
): string | null {
  if (!env.RETRIEVAL_CACHE_ENABLED) {
    return 'cache_disabled';
  }
  if (workflowPlan.scope.scope !== 'legal') {
    return 'non_legal_scope';
  }
  if (workflowPlan.intent === 'unknown') {
    return 'unknown_intent';
  }
  if (workflowPlan.shouldSkipRetrieval) {
    return 'follow_up_or_retrieval_skipped';
  }
  if (workflowPlan.carryForwardMode !== 'full_refresh') {
    return 'not_full_refresh';
  }
  if (workflowPlan.earlyResponse) {
    return 'early_response';
  }
  if (!isRetrievalCacheEligibleQuestion(message)) {
    return 'question_not_cache_eligible_or_pii';
  }
  return null;
}

function buildRetrievalResultFromCacheEntry(entry: RetrievalCacheEntry): RetrievalResult {
  return {
    contextChunks: entry.contextChunks,
    sources: entry.sources,
    relatedLaws: entry.relatedLaws,
    relatedCases: entry.relatedCases,
    sourcesUsed: entry.sourcesUsed,
    retrievalQuality: entry.retrievalQuality ?? fallbackRetrievalQuality(entry.contextChunks),
    retrievalTiming: zeroRetrievalTiming(),
  };
}

function getGlobalRetrievalCacheQualityEligibility(
  env: AppEnv,
  retrievalResult: RetrievalResult,
): { eligible: boolean; reason: string } {
  const overall = retrievalResult.retrievalQuality?.overall ?? 0;
  if (overall >= env.RETRIEVAL_CACHE_MIN_QUALITY) {
    return { eligible: true, reason: 'quality_score' };
  }

  const hasGroundedContext =
    retrievalResult.contextChunks.length >= 2 &&
    retrievalResult.sources.length >= 1 &&
    retrievalResult.relatedLaws.length >= 1;
  if (hasGroundedContext) {
    return { eligible: true, reason: 'grounded_context' };
  }

  return { eligible: false, reason: 'low_quality_and_sparse_context' };
}

function findSessionCachedAssistantRecord(
  message: string,
  records: MessageRecord[],
): MessageRecord | null {
  const target = normalizeSessionCacheQuestion(message);
  if (!target) {
    return null;
  }

  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record?.role !== 'user' || normalizeSessionCacheQuestion(record.content) !== target) {
      continue;
    }

    for (let j = i + 1; j < records.length; j += 1) {
      const candidate = records[j];
      if (!candidate) {
        continue;
      }
      if (candidate.role === 'user') {
        break;
      }
      if (candidate.role === 'assistant' && candidate.content.trim()) {
        return candidate;
      }
    }
  }

  return null;
}

function normalizeSessionCacheQuestion(text: string): string {
  return compactText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function readScore(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asRetrievalQuality(value: unknown): RetrievalQuality {
  const quality = asRecord(value);
  const qualityBand = quality.qualityBand;
  return {
    overall: readScore(quality.overall, 0.6),
    intentPrecision: readScore(quality.intentPrecision, 0.6),
    canonicalCoverage: readScore(quality.canonicalCoverage, 0.6),
    topScore: readScore(quality.topScore, 0.6),
    qualityBand:
      qualityBand === 'low' || qualityBand === 'medium' || qualityBand === 'high'
        ? qualityBand
        : 'medium',
  };
}

function fallbackRetrievalQuality(contextChunks: ChromaQueryResult[]): RetrievalQuality {
  const topScore = contextChunks[0]?.score ?? 0.6;
  return {
    overall: topScore >= 0.8 ? 0.75 : 0.6,
    intentPrecision: 0.6,
    canonicalCoverage: contextChunks.length > 0 ? 0.6 : 0,
    topScore,
    qualityBand: topScore >= 0.8 ? 'high' : 'medium',
  };
}

function zeroRetrievalTiming(): RetrievalStageTiming {
  return {
    embeddingMs: 0,
    vectorSearchMs: 0,
    keywordSearchMs: 0,
    fallbackAndFilterMs: 0,
    caseSearchMs: 0,
    rerankMs: 0,
    buildMs: 0,
  };
}

async function resolveWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ value: T; timedOut: false } | { value?: undefined; timedOut: true }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { value: await promise, timedOut: false };
  }

  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<{ value?: undefined; timedOut: true }>((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });

  try {
    const result = await Promise.race([
      promise.then((value) => ({ value, timedOut: false as const })),
      timeoutPromise,
    ]);

    if (result.timedOut) {
      promise.catch(() => undefined);
    }

    return result;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function setupSseReply(reply: FastifyReply, origin?: string): void {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...(origin
      ? {
          'Access-Control-Allow-Origin': origin,
          Vary: 'Origin',
        }
      : {}),
  });
  reply.raw.flushHeaders?.();
}

async function streamStableAnswer(
  answer: string,
  onDelta: (delta: string) => Promise<void> | void,
): Promise<void> {
  const chunks = splitAnswerIntoStableChunks(answer);
  for (const chunk of chunks) {
    if (!chunk) {
      continue;
    }

    await onDelta(chunk);
  }
}

function splitAnswerIntoStableChunks(answer: string): string[] {
  const normalized = answer.replace(/\r\n/g, '\n');
  const paragraphs = normalized.split('\n');
  const chunks: string[] = [];

  for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index] ?? '';
    const withNewline = index < paragraphs.length - 1 ? `${paragraph}\n` : paragraph;

    if (!paragraph.trim()) {
      chunks.push(withNewline);
      continue;
    }

    if (/^\s*(?:[-*]\s|\d+\.\s|\*\*)/.test(paragraph)) {
      chunks.push(withNewline);
      continue;
    }

    const sentenceParts = paragraph.match(/[^.!?\n]+[.!?…]+(?:\s+|$)|[^.!?\n]+$/g) ?? [paragraph];
    const sentenceText = sentenceParts.join('');

    if (sentenceText.length === paragraph.length) {
      sentenceParts.forEach((part, partIndex) => {
        const suffix = partIndex === sentenceParts.length - 1 && index < paragraphs.length - 1 ? '\n' : '';
        chunks.push(`${part}${suffix}`);
      });
      continue;
    }

    chunks.push(withNewline);
  }

  return chunks;
}

function isStreamDisconnectError(error: unknown): boolean {
  return error instanceof Error && error.message === 'STREAM_CLIENT_DISCONNECTED';
}

function mapChatErrorToApiError(error: unknown): ApiError {
  const messageText = error instanceof Error ? error.message : 'Unknown error in chat pipeline';
  const errName = error instanceof Error ? error.constructor.name : '';

  const isVectorError =
    errName === 'ChromaConnectionError' ||
    messageText.includes('Vector') ||
    messageText.includes('pgvector') ||
    messageText.includes('ECONNREFUSED') ||
    messageText.includes('getCollection');

  const isOpenAIError =
    errName === 'RateLimitError' ||
    errName === 'AuthenticationError' ||
    errName === 'APIError' ||
    messageText.includes('OpenAI') ||
    messageText.includes('insufficient_quota') ||
    messageText.includes('exceeded your current quota');

  if (isVectorError) {
    return {
      error: 'VECTOR_DB_UNAVAILABLE',
      message: 'Vector database is temporarily unavailable. Please try again later.',
    };
  }

  if (isOpenAIError) {
    return {
      error: 'LLM_ERROR',
      message: 'Language model service encountered an error. Please try again later.',
    };
  }

  if (messageText.includes('CONVERSATION_OWNERSHIP_MISMATCH')) {
    return {
      error: 'FORBIDDEN',
      message: 'Conversation does not belong to the current user.',
    };
  }

  return {
    error: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred processing your request.',
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function ensureConversationExists(
  conversationId: string,
  userId: string,
  firstMessage: string,
): Promise<void> {
  const existing = await getConversationById(conversationId);
  if (existing?.userId === userId) {
    return;
  }

  if (existing && existing.userId !== userId) {
    throw new Error('CONVERSATION_OWNERSHIP_MISMATCH');
  }

  const title = compactText(firstMessage).slice(0, 80) || 'Шинэ харилцан яриа';
  await createConversation(conversationId, userId, title);
}

function buildRetrievalPlan(
  message: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
): RetrievalPlan {
  const trimmedMessage = message.trim();
  const rewrittenQuery = rewriteQuery(trimmedMessage);
  const isFollowUp = isContextDependentFollowUp(trimmedMessage);
  const relevantHistory = isFollowUp ? selectRelevantHistory(trimmedMessage, history) : [];
  const usesHistoryContext = relevantHistory.length > 0;
  const preferredLawIds = usesHistoryContext ? extractLawIdsFromHistory(relevantHistory) : [];

  if (!usesHistoryContext) {
    return {
      query: mergeRetrievalQuery(trimmedMessage, rewrittenQuery),
      rewrittenQuery,
      preferredLawIds,
      isFollowUp,
      usesHistoryContext,
      relevantHistory,
    };
  }

  const recentUser = relevantHistory
    .filter((item) => item.role === 'user')
    .slice(-2)
    .map((item) => compactText(item.content))
    .filter(Boolean)
    .join(' ');

  const recentAssistant = relevantHistory
    .filter((item) => item.role === 'assistant')
    .slice(-2)
    .map((item) => compactText(item.content))
    .filter(Boolean)
    .join(' ');

  const recentLawTitles = extractLawTitlesFromHistory(relevantHistory).join('; ');

  const context = [recentUser, recentAssistant].filter(Boolean).join(' ');
  if (!context) {
    return {
      query: mergeRetrievalQuery(trimmedMessage, rewrittenQuery),
      rewrittenQuery,
      preferredLawIds,
      isFollowUp,
      usesHistoryContext,
      relevantHistory,
    };
  }

  const lawContextLine = recentLawTitles ? `\nХууль/сэдэв: ${recentLawTitles.slice(0, 220)}` : '';

  return {
    query: `${mergeRetrievalQuery(trimmedMessage, rewrittenQuery)}\n\nӨмнөх ярианы гол контекст: ${context.slice(0, 900)}${lawContextLine}`,
    rewrittenQuery,
    preferredLawIds,
    isFollowUp,
    usesHistoryContext,
    relevantHistory,
  };
}

function mergeRetrievalQuery(message: string, rewrittenQuery: string): string {
  const trimmedMessage = message.trim();
  const trimmedRewrite = rewrittenQuery.trim();
  if (!trimmedRewrite || trimmedRewrite === trimmedMessage) {
    return trimmedMessage;
  }

  return `${trimmedMessage}\nХайлтын хувилбар: ${trimmedRewrite}`;
}

function isContextDependentFollowUp(message: string): boolean {
  const normalized = message.toLowerCase().trim();
  if (!normalized) return false;

  const shortFollowUp = normalized.length <= 120;

  const followUpHints = [
    'энэ',
    'тэр',
    'дээрх',
    'тэгвэл',
    'тэгэхээр',
    'ингэвэл',
    'ийм тохиолдолд',
    'энэ тохиолдолд',
    'төстэй',
    'адил',
    'зүйл',
    'заалт',
    'бүтнээр',
    'өгнө үү',
    'өгөөч',
    'энэ хууль',
    'тэр хууль',
    'дэлгэрэнгүй',
    'тайлбарла',
    'үргэлжлүүл',
    'нэмээд',
    'юу вэ',
    'дугаар',
    'дүгээр',
    'гаргаж',
  ];

  const hasArticlePattern = /\d+\s+(?:дугаар|дүгээр)\s+(?:зүйл|заалт)/i.test(normalized);

  return (
    shortFollowUp && (hasArticlePattern || followUpHints.some((hint) => normalized.includes(hint)))
  );
}

function selectRelevantHistory(
  message: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
): ChatMessage[] {
  if (history.length === 0) {
    return [];
  }

  const recentWindow = history
    .slice(-6)
    .map((item) => ({
      role: item.role,
      content: compactText(item.content),
    }))
    .filter((item) => item.content.length > 0);

  if (recentWindow.length === 0) {
    return [];
  }

  if (!isHistoryRelevantToMessage(message, recentWindow)) {
    return [];
  }

  return recentWindow.slice(-4);
}

function isHistoryRelevantToMessage(
  message: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
): boolean {
  const currentText = compactText(message);
  if (!currentText) {
    return false;
  }

  const recentUserText = history
    .filter((item) => item.role === 'user')
    .slice(-3)
    .map((item) => item.content)
    .join(' ')
    .trim();

  if (!recentUserText) {
    return false;
  }

  const currentIntent = classifyLegalIntent(currentText);
  const historyIntent = classifyLegalIntent(recentUserText);
  const currentTokens = extractTopicalTokens(currentText);
  const historyTokens = extractTopicalTokens(recentUserText);
  const overlapCount = countTokenOverlap(currentTokens, historyTokens);
  const overlapRatio = currentTokens.length > 0 ? overlapCount / currentTokens.length : 0;
  const hasSpecificLawReference =
    /lawId=\d+|§\s*\d+|\d+(?:\.\d+)?\s*(?:дугаар|дүгээр)\s*(?:зүйл|заалт)/iu.test(currentText);
  const explicitContextReference =
    /\b(энэ|тэр|дээрх|тэгвэл|тэгэхээр|ингэвэл|ийм|ингэхэд)\b/iu.test(currentText);

  if (hasSpecificLawReference) {
    return true;
  }

  if (overlapCount >= 2) {
    return true;
  }

  if (
    explicitContextReference &&
    currentIntent !== 'unknown' &&
    historyIntent !== 'unknown' &&
    currentIntent === historyIntent &&
    overlapCount >= 1
  ) {
    return true;
  }

  return (
    explicitContextReference &&
    currentIntent !== 'unknown' &&
    historyIntent !== 'unknown' &&
    currentIntent === historyIntent &&
    overlapRatio >= 0.2
  );
}

function extractTopicalTokens(text: string): string[] {
  const stopwords = new Set([
    'би',
    'миний',
    'бид',
    'та',
    'таны',
    'тэр',
    'энэ',
    'ийм',
    'тэгвэл',
    'тэгэхээр',
    'ингэвэл',
    'дээрх',
    'бол',
    'вэ',
    'юу',
    'яаж',
    'ямар',
    'яг',
    'байна',
    'болох',
    'байх',
    'юм',
    'л',
    'да',
    'уу',
    'үү',
  ]);

  return compactText(text)
    .toLowerCase()
    .replace(/[.,!?;:"'`()\[\]{}\\/]+/g, ' ')
    .split(/\s+/)
    .map((token) => stemHistoryToken(token))
    .filter((token) => token.length >= 3 && !stopwords.has(token));
}

function stemHistoryToken(token: string): string {
  return token.replace(
    /(ийн|ын|ийг|ыг|аас|ээс|аар|ээр|оор|өөр|тай|тэй|гүй|ууд|үүд|нууд|нүүд|д|т)$/iu,
    '',
  );
}

function countTokenOverlap(currentTokens: string[], historyTokens: string[]): number {
  if (currentTokens.length === 0 || historyTokens.length === 0) {
    return 0;
  }

  const historySet = new Set(historyTokens);
  return currentTokens.reduce((count, token) => count + (historySet.has(token) ? 1 : 0), 0);
}

function extractLawIdsFromHistory(
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
): string[] {
  const text = history
    .slice(-6)
    .map((item) => item.content)
    .join('\n');

  const ids = new Set<string>();
  for (const match of text.matchAll(/lawId=(\d+)/gi)) {
    const id = match[1];
    if (id) ids.add(id);
  }

  return Array.from(ids).slice(0, 3);
}

function extractLawTitlesFromHistory(
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
): string[] {
  const text = history
    .slice(-6)
    .map((item) => item.content)
    .join('\n');

  const titles = new Set<string>();
  const regex = /([А-Яа-яӨөҮүЁёA-Za-z0-9\s"'()-]{4,140}?тухай хууль)/g;
  for (const match of text.matchAll(regex)) {
    const title = compactText(match[1]).slice(0, 140);
    if (title) titles.add(title);
  }

  return Array.from(titles).slice(0, 3);
}

// Legacy follow-up planner kept temporarily for parity while the new workflow
// service is rolled out end-to-end. Marking it as referenced keeps strict
// typecheck green until the final cleanup pass removes the old branch.
void buildRetrievalPlan;

function compactText(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function filterRelatedCasesForResponse(
  relatedCases: RelatedCaseDto[],
  options: {
    hasRelatedLaws: boolean;
    intent: QueryIntent;
    explicitCaseAsk?: boolean;
  },
): RelatedCaseDto[] {
  if (!options.hasRelatedLaws && options.intent === 'unknown') {
    return [];
  }

  const minScore = options.explicitCaseAsk
    ? options.hasRelatedLaws
      ? MIN_CASE_UI_SCORE
      : MIN_CASE_FALLBACK_SCORE
    : MIN_CASE_AUTO_UI_SCORE;
  return relatedCases
    .filter((caseItem) => getRelatedCaseScore(caseItem) >= minScore)
    .slice(0, 6);
}

function isExplicitCaseQuestion(message: string): boolean {
  return /(ижил\s+кейс|төстэй\s+кейс|шүүхийн\s+кейс|case|кейс|кейсүүд|шүүхийн\s+шийдвэр|шүүхийн\s+практик|шүүхийн\s+жишиг|жишиг\s+шийдвэр|прецедент|шийтгэх\s+тогтоол|магадлал|хэргийн\s+жишээ)/i.test(
    compactText(message).toLowerCase(),
  );
}

function shouldUseCaseFallback(
  relatedCases: RelatedCaseDto[],
  options: {
    hasRelatedLaws: boolean;
    intent: QueryIntent;
  },
): boolean {
  if (!options.hasRelatedLaws && options.intent === 'unknown') {
    return false;
  }

  if (relatedCases.length === 0) {
    return false;
  }

  const topScore = getRelatedCaseScore(relatedCases[0]);
  return topScore >= (options.hasRelatedLaws ? MIN_CASE_UI_SCORE : MIN_CASE_FALLBACK_SCORE);
}

function getRelatedCaseScore(caseItem: RelatedCaseDto): number {
  return caseItem.displayScore ?? caseItem.score;
}

function buildCaseRecommendationAnswer(relatedCases: RelatedCaseDto[]): string {
  const topCases = relatedCases.slice(0, 3);
  if (topCases.length === 0) {
    return 'Мэдээлэл олдсонгүй.';
  }

  const caseLines = topCases
    .map((caseItem, index) => {
      const header = [caseItem.caseNumber ? `№${caseItem.caseNumber}` : '', caseItem.title]
        .filter(Boolean)
        .join(' - ');
      const meta = [caseItem.court, caseItem.decisionType].filter(Boolean).join(' | ');
      return `${index + 1}. ${header}${meta ? `\n   ${meta}` : ''}`;
    })
    .join('\n');

  return `Таны асуултад яг таарах хуулийн заалт хангалттай хүчтэй олдсонгүй. Гэхдээ төстэй шүүхийн практик олдлоо.\n\n**Төстэй кейсүүд**\n${caseLines}\n\n**Практик зөвлөмж**\n- Доорх Similar Court Cases хэсгээс кейс бүрийн дэлгэрэнгүйг нээж үзээрэй.\n- Хэрэв хүсвэл дараагийн асуултаараа нэг кейсийг дэлгэрүүлж, холбогдох хуулийн заалтуудтай нь тайлбарлаж өгч болно.`;
}
