import type { ReactNode } from 'react';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-slate-800 bg-slate-950 ${className}`}>{children}</div>;
}

/** Stat tile / hero number (dataviz: nem tudo é gráfico). Texto em ink; delta com status color. */
export function StatTile({
  label,
  value,
  hint,
  delta,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  delta?: { value: string; positive?: boolean };
}) {
  return (
    <Card className="p-4">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <div className="text-2xl font-semibold text-slate-100">{value}</div>
        {delta ? (
          <span className={`text-xs font-medium ${delta.positive ? 'text-emerald-400' : 'text-rose-400'}`}>
            {delta.value}
          </span>
        ) : null}
      </div>
      {hint ? <div className="mt-1 text-xs text-slate-600">{hint}</div> : null}
    </Card>
  );
}

/** Grade responsiva de stat tiles (KPI row). */
export function StatRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-4 md:grid-cols-4">{children}</div>;
}
