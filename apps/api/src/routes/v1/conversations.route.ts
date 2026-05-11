import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  ChatUsage,
  ConversationDetailResponse,
  ConversationsResponse,
  RelatedCase,
  RelatedLaw,
  Source,
  StoredMessage,
} from '@legal-chatbot/shared';
import {
  createConversation,
  deleteConversationForUser,
  getConversationForUser,
  listConversationsForUser,
  type MessageRecord,
} from '../../repositories/conversation.repository.js';

interface CreateConversationRequest {
  title: string;
}

interface CreateConversationResponse {
  id: string;
  title: string;
  createdAt: string;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
}

function readObjectArray<T>(value: unknown): T[] | undefined {
  return Array.isArray(value) ? (value as T[]) : undefined;
}

function mapStoredMessage(message: MessageRecord): StoredMessage | null {
  if (message.role !== 'user' && message.role !== 'assistant') {
    return null;
  }

  const metadata =
    message.metadata && typeof message.metadata === 'object'
      ? (message.metadata as Record<string, unknown>)
      : {};

  const usageValue =
    metadata.usage && typeof metadata.usage === 'object'
      ? (metadata.usage as ChatUsage)
      : undefined;

  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    content: message.content,
    sources: readObjectArray<Source>(metadata.sources),
    relatedCases: readObjectArray<RelatedCase>(metadata.relatedCases),
    relatedLaws: readObjectArray<RelatedLaw>(metadata.relatedLaws),
    confidence: readNumber(metadata.confidence),
    sourcesUsed: readNumber(metadata.sourcesUsed),
    suggestedQuestions: readStringArray(metadata.suggestedQuestions),
    usage: usageValue,
    latencyMs: readNumber(metadata.latencyMs) ?? readNumber(usageValue?.latencyMs),
    createdAt: message.createdAt,
  };
}

function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

async function listConversationsHandler(
  request: FastifyRequest<{ Querystring: { limit?: string; offset?: string } }>,
  reply: FastifyReply,
) {
  if (!request.authUser) {
    return reply.status(401).send({ error: 'UNAUTHORIZED', message: 'Authentication required.' });
  }

  try {
    const limit = Math.min(parseInt(request.query.limit || '50', 10), 100);
    const offset = Math.max(parseInt(request.query.offset || '0', 10), 0);
    const { conversations, total } = await listConversationsForUser(request.authUser.id, limit, offset);

    const response: ConversationsResponse = {
      conversations: conversations.map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        messageCount: conversation.messageCount,
      })),
      total,
      limit,
      offset,
    };

    return reply.status(200).send(response);
  } catch (error) {
    request.log.error({ err: error }, 'Failed to list conversations');
    return reply.status(500).send({ error: 'LIST_CONVERSATIONS_FAILED', message: 'Failed to list conversations.' });
  }
}

async function createConversationHandler(
  request: FastifyRequest<{ Body: CreateConversationRequest }>,
  reply: FastifyReply,
) {
  if (!request.authUser) {
    return reply.status(401).send({ error: 'UNAUTHORIZED', message: 'Authentication required.' });
  }

  const title = request.body?.title?.trim();
  if (!title) {
    return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'Title is required.' });
  }

  try {
    const { randomUUID } = await import('node:crypto');
    const conversationId = randomUUID();
    const conversation = await createConversation(conversationId, request.authUser.id, title);

    const response: CreateConversationResponse = {
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
    };

    return reply.status(201).send(response);
  } catch (error) {
    request.log.error({ err: error }, 'Failed to create conversation');
    return reply.status(500).send({ error: 'CREATE_CONVERSATION_FAILED', message: 'Failed to create conversation.' });
  }
}

async function getConversationHandler(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) {
  if (!request.authUser) {
    return reply.status(401).send({ error: 'UNAUTHORIZED', message: 'Authentication required.' });
  }

  const { id } = request.params;
  if (!isValidUUID(id)) {
    return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'Invalid conversation ID.' });
  }

  try {
    const { conversation, messages } = await getConversationForUser(id, request.authUser.id);

    if (!conversation) {
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'Conversation not found.' });
    }

    const response: ConversationDetailResponse = {
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messages: messages
        .map(mapStoredMessage)
        .filter((message): message is StoredMessage => Boolean(message)),
    };

    return reply.status(200).send(response);
  } catch (error) {
    request.log.error({ err: error }, 'Failed to get conversation');
    return reply.status(500).send({ error: 'GET_CONVERSATION_FAILED', message: 'Failed to load conversation.' });
  }
}

async function deleteConversationHandler(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) {
  if (!request.authUser) {
    return reply.status(401).send({ error: 'UNAUTHORIZED', message: 'Authentication required.' });
  }

  const { id } = request.params;
  if (!isValidUUID(id)) {
    return reply.status(400).send({ error: 'VALIDATION_ERROR', message: 'Invalid conversation ID.' });
  }

  try {
    const deleted = await deleteConversationForUser(id, request.authUser.id);
    if (!deleted) {
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'Conversation not found.' });
    }

    return reply.status(204).send();
  } catch (error) {
    request.log.error({ err: error }, 'Failed to delete conversation');
    return reply.status(500).send({ error: 'DELETE_CONVERSATION_FAILED', message: 'Failed to delete conversation.' });
  }
}

export function registerConversationsRoute(app: FastifyInstance) {
  app.get<{ Querystring: { limit?: string; offset?: string } }>(
    '/v1/conversations',
    { preHandler: app.authenticate },
    listConversationsHandler,
  );
  app.post<{ Body: CreateConversationRequest }>(
    '/v1/conversations',
    { preHandler: app.authenticate },
    createConversationHandler,
  );
  app.get<{ Params: { id: string } }>(
    '/v1/conversations/:id',
    { preHandler: app.authenticate },
    getConversationHandler,
  );
  app.delete<{ Params: { id: string } }>(
    '/v1/conversations/:id',
    { preHandler: app.authenticate },
    deleteConversationHandler,
  );
}
