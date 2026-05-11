// ────────────────────────────────────────────────────────────
// Conversation Service — CRUD for conversation persistence
// ────────────────────────────────────────────────────────────

import type { Conversation, StoredMessage, Source } from '@legal-chatbot/shared';

/**
 * Interface for conversation persistence.
 */
export interface IConversationService {
  listConversations(): Promise<Conversation[]>;
  getMessages(conversationId: string): Promise<StoredMessage[]>;
  saveMessage(
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
    sources?: Source[],
    latencyMs?: number,
  ): Promise<void>;
}

/**
 * Stub implementation — in-memory storage.
 * Replace with Postgres repository in Step 5.
 */
export class ConversationService implements IConversationService {
  private conversations = new Map<string, Conversation>();
  private messages = new Map<string, StoredMessage[]>();

  async listConversations(): Promise<Conversation[]> {
    return Array.from(this.conversations.values());
  }

  async getMessages(conversationId: string): Promise<StoredMessage[]> {
    return this.messages.get(conversationId) || [];
  }

  async saveMessage(
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
    sources: Source[] = [],
    latencyMs?: number,
  ): Promise<void> {
    // TODO: Replace with Postgres insert in Step 5
    const now = new Date().toISOString();

    if (!this.conversations.has(conversationId)) {
      this.conversations.set(conversationId, {
        id: conversationId,
        title: content.slice(0, 50),
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
      });
      this.messages.set(conversationId, []);
    }

    const msgs = this.messages.get(conversationId)!;
    msgs.push({
      id: `msg_${msgs.length}`,
      conversationId,
      role,
      content,
      sources,
      latencyMs,
      createdAt: now,
    });

    const conv = this.conversations.get(conversationId)!;
    conv.messageCount = msgs.length;
    conv.updatedAt = now;
  }
}

export const conversationService = new ConversationService();
