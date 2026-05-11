// ────────────────────────────────────────────────────────────
// Feedback Route — POST /v1/feedback
// ────────────────────────────────────────────────────────────

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  feedbackRequestSchema,
  type FeedbackRequest,
  type FeedbackResponse,
  type ApiError,
} from '@legal-chatbot/shared';
import { feedbackRateLimitConfig } from '../../plugins/rate-limiter.js';

export function registerFeedbackRoute(app: FastifyInstance) {
  app.post<{ Body: FeedbackRequest }>(
    '/v1/feedback',
    {
      config: feedbackRateLimitConfig(),
    },
    async (request: FastifyRequest<{ Body: FeedbackRequest }>, reply: FastifyReply) => {
      const parseResult = feedbackRequestSchema.safeParse(request.body);
      if (!parseResult.success) {
        const error: ApiError = {
          error: 'VALIDATION_ERROR',
          message: parseResult.error.errors.map((e) => e.message).join('; '),
        };
        return reply.status(400).send(error);
      }

      const { conversationId, messageIndex, rating } = parseResult.data;

      request.log.info({ conversationId, messageIndex, rating }, 'Feedback received');

      // TODO: Store feedback in Postgres in Step 5

      const response: FeedbackResponse = { success: true };
      return reply.status(200).send(response);
    },
  );
}
