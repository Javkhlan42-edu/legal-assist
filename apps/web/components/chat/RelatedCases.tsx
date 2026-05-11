'use client';

import { useMemo, useState } from 'react';
import type { RelatedCase } from '@legal-chatbot/shared';

interface RelatedCasesProps {
  cases: RelatedCase[];
}

function CourtIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path
        d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M8 14v3M12 14v3M16 14v3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`h-3.5 w-3.5 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ScoreBar({ score }: { score: number }) {
  const percentage = Math.round(score * 100);
  const color = score >= 0.7 ? 'bg-green-500' : score >= 0.5 ? 'bg-amber-500' : 'bg-gray-400';

  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
        <div className={`h-full ${color}`} style={{ width: `${percentage}%` }} />
      </div>
      <span className="text-xs font-medium text-gray-600 dark:text-gray-400">{percentage}%</span>
    </div>
  );
}

export function RelatedCases({ cases }: RelatedCasesProps) {
  const [isOpen, setIsOpen] = useState(false);

  if (!cases || cases.length === 0) {
    return null;
  }

  const preview = useMemo(() => {
    const firstCase = cases[0];
    if (!firstCase) return '';

    const number = firstCase.caseNumber ? `№${firstCase.caseNumber}` : null;
    const title = firstCase.title?.trim();

    return [number, title].filter(Boolean).join(' · ');
  }, [cases]);

  return (
    <section className="space-y-3">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="flex w-full items-start justify-between gap-3 rounded-xl border border-gray-200 bg-white/70 px-3 py-3 text-left transition hover:border-amber-300 hover:bg-amber-50/70 dark:border-gray-700 dark:bg-gray-800/35 dark:hover:border-amber-600/50 dark:hover:bg-amber-900/10"
        aria-expanded={isOpen}
      >
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400">
            <CourtIcon />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                Similar Court Cases
              </h3>
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                {cases.length}
              </span>
            </div>
            {preview && (
              <p className="mt-1 line-clamp-1 text-xs text-gray-500 dark:text-gray-400">
                {preview}
              </p>
            )}
          </div>
        </div>
        <div className="mt-0.5 flex shrink-0 items-center gap-1 text-xs font-medium text-gray-500 dark:text-gray-400">
          <span>{isOpen ? 'Хураах' : 'Дэлгэрүүлэх'}</span>
          <ChevronIcon open={isOpen} />
        </div>
      </button>

      {isOpen && (
        <div className="space-y-2">
          {cases.map((caseItem, idx) => (
            <div
              key={`${caseItem.url}-${idx}`}
              className="group rounded-lg border border-gray-200 bg-gradient-to-br from-amber-50 via-transparent to-transparent p-3 transition hover:border-amber-300 hover:bg-amber-50/50 dark:border-gray-700 dark:from-amber-900/10 dark:via-transparent dark:to-transparent dark:hover:border-amber-600/50 dark:hover:bg-amber-900/20"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {caseItem.caseNumber && (
                      <span className="inline-block shrink-0 rounded-md bg-amber-200 px-2 py-0.5 text-[11px] font-bold text-amber-900 dark:bg-amber-900/50 dark:text-amber-300">
                        №{caseItem.caseNumber}
                      </span>
                    )}
                    {caseItem.decisionType && (
                      <span className="inline-block shrink-0 rounded-md bg-white/80 px-2 py-0.5 text-[11px] font-medium text-gray-600 ring-1 ring-amber-200 dark:bg-gray-800/70 dark:text-gray-300 dark:ring-amber-900/40">
                        {caseItem.decisionType}
                      </span>
                    )}
                  </div>

                  {caseItem.url ? (
                    <a
                      href={caseItem.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-flex items-center gap-1.5 text-sm font-medium text-amber-700 transition hover:text-amber-900 dark:text-amber-400 dark:hover:text-amber-300"
                    >
                      <span className="line-clamp-2 text-left">{caseItem.title}</span>
                      <LinkIcon />
                    </a>
                  ) : (
                    <p className="mt-1 line-clamp-2 text-sm font-medium text-gray-800 dark:text-gray-200">
                      {caseItem.title}
                    </p>
                  )}
                  {caseItem.court && (
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{caseItem.court}</p>
                  )}
                  {caseItem.summary && (
                    <p className="mt-2 line-clamp-3 text-xs leading-5 text-gray-600 dark:text-gray-300">
                      {caseItem.summary}
                    </p>
                  )}
                </div>
              </div>

              <div className="mt-2 flex items-center justify-between">
                <span className="text-[11px] font-medium text-gray-500 dark:text-gray-400">
                  Холбогдол:
                </span>
                <ScoreBar score={caseItem.displayScore ?? caseItem.score} />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
