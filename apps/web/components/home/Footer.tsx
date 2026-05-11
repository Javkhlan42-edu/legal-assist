import Link from 'next/link';

export function Footer() {
  return (
    <footer className="border-t border-gray-200 bg-white py-12 dark:border-gray-800 dark:bg-gray-950">
      <div className="mx-auto max-w-6xl px-6">
        <div className="flex flex-col items-center justify-between gap-6 md:flex-row">
          {/* Logo */}
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-600">
              <svg className="h-4 w-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M12 3v18M3 7l9-4 9 4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <span className="text-lg font-semibold text-gray-900 dark:text-white">HuuliX</span>
          </div>

          {/* Links */}
          <div className="flex gap-8">
            <Link href="/" className="text-sm text-gray-500 transition hover:text-gray-900 dark:text-gray-400 dark:hover:text-white">
              Нүүр
            </Link>
            <Link href="/chat" className="text-sm text-gray-500 transition hover:text-gray-900 dark:text-gray-400 dark:hover:text-white">
              Чат
            </Link>
            <a href="#about" className="text-sm text-gray-500 transition hover:text-gray-900 dark:text-gray-400 dark:hover:text-white">
              Тухай
            </a>
          </div>

          {/* Copyright */}
          <p className="text-xs text-gray-400 dark:text-gray-500">
            © {new Date().getFullYear()} HuuliX. Бакалаврын дипломын ажил.
          </p>
        </div>
      </div>
    </footer>
  );
}
