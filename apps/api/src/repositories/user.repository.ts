import type { AuthProvider, AuthUser } from '@legal-chatbot/shared';
import { dbQuery, dbTransaction } from '../lib/db.js';
import { normalizeEmail, normalizeName } from '../lib/auth.js';

interface UserRow {
  id: string;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  providers: string[] | null;
}

interface CredentialIdentityRow extends UserRow {
  identityId: string;
  passwordHash: string | null;
}

export interface UserRecord extends AuthUser {}

export interface CredentialIdentityRecord {
  identityId: string;
  passwordHash: string;
  user: UserRecord;
}

function mapProviders(value: string[] | null | undefined): AuthProvider[] {
  return (value ?? []).filter(
    (provider): provider is AuthProvider => provider === 'credentials' || provider === 'google',
  );
}

function mapUserRow(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName ?? undefined,
    avatarUrl: row.avatarUrl ?? undefined,
    providerHints: mapProviders(row.providers),
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt ?? undefined,
  };
}

async function getUserByWhereClause(whereClause: string, values: Array<string | null>) {
  const rows = await dbQuery<UserRow>(
    `
      SELECT
        u.id,
        u.email,
        u.full_name AS "fullName",
        u.avatar_url AS "avatarUrl",
        u.created_at AS "createdAt",
        u.last_login_at AS "lastLoginAt",
        COALESCE(
          array_agg(DISTINCT ai.provider) FILTER (WHERE ai.provider IS NOT NULL),
          ARRAY[]::text[]
        ) AS providers
      FROM users u
      LEFT JOIN auth_identities ai ON ai.user_id = u.id
      WHERE ${whereClause}
      GROUP BY u.id
      LIMIT 1
    `,
    values,
  );

  return rows[0] ? mapUserRow(rows[0]) : null;
}

export async function getUserById(userId: string): Promise<UserRecord | null> {
  return getUserByWhereClause('u.id = $1 AND u.status = \'active\'', [userId]);
}

export async function getUserByEmail(email: string): Promise<UserRecord | null> {
  return getUserByWhereClause('LOWER(u.email) = LOWER($1) AND u.status = \'active\'', [email]);
}

export async function getCredentialIdentityByEmail(
  email: string,
): Promise<CredentialIdentityRecord | null> {
  const rows = await dbQuery<CredentialIdentityRow>(
    `
      SELECT
        u.id,
        u.email,
        u.full_name AS "fullName",
        u.avatar_url AS "avatarUrl",
        u.created_at AS "createdAt",
        u.last_login_at AS "lastLoginAt",
        ARRAY['credentials']::text[] AS providers,
        ai.id AS "identityId",
        ai.password_hash AS "passwordHash"
      FROM users u
      JOIN auth_identities ai
        ON ai.user_id = u.id
       AND ai.provider = 'credentials'
      WHERE LOWER(u.email) = LOWER($1)
        AND u.status = 'active'
      LIMIT 1
    `,
    [email],
  );

  const row = rows[0];
  if (!row?.passwordHash) {
    return null;
  }

  return {
    identityId: row.identityId,
    passwordHash: row.passwordHash,
    user: mapUserRow(row),
  };
}

