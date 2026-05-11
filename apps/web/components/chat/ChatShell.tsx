'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChatBackground } from '@/components/chat/ChatBackground';
import { Sidebar } from '@/components/chat/Sidebar';
import { Header } from '@/components/chat/Header';
import { MessageList } from '@/components/chat/MessageList';
import { ChatInput } from '@/components/chat/ChatInput';
import { useAuth } from '@/lib/auth';
import { useChat } from '@/lib/useChat';

function LoadingState({ message }: { message: string }) {
  return (
    <div className="relative flex h-screen items-center justify-center overflow-hidden bg-white dark:bg-gray-950">
      <ChatBackground />
      <div className="relative z-10 rounded-3xl border border-white/70 bg-white/80 px-8 py-6 text-sm text-gray-600 shadow-xl backdrop-blur dark:border-gray-800 dark:bg-gray-900/70 dark:text-gray-300">
        {message}
      </div>
    </div>
  );
}

export function ChatShell() {
  const router = useRouter();
  const { user, isReady, logout } = useAuth();
  const chat = useChat();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    if (isReady && !user) {
      router.replace('/auth?redirect=/chat');
    }
  }, [isReady, router, user]);

  const historySubtitle = useMemo(() => {
    if (chat.isHistoryLoading && chat.conversations.length === 0) {
      return 'Түүх ачаалж байна';
    }

    return `${chat.conversations.length} хадгалсан чат`;
  }, [chat.conversations.length, chat.isHistoryLoading]);

  const showHistoryLoader = chat.isHistoryLoading && chat.messages.length === 0;

  if (!isReady) {
    return <LoadingState message="Session шалгаж байна..." />;
  }

  if (!user) {
    return <LoadingState message="Нэвтрэх хуудас руу шилжүүлж байна..." />;
  }

  return (
    <div className="relative flex h-screen overflow-hidden bg-white dark:bg-gray-950">
      <ChatBackground />

      <Sidebar
        conversations={chat.conversations}
        activeId={chat.conversationId}
        user={{
          fullName: user.fullName,
          email: user.email,
          avatarUrl: user.avatarUrl,
        }}
        isHistoryLoading={chat.isHistoryLoading}
        onNewChat={chat.startNewChat}
        onSelect={chat.loadConversation}
        onDeleteConversation={chat.deleteConversation}
        onLogout={() => {
          logout();
          router.replace('/');
        }}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      <div className="relative z-10 flex flex-1 flex-col overflow-hidden">
        <div className="absolute inset-x-0 top-0 z-30 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent dark:via-white/10" />

        <Header
          title="Хуулийн Туслах"
          subtitle={historySubtitle}
          userLabel={user.fullName || user.email}
          onMenuClick={() => setSidebarOpen(true)}
        />

        {showHistoryLoader ? (
          <div className="flex flex-1 items-center justify-center px-6">
            <div className="rounded-3xl border border-gray-200/70 bg-white/80 px-6 py-5 text-sm text-gray-500 shadow-sm backdrop-blur dark:border-gray-800 dark:bg-gray-900/70 dark:text-gray-300">
              Хадгалсан chat history-г ачаалж байна...
            </div>
          </div>
        ) : (
          <MessageList
            messages={chat.messages}
            isLoading={chat.isLoading}
            onExampleClick={chat.sendMessage}
            onSuggestedQuestionClick={chat.sendMessage}
          />
        )}

        {chat.error && (
          <div className="flex items-center gap-2 border-t border-red-200 bg-red-50 px-6 py-2.5 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-400">
            <svg
              className="h-4 w-4 shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4m0 4h.01" strokeLinecap="round" />
            </svg>
            <span className="flex-1 truncate">{chat.error}</span>
            <button
              onClick={chat.retry}
              className="shrink-0 font-medium underline hover:no-underline"
            >
              Дахин оролдох
            </button>
          </div>
        )}

        <ChatInput
          onSend={chat.sendMessage}
          disabled={chat.isLoading || chat.isHistoryLoading}
        />

        <div className="shrink-0 border-t border-gray-200/60 bg-white/60 px-4 py-2 text-center text-[11px] text-gray-400 backdrop-blur-lg dark:border-gray-800/60 dark:bg-gray-950/60 dark:text-gray-500">
          Энэ систем нь зөвхөн мэдээллийн зорилгоор хариулт өгдөг бөгөөд албан ёсны
          хуулийн зөвлөгөө биш юм.
        </div>
      </div>
    </div>
  );
}
