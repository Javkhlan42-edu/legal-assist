'use client';

import Link from 'next/link';

interface HeaderProps {
  title?: string;
  subtitle?: string;
  userLabel?: string;
  onMenuClick?: () => void;
}

export function Header({
  title = 'Хуулийн Туслах',
  subtitle,
  userLabel,
  onMenuClick,
}: HeaderProps) {
  return (
    <header className="relative z-20 flex h-16 shrink-0 items-center gap-3 border-b border-gray-200/60 bg-white/70 px-4 backdrop-blur-xl dark:border-gray-800/60 dark:bg-gray-950/70">
      {onMenuClick && (
        <button
          onClick={onMenuClick}
          className="rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-gray-100/80 md:hidden dark:text-gray-400 dark:hover:bg-gray-800/80"
          aria-label="Open sidebar"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
          </svg>
        </button>
      )}

      <Link
        href="/"
        className="flex min-w-0 items-center gap-3 rounded-lg px-1.5 py-1 transition-colors hover:bg-gray-100/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 dark:hover:bg-gray-800/60"
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary-600 shadow-sm">
          <svg className="h-4 w-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <path d="M12 3v18M3 7l9-4 9 4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold text-gray-800 dark:text-gray-200">{title}</h1>
          {subtitle && (
            <p className="truncate text-xs text-gray-500 dark:text-gray-400">{subtitle}</p>
          )}
        </div>
      </Link>

      <div className="ml-auto hidden items-center gap-2 sm:flex">
        {userLabel && (
          <span className="rounded-full border border-gray-200 bg-white/90 px-3 py-1 text-xs font-medium text-gray-600 shadow-sm dark:border-gray-700 dark:bg-gray-900/80 dark:text-gray-300">
            {userLabel}
          </span>
        )}
      </div>
    </header>
  );
}
