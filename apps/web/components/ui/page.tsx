import type { ReactNode } from 'react';
import { Topbar } from '@/components/topbar';

/** Casca de uma tela: topbar + área rolável. `actions` fica alinhado à direita. */
export function Page({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <Topbar title={title} />
      <main className="flex-1 overflow-y-auto p-6">
        {actions ? <div className="mb-4 flex flex-wrap items-center justify-end gap-2">{actions}</div> : null}
        {children}
      </main>
    </>
  );
}

export function Section({
  title,
  description,
  children,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-8">
      {title ? <h2 className="mb-1 text-sm font-semibold text-slate-200">{title}</h2> : null}
      {description ? <p className="mb-3 text-xs text-slate-500">{description}</p> : null}
      {children}
    </section>
  );
}

/** Linha de filtros/ações acima do conteúdo. */
export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="mb-4 flex flex-wrap items-center gap-2">{children}</div>;
}
