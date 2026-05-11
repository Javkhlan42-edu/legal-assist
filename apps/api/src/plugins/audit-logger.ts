// ────────────────────────────────────────────────────────────
// Audit Logger Plugin — Log all API requests for compliance
// ────────────────────────────────────────────────────────────

import type { FastifyInstance } from 'fastify';

/**
 * Registers an onResponse hook that logs query details asynchronously.
 * In production, this would write to the audit_logs Postgres table.
 * For MVP, it logs to stdout via pino.
 */
export async function registerAuditLogger(app: FastifyInstance) {
  app.addHook('onResponse', async (request, reply) => {
    // Only audit /v1/ routes
    if (!request.url.startsWith('/v1/')) return;

    const auditEntry = {
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      latencyMs: Math.round(reply.elapsedTime),
      ip: request.ip,
      userAgent: request.headers['user-agent'] || 'unknown',
      timestamp: new Date().toISOString(),
    };

    // TODO: Write to audit_logs table in Postgres (Step 4+)
    request.log.info({ audit: auditEntry }, 'API audit log');
  });
}
