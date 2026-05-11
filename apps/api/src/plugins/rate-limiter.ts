// ────────────────────────────────────────────────────────────
// Rate Limiter Plugin — Applied per-route or globally
// ────────────────────────────────────────────────────────────
// NOTE: Global rate limiting is registered in app.ts via @fastify/rate-limit.
// This file provides stricter per-route limits for sensitive endpoints.

import type { FastifyRequest } from 'fastify';

/**
 * Apply a stricter rate limit to a specific route config.
 * Use this for the /v1/chat endpoint which is more expensive.
 */
export function chatRateLimitConfig() {
  return {
    rateLimit: {
      max: 10,
      timeWindow: '1 minute',
      keyGenerator: (req: FastifyRequest) => req.ip,
    },
  };
}

/**
 * Rate limit config for feedback endpoint (more lenient).
 */
export function feedbackRateLimitConfig() {
  return {
    rateLimit: {
      max: 30,
      timeWindow: '1 minute',
    },
  };
}
