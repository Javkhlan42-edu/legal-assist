// ────────────────────────────────────────────────────────────
// Health Route — GET /health
// ────────────────────────────────────────────────────────────

import type { FastifyInstance } from 'fastify';
import type { HealthResponse } from '@legal-chatbot/shared';

const startTime = Date.now();

export function registerHealthRoute(app: FastifyInstance) {
  app.get('/health', async (_req, _reply) => {
    const response: HealthResponse = {
      status: 'ok',
      version: '0.1.0',
      uptime: Math.floor((Date.now() - startTime) / 1000),
    };
    return response;
  });
}
