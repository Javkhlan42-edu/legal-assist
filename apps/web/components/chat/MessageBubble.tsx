'use client';

import { useState, useCallback } from 'react';
import { LegalAnswerCard } from './LegalAnswerCard';
import { SuggestedQuestions } from './SuggestedQuestions';
import { SourcesAccordion } from './SourcesAccordion';
import type { UIMessage } from '@/lib/useChat';

interface MessageBubbleProps {
  message: UIMessage;
  isLatest?: boolean;
  onSuggestedQuestionClick?: (question: string) => void;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('mn-MN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function CopyIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="h-3.5 w-3.5 text-green-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BotAvatar() {
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary-500 to-primary-700 shadow-sm">
      <svg className="h-4 w-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
        <path d="M12 3v18M3 7l9-4 9 4M3 7l3 6c.5 1.5 2 3 6 3s5.5-1.5 6-3l3-6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

export function MessageBubble({ message, isLatest, onSuggestedQuestionClick }: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === 'user';

  const copyToClipboard = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* silent */
    }
  }, [message.content]);

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%]">
          <div className="rounded-2xl rounded-tr-sm bg-primary-600 px-4 py-3 text-white shadow-sm">
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{message.content}</p>
          </div>
          <p className="mt-1 text-right text-xs text-gray-400 dark:text-gray-500">
            {formatTime(message.timestamp)}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3">
      <BotAvatar />

      <div className="min-w-0 max-w-[85%]">
        <div className="rounded-2xl rounded-tl-sm bg-white px-5 py-4 shadow-sm ring-1 ring-gray-100 dark:bg-gray-800/80 dark:ring-gray-700/50">
          <LegalAnswerCard
            content={message.content}
            relatedCases={message.relatedCases}
            relatedLaws={message.relatedLaws}
            confidence={message.confidence}
            sourcesUsed={message.sourcesUsed}
            sources={message.sources}
            elapsedMs={message.usage?.latencyMs}
          />

          {isLatest &&
            message.suggestedQuestions &&
            message.suggestedQuestions.length > 0 &&
            onSuggestedQuestionClick && (
              <SuggestedQuestions
                questions={message.suggestedQuestions}
                onQuestionClick={onSuggestedQuestionClick}
              />
            )}
        </div>

        <div className="mt-1.5 flex items-center gap-3">
          <span className="text-xs text-gray-400 dark:text-gray-500">
            {formatTime(message.timestamp)}
          </span>
          <button
            onClick={copyToClipboard}
            className="flex items-center gap-1 text-xs text-gray-400 transition hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
            title="Хуулах"
          >
            {copied ? (
              <>
                <CheckIcon />
                <span>Хуулсан</span>
              </>
            ) : (
              <>
                <CopyIcon />
                <span>Хуулах</span>
              </>
            )}
          </button>
        </div>

        {message.sources && message.sources.length > 0 && (
          <SourcesAccordion sources={message.sources} />
        )}
      </div>
    </div>
  );
}
