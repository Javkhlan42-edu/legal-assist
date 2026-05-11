// ────────────────────────────────────────────────────────────
// Fastify Type Augmentations
// ────────────────────────────────────────────────────────────

import type { AppEnv } from '../config/env.js';
import type { UserRecord } from '../repositories/user.repository.js';

declare module 'fastify' {
  interface FastifyInstance {
    env: AppEnv;
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyRequest {
    authUser: UserRecord | null;
  }
}
