'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { getPrimaryNavItems, type FeatureDefinition } from '@/lib/capabilities';

export interface PrimaryNavProps {
  onItemClick?: () => void;
  className?: string;
}

// Mapeia o id da feature para o ID legado correspondente para preservar compatibilidade com seletores E2E
const LEGACY_NAV_IDS: Record<string, string> = {
  overview: 'nav-link-dashboard',
  opportunities: 'nav-link-revenue-opportunities',
  radars: 'nav-link-radars',
  customers: 'nav-link-profiles',
  integrations: 'nav-link-integrations',
  settings: 'nav-link-settings',
};

export default function PrimaryNav({ onItemClick, className = '' }: PrimaryNavProps) {
  const pathname = usePathname() || '/app';
  const items = getPrimaryNavItems();

  return (
    <nav
      aria-label="Menu principal"
      className={`space-y-1 overflow-y-auto ${className}`}
    >
      {items.map((item) => {
        const IconComponent = item.icon;
        // Correspondência exata para /app, prefixo para subrotas (/app/radars/...)
        const isActive =
          item.route === '/app'
            ? pathname === '/app' || pathname === '/'
            : pathname === item.route || pathname.startsWith(`${item.route}/`);

        const elementId = LEGACY_NAV_IDS[item.id] || `nav-link-${item.id}`;

        return (
          <Link
            key={item.id}
            id={elementId}
            href={item.route}
            onClick={onItemClick}
            aria-current={isActive ? 'page' : undefined}
            className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-xs font-medium transition-all ${
              isActive
                ? 'bg-teal-50 text-teal-800 border-l-4 border-teal-600 font-semibold shadow-2xs'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50/70 border-l-4 border-transparent'
            }`}
          >
            <div className="flex items-center gap-3 min-w-0">
              <IconComponent
                className={`w-4 h-4 shrink-0 ${
                  isActive ? 'text-teal-700' : 'text-slate-400'
                }`}
                aria-hidden="true"
              />
              <span className="truncate">{item.name}</span>
            </div>
            {item.badge && (
              <span
                className={`px-1.5 py-0.5 rounded-full text-[9px] font-mono shrink-0 ${
                  isActive
                    ? 'bg-teal-100 text-teal-800'
                    : 'bg-slate-100 text-slate-500'
                }`}
              >
                {item.badge}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
