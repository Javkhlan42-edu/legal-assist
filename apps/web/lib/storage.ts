const THEME_KEY = 'theme';

export function getStoredTheme(): 'dark' | 'light' | null {
  if (typeof window === 'undefined') return null;
  const val = localStorage.getItem(THEME_KEY);
  if (val === 'dark' || val === 'light') return val;
  return null;
}

export function setStoredTheme(theme: 'dark' | 'light'): void {
  localStorage.setItem(THEME_KEY, theme);
}

export function applyTheme(dark: boolean): void {
  document.documentElement.classList.toggle('dark', dark);
}

export function getSystemPrefersDark(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function isDark(): boolean {
  const stored = getStoredTheme();
  if (stored) return stored === 'dark';
  return getSystemPrefersDark();
}
