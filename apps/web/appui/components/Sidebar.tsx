'use client';

import React from 'react';
import {
  HelpCircle,
  GraduationCap,
  LogOut,
  Sparkles,
} from 'lucide-react';
import { ViewState, ProfileConfig } from '../types';
import type { SessionMode } from '@/lib/session';
import Logo from './Logo';
import WorkspaceSwitcher from './WorkspaceSwitcher';
import { getPrimaryNavItems, type FeatureId } from '@/lib/capabilities';

interface SidebarProps {
  currentView: ViewState;
  setView: (view: ViewState) => void;
  workspaceName: string;
  workspaceId: string;
  workspaces: Array<{ id: string; name: string }>;
  setWorkspace: (id: string) => void;
  mode: SessionMode;
  onStartOnboarding: () => void;
  profile: ProfileConfig;
  onLogout: () => void;
}

// Mapeia o id da capability central para o ViewState legado e para o ID de elemento HTML legado
const CAPABILITY_TO_VIEW: Record<FeatureId, { view: ViewState; elementId: string }> = {
  overview: { view: 'dashboard', elementId: 'nav-link-dashboard' },
  opportunities: { view: 'revenue-opportunities', elementId: 'nav-link-revenue-opportunities' },
  radars: { view: 'radars', elementId: 'nav-link-radars' },
  customers: { view: 'profiles', elementId: 'nav-link-profiles' },
  integrations: { view: 'integrations', elementId: 'nav-link-integrations' },
  settings: { view: 'settings', elementId: 'nav-link-settings' },
  onboarding: { view: 'onboarding', elementId: 'nav-link-onboarding' },
  funnels: { view: 'funnels', elementId: 'nav-link-funnels' },
  'funnel-builder': { view: 'funnel-builder', elementId: 'nav-link-funnel-builder' },
  attribution: { view: 'attribution', elementId: 'nav-link-attribution' },
  creatives: { view: 'creatives', elementId: 'nav-link-creatives' },
  explorer: { view: 'explorer', elementId: 'nav-link-explorer' },
  ai: { view: 'ai', elementId: 'nav-link-ai' },
  'data-quality': { view: 'data-quality', elementId: 'nav-link-data-quality' },
  reports: { view: 'reports', elementId: 'nav-link-reports' },
  tracking: { view: 'tracking', elementId: 'nav-link-tracking' },
  billing: { view: 'billing', elementId: 'nav-link-billing' },
};

export default function Sidebar({ 
  currentView, 
  setView, 
  workspaceName, 
  workspaceId,
  workspaces,
  setWorkspace,
  mode,
  onStartOnboarding,
  profile,
  onLogout
}: SidebarProps) {
  // Exibe apenas as capabilities ativas no MVP
  const visibleItems = getPrimaryNavItems();

  return (
    <aside id="sidebar-container" className="w-64 bg-white border-r border-slate-100 flex flex-col h-screen fixed top-0 left-0 z-20">
      {/* Brand Header */}
      <div className="p-6 border-b border-slate-50 flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <Logo mark="#6366f1" word="#0f172a" className="h-7 w-auto" />
          <span className="text-[10px] font-mono text-indigo-500 tracking-[0.3em] uppercase font-semibold pl-0.5">Analytics</span>
        </div>
      </div>

      {/* Workspace Switcher */}
      <WorkspaceSwitcher
        currentWorkspaceId={workspaceId}
        currentWorkspaceName={workspaceName}
        workspaces={workspaces}
        onSelectWorkspace={setWorkspace}
        mode={mode}
      />

      {/* Navigation Links */}
      <nav aria-label="Navegação da barra lateral" className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {visibleItems.map((item) => {
          const IconComponent = item.icon;
          const mapping = CAPABILITY_TO_VIEW[item.id] || { view: item.id as ViewState, elementId: `nav-link-${item.id}` };
          const isActive = currentView === mapping.view;
          return (
            <button
              key={item.id}
              id={mapping.elementId}
              onClick={() => setView(mapping.view)}
              aria-current={isActive ? 'page' : undefined}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-xs font-medium transition-all ${
                isActive
                  ? 'bg-teal-50 text-teal-800 border-l-4 border-teal-600 font-semibold shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50/70 border-l-4 border-transparent'
              }`}
            >
              <div className="flex items-center gap-3">
                <IconComponent className={`w-4 h-4 ${isActive ? 'text-teal-700' : 'text-slate-400'}`} />
                <span>{item.name}</span>
              </div>
              {item.badge && (
                <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-mono ${
                  isActive ? 'bg-teal-100 text-teal-800' : 'bg-slate-100 text-slate-500'
                }`}>
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Quick Access/Support Info */}
      <div className="p-4 mx-3 mb-3 bg-slate-50/80 rounded-xl border border-slate-100">
        <div className="flex gap-2 items-start mb-2">
          <Sparkles className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
          <div>
            <h4 className="text-[11px] font-semibold text-slate-800 leading-none mb-1">Onboarding Wizard</h4>
            <p className="text-[10px] text-slate-500 leading-normal">Configure custom pixels or link ad accounts anytime.</p>
          </div>
        </div>
        <button
          id="launch-setup-wizard-btn"
          onClick={onStartOnboarding}
          className="w-full py-1.5 bg-white border border-slate-200 hover:border-slate-300 rounded-lg text-[10px] font-medium text-slate-700 hover:text-slate-800 transition-colors shadow-2xs flex items-center justify-center gap-1.5"
        >
          <GraduationCap className="w-3.5 h-3.5 text-teal-600" />
          <span>Launch Setup Wizard</span>
        </button>
      </div>

      {/* User Profile Footer */}
      <div className="p-4 border-t border-slate-100 bg-slate-50/50 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 overflow-hidden">
            <div className="relative">
              <div className="w-9 h-9 rounded-full bg-linear-to-br from-teal-500 to-emerald-600 flex items-center justify-center text-white font-bold text-xs border-2 border-white shadow-xs">
                {profile.fullName ? profile.fullName.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() : 'AM'}
              </div>
              <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-emerald-500 rounded-full border-2 border-white" />
            </div>
            <div className="overflow-hidden">
              <span className="text-xs font-semibold text-slate-800 block truncate">{profile.fullName || 'Usuário'}</span>
              <span className="text-[10px] font-medium text-slate-500 block truncate">{profile.email}</span>
            </div>
          </div>
          <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full font-mono shrink-0 ${mode === 'live' ? 'bg-emerald-100 text-emerald-800' : 'bg-indigo-100 text-indigo-800'}`}>
            {mode === 'live' ? 'LIVE' : 'DEMO'}
          </span>
        </div>

        {/* Docs de integração */}
        <a
          href="/docs"
          target="_blank"
          rel="noopener noreferrer"
          className="w-full py-1.5 border border-slate-200 hover:border-indigo-300 bg-white hover:bg-indigo-50/60 rounded-lg text-[10px] font-bold text-slate-600 hover:text-indigo-700 transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
        >
          <HelpCircle className="w-3.5 h-3.5" />
          <span>Docs de integração</span>
        </a>

        {/* Logout Button */}
        <button
          onClick={onLogout}
          className="w-full py-1.5 border border-red-100 hover:border-red-200 bg-red-50/30 hover:bg-red-50/80 rounded-lg text-[10px] font-bold text-red-600 hover:text-red-700 transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
        >
          <LogOut className="w-3.5 h-3.5" />
          <span>Sair da Conta</span>
        </button>
      </div>
    </aside>
  );
}
