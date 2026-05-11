import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import type { AppEnv } from './config/env.js';
import { registerHealthRoute } from './routes/health.route.js';
import { registerAuthRoute } from './routes/v1/auth.route.js';
import { registerChatRoute } from './routes/v1/chat.route.js';
import { registerConversationsRoute } from './routes/v1/conversations.route.js';
import { registerFeedbackRoute } from './routes/v1/feedback.route.js';
import { registerAuditLogger } from './plugins/audit-logger.js';
import { registerAuthPlugin } from './plugins/auth.js';

interface BuildAppOptions {
  env: AppEnv;
}

function parseAllowedOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export async function buildApp({ env }: BuildAppOptions) {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport:
        env.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
  });

  const allowedOrigins = parseAllowedOrigins(env.CORS_ORIGIN);

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin ${origin} is not allowed by CORS`), false);
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX_REQUESTS,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    keyGenerator: (req) => req.ip,
  });

  await registerAuditLogger(app);
  await registerAuthPlugin(app);

  app.decorate('env', env);

  registerHealthRoute(app);
  registerAuthRoute(app);
  registerChatRoute(app);
  registerConversationsRoute(app);
  registerFeedbackRoute(app);

  return app;
}
