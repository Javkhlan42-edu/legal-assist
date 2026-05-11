'use client';

import { createContext, startTransition, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { AuthUser } from '@legal-chatbot/shared';
import {
  fetchCurrentUser,
  login as loginRequest,
  loginWithGoogle as loginWithGoogleRequest,
  signup as signupRequest,
} from './api';
import {
  clearAuthSession,
  loadAuthSession,
  saveAuthSession,
  type StoredAuthSession,
} from './auth-storage';

interface AuthContextValue {
  user: AuthUser | null;
  accessToken: string | null;
  isReady: boolean;
  isBusy: boolean;
  login: (input: { email: string; password: string }) => Promise<AuthUser>;
  signup: (input: { email: string; password: string; fullName?: string }) => Promise<AuthUser>;
  loginWithGoogle: (credential: string) => Promise<AuthUser>;
  refreshUser: () => Promise<AuthUser | null>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function persistSession(session: StoredAuthSession) {
  saveAuthSession(session);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isBusy, setIsBusy] = useState(false);

  const applySession = useCallback((session: StoredAuthSession) => {
    persistSession(session);
    startTransition(() => {
      setAccessToken(session.accessToken);
      setUser(session.user);
    });
  }, []);

  const clearSession = useCallback(() => {
    clearAuthSession();
    startTransition(() => {
      setAccessToken(null);
      setUser(null);
    });
  }, []);

  const refreshUser = useCallback(async () => {
    const session = loadAuthSession();
    if (!session?.accessToken) {
      clearSession();
      return null;
    }

    try {
      const response = await fetchCurrentUser(session.accessToken);
      applySession({
        accessToken: session.accessToken,
        user: response.user,
      });
      return response.user;
    } catch {
      clearSession();
      return null;
    }
  }, [applySession, clearSession]);

  useEffect(() => {
    let active = true;

    const bootstrap = async () => {
      const session = loadAuthSession();
      if (!session?.accessToken) {
        if (active) {
          setIsReady(true);
        }
        return;
      }

      try {
        const response = await fetchCurrentUser(session.accessToken);
        if (!active) {
          return;
        }

        applySession({
          accessToken: session.accessToken,
          user: response.user,
        });
      } catch {
        if (!active) {
          return;
        }

        clearSession();
      } finally {
        if (active) {
          setIsReady(true);
        }
      }
    };

    void bootstrap();

    return () => {
      active = false;
    };
  }, [applySession, clearSession]);

  const login = useCallback(
    async (input: { email: string; password: string }) => {
      setIsBusy(true);
      try {
        const session = await loginRequest(input);
        applySession(session);
        return session.user;
      } finally {
        setIsBusy(false);
      }
    },
    [applySession],
  );

  const signup = useCallback(
    async (input: { email: string; password: string; fullName?: string }) => {
      setIsBusy(true);
      try {
        const session = await signupRequest(input);
        applySession(session);
        return session.user;
      } finally {
        setIsBusy(false);
      }
    },
    [applySession],
  );

  const loginWithGoogle = useCallback(
    async (credential: string) => {
      setIsBusy(true);
      try {
        const session = await loginWithGoogleRequest({ credential });
        applySession(session);
        return session.user;
      } finally {
        setIsBusy(false);
      }
    },
    [applySession],
  );

  const logout = useCallback(() => {
    clearSession();
  }, [clearSession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      accessToken,
      isReady,
      isBusy,
      login,
      signup,
      loginWithGoogle,
      refreshUser,
      logout,
    }),
    [accessToken, isBusy, isReady, login, loginWithGoogle, logout, refreshUser, signup, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside AuthProvider');
  }

  return context;
}
