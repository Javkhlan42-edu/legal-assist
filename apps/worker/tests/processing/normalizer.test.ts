// ────────────────────────────────────────────────────────────
// Normalizer Tests
// ────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { normalizeText } from '../../src/processing/normalizer.js';

describe('normalizeText', () => {
  it('normalizes Unicode to NFC', () => {
    const decomposed = 'cafe\u0301';
    const normalized = normalizeText(decomposed);

    expect(normalized).toContain('café');
    expect(normalized).toBe(normalized.normalize('NFC'));
  });

  it('collapses extra whitespace while preserving paragraph boundaries', () => {
    const raw = 'Эхний мөр   \n\n\n\n  Дараагийн\tмөр  ';
    const normalized = normalizeText(raw);

    expect(normalized).toBe('Эхний мөр\n\nДараагийн мөр');
  });

  it('removes zero-width and BOM characters', () => {
    const raw = '\ufeffХууль\u200b\u200c\u200d';
    const normalized = normalizeText(raw);

    expect(normalized).toBe('Хууль');
  });

  it('normalizes Mongolian quotation marks', () => {
    const raw = '«Тайлбар»';
    const normalized = normalizeText(raw);

    expect(normalized).toBe('"Тайлбар"');
  });

  it('handles empty string', () => {
    expect(normalizeText('')).toBe('');
  });
});
