'use client';

import React, { type ReactNode, useEffect, useRef } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  Ban,
  Clock,
  HelpCircle,
  LoaderCircle,
  Lock,
  Plus,
  RefreshCw,
  SearchX,
  Sparkles,
  X,
} from 'lucide-react';
import type { LiveFailure, LiveState, LiveStatus, LiveSurface } from '@/lib/live-state';

// ----------------------------------------------------------------------------
// 1. Loading & Skeleton
// ----------------------------------------------------------------------------

export interface LoadingProps {
  label?: string;
  description?: string;
  fullScreen?: boolean;
}

export function Loading({
  label = 'Carregando...',
  description = 'Aguarde enquanto os dados são recuperados.',
  fullScreen = false,
}: LoadingProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      className={`flex flex-col items-center justify-center p-8 text-center ${
        fullScreen ? 'min-h-[400px]' : 'min-h-[220px]'
      }`}
    >
      <LoaderCircle className="h-8 w-8 animate-spin text-teal-600 mb-3" />
      <p className="text-sm font-semibold text-slate-800">{label}</p>
      {description && <p className="mt-1 text-xs text-slate-500 max-w-sm">{description}</p>}
    </div>
  );
}

export function Skeleton({
  className = 'h-4 w-full',
  count = 1,
}: {
  className?: string;
  count?: number;
}) {
  return (
    <div className="space-y-2.5 w-full animate-pulse" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className={`bg-slate-200/80 rounded-md ${className}`} />
      ))}
    </div>
  );
}

export function AppShellSkeleton() {
  return (
    <div className="min-h-screen bg-slate-50 flex" aria-label="Carregando aplicativo">
      {/* Sidebar skeleton */}
      <aside className="w-64 bg-white border-r border-slate-100 p-6 flex flex-col gap-6 hidden md:flex">
        <div className="h-8 w-32 bg-slate-200 rounded-md animate-pulse" />
        <div className="h-10 w-full bg-slate-100 rounded-lg animate-pulse" />
        <div className="space-y-2 flex-1">
          <Skeleton className="h-9 w-full rounded-lg" count={6} />
        </div>
        <div className="h-16 w-full bg-slate-100 rounded-xl animate-pulse" />
      </aside>
      {/* Main content skeleton */}
      <main className="flex-1 p-8">
        <div className="max-w-6xl mx-auto space-y-6">
          <div className="flex justify-between items-center">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-10 w-32" />
          </div>
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      </main>
    </div>
  );
}

// ----------------------------------------------------------------------------
// 2. Empty State
// ----------------------------------------------------------------------------

export interface EmptyStateProps {
  title?: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  actionHref?: string;
  icon?: React.ComponentType<{ className?: string }>;
  label?: string;
}

export function EmptyState({
  title = 'Nenhum dado encontrado',
  description = 'Não há itens para exibir neste momento.',
  actionLabel,
  onAction,
  actionHref,
  icon: Icon = SearchX,
  label = 'Conteúdo vazio',
}: EmptyStateProps) {
  return (
    <section
      aria-label={label}
      className="m-4 flex min-h-[260px] flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 bg-white p-8 text-center"
    >
      <div className="w-12 h-12 rounded-full bg-slate-50 border border-slate-100 flex items-center justify-center mb-3">
        <Icon className="h-6 w-6 text-slate-400" />
      </div>
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      <p className="mt-1 max-w-md text-sm text-slate-500">{description}</p>
      {actionHref && (
        <Link
          href={actionHref}
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-bold text-white hover:bg-slate-800 transition-colors shadow-xs"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>{actionLabel}</span>
        </Link>
      )}
      {onAction && !actionHref && (
        <button
          onClick={onAction}
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-bold text-white hover:bg-slate-800 transition-colors shadow-xs"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>{actionLabel}</span>
        </button>
      )}
    </section>
  );
}

// ----------------------------------------------------------------------------
// 3. Error State
// ----------------------------------------------------------------------------

export interface ErrorStateProps {
  title?: string;
  description?: string;
  error?: LiveFailure | Error | null;
  onRetry?: () => void;
  label?: string;
}

