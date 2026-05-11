import { randomUUID } from 'node:crypto';
import type { ChatMessage } from '@legal-chatbot/shared';
import { dbQuery } from '../lib/db.js';

export interface ConversationRecord {
  id: string;
  userId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

export async function listConversationsForUser(
  userId: string,
  limit: number = 50,
  offset: number = 0,
): Promise<{ conversations: ConversationRecord[]; total: number }> {
  const [totalRow] = await dbQuery<{ total: number }>(
    `
      SELECT COUNT(*)::int AS total
      FROM conversations
      WHERE user_id = $1
    `,
    [userId],
  );

  const conversations = await dbQuery<ConversationRecord>(
    `
      SELECT
        c.id,
        c.user_id AS "userId",
        c.title,
        c.created_at AS "createdAt",
        c.updated_at AS "updatedAt",
        COALESCE(COUNT(m.id), 0)::int AS "messageCount"
      FROM conversations c
      LEFT JOIN messages m ON m.conversation_id = c.id
      WHERE c.user_id = $1
      GROUP BY c.id
      ORDER BY c.updated_at DESC
      LIMIT $2
      OFFSET $3
    `,
    [userId, limit, offset],
  );

  return {
    conversations,
    total: totalRow?.total ?? 0,
  };
}

export async function getConversationById(
  conversationId: string,
): Promise<ConversationRecord | null> {
  const rows = await dbQuery<ConversationRecord>(
    `
      SELECT
        c.id,
        c.user_id AS "userId",
        c.title,
        c.created_at AS "createdAt",
        c.updated_at AS "updatedAt",
        COALESCE(COUNT(m.id), 0)::int AS "messageCount"
      FROM conversations c
      LEFT JOIN messages m ON m.conversation_id = c.id
      WHERE c.id = $1
      GROUP BY c.id
      LIMIT 1
    `,
    [conversationId],
  );

  return rows[0] ?? null;
}

export async function getConversationForUser(
  conversationId: string,
  userId: string,
): Promise<{ conversation: ConversationRecord | null; messages: MessageRecord[] }> {
  const conversationRows = await dbQuery<ConversationRecord>(
    `
      SELECT
        c.id,
        c.user_id AS "userId",
        c.title,
        c.created_at AS "createdAt",
        c.updated_at AS "updatedAt",
        COALESCE(COUNT(m.id), 0)::int AS "messageCount"
      FROM conversations c
      LEFT JOIN messages m ON m.conversation_id = c.id
      WHERE c.id = $1
        AND c.user_id = $2
      GROUP BY c.id
      LIMIT 1
    `,
    [conversationId, userId],
  );

  if (!conversationRows[0]) {
    return {
      conversation: null,
      messages: [],
    };
  }

  const messages = await dbQuery<MessageRecord>(
    `
      SELECT
        id,
        conversation_id AS "conversationId",
        role,
        content,
        metadata,
        created_at AS "createdAt"
      FROM messages
      WHERE conversation_id = $1
      ORDER BY created_at ASC
    `,
    [conversationId],
  );

  return {
    conversation: conversationRows[0],
    messages,
  };
}

export async function createConversation(
  id: string,
  userId: string,
  title: string,
): Promise<ConversationRecord> {
  const now = new Date().toISOString();
  const rows = await dbQuery<ConversationRecord>(
    `
      INSERT INTO conversations (id, user_id, title, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING
        id,
        user_id AS "userId",
        title,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        0::int AS "messageCount"
    `,
    [id, userId, title, now, now],
  );

  return rows[0];
}

export async function addMessage(
  conversationId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  metadata?: Record<string, unknown>,
): Promise<MessageRecord> {
  const now = new Date().toISOString();
  const id = randomUUID();

  const rows = await dbQuery<MessageRecord>(
    `
      INSERT INTO messages (id, conversation_id, role, content, metadata, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING
        id,
        conversation_id AS "conversationId",
        role,
        content,
        metadata,
        created_at AS "createdAt"
    `,
    [id, conversationId, role, content, metadata ? JSON.stringify(metadata) : null, now],
  );

  await dbQuery(
    `
      UPDATE conversations
      SET updated_at = $1
      WHERE id = $2
    `,
    [now, conversationId],
  );

  return rows[0];
}

export async function getConversationMessagesForUser(
  conversationId: string,
  userId: string,
): Promise<ChatMessage[]> {
  const rows = await dbQuery<{ role: 'user' | 'assistant'; content: string }>(
    `
      SELECT m.role, m.content
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.conversation_id = $1
        AND c.user_id = $2
        AND m.role IN ('user', 'assistant')
      ORDER BY m.created_at ASC
    `,
    [conversationId, userId],
  );

  return rows.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

export async function deleteConversationForUser(
  conversationId: string,
  userId: string,
): Promise<boolean> {
  const rows = await dbQuery<{ id: string }>(
    `
      DELETE FROM conversations
      WHERE id = $1
        AND user_id = $2
      RETURNING id
    `,
    [conversationId, userId],
  );

  return rows.length > 0;
}
