import type { ReactNode } from 'react';

export type BadgeVariant = 'neutral' | 'good' | 'warning' | 'critical' | 'info';

const styles: Record<BadgeVariant, string> = {
  neutral: 'bg-slate-800 text-slate-300',
  good: 'bg-emerald-500/15 text-emerald-300',
  warning: 'bg-amber-500/15 text-amber-300',
  critical: 'bg-rose-500/15 text-rose-300',
  info: 'bg-sky-500/15 text-sky-300',
};

/** Status como cor reservada + label (dataviz: nunca cor sozinha). */
export function Badge({ children, variant = 'neutral' }: { children: ReactNode; variant?: BadgeVariant }) {
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${styles[variant]}`}>
      {children}
    </span>
  );
}
