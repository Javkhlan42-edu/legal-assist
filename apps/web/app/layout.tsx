import type { Metadata } from 'next';
import Script from 'next/script';
import { AuthProvider } from '@/lib/auth';
import '../styles/globals.css';

const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

export const metadata: Metadata = {
  title: 'Legal RAG Assistant — Хууль зүйн туслах',
  description:
    'Монголын хууль тогтоомж, шүүхийн шийдвэрийн мэдээллийн сангаас хариулт өгдөг AI чатбот',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="mn" suppressHydrationWarning>
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <script
          dangerouslySetInnerHTML={{
            __html:
              'try{var t=localStorage.getItem("theme");if(t==="dark"||(!t&&matchMedia("(prefers-color-scheme:dark)").matches))document.documentElement.classList.add("dark")}catch(e){}',
          }}
        />
      </head>
      <body className="min-h-screen antialiased">
        {googleClientId && (
          <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" />
        )}
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
