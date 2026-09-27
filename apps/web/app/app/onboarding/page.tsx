'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import OnboardingFlow from '@/appui/components/OnboardingFlow';
import { useSession, type Workspace } from '@/lib/session';
import { api } from '@/lib/api';
import { Building2, Loader2, ArrowRight } from 'lucide-react';

export default function OnboardingPage() {
  const session = useSession();
  const router = useRouter();
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsProvisioning = session.isLive && !session.workspace && session.workspaces.length === 0;

  const handleCreateWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const created = await api<Workspace>('/v1/workspaces', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim() }),
      });
      if (created?.id) {
        session.adoptWorkspace(created);
        await session.refreshWorkspaces().catch(() => {});
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao criar workspace');
    } finally {
      setCreating(false);
    }
  };

  if (needsProvisioning) {
    return (
      <div className="max-w-md mx-auto py-12 px-4">
        <div className="bg-white rounded-2xl border border-slate-200 p-8 shadow-sm">
          <div className="w-12 h-12 rounded-xl bg-teal-50 text-teal-600 flex items-center justify-center mb-6">
            <Building2 className="w-6 h-6" />
          </div>
          <h2 className="text-xl font-bold text-slate-900 mb-2">Crie seu primeiro Workspace</h2>
          <p className="text-sm text-slate-500 mb-6">
            Para iniciar a configuração e integração de dados, informe o nome da sua empresa ou projeto.
          </p>

          <form onSubmit={handleCreateWorkspace} className="space-y-4">
            <div>
              <label htmlFor="workspace-name-input" className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5">
                Nome do Workspace
              </label>
              <input
                id="workspace-name-input"
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ex: Minha Loja Online"
                className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-600 transition-colors"
              />
            </div>

            {error && (
              <div role="alert" className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={creating || !name.trim()}
              className="w-full py-2.5 px-4 bg-teal-700 hover:bg-teal-800 disabled:opacity-50 text-white rounded-lg text-sm font-semibold flex items-center justify-center gap-2 transition-colors shadow-xs"
            >
              {creating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Criando Workspace...</span>
                </>
              ) : (
                <>
                  <span>Criar e Prosseguir</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>
        </div>
      </div>
    );
  }

  const workspaceId = session.workspace?.id || 'truvo-global';

  const handleComplete = () => {
    router.push('/app/radars');
  };

  const handleCancel = () => {
    router.push('/app');
  };

  const handleOpenIntegrations = () => {
    router.push('/app/integrations');
  };

  return (
    <div className="py-2">
      <OnboardingFlow
        key={workspaceId}
        workspaceId={workspaceId}
        onComplete={handleComplete}
        onCancel={handleCancel}
        onOpenIntegrations={handleOpenIntegrations}
        showCancelButton={true}
      />
    </div>
  );
}
