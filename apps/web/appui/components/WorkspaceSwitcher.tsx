'use client';

import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import type { SessionMode, Workspace } from '@/lib/session';

export interface WorkspaceSwitcherProps {
  currentWorkspaceId: string;
  currentWorkspaceName: string;
  workspaces: Array<{ id: string; name: string }>;
  onSelectWorkspace: (id: string) => void;
  mode: SessionMode;
}

export default function WorkspaceSwitcher({
  currentWorkspaceId,
  currentWorkspaceName,
  workspaces,
  onSelectWorkspace,
  mode,
}: WorkspaceSwitcherProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const initialLetter = currentWorkspaceName ? currentWorkspaceName[0]?.toUpperCase() : 'W';

  return (
    <div ref={containerRef} className="px-4 py-3 border-b border-slate-50 relative">
      <button
        ref={triggerRef}
        id="workspace-switcher-btn"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((prev) => !prev)}
        className="w-full flex items-center justify-between p-2.5 rounded-lg border border-slate-100 hover:border-slate-200 bg-slate-50/50 hover:bg-slate-50 transition-all text-left focus:outline-hidden focus:ring-2 focus:ring-teal-500"
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-5 h-5 rounded-md bg-teal-100 shrink-0 flex items-center justify-center text-xs text-teal-800 font-bold">
            {initialLetter}
          </div>
          <span className="text-xs font-semibold text-slate-700 truncate block">
            {currentWorkspaceName}
          </span>
        </div>
        <ChevronDown
          className={`w-4 h-4 text-slate-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {isOpen && (
        <div
          role="listbox"
          aria-label="Selecionar workspace"
          className="absolute top-full left-4 right-4 mt-1 bg-white border border-slate-100 rounded-lg shadow-lg z-50 py-1 max-h-60 overflow-y-auto animate-fadeIn"
        >
          {workspaces.map((ws) => {
            const isSelected = ws.id === currentWorkspaceId;
            return (
              <button
                key={ws.id}
                type="button"
                aria-pressed={isSelected}
                onClick={() => {
                  onSelectWorkspace(ws.id);
                  setIsOpen(false);
                  triggerRef.current?.focus();
                }}
                className={`w-full px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 flex items-center justify-between transition-colors ${
                  isSelected ? 'bg-teal-50/50 text-teal-900 font-semibold' : ''
                }`}
              >
                <span className="truncate">{ws.name}</span>
                {isSelected && <Check className="w-3.5 h-3.5 text-teal-600 shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