export function ErrorState({
  title = 'Ocorreu um erro ao carregar os dados',
  description = 'Não foi possível completar a solicitação. Tente novamente mais tarde.',
  error,
  onRetry,
  label = 'Erro nos dados',
}: ErrorStateProps) {
  const errorMessage = error instanceof Error ? error.message : error?.message;

  return (
    <section
      role="alert"
      aria-label={label}
      className="m-4 flex min-h-[260px] flex-col items-center justify-center rounded-xl border border-rose-200 bg-rose-50/50 p-8 text-center"
    >
      <div className="w-12 h-12 rounded-full bg-rose-100 border border-rose-200 flex items-center justify-center mb-3">
        <AlertTriangle className="h-6 w-6 text-rose-600" />
      </div>
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      <p className="mt-1 max-w-md text-sm text-slate-600">
        {errorMessage || description}
      </p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-4 inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors shadow-2xs"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          <span>Tentar novamente</span>
        </button>
      )}
    </section>
  );
}

// ----------------------------------------------------------------------------
// 4. Degraded State
// ----------------------------------------------------------------------------

export interface DegradedStateProps {
  title?: string;
  description?: string;
  reason?: string;
  onAction?: () => void;
  actionLabel?: string;
}

export function DegradedState({
  title = 'Serviço operando com capacidade reduzida',
  description = 'Algumas informações podem estar temporariamente desatualizadas ou limitadas.',
  reason,
  onAction,
  actionLabel = 'Atualizar status',
}: DegradedStateProps) {
  return (
    <section
      role="region"
      aria-label="Estado degradado"
      className="m-4 flex min-h-[240px] flex-col items-center justify-center rounded-xl border border-amber-200 bg-amber-50/60 p-8 text-center"
    >
      <div className="w-12 h-12 rounded-full bg-amber-100 border border-amber-200 flex items-center justify-center mb-3">
        <Clock className="h-6 w-6 text-amber-700" />
      </div>
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      <p className="mt-1 max-w-md text-sm text-slate-600">{description}</p>
      {reason && (
        <p className="mt-2 text-xs font-mono text-amber-800 bg-amber-100/70 px-2 py-1 rounded">
          {reason}
        </p>
      )}
      {onAction && (
        <button
          onClick={onAction}
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-50 transition-colors"
        >
          <span>{actionLabel}</span>
        </button>
      )}
    </section>
  );
}

// ----------------------------------------------------------------------------
// 5. Permission / Auth State
// ----------------------------------------------------------------------------

export interface PermissionStateProps {
  title?: string;
  description?: string;
  kind?: 'permission' | 'auth';
  onLogin?: () => void;
}

export function PermissionState({
  title,
  description,
  kind = 'permission',
  onLogin,
}: PermissionStateProps) {
  const isAuth = kind === 'auth';
  const defaultTitle = isAuth
    ? 'Sua sessão expirou'
    : 'Acesso restrito ao workspace';
  const defaultDescription = isAuth
    ? 'Por favor, autentique-se novamente para visualizar estas informações.'
    : 'Sua conta não tem permissão para visualizar ou modificar este recurso no workspace ativo.';

  return (
    <section
      role="alert"
      aria-label="Acesso não autorizado"
      className="m-4 flex min-h-[280px] flex-col items-center justify-center rounded-xl border border-slate-200 bg-white p-8 text-center"
    >
      <div className="w-12 h-12 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center mb-3">
        {isAuth ? <Lock className="h-6 w-6 text-slate-600" /> : <Ban className="h-6 w-6 text-slate-600" />}
      </div>
      <h3 className="text-base font-semibold text-slate-900">
        {title || defaultTitle}
      </h3>
      <p className="mt-1 max-w-md text-sm text-slate-500">
        {description || defaultDescription}
      </p>
      {isAuth && (
        <Link
          href="/"
          onClick={onLogin}
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-bold text-white hover:bg-slate-800 transition-colors shadow-xs"
        >
          <span>Entrar novamente</span>
        </Link>
      )}
    </section>
  );
}

// ----------------------------------------------------------------------------
// 6. Feature Unavailable State (Guard para rotas desabilitadas)
// ----------------------------------------------------------------------------

export interface FeatureUnavailableStateProps {
  featureName?: string;
  description?: string;
}

