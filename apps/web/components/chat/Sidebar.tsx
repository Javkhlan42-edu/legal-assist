'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { isDark, setStoredTheme, applyTheme } from '@/lib/storage';

interface ConversationEntry {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

interface SidebarUser {
  fullName?: string;
  email: string;
  avatarUrl?: string;
}

interface SidebarProps {
  conversations: ConversationEntry[];
  activeId: string | null;
  user: SidebarUser;
  isHistoryLoading: boolean;
  onNewChat: () => void;
  onSelect: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onLogout: () => void;
  open: boolean;
  onClose: () => void;
}

function formatUpdatedAt(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isSameDay = date.toDateString() === now.toDateString();

  if (isSameDay) {
    return date.toLocaleTimeString('mn-MN', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  return date.toLocaleDateString('mn-MN', {
    month: 'short',
    day: 'numeric',
  });
}

function getInitials(name?: string, email?: string): string {
  const source = name?.trim() || email || 'U';
  return source
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}

export function Sidebar({
  conversations,
  activeId,
  user,
  isHistoryLoading,
  onNewChat,
  onSelect,
  onDeleteConversation,
  onLogout,
  open,
  onClose,
}: SidebarProps) {
  const [dark, setDarkState] = useState(false);

  useEffect(() => {
    setDarkState(isDark());
  }, []);

  const toggleDark = useCallback(() => {
    setDarkState((previous) => {
      const next = !previous;
      setStoredTheme(next ? 'dark' : 'light');
      applyTheme(next);
      return next;
    });
  }, []);

  const handleSelect = (id: string) => {
    onSelect(id);
    onClose();
  };

  const handleNewChat = () => {
    onNewChat();
    onClose();
  };

  const sidebarContent = (
    <div className="flex h-full flex-col bg-gray-50/80 backdrop-blur-xl dark:bg-gray-900/80">
      <div className="flex items-center justify-between border-b border-gray-200/60 p-4 dark:border-gray-800/60">
        <Link
          href="/"
          className="flex items-center gap-2 rounded-lg px-1 py-0.5 transition-colors hover:bg-gray-200/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 dark:hover:bg-gray-800/60"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary-600 shadow-sm">
            <svg className="h-4 w-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M12 3v18M3 7l9-4 9 4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div>
            <span className="block text-sm font-semibold text-gray-800 dark:text-gray-200">HuuliX</span>
            <span className="block text-[11px] text-gray-500 dark:text-gray-400">Private workspace</span>
          </div>
        </Link>

        <button
          onClick={onClose}
          className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-200 md:hidden dark:text-gray-400 dark:hover:bg-gray-800"
          aria-label="Close sidebar"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="p-3">
        <button
          onClick={handleNewChat}
          className="flex w-full items-center justify-center gap-2 rounded-2xl border border-gray-300/80 bg-white/90 px-4 py-3 text-sm font-medium text-gray-700 shadow-sm transition-all hover:bg-gray-100/90 hover:shadow-md active:scale-[0.98] dark:border-gray-700/80 dark:bg-gray-800/80 dark:text-gray-200 dark:hover:bg-gray-700/80"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M12 5v14m-7-7h14" strokeLinecap="round" />
          </svg>
          Шинэ чат
        </button>
      </div>

      <div className="px-4 pb-2">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-400 dark:text-gray-500">
            Chat history
          </h2>
          <span className="text-xs text-gray-400 dark:text-gray-500">{conversations.length}</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {isHistoryLoading && conversations.length === 0 && (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <div
                key={index}
                className="rounded-2xl border border-gray-200/80 bg-white/80 px-3 py-3 dark:border-gray-800 dark:bg-gray-800/60"
              >
                <div className="h-3 w-3/4 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
                <div className="mt-2 h-2 w-1/3 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
              </div>
            ))}
          </div>
        )}

        {!isHistoryLoading && conversations.length === 0 && (
          <p className="mt-6 px-2 text-center text-xs text-gray-400 dark:text-gray-500">
            Одоогоор хадгалагдсан чат алга байна.
          </p>
        )}

        <div className="space-y-2">
          {conversations.map((conversation) => (
            <div
              key={conversation.id}
              className={`group rounded-2xl border px-3 py-3 transition-all ${
                conversation.id === activeId
                  ? 'border-primary-200 bg-primary-50/80 shadow-sm dark:border-primary-700/40 dark:bg-primary-900/20'
                  : 'border-gray-200/70 bg-white/80 hover:border-gray-300 hover:bg-white dark:border-gray-800 dark:bg-gray-800/60 dark:hover:border-gray-700'
              }`}
            >
              <div className="flex items-start gap-2">
                <button
                  onClick={() => handleSelect(conversation.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block truncate text-sm font-medium text-gray-700 dark:text-gray-200">
                    {conversation.title}
                  </span>
                  <span className="mt-1 block text-[11px] text-gray-400 dark:text-gray-500">
                    {conversation.messageCount} msgs • {formatUpdatedAt(conversation.updatedAt)}
                  </span>
                </button>

                <button
                  onClick={() => onDeleteConversation(conversation.id)}
                  className="rounded-lg p-1.5 text-gray-400 opacity-0 transition hover:bg-gray-100 hover:text-rose-500 group-hover:opacity-100 dark:hover:bg-gray-700"
                  aria-label="Delete conversation"
                  title="Delete conversation"
                >
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M10 11v6M14 11v6" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="border-t border-gray-200 p-3 dark:border-gray-800">
        <div className="rounded-2xl border border-gray-200/80 bg-white/90 p-3 shadow-sm dark:border-gray-700/70 dark:bg-gray-800/80">
          <div className="flex items-center gap-3">
            {user.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={user.avatarUrl}
                alt={user.fullName || user.email}
                className="h-10 w-10 rounded-2xl object-cover"
              />
            ) : (
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary-100 text-sm font-semibold text-primary-700 dark:bg-primary-900/40 dark:text-primary-300">
                {getInitials(user.fullName, user.email)}
              </div>
            )}
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-gray-800 dark:text-gray-200">
                {user.fullName || 'Legal workspace'}
              </p>
              <p className="truncate text-xs text-gray-500 dark:text-gray-400">{user.email}</p>
            </div>
          </div>

          <div className="mt-3 grid gap-2">
            <button
              onClick={toggleDark}
              className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-gray-600 transition hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700/80"
            >
              {dark ? (
                <>
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <circle cx="12" cy="12" r="5" />
                    <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" strokeLinecap="round" />
                  </svg>
                  Цайвар горим
                </>
              ) : (
                <>
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
                  </svg>
                  Харанхуй горим
                </>
              )}
            </button>

            <button
              onClick={onLogout}
              className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-rose-600 transition hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-950/30"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Гарах
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <>
      <aside className="relative z-20 hidden w-80 shrink-0 border-r border-gray-200/60 md:block dark:border-gray-800/60">
        {sidebarContent}
      </aside>

      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={onClose} />
          <aside className="absolute inset-y-0 left-0 w-80 shadow-xl">{sidebarContent}</aside>
        </div>
      )}
    </>
  );
}
