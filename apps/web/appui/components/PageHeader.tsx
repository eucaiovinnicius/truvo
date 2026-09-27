'use client';

import React, { type ReactNode } from 'react';
import type { SessionMode } from '@/lib/session';

export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  mode: SessionMode;
  actions?: ReactNode;
  breadcrumbs?: Array<{ label: string; href?: string }>;
  badge?: string | null;
}

export default function PageHeader({
  title,
  subtitle,
  mode,
  actions,
  breadcrumbs,
  badge,
}: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between pb-6 border-b border-slate-100">
      <div className="min-w-0">
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav aria-label="Navegação estrutural" className="mb-1">
            <ol className="flex items-center gap-1.5 text-xs text-slate-500">
              {breadcrumbs.map((crumb, idx) => (
                <li key={idx} className="flex items-center gap-1.5">
                  {idx > 0 && <span className="text-slate-300">/</span>}
                  {crumb.href ? (
                    <a href={crumb.href} className="hover:text-slate-800 transition-colors">
                      {crumb.label}
                    </a>
                  ) : (
                    <span className="text-slate-700 font-medium">{crumb.label}</span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        )}
        <div className="flex items-center gap-3">
          <h1
            id="topbar-view-title"
            className="text-2xl font-bold tracking-tight text-slate-900 truncate"
          >
            {title}
          </h1>
          {badge && (
            <span className="px-2 py-0.5 rounded-full text-xs font-mono font-semibold bg-teal-100 text-teal-800">
              {badge}
            </span>
          )}
          <div className="flex items-center gap-1.5 shrink-0">
            <span
              className={`w-2 h-2 rounded-full ${
                mode === 'live' ? 'bg-emerald-500' : 'bg-indigo-500'
              }`}
              aria-hidden="true"
            />
            <span className="text-[10px] font-mono font-semibold uppercase tracking-wider text-slate-500">
              {mode === 'live' ? 'Modo ao vivo' : 'Modo demonstração'}
            </span>
          </div>
        </div>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>

      {actions && <div className="flex items-center gap-2.5 shrink-0 mt-3 md:mt-0">{actions}</div>}
    </div>
  );
}
