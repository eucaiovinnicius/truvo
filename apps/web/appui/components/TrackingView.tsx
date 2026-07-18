'use client';

import React, { useState } from 'react';
import { 
  Code2, 
  Copy, 
  Check, 
  Plus, 
  Trash2, 
  RefreshCw, 
  CheckCircle, 
  AlertCircle, 
  Key, 
  Power,
  Database,
  ExternalLink,
  ChevronRight,
  Sparkles
} from 'lucide-react';
import { Integration, ApiKey } from '../types';
import { useSession } from '@/lib/session';
import { useLive } from '@/lib/live';

interface TrackingViewProps {
  integrations: Integration[];
  setIntegrations: React.Dispatch<React.SetStateAction<Integration[]>>;
  apiKeys: ApiKey[];
  setApiKeys: React.Dispatch<React.SetStateAction<ApiKey[]>>;
}

// ── Live wiring: API real → MESMA forma que o JSX já consome ────────────────

/** GET /v1/api-keys → { apiKeys: [...] } (sem hash; só prefix público). */
interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  status: string; // 'active' | 'revoked'
  lastUsedAt?: string | null;
  createdAt?: string | null;
  revokedAt?: string | null;
}
interface ApiKeysResponse {
  apiKeys: ApiKeyRow[];
}

/** GET /v1/integrations (entrada / webhooks) → array de integrações. */
interface IntegrationInRow {
  id: string;
  type: string; // 'shopify' | 'stripe' | 'hotmart' | 'kiwify'
  name: string;
  status: string; // 'pending' | 'active' | 'inactive' | 'error'
  lastError?: string | null;
  lastEventAt?: string | null;
  hasCredentials?: boolean;
}

