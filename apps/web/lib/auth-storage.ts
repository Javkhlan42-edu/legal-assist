import type { AuthUser } from '@legal-chatbot/shared';

const AUTH_STORAGE_KEY = 'legal-chatbot.auth-session';

export interface StoredAuthSession {
  accessToken: string;
  user: AuthUser;
}

export function loadAuthSession(): StoredAuthSession | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as StoredAuthSession;
    if (!parsed?.accessToken || !parsed?.user?.id) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function saveAuthSession(session: StoredAuthSession): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
}

export function clearAuthSession(): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.removeItem(AUTH_STORAGE_KEY);
}

export function getStoredAccessToken(): string | null {
  return loadAuthSession()?.accessToken ?? null;
}
