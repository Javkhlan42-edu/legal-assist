// ────────────────────────────────────────────────────────────
// Logger — Structured logging with pino
// ────────────────────────────────────────────────────────────

import pino from 'pino';

/**
 * Create a named child logger.
 */
export function createLogger(name: string) {
  const level = process.env.LOG_LEVEL || 'info';

  return pino({
    name,
    level,
    transport:
      process.env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  });
}
