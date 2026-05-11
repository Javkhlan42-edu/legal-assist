'use client';

import { motion } from 'framer-motion';

export function TrustDisclaimer() {
  return (
    <section id="about" className="bg-gray-50/80 py-20 lg:py-24 dark:bg-gray-900/50">
      <div className="mx-auto max-w-6xl px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-60px' }}
          transition={{ duration: 0.5 }}
          className="mx-auto max-w-2xl text-center"
        >
          <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-50 dark:bg-amber-900/20">
            <svg className="h-6 w-6 text-amber-600 dark:text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>

          <h2 className="mb-4 text-2xl font-bold text-gray-900 dark:text-white">
            Анхааруулга
          </h2>

          <p className="mb-6 text-sm leading-relaxed text-gray-600 dark:text-gray-400">
            Энэхүү систем нь зөвхөн{' '}
            <strong className="text-gray-800 dark:text-gray-200">мэдээллийн зорилгоор</strong>{' '}
            хариулт өгөх бөгөөд албан ёсны хуулийн зөвлөгөө, шүүхийн шийдвэрийн орлуулагч{' '}
            <strong className="text-gray-800 dark:text-gray-200">биш</strong> юм. Хуулийн нарийвчилсан зөвлөгөө авахыг хүсвэл мэргэжлийн хуульчтай зөвлөлдөнө үү.
          </p>

          <div className="inline-flex flex-wrap justify-center gap-4">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-4 py-2 text-xs font-medium text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
              <svg className="h-3.5 w-3.5 text-blue-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" />
              </svg>
              legalinfo.mn
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-4 py-2 text-xs font-medium text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
              <svg className="h-3.5 w-3.5 text-amber-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M8 14v3M12 14v3M16 14v3" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              shuukh.mn
            </span>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
