'use client';

import React, { useState } from 'react';
import {
  Activity,
  Layers,
  Compass,
  TrendingUp,
  Code2,
  Settings,
  ChevronDown,
  Check,
  Sparkles,
  HelpCircle,
  GraduationCap,
  LogOut,
  Image,
  Search,
  Brain,
  Users,
  ShieldCheck,
  FileText,
  Blocks,
  CreditCard
  ,Radar, Target
} from 'lucide-react';
import { ViewState, ProfileConfig } from '../types';
import type { SessionMode } from '@/lib/session';
import Logo from './Logo';

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
  const [showWorkspaceDropdown, setShowWorkspaceDropdown] = useState(false);

  const menuItems = [
    { id: 'dashboard', name: 'Overview Dashboard', icon: Activity, badge: null },
    { id: 'funnels', name: 'Marketing Funnels', icon: Layers, badge: null },
    { id: 'funnel-builder', name: 'Funnel Builder', icon: Compass, badge: null },
    { id: 'attribution', name: 'Attribution Analyzer', icon: TrendingUp, badge: null },
    { id: 'creatives', name: 'Creative Analytics', icon: Image, badge: null },
    { id: 'explorer', name: 'Data Explorer', icon: Search, badge: null },
    { id: 'ai', name: 'AI Journeys', icon: Brain, badge: 'IA' },
    { id: 'profiles', name: 'Customer 360', icon: Users, badge: null },
    { id: 'data-quality', name: 'Data Quality', icon: ShieldCheck, badge: null },
    { id: 'radars', name: 'Radars', icon: Radar, badge: 'NOVO' },
    { id: 'revenue-opportunities', name: 'Revenue Opportunities', icon: Target, badge: 'NOVO' },
    { id: 'reports', name: 'Reports', icon: FileText, badge: null },
    { id: 'tracking', name: 'SDK & Pixel', icon: Code2, badge: null },
    { id: 'integrations', name: 'Integrations Hub', icon: Blocks, badge: null },
    { id: 'billing', name: 'Billing & Plans', icon: CreditCard, badge: null },
    { id: 'settings', name: 'Workspace Settings', icon: Settings, badge: null }
  ];

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
      <div className="px-4 py-3 border-b border-slate-50 relative">
        <button 
          id="workspace-switcher-btn"
          onClick={() => setShowWorkspaceDropdown(!showWorkspaceDropdown)}
          className="w-full flex items-center justify-between p-2.5 rounded-lg border border-slate-100 hover:border-slate-200 bg-slate-50/50 hover:bg-slate-50 transition-all text-left"
        >
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded-md bg-teal-100 flex items-center justify-center text-xs text-teal-800 font-bold">
              {workspaceName[0]}
            </div>
            <span className="text-xs font-semibold text-slate-700 truncate">{workspaceName}</span>
          </div>
          <ChevronDown className="w-4 h-4 text-slate-400" />
        </button>

        {showWorkspaceDropdown && (
          <div className="absolute top-full left-4 right-4 mt-1 bg-white border border-slate-100 rounded-lg shadow-lg z-50 py-1">
            {workspaces.map((ws) => (
              <button
                key={ws.id}
                onClick={() => {
                  setWorkspace(ws.id);
                  setShowWorkspaceDropdown(false);
                }}
                className="w-full px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 flex items-center justify-between"
              >
                {ws.name}
                {ws.id === workspaceId && <Check className="w-3.5 h-3.5 text-teal-600" />}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Navigation Links */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {menuItems.map((item) => {
          const IconComponent = item.icon;
          const isActive = currentView === item.id;
          return (
            <button
              key={item.id}
              id={`nav-link-${item.id}`}
              onClick={() => setView(item.id as ViewState)}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-xs font-medium transition-all ${
                isActive 
                  ? 'bg-teal-50 text-teal-800 border-l-4 border-teal-600 font-semibold' 
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
              <div className="w-9 h-9 rounded-full bg-linear-to-br from-teal-500 to-emerald-600 flex items-center justify-center text-white font-bold text-xs border-2 border-white shadow-sm">
                {profile.fullName ? profile.fullName.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() : 'AM'}
              </div>
              <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-emerald-500 rounded-full border-2 border-white sync-pulse" />
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

        {/* Docs de integração (página pública /docs) */}
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
