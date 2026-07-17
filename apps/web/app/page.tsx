'use client';

import { useEffect, useState } from 'react';

export default function Home() {
  const [api, setApi] = useState<string>('checando…');

  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3333';
    fetch(`${url}/health`)
      .then((r) => r.json())
      .then((d) => setApi(String(d.status)))
      .catch(() => setApi('offline'));
  }, []);

  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-4 bg-slate-950 text-slate-100">
      <h1 className="text-5xl font-bold tracking-tight">Truvo</h1>
      <p className="text-slate-400">Dados que você pode confiar.</p>
      <span className="text-xs uppercase tracking-[0.2em] text-teal-400">Fase 0 — Fundação</span>
      <div className="mt-4 rounded-lg border border-slate-800 px-4 py-2 text-sm">
        API health: <span className="font-mono text-teal-300">{api}</span>
      </div>
    </main>
  );
}
