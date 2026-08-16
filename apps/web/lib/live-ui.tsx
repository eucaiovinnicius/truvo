'use client';

import React, { type ReactNode } from 'react';
import { AlertTriangle, Ban, LoaderCircle, LogIn, SearchX } from 'lucide-react';
import { resolveLiveSurface, type LiveState } from './live-state';

interface LiveDataBoundaryProps {
  states: LiveState<unknown>[];
  empty: boolean;
  label: string;
  children: ReactNode;
}

const COPY = {
  loading: ['Carregando dados ao vivo', 'Aguarde enquanto buscamos os dados deste workspace.'],
  empty: ['Nenhum dado encontrado', 'Ainda não há dados para exibir neste workspace.'],
  error: ['Dados ao vivo indisponíveis', 'Não foi possível carregar os dados. Tente novamente mais tarde.'],
  permission: ['Acesso não permitido', 'Você não tem permissão para visualizar estes dados.'],
  auth: ['Sessão expirada', 'Entre novamente para continuar.'],
} as const;

export function LiveDataBoundary({ states, empty, label, children }: LiveDataBoundaryProps) {
  const surface = resolveLiveSurface(states, empty);
  if (surface === 'content') return <>{children}</>;

  const Icon =
    surface === 'loading'
      ? LoaderCircle
      : surface === 'empty'
        ? SearchX
        : surface === 'permission'
          ? Ban
          : surface === 'auth'
            ? LogIn
            : AlertTriangle;
  const [title, description] = COPY[surface];

  return (
    <section
      aria-live="polite"
      aria-label={label}
      data-live-state={surface}
      className="m-6 flex min-h-[280px] flex-col items-center justify-center rounded-xl border border-slate-200 bg-white p-8 text-center"
    >
      <Icon className={`mb-3 h-7 w-7 text-slate-500 ${surface === 'loading' ? 'animate-spin' : ''}`} />
      <h2 className="text-base font-semibold text-slate-900">{title}</h2>
      <p className="mt-1 max-w-md text-sm text-slate-500">{description}</p>
    </section>
  );
}
