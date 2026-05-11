'use client';

import type { RelatedLaw } from '@legal-chatbot/shared';

interface RelatedLawsProps {
  laws: RelatedLaw[];
}

function ScaleIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M3 12h18M12 3v18M7 7h10v10H7z" strokeLinecap="round" strokeLinejoin="round" />
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

function ScoreBar({ score }: { score: number }) {
  const percentage = Math.round(score * 100);
  const color = score >= 0.7 ? 'bg-green-500' : score >= 0.5 ? 'bg-blue-500' : 'bg-gray-400';

  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
        <div className={`h-full ${color}`} style={{ width: `${percentage}%` }} />
      </div>
      <span className="text-xs font-medium text-gray-600 dark:text-gray-400">{percentage}%</span>
    </div>
  );
}

export function RelatedLaws({ laws }: RelatedLawsProps) {
  if (!laws || laws.length === 0) {
    return null;
  }

  return (
    <div className="mt-4 border-t border-gray-200 pt-4 dark:border-gray-700">
      {/* Header */}
      <div className="mb-3 flex items-center gap-2">
        <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400">
          <ScaleIcon />
        </div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Холбогдох хуулиуд ({laws.length})
        </h3>
      </div>

      {/* Laws grid */}
      <div className="space-y-2">
        {laws.map((law, idx) => (
          <div
            key={`${law.url}-${idx}`}
            className="group rounded-lg border border-gray-200 bg-gradient-to-br from-blue-50 via-transparent to-transparent p-3 transition hover:border-blue-300 hover:bg-blue-50/50 dark:border-gray-700 dark:from-blue-900/10 dark:via-transparent dark:to-transparent dark:hover:border-blue-600/50 dark:hover:bg-blue-900/20"
          >
            {/* Title + Link */}
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                {law.url ? (
                  <a
                    href={law.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-700 transition hover:text-blue-900 dark:text-blue-400 dark:hover:text-blue-300"
                  >
                    <span className="truncate">{law.title}</span>
                    <LinkIcon />
                  </a>
                ) : (
                  <p className="truncate text-sm font-medium text-gray-800 dark:text-gray-200">
                    {law.title}
                  </p>
                )}

                {/* Articles */}
                {law.articleNo && (
                  <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                    📄 {law.articleNo}
                  </p>
                )}
              </div>
            </div>

            {/* Score */}
            <div className="mt-2 flex items-center justify-between">
              <span className="text-[11px] font-medium text-gray-500 dark:text-gray-400">
                Холбоо:
              </span>
              <ScoreBar score={law.score} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
