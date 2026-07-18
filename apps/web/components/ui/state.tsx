import type { ReactNode } from 'react';

export function LoadingState({ label = 'Carregando…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center rounded-xl border border-slate-800 bg-slate-950 p-10 text-sm text-slate-500">
      {label}
    </div>
  );
}

export function EmptyState({ title = 'Sem dados ainda', hint }: { title?: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-800 bg-slate-950/50 p-10 text-center">
      <div className="text-sm text-slate-400">{title}</div>
      {hint ? <div className="mt-1 max-w-md text-xs text-slate-600">{hint}</div> : null}
    </div>
  );
}

export function ErrorState({ error }: { error: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950 p-6">
      <div className="text-sm text-slate-300">API indisponível</div>
      <div className="mt-1 text-xs text-slate-600">
        {error}. Suba a infra (<span className="font-mono text-slate-500">pnpm infra:up</span>) e conecte o Supabase para
        popular esta tela.
      </div>
    </div>
  );
}

/** Renderiza o estado certo (loading → erro → vazio → conteúdo) de um useApi. */
export function AsyncBoundary<T>({
  state,
  empty,
  emptyHint,
  children,
}: {
  state: { data: T | null; loading: boolean; error: string | null };
  empty?: (d: T) => boolean;
  emptyHint?: string;
  children: (d: T) => ReactNode;
}) {
  if (state.loading) return <LoadingState />;
  if (state.error) return <ErrorState error={state.error} />;
  if (state.data == null || (empty && empty(state.data))) return <EmptyState hint={emptyHint} />;
  return <>{children(state.data)}</>;
}
