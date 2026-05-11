'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { LogoAnimation } from './LogoAnimation';

const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, delay: i * 0.12, ease: 'easeOut' },
  }),
};

export function Hero() {
  return (
    <section className="relative overflow-hidden pt-28 pb-20 lg:pt-36 lg:pb-28">
      {/* Background decorations */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="hero-gradient left-1/4 top-20 h-96 w-96 bg-primary-400" />
        <div className="hero-gradient right-1/4 bottom-10 h-80 w-80 bg-indigo-400" style={{ animationDelay: '4s' }} />
      </div>

      <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 lg:grid-cols-2 lg:gap-16">
        {/* Text column */}
        <div>
          <motion.div
            initial="hidden"
            animate="visible"
            className="max-w-xl"
          >
            <motion.div variants={fadeUp} custom={0} className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary-200 bg-primary-50 px-3.5 py-1.5 text-xs font-medium text-primary-700 dark:border-primary-800 dark:bg-primary-900/30 dark:text-primary-300">
              <span className="h-1.5 w-1.5 rounded-full bg-primary-500" />
              AI хууль зүйн туслах
            </motion.div>

            <motion.h1 variants={fadeUp} custom={1} className="mb-5 text-4xl font-bold leading-tight tracking-tight text-gray-900 sm:text-5xl lg:text-6xl dark:text-white">
              Монгол хуулийг{' '}
              <span className="bg-gradient-to-r from-primary-600 to-indigo-600 bg-clip-text text-transparent dark:from-primary-400 dark:to-indigo-400">
                ухаалгаар
              </span>{' '}
              ойлгох
            </motion.h1>

            <motion.p variants={fadeUp} custom={2} className="mb-8 text-lg leading-relaxed text-gray-600 dark:text-gray-400">
              Албан ёсны хууль тогтоомж, шүүхийн шийдвэрт суурилсан AI туслах. Асуултаа тавиад, эх сурвалжтай хариултыг авна уу.
            </motion.p>

            <motion.div variants={fadeUp} custom={3} className="flex flex-wrap gap-4">
              <Link
                href="/chat"
                className="inline-flex items-center gap-2 rounded-xl bg-primary-600 px-7 py-3.5 text-sm font-semibold text-white shadow-lg shadow-primary-500/25 transition hover:bg-primary-700 hover:shadow-primary-500/40 focus:outline-none focus:ring-2 focus:ring-primary-500/40"
              >
                Чат эхлүүлэх
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path d="M5 12h14M12 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </Link>
              <a
                href="#how-it-works"
                className="inline-flex items-center gap-2 rounded-xl border border-gray-300 px-7 py-3.5 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-300/40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900"
              >
                Хэрхэн ажилладаг вэ
              </a>
            </motion.div>
          </motion.div>
        </div>

        {/* Animation column */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 1, delay: 0.3 }}
          className="hidden lg:block"
        >
          <LogoAnimation />
        </motion.div>
      </div>
    </section>
  );
}
