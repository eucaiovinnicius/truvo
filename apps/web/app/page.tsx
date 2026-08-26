'use client';

import { SessionProvider } from '@/lib/session';
import dynamic from 'next/dynamic';

const App = dynamic(() => import('@/appui/App'), {
  ssr: false,
  loading: () => <div className="min-h-screen bg-slate-50" />,
});

/**
 * SPA da marca (login → onboarding → dashboard) portada de _reference/src.
 * É client-only: o login lê `localStorage` no primeiro render, então
 * desabilitamos SSR para não quebrar a pré-renderização do Next.
 */
export default function HomePage() {
  return (
    <SessionProvider>
      <App />
    </SessionProvider>
  );
}
