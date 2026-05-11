'use client';

import { motion } from 'framer-motion';

const steps = [
  {
    num: '01',
    icon: (
      <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
        <path d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
    title: 'Асуулт тавих',
    desc: 'Хууль зүйн асуултаа монгол хэлээр бичнэ үү.',
  },
  {
    num: '02',
    icon: (
      <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
        <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
    title: 'Хайлт хийх',
    desc: 'Хуулийн мэдээллийн сан, шүүхийн шийдвэрээс холбогдох мэдээллийг олно.',
  },
  {
    num: '03',
    icon: (
      <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
        <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
    title: 'Хариулт авах',
    desc: 'Эх сурвалж, ишлэлтэй нарийвчилсан хариултыг авна.',
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="py-20 lg:py-28">
      <div className="mx-auto max-w-6xl px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-60px' }}
          transition={{ duration: 0.5 }}
          className="mb-14 text-center"
        >
          <p className="mb-2 text-sm font-semibold uppercase tracking-wider text-primary-600 dark:text-primary-400">
            Хэрхэн ажилладаг
          </p>
          <h2 className="text-3xl font-bold text-gray-900 sm:text-4xl dark:text-white">
            Гурван алхам
          </h2>
        </motion.div>

        <div className="grid gap-8 md:grid-cols-3">
          {steps.map((s, i) => (
            <motion.div
              key={s.num}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-40px' }}
              transition={{ duration: 0.5, delay: i * 0.15 }}
              className="group relative rounded-2xl border border-gray-200 bg-white p-8 transition hover:border-primary-200 hover:shadow-lg hover:shadow-primary-500/5 dark:border-gray-800 dark:bg-gray-900 dark:hover:border-primary-800"
            >
              {/* Step number */}
              <span className="absolute right-6 top-6 text-5xl font-bold text-gray-100 dark:text-gray-800/60">
                {s.num}
              </span>

              <div className="relative z-10">
                <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-primary-50 text-primary-600 transition group-hover:bg-primary-100 dark:bg-primary-900/30 dark:text-primary-400 dark:group-hover:bg-primary-900/50">
                  {s.icon}
                </div>
                <h3 className="mb-2 text-lg font-semibold text-gray-900 dark:text-white">{s.title}</h3>
                <p className="text-sm leading-relaxed text-gray-500 dark:text-gray-400">{s.desc}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
