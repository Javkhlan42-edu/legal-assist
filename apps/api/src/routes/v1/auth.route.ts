import type { FastifyInstance, FastifyReply } from 'fastify';
import { OAuth2Client } from 'google-auth-library';
import type {
  AuthMeResponse,
  AuthSuccessResponse,
  GoogleAuthRequest,
  LoginRequest,
  SignupRequest,
} from '@legal-chatbot/shared';
import { z } from 'zod';
import {
  hashPassword,
  normalizeEmail,
  signAccessToken,
  verifyPassword,
} from '../../lib/auth.js';
import {
  createOrAttachCredentialsIdentity,
  createOrAttachGoogleIdentity,
  getCredentialIdentityByEmail,
  getUserByEmail,
  getUserById,
  recordUserLogin,
} from '../../repositories/user.repository.js';

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  fullName: z.string().trim().min(2).max(120).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
});

const googleSchema = z.object({
  credential: z.string().min(1),
});

function validationError(reply: FastifyReply, message: string) {
  return reply.status(400).send({
    error: 'VALIDATION_ERROR',
    message,
  });
}

export function registerAuthRoute(app: FastifyInstance) {
  const googleClient = app.env.GOOGLE_CLIENT_ID
    ? new OAuth2Client(app.env.GOOGLE_CLIENT_ID)
    : null;

  app.post<{ Body: SignupRequest }>('/v1/auth/signup', async (request, reply) => {
    const parsed = signupSchema.safeParse(request.body);
    if (!parsed.success) {
      return validationError(
        reply,
        parsed.error.errors.map((issue) => issue.message).join('; '),
      );
    }

    const email = normalizeEmail(parsed.data.email);
    const existing = await getUserByEmail(email);
    if (existing?.providerHints.includes('credentials')) {
      return reply.status(409).send({
        error: 'EMAIL_ALREADY_REGISTERED',
        message: 'This email address already has an account.',
      });
    }

    try {
      const passwordHash = await hashPassword(parsed.data.password);
      const user = await createOrAttachCredentialsIdentity({
        email,
        fullName: parsed.data.fullName,
        passwordHash,
      });

      const accessToken = await signAccessToken(app.env, user);
      const response: AuthSuccessResponse = { accessToken, user };
      return reply.status(201).send(response);
    } catch (error) {
      if (error instanceof Error && error.message === 'EMAIL_ALREADY_REGISTERED') {
        return reply.status(409).send({
          error: 'EMAIL_ALREADY_REGISTERED',
          message: 'This email address already has an account.',
        });
      }

      request.log.error({ err: error }, 'Failed to create credentials account');
      return reply.status(500).send({
        error: 'SIGNUP_FAILED',
        message: 'Unable to create account right now.',
      });
    }
  });

  app.post<{ Body: LoginRequest }>('/v1/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return validationError(
        reply,
        parsed.error.errors.map((issue) => issue.message).join('; '),
      );
    }

    const identity = await getCredentialIdentityByEmail(parsed.data.email);
    if (!identity) {
      return reply.status(401).send({
        error: 'INVALID_CREDENTIALS',
        message: 'Email or password is incorrect.',
      });
    }

    const passwordMatches = await verifyPassword(parsed.data.password, identity.passwordHash);
    if (!passwordMatches) {
      return reply.status(401).send({
        error: 'INVALID_CREDENTIALS',
        message: 'Email or password is incorrect.',
      });
    }

    await recordUserLogin(identity.user.id);
    const freshUser = await getUserById(identity.user.id);
    if (!freshUser) {
      return reply.status(500).send({
        error: 'LOGIN_FAILED',
        message: 'Unable to load account profile.',
      });
    }

    const accessToken = await signAccessToken(app.env, freshUser);
    const response: AuthSuccessResponse = { accessToken, user: freshUser };
    return reply.status(200).send(response);
  });

  app.post<{ Body: GoogleAuthRequest }>('/v1/auth/google', async (request, reply) => {
    const parsed = googleSchema.safeParse(request.body);
    if (!parsed.success) {
      return validationError(
        reply,
        parsed.error.errors.map((issue) => issue.message).join('; '),
      );
    }

    if (!googleClient || !app.env.GOOGLE_CLIENT_ID) {
      return reply.status(503).send({
        error: 'GOOGLE_AUTH_DISABLED',
        message: 'Google sign-in is not configured on the server.',
      });
    }

    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: parsed.data.credential,
        audience: app.env.GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();

      if (!payload?.sub || !payload.email || !payload.email_verified) {
        return reply.status(401).send({
          error: 'INVALID_GOOGLE_TOKEN',
          message: 'Google account verification failed.',
        });
      }

      const user = await createOrAttachGoogleIdentity({
        email: payload.email,
        fullName: payload.name,
        avatarUrl: payload.picture,
        providerUserId: payload.sub,
      });

      const accessToken = await signAccessToken(app.env, user);
      const response: AuthSuccessResponse = { accessToken, user };
      return reply.status(200).send(response);
    } catch (error) {
      request.log.error({ err: error }, 'Google login failed');
      return reply.status(401).send({
        error: 'INVALID_GOOGLE_TOKEN',
        message: 'Google account verification failed.',
      });
    }
  });

  app.get('/v1/auth/me', { preHandler: app.authenticate }, async (request, reply) => {
    if (!request.authUser) {
      return reply.status(401).send({
        error: 'UNAUTHORIZED',
        message: 'Authentication required.',
      });
    }

    const response: AuthMeResponse = {
      user: request.authUser,
    };

    return reply.status(200).send(response);
  });
}