/** GET /v1/integrations-out/status → { platforms: [...] } (saída / CAPI). */
interface IntegrationOutPlatformRow {
  platform: string; // 'meta_capi' | 'google_enhanced' | 'tiktok_events'
  configured?: boolean;
  enabled?: boolean;
  status?: string; // 'not_configured' | 'pending' | 'active' | 'inactive' | 'error'
  last_error?: string | null;
  last_forward_at?: string | null;
}
interface IntegrationsOutStatusResponse {
  platforms: IntegrationOutPlatformRow[];
}

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function fmtWhen(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

/** status da API → os 3 estados que o JSX estiliza. active→connected, error→auth_error, resto→syncing. */
function mapIntegrationStatus(status?: string | null): Integration['status'] {
  if (status === 'active') return 'connected';
  if (status === 'error') return 'auth_error';
  return 'syncing';
}

function iconForPlatform(platform: string): string {
  if (platform.startsWith('meta')) return 'Meta';
  if (platform.startsWith('google')) return 'Google';
  if (platform.startsWith('tiktok')) return 'TikTok';
  return cap(platform) || '—';
}

function platformName(platform: string): string {
  switch (platform) {
    case 'meta_capi':
      return 'Meta Conversions API';
    case 'google_enhanced':
      return 'Google Enhanced';
    case 'tiktok_events':
      return 'TikTok Events';
    default:
      return cap(platform) || '—';
  }
}

/** { apiKeys } da API → ApiKey[] (mock shape). key = prefix + máscara. */
function adaptApiKeys(res: ApiKeysResponse): ApiKey[] {
  return (res.apiKeys ?? []).map((k) => ({
    id: k.id,
    name: k.name,
    key: `${k.prefix ?? ''}••••••`,
    status: k.status === 'active' ? 'active' : 'inactive',
  }));
}

/**
 * Junta entrada (/v1/integrations) + saída (/v1/integrations-out/status) num
 * Integration[] único. Retorna null quando NENHUMA fonte carregou → o chamador
 * cai no mock/props. `icon` nunca é vazio (o JSX usa `icon[0]`).
 */
function adaptIntegrations(
  inRows: IntegrationInRow[] | null,
  outStatus: IntegrationsOutStatusResponse | null,
): Integration[] | null {
  if (!inRows && !outStatus) return null;
  const list: Integration[] = [];
  for (const r of inRows ?? []) {
    list.push({
      id: r.id,
      name: r.name,
      icon: cap(r.type ?? '') || '—',
      status: mapIntegrationStatus(r.status),
      details:
        r.lastError ??
        `Webhook de entrada • ${cap(r.type ?? '') || '—'}${
          r.hasCredentials ? ' • credenciais salvas' : ''
        }`,
      lastSync: fmtWhen(r.lastEventAt),
    });
  }
  for (const p of outStatus?.platforms ?? []) {
    list.push({
      id: `out_${p.platform}`,
      name: platformName(p.platform),
      icon: iconForPlatform(p.platform),
      status: mapIntegrationStatus(p.status),
      details:
        p.last_error ??
        `${p.configured ? 'Configurada' : 'Não configurada'}${
          p.enabled ? ' • ativa' : ' • inativa'
        }`,
      lastSync: fmtWhen(p.last_forward_at),
    });
  }
  return list;
}

export default function TrackingView({
  integrations: propIntegrations,
  setIntegrations,
  apiKeys: propApiKeys,
  setApiKeys
}: TrackingViewProps) {
  const [copied, setCopied] = useState(false);
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [showAddKey, setShowAddKey] = useState(false);

  // Fonte de dados: prefere API real; em demo (ou sem workspace) useLive
  // retorna null → cai nas props/mock, intactos. Endpoints são escopados por
  // workspace via header x-workspace-id; gate no wid p/ evitar 401 prematuro.
  const wid = useSession().workspace?.id;
  const keysLive = useLive<ApiKeysResponse>(wid ? '/v1/api-keys' : null, [wid]);
  const intInLive = useLive<IntegrationInRow[]>(wid ? '/v1/integrations' : null, [wid]);
  const intOutLive = useLive<IntegrationsOutStatusResponse>(
    wid ? '/v1/integrations-out/status' : null,
    [wid],
  );

  const apiKeys: ApiKey[] = keysLive.data ? adaptApiKeys(keysLive.data) : propApiKeys;
  const liveIntegrations = adaptIntegrations(intInLive.data, intOutLive.data);
  const integrations: Integration[] = liveIntegrations ?? propIntegrations;

  // Copied Animation
  const handleCopy = () => {
    navigator.clipboard.writeText(`<!-- Truvo Analytics Real-Time Pixel -->
<script>
  !function(t,r,u,v,o){t.Truvo=o,t[o]=t[o]||function(){
  (t[o].q=t[o].q||[]).push(arguments)},t[o].l=1*new Date;
  var e=r.createElement("script");e.async=1,e.src=u;
  var a=r.getElementsByTagName("script")[0];
  a.parentNode.insertBefore(e,a)}(window,document,"https://cdn.truvo.ai/pixel.js","tr");
  
  tr('init', 'pk_live_68798e98b7a9f2');
  tr('track', 'PageView');
</script>`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Create API Key
  const handleCreateKey = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKeyLabel.trim()) return;

    const newKey: ApiKey = {
      id: `key-new-${Date.now()}`,
      name: newKeyLabel,
      key: `pk_live_${Math.random().toString(16).substring(2, 16)}`,
      status: 'active'
    };

    setApiKeys([...apiKeys, newKey]);
    setNewKeyLabel('');
    setShowAddKey(false);
  };

  // Toggle API Key Status
  const handleToggleKeyStatus = (keyId: string) => {
    setApiKeys(prev => prev.map(k => {
      if (k.id === keyId) {
        return { ...k, status: k.status === 'active' ? 'inactive' : 'active' };
      }
      return k;
    }));
  };

  // Delete API Key
  const handleDeleteKey = (keyId: string) => {
    setApiKeys(prev => prev.filter(k => k.id !== keyId));
  };

  // Connect/Disconnect Integration
  const handleToggleIntegration = (id: string) => {
    setIntegrations(prev => prev.map(item => {
      if (item.id === id) {
        if (item.status === 'auth_error' || item.status === 'syncing') {
          return {
            ...item,
            status: 'connected',
            details: `Connected to verified account. OAuth verified successfully.`,
            lastSync: 'Syncing live'
          };
        } else {
          return {
            ...item,
            status: 'auth_error',
            details: 'Disconnected by user. Re-authorization required.',
            lastSync: 'Paused'
          };
        }
      }
      return item;
    }));
  };

  return (
    <div id="tracking-view-container" className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      {/* Left Column: SDK Code & API Keys - Span 7 */}
      <div className="lg:col-span-7 space-y-6">
        {/* Pixel Integration Snippet */}
        <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Code2 className="w-4.5 h-4.5 text-teal-600" />
              <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">Truvo Universal JS Pixel</h3>
            </div>
            
            <button
              onClick={handleCopy}
              className={`px-3 py-1.5 rounded-lg border text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                copied 
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-700' 
                  : 'bg-slate-50 border-slate-100 hover:border-slate-200 text-slate-700'
              }`}
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5 text-slate-400" />}
              <span>{copied ? 'Copied Snippet!' : 'Copy Pixel Script'}</span>
            </button>
          </div>

          <p className="text-xs text-slate-500 leading-relaxed mb-4">
            Copy and paste this script tag inside the <code className="font-mono bg-slate-50 text-[11px] text-teal-800 px-1 py-0.5 rounded-md font-bold">&lt;head&gt;</code> section of your e-commerce or landing templates to monitor UTM campaign drop-offs in real time.
          </p>

          <div className="relative rounded-xl overflow-hidden bg-slate-900 border border-slate-850 p-4">
            <pre className="text-[10px] font-mono text-slate-300 overflow-x-auto leading-relaxed">
{`<!-- Truvo Analytics Real-Time Pixel -->
<script>
  !function(t,r,u,v,o){t.Truvo=o,t[o]=t[o]||function(){
  (t[o].q=t[o].q||[]).push(arguments)},t[o].l=1*new Date;
  var e=r.createElement("script");e.async=1,e.src=u;
  var a=r.getElementsByTagName("script")[0];
  a.parentNode.insertBefore(e,a)}(window,document,"https://cdn.truvo.ai/pixel.js","tr");
  
  tr('init', 'pk_live_68798e98b7a9f2');
  tr('track', 'PageView');
</script>`}
            </pre>
          </div>
        </div>

        {/* Secret Keys Management */}
        <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Key className="w-4.5 h-4.5 text-teal-600" />
              <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">Server-Side Secret Keys</h3>
            </div>
            
            <button
              onClick={() => setShowAddKey(!showAddKey)}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-900 text-white rounded-lg text-[10px] font-bold transition-all cursor-pointer flex items-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Generate API Key</span>
            </button>
          </div>

          <p className="text-xs text-slate-500 leading-normal">
            API keys allow you to push offline orders, webhook conversions, or server-side store interactions directly to Truvo's modeling databases.
          </p>

          {/* New Key Form */}
          {showAddKey && (
            <form onSubmit={handleCreateKey} className="p-3.5 bg-slate-50 rounded-xl border border-slate-150/60 flex items-end gap-3 animate-fadeIn">
              <div className="flex-1">
                <label className="text-[10px] font-mono text-slate-400 uppercase font-semibold block mb-1">Key Description Label</label>
                <input
                  type="text"
                  required
                  value={newKeyLabel}
                  onChange={(e) => setNewKeyLabel(e.target.value)}
                  placeholder="e.g. Shopify Backend Webhook"
                  className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-xs text-slate-800 outline-none focus:border-teal-500"
                />
              </div>
              <button
                type="submit"
                className="px-3 py-1.5 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-xs font-bold cursor-pointer"
              >
                Create
              </button>
            </form>
          )}

          {/* Keys list */}
          <div className="space-y-2">
            {apiKeys.map((key) => (
              <div key={key.id} className="p-3 border border-slate-100 hover:border-slate-200 rounded-xl flex items-center justify-between gap-4 transition-colors">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-slate-800">{key.name}</span>
                    <span className={`px-1.5 py-0.2 rounded-xs text-[9px] font-mono font-semibold uppercase ${
                      key.status === 'active' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-500'
                    }`}>
                      {key.status}
                    </span>
                  </div>
                  <code className="text-[10px] font-mono text-slate-400 mt-1 block select-all">{key.key}</code>
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => handleToggleKeyStatus(key.id)}
                    className={`p-1.5 rounded-lg border transition-colors ${
                      key.status === 'active' 
                        ? 'bg-rose-50 border-rose-100 text-rose-600 hover:bg-rose-100' 
                        : 'bg-emerald-50 border-emerald-100 text-emerald-600 hover:bg-emerald-100'
                    }`}
                    title={key.status === 'active' ? 'Deactivate Key' : 'Activate Key'}
                  >
                    <Power className="w-3.5 h-3.5" />
                  </button>

                  <button
                    onClick={() => handleDeleteKey(key.id)}
                    className="p-1.5 hover:bg-slate-50 border border-transparent hover:border-slate-100 rounded-lg text-slate-400 hover:text-slate-600"
                    title="Delete Key"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Right Column: Active Integrations Grid - Span 5 */}
      <div className="lg:col-span-5 space-y-6">
        <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs flex flex-col justify-between h-full">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Database className="w-4.5 h-4.5 text-teal-600" />
                <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">Live Integrations Hub</h3>
              </div>
              <span className="text-[10px] font-mono bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full font-bold uppercase">
                API Channels
              </span>
            </div>

            <p className="text-xs text-slate-500 leading-relaxed mb-4">
              Authorize secure server-side tracking pipelines with Meta Ads, Google Ads, TikTok, and Shopify. Re-authorize accounts to clear active token synchronization failures.
            </p>

            <div className="space-y-4">
              {integrations.map((item) => (
                <div key={item.id} className="p-4 bg-slate-50/60 rounded-xl border border-slate-100 hover:border-slate-150 transition-all">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {/* Custom brand initials block */}
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-bold text-xs ${
                        item.icon === 'Meta' ? 'bg-indigo-100 text-indigo-800' :
                        item.icon === 'Google' ? 'bg-red-100 text-red-800' :
                        item.icon === 'TikTok' ? 'bg-slate-900 text-white' :
                        'bg-emerald-100 text-emerald-800'
                      }`}>
                        {item.icon[0]}
                      </div>
                      <div>
                        <h4 className="text-xs font-bold text-slate-800">{item.name}</h4>
                        <span className="text-[9px] font-mono text-slate-400 block mt-0.5">{item.lastSync}</span>
                      </div>
                    </div>

                    <span className={`px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase ${
                      item.status === 'syncing' ? 'bg-teal-100 text-teal-800 sync-pulse' :
                      item.status === 'connected' ? 'bg-emerald-100 text-emerald-800' :
                      'bg-rose-100 text-rose-800'
                    }`}>
                      {item.status}
                    </span>
                  </div>

                  <p className="text-[11px] text-slate-600 font-sans mt-2 leading-normal">
                    {item.details}
                  </p>

                  <div className="mt-3 pt-2.5 border-t border-slate-150/40 flex items-center justify-between">
                    <span className="text-[9px] text-slate-400 font-mono">Platform Integration API v4.2</span>
                    <button
                      onClick={() => handleToggleIntegration(item.id)}
                      className="text-[10px] font-bold text-teal-600 hover:text-teal-700 flex items-center gap-0.5 cursor-pointer"
                    >
                      <span>{item.status === 'auth_error' ? 'Re-Authorize' : 'Disconnect'}</span>
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-6 pt-4 border-t border-slate-100">
            <div className="bg-slate-50/70 p-3.5 rounded-xl border border-slate-100 text-xs text-slate-600 leading-normal flex items-start gap-2">
              <Sparkles className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
              <p className="text-[10px] leading-relaxed">
                By default, Truvo routes connection pipelines through proxy server-direct routes to conceal API tokens from browser dev inspectors.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
