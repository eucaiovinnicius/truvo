'use client';

import { useEffect, useState } from 'react';
import { Topbar } from '@/components/topbar';
import { api } from '@/lib/api';

const KPIS = ['ROAS', 'CAC', 'AOV', 'CVR'] as const;

export default function OverviewPage() {
  const [health, setHealth] = useState<string>('checando…');

  useEffect(() => {
    api<{ status: string }>('/health')
      .then((d) => setHealth(d.status))
      .catch(() => setHealth('offline'));
  }, []);

  return (
    <>
      <Topbar title="Overview" />
      <main className="flex-1 p-6">
        <p className="text-sm text-slate-400">
          API: <span className="font-mono text-teal-300">{health}</span>
        </p>

        <div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-4">
          {KPIS.map((k) => (
            <div key={k} className="rounded-xl border border-slate-800 bg-slate-950 p-4">
              <div className="text-xs uppercase tracking-wide text-slate-500">{k}</div>
              <div className="mt-1 text-2xl font-semibold text-slate-200">—</div>
            </div>
          ))}
        </div>

        <p className="mt-8 max-w-lg text-xs leading-relaxed text-slate-600">
          As telas de cada área serão preenchidas com dados reais quando a infra (ClickHouse/
          Supabase) estiver no ar. O backend dos módulos já está implementado — este é o shell
          navegável do dashboard.
        </p>
      </main>
    </>
  );
}
