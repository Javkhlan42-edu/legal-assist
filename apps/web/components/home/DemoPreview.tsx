'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';

const mockMessages = [
  { role: 'user' as const, text: 'Хөдөлмөрийн гэрээг цуцлах журам юу вэ?' },
  {
    role: 'assistant' as const,
    text: 'Хөдөлмөрийн тухай хуулийн 40-р зүйлд зааснаар ажил олгогч дараах тохиолдолд хөдөлмөрийн гэрээг цуцалж болно:\n\n1. Байгууллага татан буугдсан\n2. Орон тоо хасагдсан\n3. Ажилтан мэргэжлийн шаардлага хангаагүй...',
    sources: ['Хөдөлмөрийн тухай хууль — 40-р зүйл', 'Шүүхийн шийдвэр #2024-0421'],
  },
];

export function DemoPreview() {
  return (
    <section className="py-20 lg:py-28">
      <div className="mx-auto max-w-6xl px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-60px' }}
          transition={{ duration: 0.5 }}
          className="mb-14 text-center"
        >
          <p className="mb-2 text-sm font-semibold uppercase tracking-wider text-primary-600 dark:text-primary-400">
            Жишээ
          </p>
          <h2 className="text-3xl font-bold text-gray-900 sm:text-4xl dark:text-white">
            Хэрхэн харагддаг вэ?
          </h2>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-40px' }}
          transition={{ duration: 0.6 }}
          className="mx-auto max-w-2xl overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-xl shadow-gray-200/50 dark:border-gray-800 dark:bg-gray-900 dark:shadow-none"
        >
          {/* Mock header */}
          <div className="flex items-center gap-2 border-b border-gray-100 px-5 py-3 dark:border-gray-800">
            <div className="h-3 w-3 rounded-full bg-red-400" />
            <div className="h-3 w-3 rounded-full bg-yellow-400" />
            <div className="h-3 w-3 rounded-full bg-green-400" />
            <span className="ml-3 text-xs text-gray-400">LegalRAG Chat</span>
          </div>

          {/* Messages */}
          <div className="space-y-4 p-5">
            {mockMessages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                    m.role === 'user'
                      ? 'rounded-tr-sm bg-primary-600 text-white'
                      : 'rounded-tl-sm bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200'
                  }`}
                >
                  <p className="whitespace-pre-line">{m.text}</p>
                  {'sources' in m && m.sources && (
                    <div className="mt-3 space-y-1 border-t border-gray-200/50 pt-2 dark:border-gray-700">
                      <p className="text-[11px] font-medium text-gray-500 dark:text-gray-400">Эх сурвалж:</p>
                      {m.sources.map((s, j) => (
                        <p key={j} className="text-[11px] text-primary-600 dark:text-primary-400">📄 {s}</p>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Mock input */}
          <div className="border-t border-gray-100 p-4 dark:border-gray-800">
            <div className="flex items-center gap-3">
              <div className="flex-1 rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-400 dark:border-gray-700 dark:bg-gray-800">
                Хуулийн асуултаа бичнэ үү...
              </div>
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-600 text-white">
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
            </div>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.3 }}
          className="mt-8 text-center"
        >
          <Link
            href="/chat"
            className="inline-flex items-center gap-2 rounded-xl bg-primary-600 px-7 py-3.5 text-sm font-semibold text-white shadow-lg shadow-primary-500/25 transition hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500/40"
          >
            Одоо туршах
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M5 12h14M12 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </Link>
        </motion.div>
      </div>
    </section>
  );
}