export function FeatureUnavailableState({
  featureName = 'Módulo não disponível',
  description = 'Esta funcionalidade está programada para versões futuras e não está ativa no MVP atual.',
}: FeatureUnavailableStateProps) {
  return (
    <section
      aria-label="Módulo indisponível"
      className="m-6 flex min-h-[320px] flex-col items-center justify-center rounded-xl border border-slate-200 bg-white p-8 text-center"
    >
      <div className="w-12 h-12 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center mb-3">
        <Sparkles className="h-6 w-6 text-indigo-500" />
      </div>
      <h2 className="text-lg font-bold text-slate-900">{featureName}</h2>
      <p className="mt-1.5 max-w-md text-sm text-slate-500">{description}</p>
      <p className="mt-3 text-xs text-slate-400 font-mono">
        Status: Roadmap / Inativo no MVP
      </p>
      <Link
        href="/app"
        className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-4 py-2 text-xs font-bold text-white hover:bg-teal-800 transition-colors shadow-xs"
      >
        <span>Voltar ao Overview</span>
      </Link>
    </section>
  );
}

// ----------------------------------------------------------------------------
// 7. No Workspace State
// ----------------------------------------------------------------------------

export function NoWorkspaceState() {
  return (
    <section
      aria-label="Nenhum workspace selecionado"
      className="m-6 flex min-h-[320px] flex-col items-center justify-center rounded-xl border border-slate-200 bg-white p-8 text-center"
    >
      <div className="w-12 h-12 rounded-full bg-teal-50 border border-teal-100 flex items-center justify-center mb-3">
        <HelpCircle className="h-6 w-6 text-teal-600" />
      </div>
      <h2 className="text-lg font-bold text-slate-900">Nenhum workspace acessível</h2>
      <p className="mt-1.5 max-w-md text-sm text-slate-500">
        Você não possui nenhum workspace vinculado ou ainda não selecionou um workspace ativo.
      </p>
      <Link
        href="/app/onboarding"
        className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-4 py-2 text-xs font-bold text-white hover:bg-teal-800 transition-colors shadow-xs"
      >
        <Plus className="w-3.5 h-3.5" />
        <span>Configurar novo workspace</span>
      </Link>
    </section>
  );
}

// ----------------------------------------------------------------------------
// 8. Confirmation Dialog
// ----------------------------------------------------------------------------

export interface ConfirmationDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  isDestructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmationDialog({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  isDestructive = false,
  onConfirm,
  onCancel,
}: ConfirmationDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-xs p-4"
    >
      <div
        ref={dialogRef}
        className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-2xl p-6 animate-fadeIn"
      >
        <div className="flex justify-between items-start mb-3">
          <h3 id="confirm-dialog-title" className="text-base font-bold text-slate-900">
            {title}
          </h3>
          <button
            onClick={onCancel}
            aria-label="Fechar"
            className="text-slate-400 hover:text-slate-600 p-1 rounded-md"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-sm text-slate-600 mb-6">{message}</p>
        <div className="flex justify-end gap-2.5">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 text-xs font-bold text-white rounded-lg transition-colors shadow-xs ${
              isDestructive
                ? 'bg-rose-600 hover:bg-rose-700'
                : 'bg-slate-900 hover:bg-slate-800'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// 9. DataState (Adaptador unificado que mapeia LiveState para a UI correta)
// ----------------------------------------------------------------------------

export interface DataStateProps {
  states: LiveState<unknown>[];
  empty?: boolean;
  label: string;
  emptyTitle?: string;
  emptyDescription?: string;
  onRetry?: () => void;
  children: ReactNode;
}

export function DataState({
  states,
  empty = false,
  label,
  emptyTitle,
  emptyDescription,
  onRetry,
  children,
}: DataStateProps) {
  const firstError = states.find((s) => s.status === 'error')?.error;
  const isLoading = states.some((s) => s.status === 'loading');
  const isAuth = firstError?.kind === 'auth';
  const isPermission = firstError?.kind === 'permission';

  if (isAuth) {
    return <PermissionState kind="auth" title={firstError?.message} />;
  }
  if (isPermission) {
    return <PermissionState kind="permission" title={firstError?.message} />;
  }
  if (firstError) {
    return <ErrorState error={firstError} onRetry={onRetry} label={label} />;
  }
  if (isLoading) {
    return <Loading label={`Carregando ${label}...`} />;
  }
  if (empty) {
    return <EmptyState title={emptyTitle} description={emptyDescription} label={label} />;
  }

  return <>{children}</>;
}
