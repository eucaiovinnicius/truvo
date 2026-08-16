'use client';

import React, { useState, useEffect } from 'react';
import {
  ShoppingBag,
  CreditCard,
  Package,
  Radio,
  Send,
  RefreshCw,
  Link2,
  ArrowUpRight,
  Info,
  Zap,
  ShieldCheck,
  AlertTriangle,
  Activity,
  ChevronRight,
  Users,
} from 'lucide-react';
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import { useLive } from '@/lib/live';
import { LiveDataBoundary } from '@/lib/live-ui';
import { selectLiveData } from '@/lib/live-state';
import { useSession } from '@/lib/session';
import { api } from '@/lib/api';

// ────────────────────────────────────────────────────────────────────────────
// Tipos
// ────────────────────────────────────────────────────────────────────────────

type InboundStatus = 'connected' | 'syncing' | 'error';
type OutboundStatus = 'active' | 'attention' | 'paused';

interface InboundIntegration {
  id: string;
  name: string;
  category: string;
  icon: React.ComponentType<{ className?: string }>;
  brand: string; // cor de marca (hex) para o selo
  initials: string;
  status: InboundStatus;
  lastSync: string;
  eventsToday: number | null;
  revenueToday: number | null; // BRL
}

interface OutboundIntegration {
  id: string;
  name: string;
  subtitle: string;
  brand: string;
  initials: string;
  matchQuality: number; // EMQ 0–10
  sent: number;
  failed: number;
  enabled: boolean;
}