export async function createOrAttachCredentialsIdentity(input: {
  email: string;
  fullName?: string;
  passwordHash: string;
}): Promise<UserRecord> {
  const email = normalizeEmail(input.email);
  const fullName = normalizeName(input.fullName);

  const userId = await dbTransaction(async (query) => {
    const existingCredentialRows = (await query(
      `
        SELECT u.id
        FROM users u
        JOIN auth_identities ai
          ON ai.user_id = u.id
         AND ai.provider = 'credentials'
        WHERE LOWER(u.email) = LOWER($1)
        LIMIT 1
      `,
      [email],
    )) as Array<{ id: string }>;

    if (existingCredentialRows[0]?.id) {
      throw new Error('EMAIL_ALREADY_REGISTERED');
    }

    const existingUserRows = (await query(
      `
        SELECT id
        FROM users
        WHERE LOWER(email) = LOWER($1)
        LIMIT 1
      `,
      [email],
    )) as Array<{ id: string }>;

    let resolvedUserId = existingUserRows[0]?.id;

    if (!resolvedUserId) {
      const insertedUsers = (await query(
        `
          INSERT INTO users (email, full_name, last_login_at)
          VALUES ($1, $2, NOW())
          RETURNING id
        `,
        [email, fullName],
      )) as Array<{ id: string }>;

      resolvedUserId = insertedUsers[0]?.id;
    } else {
      await query(
        `
          UPDATE users
          SET
            full_name = COALESCE($2, full_name),
            last_login_at = NOW(),
            updated_at = NOW()
          WHERE id = $1
        `,
        [resolvedUserId, fullName],
      );
    }

    await query(
      `
        INSERT INTO auth_identities (user_id, provider, provider_user_id, password_hash)
        VALUES ($1, 'credentials', $2, $3)
      `,
      [resolvedUserId, email, input.passwordHash],
    );

    return resolvedUserId;
  });

  const user = await getUserById(userId);
  if (!user) {
    throw new Error('USER_NOT_FOUND_AFTER_CREATE');
  }

  return user;
}

export async function createOrAttachGoogleIdentity(input: {
  email: string;
  fullName?: string | null;
  avatarUrl?: string | null;
  providerUserId: string;
}): Promise<UserRecord> {
  const email = normalizeEmail(input.email);
  const fullName = normalizeName(input.fullName);
  const avatarUrl = input.avatarUrl?.trim() || null;

  const userId = await dbTransaction(async (query) => {
    const existingIdentityRows = (await query(
      `
        SELECT user_id AS "userId"
        FROM auth_identities
        WHERE provider = 'google'
          AND provider_user_id = $1
        LIMIT 1
      `,
      [input.providerUserId],
    )) as Array<{ userId: string }>;

    let resolvedUserId = existingIdentityRows[0]?.userId;

    if (!resolvedUserId) {
      const existingUserRows = (await query(
        `
          SELECT id
          FROM users
          WHERE LOWER(email) = LOWER($1)
          LIMIT 1
        `,
        [email],
      )) as Array<{ id: string }>;

      resolvedUserId = existingUserRows[0]?.id;

      if (!resolvedUserId) {
        const insertedUsers = (await query(
          `
            INSERT INTO users (email, full_name, avatar_url, last_login_at)
            VALUES ($1, $2, $3, NOW())
            RETURNING id
          `,
          [email, fullName, avatarUrl],
        )) as Array<{ id: string }>;

        resolvedUserId = insertedUsers[0]?.id;
      } else {
        await query(
          `
            UPDATE users
            SET
              full_name = COALESCE($2, full_name),
              avatar_url = COALESCE($3, avatar_url),
              last_login_at = NOW(),
              updated_at = NOW()
            WHERE id = $1
          `,
          [resolvedUserId, fullName, avatarUrl],
        );
      }

      await query(
        `
          INSERT INTO auth_identities (user_id, provider, provider_user_id)
          VALUES ($1, 'google', $2)
        `,
        [resolvedUserId, input.providerUserId],
      );
    } else {
      await query(
        `
          UPDATE users
          SET
            full_name = COALESCE($2, full_name),
            avatar_url = COALESCE($3, avatar_url),
            last_login_at = NOW(),
            updated_at = NOW()
          WHERE id = $1
        `,
        [resolvedUserId, fullName, avatarUrl],
      );
    }

    return resolvedUserId;
  });

  const user = await getUserById(userId);
  if (!user) {
    throw new Error('USER_NOT_FOUND_AFTER_GOOGLE_LOGIN');
  }

  return user;
}

export async function recordUserLogin(userId: string): Promise<void> {
  await dbQuery(
    `
      UPDATE users
      SET
        last_login_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
    `,
    [userId],
  );
}
