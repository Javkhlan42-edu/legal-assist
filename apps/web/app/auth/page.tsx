import { Suspense } from 'react';
import { AuthPageShell } from '@/components/auth/AuthPageShell';

export default function AuthPage() {
  return (
    <Suspense fallback={null}>
      <AuthPageShell />
    </Suspense>
  );
}
