import { compare, hash } from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import type { AuthProvider, AuthUser } from '@legal-chatbot/shared';
import type { AppEnv } from '../config/env.js';

const AUTH_ISSUER = 'legal-chatbot-api';
const AUTH_AUDIENCE = 'legal-chatbot-web';
const ACCESS_TOKEN_TTL = '7d';
const encoder = new TextEncoder();

export interface AccessTokenPayload {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
  providers: AuthProvider[];
}

function getSecret(secret: string): Uint8Array {
  return encoder.encode(secret);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeName(name?: string | null): string | null {
  const normalized = name?.trim();
  if (!normalized) {
    return null;
  }

  return normalized.slice(0, 120);
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password, 12);
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return compare(password, passwordHash);
}

export async function signAccessToken(env: AppEnv, user: AuthUser): Promise<string> {
  return new SignJWT({
    email: user.email,
    name: user.fullName,
    picture: user.avatarUrl,
    providers: user.providerHints,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(AUTH_ISSUER)
    .setAudience(AUTH_AUDIENCE)
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_TTL)
    .sign(getSecret(env.JWT_SECRET));
}

export async function verifyAccessToken(
  env: AppEnv,
  token: string,
): Promise<AccessTokenPayload> {
  const { payload } = await jwtVerify(token, getSecret(env.JWT_SECRET), {
    issuer: AUTH_ISSUER,
    audience: AUTH_AUDIENCE,
  });

  return {
    sub: String(payload.sub ?? ''),
    email: String(payload.email ?? ''),
    name: typeof payload.name === 'string' ? payload.name : undefined,
    picture: typeof payload.picture === 'string' ? payload.picture : undefined,
    providers: Array.isArray(payload.providers)
      ? payload.providers.filter(
          (provider): provider is AuthProvider =>
            provider === 'credentials' || provider === 'google',
        )
      : [],
  };
}

export function extractBearerToken(headerValue?: string): string | null {
  if (!headerValue) {
    return null;
  }

  const [scheme, token] = headerValue.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return null;
  }

  return token.trim();
}
