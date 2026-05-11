import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { extractBearerToken, verifyAccessToken } from '../lib/auth.js';
import { getUserById } from '../repositories/user.repository.js';

export async function registerAuthPlugin(app: FastifyInstance) {
  app.decorateRequest('authUser', null);

  app.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = extractBearerToken(req.headers.authorization);

    if (!token) {
      reply.status(401).send({
        error: 'UNAUTHORIZED',
        message: 'Authentication token is required.',
      });
      return;
    }

    try {
      const payload = await verifyAccessToken(app.env, token);
      const user = await getUserById(payload.sub);

      if (!user) {
        reply.status(401).send({
          error: 'UNAUTHORIZED',
          message: 'Your session is no longer valid.',
        });
        return;
      }

      req.authUser = user;
    } catch {
      reply.status(401).send({
        error: 'UNAUTHORIZED',
        message: 'Authentication token is invalid or expired.',
      });
    }
  });
}
