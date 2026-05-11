'use client';

import { motion } from 'framer-motion';

/**
 * Animated logo illustration for the hero section.
 * Pure SVG + framer-motion — no external animation library needed.
 * Renders a stylised scale-of-justice with floating particles.
 */
export function LogoAnimation() {
  return (
    <div className="relative mx-auto flex h-64 w-64 items-center justify-center sm:h-80 sm:w-80 lg:h-96 lg:w-96">
      {/* Gradient glow */}
      <div className="hero-gradient -top-10 -left-10 h-72 w-72 bg-primary-400" />
      <div className="hero-gradient -bottom-10 -right-10 h-60 w-60 bg-indigo-400" style={{ animationDelay: '4s' }} />

      {/* Main SVG */}
      <motion.svg
        viewBox="0 0 200 200"
        className="relative z-10 h-full w-full drop-shadow-2xl"
        initial={{ opacity: 0, scale: 0.85 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.8, ease: 'easeOut' }}
      >
        {/* Outer ring */}
        <motion.circle
          cx="100" cy="100" r="90"
          fill="none"
          stroke="currentColor"
          strokeWidth={0.5}
          className="text-primary-300 dark:text-primary-700"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 2, ease: 'easeInOut' }}
        />

        {/* Inner gradient disc */}
        <defs>
          <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.15" />
            <stop offset="100%" stopColor="#6366f1" stopOpacity="0.08" />
          </linearGradient>
        </defs>
        <circle cx="100" cy="100" r="80" fill="url(#grad)" />

        {/* Scale post */}
        <motion.line
          x1="100" y1="50" x2="100" y2="155"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          className="text-primary-600 dark:text-primary-400"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 1, delay: 0.3 }}
        />

        {/* Crossbar */}
        <motion.line
          x1="55" y1="75" x2="145" y2="75"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          className="text-primary-600 dark:text-primary-400"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.8, delay: 0.8 }}
        />

        {/* Left pan */}
        <motion.path
          d="M55 75 L45 105 Q55 115 65 105 Z"
          fill="currentColor"
          className="text-primary-500/30 dark:text-primary-400/20"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 1.4 }}
        />

        {/* Right pan */}
        <motion.path
          d="M145 75 L135 105 Q145 115 155 105 Z"
          fill="currentColor"
          className="text-primary-500/30 dark:text-primary-400/20"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 1.6 }}
        />

        {/* Base */}
        <motion.rect
          x="80" y="150" width="40" height="6" rx="3"
          fill="currentColor"
          className="text-primary-600 dark:text-primary-400"
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ duration: 0.5, delay: 1 }}
        />

        {/* Floating particles */}
        {[
          { cx: 35, cy: 45, r: 3, delay: 1.8 },
          { cx: 165, cy: 55, r: 2, delay: 2.2 },
          { cx: 40, cy: 140, r: 2.5, delay: 2.0 },
          { cx: 160, cy: 145, r: 2, delay: 2.4 },
          { cx: 100, cy: 30, r: 2, delay: 1.6 },
        ].map((p, i) => (
          <motion.circle
            key={i}
            cx={p.cx} cy={p.cy} r={p.r}
            fill="currentColor"
            className="text-primary-400/60 dark:text-primary-500/40"
            initial={{ opacity: 0, scale: 0 }}
            animate={{ opacity: [0, 1, 0.6], scale: [0, 1.2, 1] }}
            transition={{ duration: 2, delay: p.delay, repeat: Infinity, repeatType: 'reverse', repeatDelay: 3 }}
          />
        ))}
      </motion.svg>
    </div>
  );
}