interface EventPoint {
  name: string;
  Enviados: number;
  Falhos: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Mock data (pt-BR)
// ────────────────────────────────────────────────────────────────────────────

const INBOUND: InboundIntegration[] = [
  {
    id: 'shopify',
    name: 'Shopify',
    category: 'E-commerce',
    icon: ShoppingBag,
    brand: '#5E8E3E',
    initials: 'Sh',
    status: 'connected',
    lastSync: 'há 2 min',
    eventsToday: 8420,
    revenueToday: 48230.5,
  },
  {
    id: 'stripe',
    name: 'Stripe',
    category: 'Pagamentos',
    icon: CreditCard,
    brand: '#635BFF',
    initials: 'St',
    status: 'connected',
    lastSync: 'há 40 s',
    eventsToday: 3110,
    revenueToday: 22940.0,
  },
  {
    id: 'hotmart',
    name: 'Hotmart',
    category: 'Infoprodutos',
    icon: Package,
    brand: '#EF4E23',
    initials: 'Ho',
    status: 'syncing',
    lastSync: 'sincronizando…',
    eventsToday: 1290,
    revenueToday: 9780.0,
  },
  {
    id: 'kiwify',
    name: 'Kiwify',
    category: 'Infoprodutos',
    icon: Package,
    brand: '#00A868',
    initials: 'Kw',
    status: 'error',
    lastSync: 'há 3 h',
    eventsToday: 0,
    revenueToday: 0,
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    category: 'CRM & Marketing',
    icon: Users,
    brand: '#FF7A59',
    initials: 'Hs',
    status: 'connected',
    lastSync: 'há 1 min',
    eventsToday: 4260,
    revenueToday: 0,
  },
];

const OUTBOUND_SEED: OutboundIntegration[] = [
  {
    id: 'meta_capi',
    name: 'Meta CAPI',
    subtitle: 'Conversions API',
    brand: '#0866FF',
    initials: 'M',
    matchQuality: 8.7,
    sent: 14230,
    failed: 62,
    enabled: true,
  },
  {
    id: 'google_ec',
    name: 'Google Enhanced Conversions',
    subtitle: 'Enhanced Conversions',
    brand: '#4285F4',
    initials: 'G',
    matchQuality: 7.9,
    sent: 7180,
    failed: 44,
    enabled: true,
  },
  {
    id: 'tiktok_events',
    name: 'TikTok Events',
    subtitle: 'Events API',
    brand: '#010101',
    initials: 'TT',
    matchQuality: 6.2,
    sent: 2908,
    failed: 214,
    enabled: true,
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    subtitle: 'Custom Behavioral Events',
    brand: '#FF7A59',
    initials: 'Hs',
    matchQuality: 7.4,
    sent: 5120,
    failed: 38,
    enabled: true,
  },
];

const EVENT_SERIES: EventPoint[] = [
  { name: 'Seg', Enviados: 19800, Falhos: 240 },
  { name: 'Ter', Enviados: 21400, Falhos: 190 },
  { name: 'Qua', Enviados: 20350, Falhos: 310 },
  { name: 'Qui', Enviados: 23100, Falhos: 205 },
  { name: 'Sex', Enviados: 24800, Falhos: 280 },
  { name: 'Sáb', Enviados: 18200, Falhos: 160 },
  { name: 'Dom', Enviados: 24318, Falhos: 320 },
];

// ────────────────────────────────────────────────────────────────────────────
// Formas da API real (M4 entrada + M9 saída) + adapters (fallback demo)
// ────────────────────────────────────────────────────────────────────────────

type InboundApiType = 'shopify' | 'stripe' | 'hotmart' | 'kiwify' | 'hubspot';
type InboundApiStatus = 'pending' | 'active' | 'inactive' | 'error';

/** Item BARE de GET /v1/integrations (entrada M4). */
interface InboundApiItem {
  id: string;
  type: InboundApiType;
  name: string;
  status: InboundApiStatus;
  lastEventAt: string | null;
  hasCredentials: boolean;
  config?: Record<string, unknown>;
}

interface OutboundApiStats {
  sent: number;
  failed: number;
  skipped: number;
  avgMatchQuality: number | null; // pegadinha: 0–10 e pode vir null
}

/** Item de platforms[] de GET /v1/integrations-out/status (saída M9). */
interface OutboundApiPlatform {
  platform: string; // meta_capi | google_enhanced | tiktok_events | hubspot
  configured: boolean;
  enabled: boolean;
  has_credentials: boolean; // snake_case no contrato
  status: string;
  last_forward_at: string | null;
  stats: OutboundApiStats;
}

interface OutboundStatusResponse {
  platforms: OutboundApiPlatform[];
}

/** status da API (M4) → status visual dos cards de entrada. */
function mapInboundStatus(s: InboundApiStatus | undefined): InboundStatus {
  if (s === 'active') return 'connected';
  if (s === 'error') return 'error';
  return 'syncing'; // pending | inactive | desconhecido
}

/** ISO → tempo relativo pt-BR curto (rótulo "último sync"). */
function relTimePt(iso: string | null | undefined): string {
  if (!iso) return 'sem eventos';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'sem eventos';
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (secs < 60) return `há ${secs} s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `há ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `há ${hrs} h`;
  return `há ${Math.floor(hrs / 24)} d`;
}

/** Metadados visuais (ícone/cor/iniciais/categoria) por tipo — reaproveita o mock. */
function inboundMetaFor(
  type: string,
): Pick<InboundIntegration, 'category' | 'icon' | 'brand' | 'initials'> {
  const m = INBOUND.find((i) => i.id === type);
  return {
    category: m?.category ?? 'Integração',
    icon: m?.icon ?? Link2,
    brand: m?.brand ?? '#64748b',
    initials: m?.initials ?? (type.slice(0, 2) || '?'),
  };
}

/** GET /v1/integrations → forma que os cards de Entrada já consomem. */
function adaptInbound(rows: InboundApiItem[]): InboundIntegration[] {
  return (rows ?? []).map((r) => {
    const meta = inboundMetaFor(r?.type ?? '');
    return {
      id: r?.id ?? r?.type ?? '',
      name: r?.name ?? meta.category,
      category: meta.category,
      icon: meta.icon,
      brand: meta.brand,
      initials: meta.initials,
      status: mapInboundStatus(r?.status),
      lastSync: relTimePt(r?.lastEventAt),
      eventsToday: null,
      revenueToday: null,
    };
  });
}

/** Metadados visuais das plataformas de saída, chaveados pelo `platform` da API. */
const OUTBOUND_META: Record<
  string,
  Pick<OutboundIntegration, 'name' | 'subtitle' | 'brand' | 'initials'>
> = {
  meta_capi: { name: 'Meta CAPI', subtitle: 'Conversions API', brand: '#0866FF', initials: 'M' },
  google_enhanced: {
    name: 'Google Enhanced Conversions',
    subtitle: 'Enhanced Conversions',
    brand: '#4285F4',
    initials: 'G',
  },
  tiktok_events: {
    name: 'TikTok Events',
    subtitle: 'Events API',
    brand: '#010101',
    initials: 'TT',
  },
  hubspot: {
    name: 'HubSpot',
    subtitle: 'Custom Behavioral Events',
    brand: '#FF7A59',
    initials: 'Hs',
  },
};

/** GET /v1/integrations-out/status → forma que os cards de Saída já consomem. */
function adaptOutbound(platforms: OutboundApiPlatform[]): OutboundIntegration[] {
  return (platforms ?? []).map((p) => {
    const meta = OUTBOUND_META[p?.platform ?? ''] ?? {
      name: p?.platform ?? 'Plataforma',
      subtitle: 'Conversions API',
      brand: '#64748b',
      initials: (p?.platform ?? '?').slice(0, 2).toUpperCase(),
    };
    return {
      id: p?.platform ?? '',
      name: meta.name,
      subtitle: meta.subtitle,
      brand: meta.brand,
      initials: meta.initials,
      matchQuality: p?.stats?.avgMatchQuality ?? 0, // EMQ = avgMatchQuality (0–10)
      sent: p?.stats?.sent ?? 0,
      failed: p?.stats?.failed ?? 0,
      enabled: p?.enabled ?? false,
    };
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

const fmtInt = (n: number): string => n.toLocaleString('pt-BR');

const fmtBRL = (n: number): string =>
  n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const INBOUND_BADGE: Record<InboundStatus, { label: string; cls: string }> = {
  connected: { label: 'conectado', cls: 'bg-emerald-100 text-emerald-800' },
  syncing: { label: 'sincronizando', cls: 'bg-amber-100 text-amber-800' },
  error: { label: 'erro de auth', cls: 'bg-rose-100 text-rose-800' },
};

const OUTBOUND_BADGE: Record<OutboundStatus, { label: string; cls: string }> = {
  active: { label: 'ativo', cls: 'bg-teal-100 text-teal-800' },
  attention: { label: 'atenção', cls: 'bg-amber-100 text-amber-800' },
  paused: { label: 'pausado', cls: 'bg-slate-100 text-slate-600' },
};

/** Estado de saída derivado do toggle + taxa de falha. */
function outboundStatus(o: OutboundIntegration): OutboundStatus {
  if (!o.enabled) return 'paused';
  const total = o.sent + o.failed;
  const failRate = total > 0 ? o.failed / total : 0;
  return failRate > 0.05 ? 'attention' : 'active';
}

/** Faixa de qualidade → gradiente + rótulo. */
function qualityMeta(emq: number): { grad: string; label: string; text: string } {
  if (emq >= 8) {
    return { grad: 'from-teal-500 to-emerald-500', label: 'excelente', text: 'text-emerald-600' };
  }
  if (emq >= 6.5) {
    return { grad: 'from-teal-400 to-teal-500', label: 'boa', text: 'text-teal-600' };
  }
  return { grad: 'from-amber-400 to-orange-500', label: 'a melhorar', text: 'text-amber-600' };
}

// ────────────────────────────────────────────────────────────────────────────
// Subcomponentes
// ────────────────────────────────────────────────────────────────────────────

function BrandSeal({
  brand,
  initials,
  size = 'md',
}: {
  brand: string;
  initials: string;
  size?: 'md' | 'lg';
}): React.ReactElement {
  const dim = size === 'lg' ? 'w-12 h-12 text-base' : 'w-11 h-11 text-sm';
  return (
    <div
      className={`${dim} rounded-xl flex items-center justify-center text-white font-bold font-mono shrink-0 shadow-xs`}
      style={{ backgroundColor: brand }}
    >
      {initials}
    </div>
  );
}

function Toggle({
  on,
  onClick,
  label,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors cursor-pointer shrink-0 ${
        on ? 'bg-teal-600' : 'bg-slate-200'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-2xs transition-transform ${
          on ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// View
// ────────────────────────────────────────────────────────────────────────────

export default function IntegrationsView(): React.ReactElement {
  // ── Live wiring (M4 entrada + M9 saída) ────────────────────────────────────
  // Em modo demo useLive retorna null → cai nos mocks (INBOUND / OUTBOUND_SEED).
  const inboundLive = useLive<InboundApiItem[]>('/v1/integrations', []);
  const outboundLive = useLive<OutboundStatusResponse>('/v1/integrations-out/status', []);

  // Entrada: real quando 'live' (e não-vazio); senão o mock existente.
  const inbound: InboundIntegration[] = selectLiveData(inboundLive, INBOUND, [], adaptInbound);

  const { isLive } = useSession();
  const [outbound, setOutbound] = useState<OutboundIntegration[]>([]);
  const [outError, setOutError] = useState<string | null>(null);

  // Saída: quando o live chega, hidrata o estado (preserva o toggle otimista local).
  useEffect(() => {
    if (outboundLive.status === 'demo') setOutbound(OUTBOUND_SEED);
    else if (outboundLive.status === 'success') setOutbound(adaptOutbound(outboundLive.data?.platforms ?? []));
    else setOutbound([]);
  }, [outboundLive.status, outboundLive.data]);

  // Toggle — demo: só local; live: PUT /v1/integrations-out/:platform { enabled }.
  // Hoje isso falha-fechado sem INTEGRATIONS_ENCRYPTION_KEY → revertemos e avisamos.
  const toggleOutbound = (id: string): void => {
    const next = !(outbound.find((o) => o.id === id)?.enabled ?? false);
    setOutbound((prev) => prev.map((o) => (o.id === id ? { ...o, enabled: next } : o)));
    if (!isLive) return;
    setOutError(null);
    void api(`/v1/integrations-out/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled: next }),
    }).catch(() => {
      setOutbound((prev) => prev.map((o) => (o.id === id ? { ...o, enabled: !next } : o)));
      setOutError(
        'Não foi possível atualizar a integração de saída. Configure a chave de criptografia (INTEGRATIONS_ENCRYPTION_KEY) no servidor.',
      );
      setTimeout(() => setOutError(null), 5000);
    });
  };

  // KPIs derivados (reagem aos toggles) ──────────────────────────────────────
  const inboundConnected = inbound.filter((i) => i.status === 'connected').length;
  const outboundEnabled = outbound.filter((o) => o.enabled).length;
  const activeCount = inboundConnected + outboundEnabled;
  const totalConnections = inbound.length + outbound.length;

  const eventsSentToday = outbound
    .filter((o) => o.enabled)
    .reduce((acc, o) => acc + o.sent, 0);

  const enabledOut = outbound.filter((o) => o.enabled);
  const avgMatchQuality =
    enabledOut.length > 0
      ? enabledOut.reduce((acc, o) => acc + o.matchQuality, 0) / enabledOut.length
      : 0;

  const totalFailed = outbound.reduce((acc, o) => acc + o.failed, 0);

  return (
    <LiveDataBoundary
      states={[inboundLive, outboundLive]}
      empty={inbound.length === 0 && outbound.length === 0}
      label="Integrações"
    >
    <div id="integrations-view-container" className="space-y-6">
      {/* Header row */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono flex items-center gap-2">
            <Link2 className="w-4 h-4 text-teal-600" />
            Integrations Hub
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Conexões server-side de entrada (vendas &amp; eventos) e saída (Conversions API).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden sm:flex items-center gap-1.5 text-[10px] font-mono text-slate-500">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            Túnel de eventos ativo
          </span>
          <button
            type="button"
            className="px-4 py-2 border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5 text-slate-400" />
            Sincronizar tudo
          </button>
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {/* Integrações ativas */}
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 font-mono uppercase tracking-wider">
              Integrações Ativas
            </span>
            <span className="w-8 h-8 rounded-lg bg-teal-50 border border-teal-100 flex items-center justify-center text-teal-600">
              <Zap className="w-4 h-4" />
            </span>
          </div>
          <div className="mt-3">
            <h3 className="text-2xl font-bold text-slate-900 tracking-tight font-mono">
              {activeCount}
              <span className="text-base text-slate-400 font-mono"> / {totalConnections}</span>
            </h3>
            <p className="text-[10px] text-slate-400 mt-1 flex items-center gap-1 font-mono">
              <Info className="w-3.5 h-3.5 shrink-0" />
              {inboundConnected} entrada · {outboundEnabled} saída
            </p>
          </div>
        </div>

        {/* Eventos enviados hoje */}
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 font-mono uppercase tracking-wider">
              Eventos Enviados Hoje
            </span>
            <span className="flex items-center gap-0.5 text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
              <ArrowUpRight className="w-3 h-3" />
              12.8%
            </span>
          </div>
          <div className="mt-3">
            <h3 className="text-2xl font-bold text-slate-900 tracking-tight font-mono">
              {fmtInt(eventsSentToday)}
            </h3>
            <p className="text-[10px] text-slate-400 mt-1 flex items-center gap-1 font-mono">
              <Info className="w-3.5 h-3.5 shrink-0" />
              {fmtInt(totalFailed)} falhas nas últimas 24h
            </p>
          </div>
          <div className="mt-4 h-9 w-full">
            <svg
              className="w-full h-full text-teal-500 overflow-visible"
              viewBox="0 0 120 40"
              preserveAspectRatio="none"
            >
              <defs>
                <linearGradient id="grad-int-events" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="currentColor" stopOpacity="0.15" />
                  <stop offset="100%" stopColor="currentColor" stopOpacity="0.0" />
                </linearGradient>
              </defs>
              <path
                d="M 0 30 C 20 26, 40 30, 60 20 C 80 12, 100 16, 120 8 L 120 40 L 0 40 Z"
                fill="url(#grad-int-events)"
              />
              <path
                d="M 0 30 C 20 26, 40 30, 60 20 C 80 12, 100 16, 120 8"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </div>
        </div>

        {/* Match quality médio */}
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 font-mono uppercase tracking-wider">
              Match Quality Médio
            </span>
            <span className="w-8 h-8 rounded-lg bg-emerald-50 border border-emerald-100 flex items-center justify-center text-emerald-600">
              <ShieldCheck className="w-4 h-4" />
            </span>
          </div>
          <div className="mt-3">
            <h3 className="text-2xl font-bold text-slate-900 tracking-tight font-mono">
              {avgMatchQuality.toFixed(1)}
              <span className="text-base text-slate-400 font-mono"> / 10</span>
            </h3>
            <p className="text-[10px] text-slate-400 mt-1 flex items-center gap-1 font-mono">
              <Info className="w-3.5 h-3.5 shrink-0" />
              EMQ médio das plataformas ativas
            </p>
          </div>
          <div className="mt-3 w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full bg-linear-to-r from-teal-500 to-emerald-500 transition-all"
              style={{ width: `${Math.min(100, (avgMatchQuality / 10) * 100)}%` }}
            />
          </div>
        </div>
      </div>

      {/* ── Entrada (vendas & eventos) ─────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono flex items-center gap-1.5">
              <Radio className="w-3.5 h-3.5 text-teal-600" />
              Entrada — Vendas &amp; Eventos
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              Webhooks server-side que alimentam a atribuição com pedidos e conversões reais.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-5">
          {inbound.map((it) => {
            const badge = INBOUND_BADGE[it.status];
            const Icon = it.icon;
            const isError = it.status === 'error';
            return (
              <div
                key={it.id}
                className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs flex flex-col justify-between hover:border-slate-200 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <BrandSeal brand={it.brand} initials={it.initials} />
                    <div className="min-w-0">
                      <h4 className="text-sm font-bold text-slate-800 truncate">{it.name}</h4>
                      <span className="text-[10px] text-slate-400 font-mono flex items-center gap-1 mt-0.5">
                        <Icon className="w-3 h-3" />
                        {it.category}
                      </span>
                    </div>
                  </div>
                  <span
                    className={`px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase inline-flex items-center gap-1 shrink-0 ${badge.cls}`}
                  >
                    {it.status === 'syncing' && (
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                    )}
                    {badge.label}
                  </span>
                </div>

                {/* métricas */}
                <div className="mt-5 grid grid-cols-2 gap-3">
                  <div className="bg-slate-50/70 rounded-xl border border-slate-100/70 p-2.5">
                    <span className="text-[9px] font-mono text-slate-400 uppercase font-bold block">
                      Eventos hoje
                    </span>
                    <span className="text-sm font-bold text-slate-800 font-mono">
                      {it.eventsToday === null ? '—' : fmtInt(it.eventsToday)}
                    </span>
                  </div>
                  <div className="bg-slate-50/70 rounded-xl border border-slate-100/70 p-2.5">
                    <span className="text-[9px] font-mono text-slate-400 uppercase font-bold block">
                      Receita hoje
                    </span>
                    <span className="text-sm font-bold text-slate-800 font-mono">
                      {it.revenueToday !== null && it.revenueToday > 0 ? fmtBRL(it.revenueToday) : '—'}
                    </span>
                  </div>
                </div>

                {isError && (
                  <div className="mt-3 flex items-start gap-1.5 text-[10px] text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-2.5 py-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                    <span>Token OAuth expirado — reautorize para retomar o sync.</span>
                  </div>
                )}

                <div className="mt-4 pt-4 border-t border-slate-50 flex items-center justify-between">
                  <span className="text-[10px] text-slate-400 font-mono flex items-center gap-1">
                    <RefreshCw className={`w-3 h-3 ${it.status === 'syncing' ? 'animate-spin' : ''}`} />
                    {it.lastSync}
                  </span>
                  {isError ? (
                    <button
                      type="button"
                      className="px-3 py-1.5 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-[11px] font-bold transition-colors cursor-pointer"
                    >
                      Reautorizar
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="px-3 py-1.5 border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-xl text-[11px] font-bold transition-colors cursor-pointer flex items-center gap-1"
                    >
                      Gerenciar
                      <ChevronRight className="w-3 h-3 text-slate-400" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Volume de eventos (chart) ──────────────────────────────────────── */}
      <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-teal-600" />
              Volume de Eventos — Conversions API
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              Eventos enviados vs. falhos ao longo dos últimos 7 dias
            </p>
          </div>
          <div className="flex items-center gap-4 text-xs font-mono">
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 bg-teal-500 rounded-xs" />
              <span className="text-slate-600 font-medium">Enviados</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-1.5 bg-rose-500 rounded-full inline-block" />
              <span className="text-slate-600 font-medium">Falhos</span>
            </div>
          </div>
        </div>

        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={EVENT_SERIES} margin={{ top: 10, right: -5, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis
                dataKey="name"
                stroke="#94a3b8"
                fontSize={10}
                fontFamily="JetBrains Mono"
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                yAxisId="left"
                stroke="#94a3b8"
                fontSize={10}
                fontFamily="JetBrains Mono"
                tickLine={false}
                axisLine={false}
                tickFormatter={(val: number) => `${Math.round(val / 1000)}k`}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                stroke="#94a3b8"
                fontSize={10}
                fontFamily="JetBrains Mono"
                tickLine={false}
                axisLine={false}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#ffffff',
                  border: '1px solid #e2e8f0',
                  borderRadius: '12px',
                  fontFamily: 'Inter',
                  fontSize: '11px',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.05)',
                }}
                formatter={(value) => {
                  const n = Array.isArray(value)
                    ? 0
                    : typeof value === 'number'
                      ? value
                      : Number(value) || 0;
                  return fmtInt(n);
                }}
              />
              <Bar
                yAxisId="left"
                dataKey="Enviados"
                fill="#14b8a6"
                fillOpacity={0.85}
                radius={[6, 6, 0, 0]}
                barSize={30}
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="Falhos"
                stroke="#f43f5e"
                strokeWidth={2.5}
                dot={{ r: 3, fill: '#f43f5e', strokeWidth: 0 }}
                activeDot={{ r: 5 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Saída (Conversions API) ────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono flex items-center gap-1.5">
              <Send className="w-3.5 h-3.5 text-teal-600" />
              Saída — Conversions API
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              Encaminhamento server-side de conversões para recuperar sinal perdido pelo pixel.
            </p>
          </div>
        </div>

        {outError && (
          <div className="mb-3 p-3 bg-rose-50 border border-rose-100 rounded-xl flex items-start gap-2 text-[11px] text-rose-700">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
            <span>{outError}</span>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {outbound.map((o) => {
            const status = outboundStatus(o);
            const badge = OUTBOUND_BADGE[status];
            const q = qualityMeta(o.matchQuality);
            const total = o.sent + o.failed;
            const failRate = total > 0 ? (o.failed / total) * 100 : 0;
            return (
              <div
                key={o.id}
                className={`bg-white p-6 rounded-2xl border shadow-xs flex flex-col justify-between transition-colors ${
                  o.enabled ? 'border-slate-100 hover:border-slate-200' : 'border-slate-100 opacity-75'
                }`}
              >
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <BrandSeal brand={o.brand} initials={o.initials} size="lg" />
                      <div className="min-w-0">
                        <h4 className="text-sm font-bold text-slate-800 truncate">{o.name}</h4>
                        <span className="text-[10px] text-slate-400 font-mono">{o.subtitle}</span>
                      </div>
                    </div>
                    <Toggle
                      on={o.enabled}
                      onClick={() => toggleOutbound(o.id)}
                      label={`Habilitar ${o.name}`}
                    />
                  </div>

                  <div className="mt-3 flex items-center gap-2">
                    <span
                      className={`px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase inline-flex items-center gap-1 ${badge.cls}`}
                    >
                      {status === 'active' && (
                        <span className="w-1.5 h-1.5 rounded-full bg-teal-500 animate-pulse" />
                      )}
                      {badge.label}
                    </span>
                    <span className="text-[10px] text-slate-400 font-mono">
                      {o.enabled ? 'encaminhando eventos' : 'encaminhamento pausado'}
                    </span>
                  </div>

                  {/* EMQ / Match quality */}
                  <div className="mt-5">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider font-semibold flex items-center gap-1">
                        <ShieldCheck className="w-3.5 h-3.5 text-slate-400" />
                        Match Quality (EMQ)
                      </span>
                      <span className={`text-xs font-bold font-mono ${q.text}`}>
                        {o.matchQuality.toFixed(1)}
                        <span className="text-[9px] text-slate-400"> /10 · {q.label}</span>
                      </span>
                    </div>
                    <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full bg-linear-to-r ${q.grad}`}
                        style={{ width: `${(o.matchQuality / 10) * 100}%` }}
                      />
                    </div>
                  </div>

                  {/* Eventos enviados / falhos */}
                  <div className="mt-5 grid grid-cols-2 gap-3">
                    <div className="bg-slate-50/70 rounded-xl border border-slate-100/70 p-3">
                      <span className="text-[9px] font-mono text-slate-400 uppercase font-bold block">
                        Enviados
                      </span>
                      <span className="text-base font-bold text-slate-800 font-mono">
                        {fmtInt(o.sent)}
                      </span>
                    </div>
                    <div className="bg-slate-50/70 rounded-xl border border-slate-100/70 p-3">
                      <span className="text-[9px] font-mono text-slate-400 uppercase font-bold block">
                        Falhos
                      </span>
                      <span
                        className={`text-base font-bold font-mono ${
                          failRate > 5 ? 'text-rose-500' : 'text-slate-800'
                        }`}
                      >
                        {fmtInt(o.failed)}
                        <span className="text-[9px] text-slate-400 ml-1">
                          ({failRate.toFixed(1)}%)
                        </span>
                      </span>
                    </div>
                  </div>
                </div>

                <div className="mt-4 pt-4 border-t border-slate-50 flex items-center justify-between">
                  <span className="text-[10px] text-slate-400 font-mono">
                    Dataset ID · {o.id}
                  </span>
                  <button
                    type="button"
                    className="text-teal-600 hover:text-teal-700 text-[11px] font-bold flex items-center gap-1 transition-colors cursor-pointer"
                  >
                    Configurar
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
    </LiveDataBoundary>
  );
}
