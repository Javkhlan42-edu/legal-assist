/**
 * ChatBackground — premium "light sweep / spotlight" effect.
 *
 * Architecture (4 layers, all CSS-only, zero JS animation):
 *
 *   Layer A — Static gradient base.
 *     Provides the ambient colour. No animation, no paint cost.
 *
 *   Layer B — Noise texture (inline SVG data-URI, repeating 128px tile).
 *     Adds film-grain depth at very low opacity. Static — no cost.
 *
 *   Layer C — Two radial-gradient "light beams" that sweep the viewport.
 *     WHY THIS IS LOW-RESOURCE:
 *     • Each beam is a single <div> with a pre-rasterised radial-gradient
 *       background (drawn once by the browser, cached as a texture).
 *     • Motion is ONLY via `transform: translate()` + `opacity` — both are
 *       compositor-only properties, handled entirely on the GPU, zero
 *       layout/paint per frame.
 *     • No blur filter runs per-frame (blur is baked into the gradient
 *       falloff itself), unlike the old blob approach which animated
 *       blur-filtered elements.
 *     • Different durations (18 s vs 27 s) & diagonals create an organic,
 *       non-repeating pattern, avoiding the "localised pulsing" feel.
 *     • `mix-blend-mode: soft-light` in light mode / `screen` in dark mode
 *       lets the beams interact naturally with the base, adding perceived
 *       depth without oversaturating.
 *
 *   Layer D — Static 48px grid overlay for legal-tech aesthetic.
 *     Drawn with CSS linear-gradient. No animation.
 *
 * Accessibility:
 *   - `prefers-reduced-motion: reduce` → beams freeze (CSS class `.light-beam`).
 *   - `pointer-events: none` + `aria-hidden` → invisible to assistive tech.
 *   - Low opacity values (0.10 – 0.18) → never reduces text contrast.
 */
export function ChatBackground() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden select-none"
    >
      {/* ─── Layer A: static gradient base ─── */}
      <div className="absolute inset-0 bg-gradient-to-br from-slate-50 via-blue-50/40 to-indigo-50/20 dark:from-gray-950 dark:via-[#0a0e1a] dark:to-gray-950" />

      {/* ─── Layer B: noise texture (inline SVG, repeating, static) ─── */}
      <div
        className="absolute inset-0 opacity-[0.018] dark:opacity-[0.035] mix-blend-overlay"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
          backgroundRepeat: 'repeat',
          backgroundSize: '128px 128px',
        }}
      />

      {/* ─── Layer C: two light-sweep beams ─── */}
      {/*
        Beam 1 — sweeps top-left ↘ bottom-right over 18 s.
        The radial-gradient itself has a wide falloff so it feels like a soft
        spotlight, not a hard circle. The gradient is rasterised once;
        only transform + opacity animate per frame (GPU compositing).
      */}
      <div
        className="light-beam absolute inset-0 mix-blend-soft-light dark:mix-blend-screen"
        style={{
          background:
            'radial-gradient(ellipse 70% 50% at 50% 50%, rgba(99,102,241,0.14) 0%, rgba(99,102,241,0) 70%)',
          animationDuration: '18s',
        }}
      />
      {/*
        Beam 2 — sweeps bottom-left ↗ top-right over 27 s (co-prime ratio
        with 18 s → the combined pattern won't visibly repeat for ~54 s).
      */}
      <div
        className="light-beam-reverse absolute inset-0 mix-blend-soft-light dark:mix-blend-screen"
        style={{
          background:
            'radial-gradient(ellipse 60% 45% at 50% 50%, rgba(59,130,246,0.11) 0%, rgba(59,130,246,0) 65%)',
          animationDuration: '27s',
        }}
      />

      {/* ─── Layer D: static grid texture (legal-tech vibe) ─── */}
      <div
        className="absolute inset-0 opacity-[0.025] dark:opacity-[0.04]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(100,116,139,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(100,116,139,0.5) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
        }}
      />

      {/* ─── Top-edge vignette for depth ─── */}
      <div className="absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-white/50 to-transparent dark:from-gray-950/70" />

      {/* ─── Bottom-edge fade so content feels grounded ─── */}
      <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-white/40 to-transparent dark:from-gray-950/60" />
    </div>
  );
}
