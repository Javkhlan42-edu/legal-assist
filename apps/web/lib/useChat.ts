'use client';

import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChatMessage,
  ChatUsage,
  Conversation,
  RelatedCase,
  RelatedLaw,
  Source,
  StoredMessage,
} from '@legal-chatbot/shared';
import {
  deleteConversation as deleteConversationRequest,
  fetchConversation,
  fetchConversations,
  streamChatMessage,
} from './api';
import { useAuth } from './auth';

export interface UIMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: Source[];
  relatedCases?: RelatedCase[];
  relatedLaws?: RelatedLaw[];
  confidence?: number;
  sourcesUsed?: number;
  usage?: ChatUsage;
  suggestedQuestions?: string[];
  timestamp: number;
}

export interface ConversationEntry {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

let counter = 0;

function uid(): string {
  counter += 1;
  return `msg_${Date.now()}_${counter}`;
}

function deriveTitle(content: string): string {
  return content.trim().replace(/\s+/g, ' ').slice(0, 60) || 'Шинэ чат';
}

function mapConversation(conversation: Conversation): ConversationEntry {
  return {
    id: conversation.id,
    title: conversation.title?.trim() || 'Шинэ чат',
    createdAt: new Date(conversation.createdAt).getTime(),
    updatedAt: new Date(conversation.updatedAt).getTime(),
    messageCount: conversation.messageCount,
  };
}

function mapStoredMessage(message: StoredMessage): UIMessage {
  return {
    id: message.id || uid(),
    role: message.role,
    content: message.content,
    sources: message.sources,
    relatedCases: message.relatedCases,
    relatedLaws: message.relatedLaws,
    confidence: message.confidence,
    sourcesUsed: message.sourcesUsed,
    usage: message.usage ?? (message.latencyMs ? { latencyMs: message.latencyMs } : undefined),
    suggestedQuestions: message.suggestedQuestions,
    timestamp: new Date(message.createdAt).getTime(),
  };
}

function sortConversations(entries: ConversationEntry[]): ConversationEntry[] {
  return [...entries].sort((left, right) => right.updatedAt - left.updatedAt);
}

export function useChat() {
  const { accessToken, isReady, user } = useAuth();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationEntry[]>([]);

  const messagesRef = useRef(messages);
  const conversationIdRef = useRef<string | null>(conversationId);
  const failedRef = useRef<string | null>(null);
  const accessTokenRef = useRef<string | null>(accessToken);

  messagesRef.current = messages;
  conversationIdRef.current = conversationId;
  accessTokenRef.current = accessToken;

  const refreshConversations = useCallback(async () => {
    const token = accessTokenRef.current;
    if (!token) {
      startTransition(() => {
        setConversations([]);
      });
      return;
    }

    const response = await fetchConversations(50, 0, token);
    startTransition(() => {
      setConversations(sortConversations(response.conversations.map(mapConversation)));
    });
  }, []);

  useEffect(() => {
    if (!isReady) {
      return;
    }

    if (!accessToken || !user) {
      setConversationId(null);
      setMessages([]);
      setConversations([]);
      setError(null);
      failedRef.current = null;
      return;
    }

    let active = true;
    setIsHistoryLoading(true);
    setError(null);

    refreshConversations()
      .catch((reason) => {
        if (!active) {
          return;
        }
        setError(reason instanceof Error ? reason.message : 'Түүх ачаалахад алдаа гарлаа.');
      })
      .finally(() => {
        if (active) {
          setIsHistoryLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [accessToken, isReady, refreshConversations, user]);

  const submitMessage = useCallback(
    async (
      content: string,
      options: {
        history: ChatMessage[];
        appendUserMessage: boolean;
      },
    ) => {
      const trimmed = content.trim();
      const token = accessTokenRef.current;

      if (!trimmed) return;
      if (!token) {
        setError('Нэвтэрч байж чат ашиглана уу.');
        return;
      }

      failedRef.current = null;
      setError(null);
      setIsLoading(true);

      if (options.appendUserMessage) {
        setMessages((current) => [
          ...current,
          {
            id: uid(),
            role: 'user',
            content: trimmed,
            timestamp: Date.now(),
          },
        ]);
      }

      const assistantMessageId = uid();
      const assistantTimestamp = Date.now();

      try {
        const activeConversationId = conversationIdRef.current;
        const requestHistory = activeConversationId ? options.history : [];
        const response = await streamChatMessage(
          {
            conversationId: activeConversationId ?? undefined,
            message: trimmed,
            history: requestHistory,
          },
          {
            onConversation: (nextConversationId) => {
              if (nextConversationId !== conversationIdRef.current) {
                conversationIdRef.current = nextConversationId;
                setConversationId(nextConversationId);
              }
            },
            onRetrieval: (preview) => {
              setMessages((current) => {
                const existing = current.find((message) => message.id === assistantMessageId);
                if (!existing) {
                  return [
                    ...current,
                    {
                      id: assistantMessageId,
                      role: 'assistant',
                      content: '',
                      sources: preview.sources,
                      relatedLaws: preview.relatedLaws,
                      relatedCases: preview.relatedCases,
                      sourcesUsed: preview.sourcesUsed,
                      timestamp: assistantTimestamp,
                    },
                  ];
                }

                return current.map((message) =>
                  message.id === assistantMessageId
                    ? {
                        ...message,
                        sources: preview.sources,
                        relatedLaws: preview.relatedLaws,
                        relatedCases: preview.relatedCases,
                        sourcesUsed: preview.sourcesUsed,
                      }
                    : message,
                );
              });
            },
            onDelta: (delta) => {
              if (!delta) {
                return;
              }

              setMessages((current) => {
                const existing = current.find((message) => message.id === assistantMessageId);
                if (!existing) {
                  return [
                    ...current,
                    {
                      id: assistantMessageId,
                      role: 'assistant',
                      content: delta,
                      timestamp: assistantTimestamp,
                    },
                  ];
                }

                return current.map((message) =>
                  message.id === assistantMessageId
                    ? {
                        ...message,
                        content: `${message.content}${delta}`,
                      }
                    : message,
                );
              });
            },
            onComplete: (response) => {
              if (response.conversationId !== conversationIdRef.current) {
                conversationIdRef.current = response.conversationId;
                setConversationId(response.conversationId);
              }

              const finalAssistantMessage: UIMessage = {
                id: assistantMessageId,
                role: 'assistant',
                content: response.answer,
                sources: response.sources,
                relatedCases: response.relatedCases,
                relatedLaws: response.relatedLaws,
                confidence: response.confidence,
                sourcesUsed: response.sourcesUsed,
                usage: response.usage,
                suggestedQuestions: response.suggestedQuestions,
                timestamp: assistantTimestamp,
              };

              setMessages((current) => {
                const existing = current.some((message) => message.id === assistantMessageId);
                if (!existing) {
                  return [...current, finalAssistantMessage];
                }

                return current.map((message) =>
                  message.id === assistantMessageId ? finalAssistantMessage : message,
                );
              });
            },
          },
          token,
        );

        setConversations((current) => {
          const now = Date.now();
          const nextEntry: ConversationEntry = {
            id: response.conversationId,
            title: deriveTitle(trimmed),
            createdAt: now,
            updatedAt: now,
            messageCount:
              (current.find((item) => item.id === response.conversationId)?.messageCount ?? 0) + 2,
          };

          const filtered = current.filter((item) => item.id !== response.conversationId);
          return sortConversations([nextEntry, ...filtered]);
        });

        void refreshConversations();
      } catch (reason) {
        failedRef.current = trimmed;
        setMessages((current) =>
          current.filter((message) => message.id !== assistantMessageId),
        );
        setError(reason instanceof Error ? reason.message : 'Алдаа гарлаа. Дахин оролдоно уу.');
      } finally {
        setIsLoading(false);
      }
    },
    [refreshConversations],
  );

  const sendMessage = useCallback(
    async (content: string) => {
      const history: ChatMessage[] = messagesRef.current.map((message) => ({
        role: message.role,
        content: message.content,
      }));

      await submitMessage(content, {
        history,
        appendUserMessage: true,
      });
    },
    [submitMessage],
  );

  const retry = useCallback(async () => {
    const content = failedRef.current;
    const token = accessTokenRef.current;

    if (!content || !token) {
      return;
    }

    const history: ChatMessage[] = messagesRef.current.slice(0, -1).map((message) => ({
      role: message.role,
      content: message.content,
    }));

    await submitMessage(content, {
      history,
      appendUserMessage: false,
    });
  }, [submitMessage]);

  const startNewChat = useCallback(() => {
    setConversationId(null);
    conversationIdRef.current = null;
    setMessages([]);
    messagesRef.current = [];
    setError(null);
    setIsLoading(false);
    failedRef.current = null;
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    const token = accessTokenRef.current;
    if (!token) {
      setError('Нэвтэрч байж түүх харах боломжтой.');
      return;
    }

    setIsHistoryLoading(true);
    setError(null);

    try {
      const detail = await fetchConversation(id, token);
      setConversationId(detail.id);
      conversationIdRef.current = detail.id;
      setMessages(detail.messages.map(mapStoredMessage));
      failedRef.current = null;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Түүх ачаалахад алдаа гарлаа.');
    } finally {
      setIsHistoryLoading(false);
    }
  }, []);

  const deleteConversation = useCallback(
    async (id: string) => {
      const token = accessTokenRef.current;
      if (!token) {
        setError('Нэвтэрч байж түүх удирдана.');
        return;
      }

      try {
        await deleteConversationRequest(id, token);
        setConversations((current) => current.filter((conversation) => conversation.id !== id));

        if (conversationIdRef.current === id) {
          startNewChat();
        }
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Чатыг устгах үед алдаа гарлаа.');
      }
    },
    [startNewChat],
  );

  return {
    conversationId,
    messages,
    isLoading,
    isHistoryLoading,
    error,
    conversations,
    sendMessage,
    retry,
    startNewChat,
    loadConversation,
    deleteConversation,
    refreshConversations,
  };
}
