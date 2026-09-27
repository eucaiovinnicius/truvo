'use client';

import React, { useState, type ReactNode, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  GraduationCap,
  HelpCircle,
  LogOut,
  Menu,
  Sparkles,
  X,
} from 'lucide-react';
import Logo from './Logo';
import PrimaryNav from './PrimaryNav';
import WorkspaceSwitcher from './WorkspaceSwitcher';
import { useSession, type SessionMode, type Workspace } from '@/lib/session';

export interface AppShellProps {
  children: ReactNode;
}

const DEMO_WORKSPACES = [
  { id: 'truvo-global', name: 'Truvo Global Store' },
  { id: 'alpha-electronics', name: 'Alpha Electronics' },
  { id: 'beta-cosmetics', name: 'BETA Cosmetics' },
];

export default function AppShell({ children }: AppShellProps) {
  const session = useSession();
  const router = useRouter();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Close mobile menu on resize to desktop
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth >= 768) setMobileMenuOpen(false);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const visibleWorkspace = session.isLive
    ? { id: session.workspace?.id ?? '', name: session.workspace?.name || 'Workspace' }
    : { id: 'truvo-global', name: 'Truvo Global Store' };

  const visibleWorkspaces = session.isLive ? session.workspaces : DEMO_WORKSPACES;

  const handleSelectWorkspace = (id: string) => {
    if (session.isLive) {
      session.selectWorkspace(id);
    }
  };

  const handleLogout = () => {
    session.logout();
    router.push('/');
  };

  const mode = session.mode ?? 'demo';
  const userName = session.user?.name || session.user?.email || (session.mode === 'live' ? 'Usuário' : 'Alex Mercer');
  const userEmail = session.user?.email || (session.mode === 'live' ? '' : 'alex@truvo.ai');
  const userInitials = userName
    .split(' ')
    .map((n) => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() || 'TR';

  return (
    <div className="min-h-screen bg-slate-50/50 flex flex-col md:flex-row font-sans antialiased text-slate-900 selection:bg-teal-500/15 selection:text-teal-900">
      {/* Accessible Skip Link */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 z-50 bg-teal-700 text-white px-4 py-2 rounded-md font-semibold text-xs shadow-lg"
      >
        Pular para o conteúdo principal
      </a>

      {/* Mobile Top Header */}
      <header
        id="mobile-topbar"
        className="md:hidden h-14 bg-white border-b border-slate-100 flex items-center justify-between px-4 sticky top-0 z-30 shadow-2xs"
      >
        <div className="flex items-center gap-2">
          <Logo mark="#6366f1" word="#0f172a" className="h-6 w-auto" />
          <span className="text-[9px] font-mono text-indigo-500 font-bold uppercase tracking-wider">
            {mode === 'live' ? 'Live' : 'Demo'}
          </span>
        </div>
        <button
          onClick={() => setMobileMenuOpen((prev) => !prev)}
          aria-label={mobileMenuOpen ? 'Fechar menu de navegação' : 'Abrir menu de navegação'}
          aria-expanded={mobileMenuOpen}
          aria-controls="mobile-sidebar"
          className="p-2 text-slate-600 hover:text-slate-900 rounded-lg hover:bg-slate-100 focus:outline-hidden focus:ring-2 focus:ring-teal-500"
        >
          {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </header>

      {/* Desktop Sidebar (Fixed Left) */}
      <aside
        id="sidebar-container"
        className="hidden md:flex w-64 bg-white border-r border-slate-100 flex-col h-screen fixed top-0 left-0 z-20"
      >
        {/* Brand Header */}
        <div className="p-6 border-b border-slate-50 flex items-center justify-between">
          <div className="flex flex-col gap-1">
            <Logo mark="#6366f1" word="#0f172a" className="h-7 w-auto" />
            <span className="text-[10px] font-mono text-indigo-500 tracking-[0.3em] uppercase font-semibold pl-0.5">
              Analytics
            </span>
          </div>
        </div>

        {/* Workspace Switcher */}
        <WorkspaceSwitcher
          currentWorkspaceId={visibleWorkspace.id}
          currentWorkspaceName={visibleWorkspace.name}
          workspaces={visibleWorkspaces}
          onSelectWorkspace={handleSelectWorkspace}
          mode={mode}
        />

        {/* Primary MVP Navigation */}
        <PrimaryNav className="flex-1 px-3 py-4" />

        {/* Setup Wizard Quick Action */}
        <div className="p-4 mx-3 mb-3 bg-slate-50/80 rounded-xl border border-slate-100">
          <div className="flex gap-2 items-start mb-2">
            <Sparkles className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            <div>
              <h4 className="text-[11px] font-semibold text-slate-800 leading-none mb-1">
                Onboarding Wizard
              </h4>
              <p className="text-[10px] text-slate-500 leading-normal">
                Configure pixels ou vincule fontes de dados.
              </p>
            </div>
          </div>
          <Link
            id="launch-setup-wizard-btn"
            href="/app/onboarding"
            className="w-full py-1.5 bg-white border border-slate-200 hover:border-slate-300 rounded-lg text-[10px] font-medium text-slate-700 hover:text-slate-800 transition-colors shadow-2xs flex items-center justify-center gap-1.5"
          >
            <GraduationCap className="w-3.5 h-3.5 text-teal-600" />
            <span>Launch Setup Wizard</span>
          </Link>
        </div>

        {/* User Profile Footer */}
        <div className="p-4 border-t border-slate-100 bg-slate-50/50 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 overflow-hidden">
              <div className="relative shrink-0">
                <div className="w-8 h-8 rounded-full bg-linear-to-br from-teal-500 to-emerald-600 flex items-center justify-center text-white font-bold text-xs border-2 border-white shadow-xs">
                  {userInitials}
                </div>
                <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-emerald-500 rounded-full border-2 border-white" />
              </div>
              <div className="overflow-hidden">
                <span className="text-xs font-semibold text-slate-800 block truncate">
                  {userName}
                </span>
                <span className="text-[10px] font-medium text-slate-500 block truncate">
                  {userEmail}
                </span>
              </div>
            </div>
            <span
              className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full font-mono shrink-0 ${
                mode === 'live' ? 'bg-emerald-100 text-emerald-800' : 'bg-indigo-100 text-indigo-800'
              }`}
            >
              {mode === 'live' ? 'LIVE' : 'DEMO'}
            </span>
          </div>

          <div className="flex gap-2">
            <a
              href="/docs"
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 py-1.5 border border-slate-200 hover:border-indigo-300 bg-white hover:bg-indigo-50/60 rounded-lg text-[10px] font-bold text-slate-600 hover:text-indigo-700 transition-colors flex items-center justify-center gap-1"
            >
              <HelpCircle className="w-3.5 h-3.5" />
              <span>Docs</span>
            </a>
            <button
              onClick={handleLogout}
              className="flex-1 py-1.5 border border-red-100 hover:border-red-200 bg-red-50/30 hover:bg-red-50/80 rounded-lg text-[10px] font-bold text-red-600 hover:text-red-700 transition-colors flex items-center justify-center gap-1"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Sair</span>
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile Drawer Navigation (Overlay) */}
      {mobileMenuOpen && (
        <div
          id="mobile-sidebar"
          role="dialog"
          aria-modal="true"
          aria-label="Menu móvel de navegação"
          className="md:hidden fixed inset-0 z-40 bg-slate-900/50 backdrop-blur-xs flex"
        >
          <div className="w-72 bg-white h-full flex flex-col shadow-2xl animate-fadeIn">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between">
              <Logo mark="#6366f1" word="#0f172a" className="h-6 w-auto" />
              <button
                onClick={() => setMobileMenuOpen(false)}
                aria-label="Fechar menu"
                className="p-1.5 text-slate-400 hover:text-slate-600 rounded-md"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <WorkspaceSwitcher
              currentWorkspaceId={visibleWorkspace.id}
              currentWorkspaceName={visibleWorkspace.name}
              workspaces={visibleWorkspaces}
              onSelectWorkspace={(id) => {
                handleSelectWorkspace(id);
                setMobileMenuOpen(false);
              }}
              mode={mode}
            />

            <PrimaryNav
              className="flex-1 px-3 py-4"
              onItemClick={() => setMobileMenuOpen(false)}
            />

            <div className="p-4 border-t border-slate-100 bg-slate-50/50">
              <button
                onClick={() => {
                  setMobileMenuOpen(false);
                  handleLogout();
                }}
                className="w-full py-2 border border-red-200 bg-white rounded-lg text-xs font-bold text-red-600 flex items-center justify-center gap-1.5"
              >
                <LogOut className="w-4 h-4" />
                <span>Sair da conta</span>
              </button>
            </div>
          </div>
          <div className="flex-1" onClick={() => setMobileMenuOpen(false)} />
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 md:ml-64">
        <main id="main-content" tabIndex={-1} className="flex-1 p-4 md:p-8 overflow-y-auto">
          <div className="max-w-[1300px] mx-auto">{children}</div>
        </main>
      </div>
    </div>
  );
}
