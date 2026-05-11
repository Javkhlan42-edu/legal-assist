'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';

type AuthMode = 'login' | 'signup';

function sanitizeRedirect(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) {
    return '/chat';
  }

  return value;
}

function GoogleSignInButton({
  disabled,
  onCredential,
}: {
  disabled: boolean;
  onCredential: (credential: string) => Promise<void>;
}) {
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? '';
  const buttonRef = useRef<HTMLDivElement | null>(null);
  const callbackRef = useRef(onCredential);

  useEffect(() => {
    callbackRef.current = onCredential;
  }, [onCredential]);

  useEffect(() => {
    if (!clientId || !buttonRef.current || disabled) {
      return;
    }

    let cancelled = false;
    let initialized = false;

    const renderButton = () => {
      if (cancelled || initialized || !buttonRef.current || !window.google?.accounts?.id) {
        return false;
      }

      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: (response) => {
          if (response.credential) {
            void callbackRef.current(response.credential);
          }
        },
      });

      buttonRef.current.innerHTML = '';
      window.google.accounts.id.renderButton(buttonRef.current, {
        theme: 'outline',
        size: 'large',
        text: 'continue_with',
        shape: 'pill',
        width: 360,
      });

      initialized = true;
      return true;
    };

    if (renderButton()) {
      return;
    }

    const intervalId = window.setInterval(() => {
      if (renderButton()) {
        window.clearInterval(intervalId);
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [clientId, disabled]);

  if (!clientId) {
    return (
      <div className="rounded-2xl border border-dashed border-gray-300 bg-gray-50 px-4 py-3 text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-400">
        Сайн байна уу? Манай системд тавтай морилно уу!
      </div>
    );
  }

  return <div ref={buttonRef} className={disabled ? 'pointer-events-none opacity-60' : ''} />;
}

export function AuthPageShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = sanitizeRedirect(searchParams.get('redirect'));
  const requestedMode = searchParams.get('mode') === 'signup' ? 'signup' : 'login';
  const { isReady, isBusy, user, login, signup, loginWithGoogle } = useAuth();
  const [mode, setMode] = useState<AuthMode>(requestedMode);
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (isReady && user) {
      router.replace(redirectTo);
    }
  }, [isReady, redirectTo, router, user]);

  useEffect(() => {
    setMode(requestedMode);
  }, [requestedMode]);

  const handleSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setError(null);
      setSubmitting(true);

      try {
        if (mode === 'signup') {
          await signup({
            fullName,
            email,
            password,
          });
        } else {
          await login({
            email,
            password,
          });
        }

        router.replace(redirectTo);
      } catch (reason) {
        const message =
          reason instanceof ApiError
            ? reason.errorBody.message
            : 'Нэвтрэх үед алдаа гарлаа. Дахин оролдоно уу.';
        setError(message);
      } finally {
        setSubmitting(false);
      }
    },
    [email, fullName, login, mode, password, redirectTo, router, signup],
  );

  const handleGoogleCredential = useCallback(
    async (credential: string) => {
      setError(null);
      setSubmitting(true);

      try {
        await loginWithGoogle(credential);
        router.replace(redirectTo);
      } catch (reason) {
        const message =
          reason instanceof ApiError
            ? reason.errorBody.message
            : 'Google нэвтрэлт амжилтгүй боллоо.';
        setError(message);
      } finally {
        setSubmitting(false);
      }
    },
    [loginWithGoogle, redirectTo, router],
  );

  if (!isReady) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top_left,_rgba(13,148,136,0.16),_transparent_30%),linear-gradient(180deg,_#f7fbff_0%,_#eef4ff_100%)] px-6 dark:bg-gray-950">
        <div className="rounded-3xl border border-white/70 bg-white/80 px-8 py-6 text-sm text-gray-600 shadow-xl backdrop-blur dark:border-gray-800 dark:bg-gray-900/70 dark:text-gray-300">
          Session шалгаж байна...
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(13,148,136,0.16),_transparent_30%),radial-gradient(circle_at_bottom_right,_rgba(59,130,246,0.12),_transparent_28%),linear-gradient(180deg,_#f7fbff_0%,_#eef4ff_100%)] px-6 py-10 dark:bg-[linear-gradient(180deg,_#020617_0%,_#0f172a_55%,_#111827_100%)]">
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-6xl items-center">
        <div className="grid w-full gap-8 lg:grid-cols-[1.05fr_0.95fr]">
          <section className="flex flex-col justify-between rounded-[2rem] border border-white/70 bg-slate-950 px-8 py-10 text-white shadow-2xl shadow-slate-900/20">
            <div>
              <Link
                href="/"
                className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-slate-100 transition hover:bg-white/15"
              >
                HuuliX
              </Link>
              <h1 className="mt-6 max-w-xl text-4xl font-semibold leading-tight sm:text-5xl">
                Хувийн орчинтой, аюулгүй нэвтрэлт бүхий ухаалаг хуулийн туслах
              </h1>
              <p className="mt-5 max-w-xl text-base leading-7 text-slate-300">
                Нэг удаагийн нэвтрэлтээр таны асуултууд, хайлтын түүх болон холбогдох хуулийн
                мэдээлэл найдвартай хадгалагдаж, дараагийн ашиглалтад бэлэн байна.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-sm font-semibold">Хадгалагдсан түүх</p>
                <p className="mt-2 text-sm text-slate-300">
                  Өмнөх чат, хайлтуудаа хялбархан нээж үргэлжлүүлэх боломжтой.
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-sm font-semibold">Аюулгүй нэвтрэлт</p>
                <p className="mt-2 text-sm text-slate-300">
                  Найдвартай баталгаажуулалтын системээр хурдан бөгөөд хамгаалалттай нэвтэрнэ.
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-sm font-semibold">Хувийн орчин</p>
                <p className="mt-2 text-sm text-slate-300">
                  Таны мэдээлэл зөвхөн таны хяналтад, хамгаалалттай хадгалагдана.
                </p>
              </div>
            </div>
          </section>

          <section className="rounded-[2rem] border border-white/70 bg-white/88 p-6 shadow-2xl shadow-slate-200/70 backdrop-blur dark:border-gray-800 dark:bg-gray-900/88 dark:shadow-none">
            <div className="rounded-2xl bg-slate-50 p-1 dark:bg-gray-800">
              <div className="grid grid-cols-2 gap-1">
                <button
                  type="button"
                  onClick={() => setMode('login')}
                  className={`rounded-2xl px-4 py-3 text-sm font-semibold transition ${
                    mode === 'login'
                      ? 'bg-white text-slate-900 shadow dark:bg-gray-900 dark:text-white'
                      : 'text-slate-500 dark:text-gray-400'
                  }`}
                >
                  Нэвтрэх
                </button>
                <button
                  type="button"
                  onClick={() => setMode('signup')}
                  className={`rounded-2xl px-4 py-3 text-sm font-semibold transition ${
                    mode === 'signup'
                      ? 'bg-white text-slate-900 shadow dark:bg-gray-900 dark:text-white'
                      : 'text-slate-500 dark:text-gray-400'
                  }`}
                >
                  Бүртгүүлэх
                </button>
              </div>
            </div>

            <div className="mt-6 space-y-4">
              <div>
                <h2 className="text-2xl font-semibold text-slate-900 dark:text-white">
                  {mode === 'signup' ? 'Шинэ хэрэглэгч үүсгэх' : 'Тавтай морил'}
                </h2>
                <p className="mt-1 text-sm text-slate-500 dark:text-gray-400">
                  {mode === 'signup'
                    ? 'Email/password эсвэл Google account-аараа бүртгүүлнэ.'
                    : 'Өөрийн хуучин түүхээ харахын тулд нэвтэрнэ үү.'}
                </p>
              </div>

              <GoogleSignInButton
                disabled={submitting || isBusy}
                onCredential={handleGoogleCredential}
              />

              <div className="flex items-center gap-3 text-xs uppercase tracking-[0.22em] text-slate-400 dark:text-gray-500">
                <span className="h-px flex-1 bg-slate-200 dark:bg-gray-700" />
                or
                <span className="h-px flex-1 bg-slate-200 dark:bg-gray-700" />
              </div>

              <form onSubmit={handleSubmit} className="space-y-4">
                {mode === 'signup' && (
                  <label className="block">
                    <span className="mb-2 block text-sm font-medium text-slate-700 dark:text-gray-200">
                      Нэр
                    </span>
                    <input
                      value={fullName}
                      onChange={(event) => setFullName(event.target.value)}
                      className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-primary-500 focus:ring-4 focus:ring-primary-500/10 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                      placeholder="Жишээ: Бат-Оргил"
                    />
                  </label>
                )}

                <label className="block">
                  <span className="mb-2 block text-sm font-medium text-slate-700 dark:text-gray-200">
                    Email
                  </span>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-primary-500 focus:ring-4 focus:ring-primary-500/10 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                    placeholder="you@example.com"
                  />
                </label>

                <label className="block">
                  <span className="mb-2 block text-sm font-medium text-slate-700 dark:text-gray-200">
                    Password
                  </span>
                  <input
                    type="password"
                    required
                    minLength={8}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-primary-500 focus:ring-4 focus:ring-primary-500/10 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                    placeholder="At least 8 characters"
                  />
                </label>

                {error && (
                  <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={submitting || isBusy}
                  className="w-full rounded-2xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-primary-600 dark:hover:bg-primary-500"
                >
                  {submitting || isBusy
                    ? 'Түр хүлээнэ үү...'
                    : mode === 'signup'
                      ? 'Бүртгүүлэх'
                      : 'Нэвтрэх'}
                </button>
              </form>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
