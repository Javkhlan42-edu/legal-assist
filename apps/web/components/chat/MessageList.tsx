'use client';

import { useRef, useEffect } from 'react';
import { MessageBubble } from './MessageBubble';
import type { UIMessage } from '@/lib/useChat';

// ── Example questions for the empty state ──

const EXAMPLE_QUESTIONS: string[] = [
  'зам тээврийн ослын талаар төстэй шүүхийн шийдвэр байна уу',
  'даатгалын маргаанд шүүх ямар практик баримталж байна вэ',
  'хулгайн хэрэг дээр ижил төстэй анхан шатны тогтоол санал болго',
];

// ── Props ──

interface MessageListProps {
  messages: UIMessage[];
  isLoading: boolean;
  onExampleClick: (question: string) => void;
  onSuggestedQuestionClick?: (question: string) => void;
}

// ── Component ──

export function MessageList({ messages, isLoading, onExampleClick, onSuggestedQuestionClick }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const latestMessage = messages[messages.length - 1];
  const shouldShowTypingIndicator =
    isLoading && !(latestMessage?.role === 'assistant' && latestMessage.content.trim().length > 0);

  // Auto-scroll on new messages or loading change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  // ── Empty state ──
  if (messages.length === 0 && !isLoading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6">
        {/* Icon */}
        <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary-50 dark:bg-primary-900/30">
          <svg
            className="h-8 w-8 text-primary-600 dark:text-primary-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              d="M12 3v18M3 7l9-4 9 4M3 7l3 6c.5 1.5 2 3 6 3s5.5-1.5 6-3l3-6M6 13c0 2 2.69 3 6 3s6-1 6-3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        <h2 className="mb-2 text-xl font-semibold text-gray-900 dark:text-white">
          Хууль ба шүүхийн практик
        </h2>

        <p className="mb-8 max-w-md text-center text-sm text-gray-500 dark:text-gray-400">
          Монголын хууль тогтоомж дээр тулгуурлаж, төстэй шүүхийн кейсүүдийг хамт санал болгоно.
        </p>

        {/* Example questions */}
        <div className="flex w-full max-w-lg flex-col gap-2">
          {EXAMPLE_QUESTIONS.map((q) => (
            <button
              key={q}
              onClick={() => onExampleClick(q)}
              className="rounded-xl border border-gray-200 px-4 py-3 text-left text-sm text-gray-700 transition hover:border-primary-300 hover:bg-primary-50 dark:border-gray-700 dark:text-gray-300 dark:hover:border-primary-600 dark:hover:bg-primary-900/20"
            >
              {q}
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ── Message list ──
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
        {messages.map((msg, idx) => {
          const isLatestAssistant =
            msg.role === 'assistant' &&
            !isLoading &&
            idx === messages.length - 1;
          return (
            <MessageBubble
              key={msg.id}
              message={msg}
              isLatest={isLatestAssistant}
              onSuggestedQuestionClick={onSuggestedQuestionClick}
            />
          );
        })}

        {/* Typing indicator */}
        {shouldShowTypingIndicator && (
          <div className="flex items-start gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800">
              <svg
                className="h-4 w-4 text-primary-600 dark:text-primary-400"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
              </svg>
            </div>
            <div className="rounded-2xl rounded-tl-sm bg-gray-100 px-4 py-3 dark:bg-gray-800">
              <div className="flex gap-1.5">
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
              </div>
            </div>
          </div>
        )}

        {/* Scroll anchor */}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
