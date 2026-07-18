'use client';

import dynamic from 'next/dynamic';

/**
 * SPA da marca (login → onboarding → dashboard) portada de _reference/src.
 * É client-only: o login lê `localStorage` no primeiro render, então
 * desabilitamos SSR para não quebrar a pré-renderização do Next.
 */
const App = dynamic(() => import('@/appui/App'), {
  ssr: false,
  loading: () => <div className="min-h-screen bg-slate-50" />,
});

export default function HomePage() {
  return <App />;
}
