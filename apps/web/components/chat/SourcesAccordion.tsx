'use client';

import { useState } from 'react';
import type { Source } from '@legal-chatbot/shared';

// ── Icons ──

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-90' : ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CourtIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M8 14v3M12 14v3M16 14v3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DocumentIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
    </svg>
  );
}

// ── Props ──

interface SourcesAccordionProps {
  sources: Source[];
}

// ── Component ──

export function SourcesAccordion({ sources }: SourcesAccordionProps) {
  const [isOpen, setIsOpen] = useState(false);

  if (sources.length === 0) return null;

  const lawCount = sources.filter((s) => s.type !== 'shuukh').length;
  const caseCount = sources.filter((s) => s.type === 'shuukh').length;

  return (
    <div className="mt-3">
      {/* Toggle button */}
      <button
        onClick={() => setIsOpen((prev) => !prev)}
        className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium text-gray-600 transition hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700/50"
      >
        <ChevronIcon open={isOpen} />
        <span>Эх сурвалж</span>
        <span className="inline-flex gap-1">
          {lawCount > 0 && (
            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
              {lawCount} хууль
            </span>
          )}
          {caseCount > 0 && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
              {caseCount} хэрэг
            </span>
          )}
        </span>
      </button>

      {/* Source cards */}
      {isOpen && (
        <div className="mt-2 space-y-1">
          {sources.map((source, i) => (
            <SourceCard key={`${source.url}-${i}`} source={source} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Source Card ──

function SourceCard({ source }: { source: Source }) {
  const isCourt = source.type === 'shuukh';

  return (
    <div className="rounded-lg border border-gray-200 bg-white/50 p-2.5 backdrop-blur-sm transition hover:border-gray-300 hover:bg-white/80 dark:border-gray-700 dark:bg-gray-800/30 dark:hover:border-gray-600 dark:hover:bg-gray-800/50">
      <div className="flex items-start gap-2">
        {/* Type icon */}
        <div
          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-xs ${
            isCourt
              ? 'bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400'
              : 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
          }`}
        >
          {isCourt ? <CourtIcon /> : <DocumentIcon />}
        </div>

        <div className="min-w-0 flex-1">
          {/* Title + type badge */}
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block truncate text-xs font-medium text-gray-900 hover:text-primary-600 dark:text-gray-100 dark:hover:text-primary-400"
              >
                {source.title}
              </a>
            </div>
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold ${
                isCourt
                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                  : 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
              }`}
            >
              {isCourt ? 'Шүүх' : 'Хууль'}
            </span>
          </div>

          {/* Snippet */}
          {source.snippet && (
            <p className="mt-0.5 line-clamp-1 text-[11px] text-gray-500 dark:text-gray-400">
              {source.snippet}
            </p>
          )}

          {/* Meta info */}
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-gray-400 dark:text-gray-500">
            {source.caseId && <span>🔖 {source.caseId}</span>}
            {source.lawId && <span>📋 {source.lawId}</span>}
            {source.articleNo && <span>📄 {source.articleNo}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
