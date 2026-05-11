'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from '@/lib/auth';
import { isDark, setStoredTheme, applyTheme } from '@/lib/storage';

function UserPill({ label }: { label: string }) {
  return (
    <span className="rounded-full border border-gray-200/70 bg-white/80 px-3 py-1 text-xs font-medium text-gray-600 shadow-sm backdrop-blur dark:border-gray-700/70 dark:bg-gray-900/70 dark:text-gray-300">
      {label}
    </span>
  );
}

export function Navbar() {
  const { user, isReady } = useAuth();
  const [scrolled, setScrolled] = useState(false);
  const [dark, setDark] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    setDark(isDark());
    const onScroll = () => setScrolled(window.scrollY > 10);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const toggleDark = useCallback(() => {
    setDark((previous) => {
      const next = !previous;
      setStoredTheme(next ? 'dark' : 'light');
      applyTheme(next);
      return next;
    });
  }, []);

  const accountLabel = user?.fullName || user?.email || 'Workspace';

  return (
    <nav
      className={`fixed inset-x-0 top-0 z-50 transition-all duration-300 ${
        scrolled
          ? 'border-b border-gray-200/60 bg-white/80 shadow-sm backdrop-blur-lg dark:border-gray-800/60 dark:bg-gray-950/80'
          : 'bg-transparent'
      }`}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-600">
            <svg className="h-4 w-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M12 3v18M3 7l9-4 9 4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <span className="text-lg font-semibold text-gray-900 dark:text-white">HuuliX</span>
        </Link>

        <div className="hidden items-center gap-8 md:flex">
          <Link href="/" className="text-sm font-medium text-gray-600 transition hover:text-gray-900 dark:text-gray-400 dark:hover:text-white">
            Нүүр
          </Link>
          <Link href="/chat" className="text-sm font-medium text-gray-600 transition hover:text-gray-900 dark:text-gray-400 dark:hover:text-white">
            Чат
          </Link>
          <a href="#about" className="text-sm font-medium text-gray-600 transition hover:text-gray-900 dark:text-gray-400 dark:hover:text-white">
            Тухай
          </a>
          <button onClick={toggleDark} className="rounded-lg p-2 text-gray-500 transition hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800" aria-label="Toggle dark mode">
            {dark ? (
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" strokeLinecap="round"/></svg>
            ) : (
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
            )}
          </button>

          {isReady && user ? (
            <>
              <UserPill label={accountLabel} />
              <Link
                href="/chat"
                className="rounded-xl bg-primary-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500/40"
              >
                Workspace нээх
              </Link>
            </>
          ) : (
            <>
              <Link
                href="/auth"
                className="text-sm font-medium text-gray-600 transition hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
              >
                Нэвтрэх
              </Link>
              <Link
                href="/auth?mode=signup"
                className="rounded-xl bg-primary-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500/40"
              >
                Бүртгүүлэх
              </Link>
            </>
          )}
        </div>

        <button onClick={() => setMobileOpen(!mobileOpen)} className="rounded-lg p-2 text-gray-600 md:hidden dark:text-gray-300" aria-label="Menu">
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            {mobileOpen ? <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round"/> : <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round"/>}
          </svg>
        </button>
      </div>

      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden border-t border-gray-200 bg-white md:hidden dark:border-gray-800 dark:bg-gray-950"
          >
            <div className="flex flex-col gap-1 p-4">
              <Link href="/" onClick={() => setMobileOpen(false)} className="rounded-lg px-3 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-900">Нүүр</Link>
              <Link href="/chat" onClick={() => setMobileOpen(false)} className="rounded-lg px-3 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-900">Чат</Link>
              <a href="#about" onClick={() => setMobileOpen(false)} className="rounded-lg px-3 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-900">Тухай</a>
              <button onClick={toggleDark} className="rounded-lg px-3 py-2.5 text-left text-sm font-medium text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-900">
                {dark ? 'Цайвар горим' : 'Харанхуй горим'}
              </button>
              {isReady && user ? (
                <>
                  <div className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">{accountLabel}</div>
                  <Link href="/chat" onClick={() => setMobileOpen(false)} className="mt-2 rounded-xl bg-primary-600 px-5 py-2.5 text-center text-sm font-semibold text-white">
                    Workspace нээх
                  </Link>
                </>
              ) : (
                <>
                  <Link href="/auth" onClick={() => setMobileOpen(false)} className="rounded-lg px-3 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-900">Нэвтрэх</Link>
                  <Link href="/auth?mode=signup" onClick={() => setMobileOpen(false)} className="mt-2 rounded-xl bg-primary-600 px-5 py-2.5 text-center text-sm font-semibold text-white">Бүртгүүлэх</Link>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </nav>
  );
}
