'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search,
  Loader2,
  UserSearch,
  Fingerprint,
  Mail,
  Phone,
  Smartphone,
  Clock,
  CalendarClock,
  DollarSign,
  ShoppingBag,
  Receipt,
  MousePointerClick,
  Activity,
  CalendarDays,
  ShoppingCart,
  CreditCard,
  Eye,
  MailOpen,
  LogIn,
  Heart,
  ArrowUpDown,
  Tag,
  Monitor,
  Tablet,
  TrendingUp,
  Copy,
  Check,
} from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  Tooltip,
  Cell,
} from 'recharts';
import { useLive } from '@/lib/live';
import { LiveDataBoundary } from '@/lib/live-ui';
import { useSession } from '@/lib/session';

// ----------------------------------------------------------------------------
// Tipos
// ----------------------------------------------------------------------------

type IconType = React.ComponentType<{ className?: string }>;

type SearchType = 'email' | 'telefone' | 'user_id' | 'order_id';

type EventKind =
  | 'session_start'
  | 'page_view'
  | 'product_view'
  | 'add_to_cart'
  | 'checkout_start'
  | 'purchase'
  | 'email_open'
  | 'email_click'
  | 'signup'
  | 'wishlist_add';

type CustomerStatus = 'vip' | 'ativo' | 'em_risco' | 'novo';

interface UtmData {
  source?: string;
  medium?: string;
  campaign?: string;
}

interface TimelineEvent {
  id: string;
  kind: EventKind;
  timestamp: string; // ISO
  device: string;
  detail?: string;
  order?: string;
  value?: number; // BRL
  utm?: UtmData;
}

interface AcquisitionChannel {
  label: string;
  share: number; // 0-100
}

interface CustomerDevice {
  name: string;
  os: string;
  lastSeen: string; // ISO
  type: 'mobile' | 'desktop' | 'tablet';
}

interface WeeklyActivity {
  semana: string;
  eventos: number;
}

interface CustomerProfile {
  name: string;
  initials: string;
  canonicalId: string;
  emailMasked: string;
  phoneMasked: string;
  devices: number;
  firstTouch: string;
  lastTouch: string;
  status: CustomerStatus;
  ltv: number;
  orders: number;
  avgTicket: number;
  sessions: number;
  events: number;
  daysSinceFirstTouch: number;
  tags: string[];
  channels: AcquisitionChannel[];
  deviceList: CustomerDevice[];
  weekly: WeeklyActivity[];
  timeline: TimelineEvent[];
}

// ----------------------------------------------------------------------------
// Formatação (pt-BR)
// ----------------------------------------------------------------------------

const brl = (n: number): string =>
  n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const num = (n: number): string => n.toLocaleString('pt-BR');

const fmtDateTime = (iso: string): string => {
  if (!iso || Number.isNaN(new Date(iso).getTime())) return '—';
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const fmtDate = (iso: string): string => {
  if (!iso || Number.isNaN(new Date(iso).getTime())) return '—';
  return new Date(iso).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
};

// ----------------------------------------------------------------------------
// Metadados por tipo de evento (label + ícone + tom de cor)
// ----------------------------------------------------------------------------

interface EventMeta {
  label: string;
  icon: IconType;
  ring: string; // classes do círculo do ícone
  dot: string; // cor do marcador no conector
}

const EVENT_META: Record<EventKind, EventMeta> = {
  session_start: {
    label: 'Início de Sessão',
    icon: LogIn,
    ring: 'bg-teal-50 text-teal-600 border-teal-100',
    dot: 'bg-teal-400',
  },
  page_view: {
    label: 'Visualização de Página',
    icon: Eye,
    ring: 'bg-slate-50 text-slate-500 border-slate-150',
    dot: 'bg-slate-300',
  },
  product_view: {
    label: 'Visualizou Produto',
    icon: Eye,
    ring: 'bg-slate-50 text-slate-600 border-slate-150',
    dot: 'bg-slate-300',
  },
  add_to_cart: {
    label: 'Adicionou ao Carrinho',
    icon: ShoppingCart,
    ring: 'bg-amber-50 text-amber-600 border-amber-100',
    dot: 'bg-amber-400',
  },
  checkout_start: {
    label: 'Iniciou Checkout',
    icon: CreditCard,
    ring: 'bg-amber-50 text-amber-600 border-amber-100',
    dot: 'bg-amber-400',
  },
  purchase: {
    label: 'Compra Concluída',
    icon: ShoppingBag,
    ring: 'bg-emerald-50 text-emerald-600 border-emerald-100',
    dot: 'bg-emerald-500',
  },
  email_open: {
    label: 'Abriu E-mail',
    icon: MailOpen,
    ring: 'bg-indigo-50 text-indigo-600 border-indigo-100',
    dot: 'bg-indigo-400',
  },
  email_click: {
    label: 'Clique em E-mail',
    icon: MousePointerClick,
    ring: 'bg-indigo-50 text-indigo-600 border-indigo-100',
    dot: 'bg-indigo-400',
  },
  signup: {
    label: 'Cadastro',
    icon: LogIn,
    ring: 'bg-teal-50 text-teal-600 border-teal-100',
    dot: 'bg-teal-400',
  },
  wishlist_add: {
    label: 'Salvou na Lista de Desejos',
    icon: Heart,
    ring: 'bg-rose-50 text-rose-500 border-rose-100',
    dot: 'bg-rose-400',
  },
};

const STATUS_META: Record<CustomerStatus, { label: string; cls: string }> = {
  vip: { label: 'VIP', cls: 'bg-teal-100 text-teal-800' },
  ativo: { label: 'Ativo', cls: 'bg-emerald-100 text-emerald-800' },
  em_risco: { label: 'Em Risco', cls: 'bg-amber-100 text-amber-800' },
  novo: { label: 'Novo', cls: 'bg-slate-100 text-slate-600' },
};

const DEVICE_ICON: Record<CustomerDevice['type'], IconType> = {
  mobile: Smartphone,
  desktop: Monitor,
  tablet: Tablet,
};

// ----------------------------------------------------------------------------
// MOCK — cliente de demonstração (Customer 360)
// ----------------------------------------------------------------------------

const MOCK_PROFILE: CustomerProfile = {
  name: 'Marina Rocha',
  initials: 'MR',
  canonicalId: 'cus_9f2a7c41e8b3',
  emailMasked: 'm•••••a@gmail.com',
  phoneMasked: '+55 11 9••••-4472',
  devices: 3,
  firstTouch: '2026-06-18T09:12:00',
  lastTouch: '2026-07-18T21:47:00',
  status: 'vip',
  ltv: 1179.6,
  orders: 3,
  avgTicket: 393.2,
  sessions: 14,
  events: 127,
  daysSinceFirstTouch: 31,
  tags: ['Recompra', 'Alto Ticket', 'Inverno 2026', 'Pix'],
  channels: [
    { label: 'instagram / social', share: 42 },
    { label: 'google / cpc', share: 28 },
    { label: 'klaviyo / email', share: 18 },
    { label: 'direto / none', share: 12 },
  ],
  deviceList: [
    { name: 'iPhone 15', os: 'iOS 18 · Safari', lastSeen: '2026-07-18T21:47:00', type: 'mobile' },
    { name: 'MacBook Air', os: 'macOS · Chrome', lastSeen: '2026-07-18T21:32:00', type: 'desktop' },
    { name: 'iPad Air', os: 'iPadOS · Safari', lastSeen: '2026-07-05T19:52:00', type: 'tablet' },
  ],
  weekly: [
    { semana: '18–24 jun', eventos: 34 },
    { semana: '25 jun–1 jul', eventos: 12 },
    { semana: '2–8 jul', eventos: 28 },
    { semana: '9–15 jul', eventos: 19 },
    { semana: '16–19 jul', eventos: 34 },
  ],
  timeline: [
    {
      id: 'ev-01',
      kind: 'session_start',
      timestamp: '2026-06-18T09:12:00',
      device: 'iPhone 15 · iOS',
      detail: 'Primeira visita via Stories do Instagram',
      utm: { source: 'instagram', medium: 'social', campaign: 'inverno-2026' },
    },
    {
      id: 'ev-02',
      kind: 'product_view',
      timestamp: '2026-06-18T09:14:00',
      device: 'iPhone 15 · iOS',
      detail: 'Jaqueta Corta-Vento Aurora',
    },
    {
      id: 'ev-03',
      kind: 'add_to_cart',
      timestamp: '2026-06-18T09:21:00',
      device: 'iPhone 15 · iOS',
      detail: 'Jaqueta Corta-Vento Aurora · Tam. M / Preto',
      value: 349.9,
    },
    {
      id: 'ev-04',
      kind: 'checkout_start',
      timestamp: '2026-06-18T09:24:00',
      device: 'iPhone 15 · iOS',
      detail: 'Checkout iniciado · pagamento via Pix',
    },
    {
      id: 'ev-05',
      kind: 'purchase',
      timestamp: '2026-06-18T09:31:00',
      device: 'iPhone 15 · iOS',
      detail: 'Pagamento aprovado · Pix',
      order: '#TRV-10432',
      value: 349.9,
      utm: { source: 'instagram', medium: 'social', campaign: 'inverno-2026' },
    },
    {
      id: 'ev-06',
      kind: 'email_open',
      timestamp: '2026-06-27T20:03:00',
      device: 'MacBook Air · macOS',
      detail: 'Novidades de inverno chegaram na loja',
      utm: { source: 'klaviyo', medium: 'email', campaign: 'newsletter-jun' },
    },
    {
      id: 'ev-07',
      kind: 'email_click',
      timestamp: '2026-06-27T20:05:00',
      device: 'MacBook Air · macOS',
      detail: 'Clicou no CTA "Ver coleção completa"',
      utm: { source: 'klaviyo', medium: 'email', campaign: 'newsletter-jun' },
    },
    {
      id: 'ev-08',
      kind: 'product_view',
      timestamp: '2026-07-05T19:40:00',
      device: 'iPad Air · iPadOS',
      detail: 'Calça Térmica Summit',
    },
    {
      id: 'ev-09',
      kind: 'purchase',
      timestamp: '2026-07-05T19:52:00',
      device: 'iPad Air · iPadOS',
      detail: 'Pagamento aprovado · Cartão de crédito',
      order: '#TRV-11890',
      value: 279.9,
      utm: { source: 'direct', medium: 'none' },
    },
    {
      id: 'ev-10',
      kind: 'add_to_cart',
      timestamp: '2026-07-18T21:32:00',
      device: 'MacBook Air · macOS',
      detail: 'Mochila Trilha 40L + kit de acessórios',
      value: 549.8,
      utm: { source: 'google', medium: 'cpc', campaign: 'retargeting-jul' },
    },
    {
      id: 'ev-11',
      kind: 'purchase',
      timestamp: '2026-07-18T21:47:00',
      device: 'iPhone 15 · iOS',
      detail: 'Pagamento aprovado · Pix',
      order: '#TRV-13205',
      value: 549.8,
      utm: { source: 'google', medium: 'cpc', campaign: 'retargeting-jul' },
    },
  ],
};

const EMPTY_PROFILE: CustomerProfile = {
  name: '—',
  initials: '—',
  canonicalId: '—',
  emailMasked: '—',
  phoneMasked: '—',
  devices: 0,
  firstTouch: '',
  lastTouch: '',
  status: 'novo',
  ltv: 0,
  orders: 0,
  avgTicket: 0,
  sessions: 0,
  events: 0,
  daysSinceFirstTouch: 0,
  tags: [],
  channels: [],
  deviceList: [],
  weekly: [],
  timeline: [],
};

const SEARCH_TYPES: { value: SearchType; label: string; placeholder: string }[] = [
  { value: 'email', label: 'E-mail', placeholder: 'ex.: marina@gmail.com' },
  { value: 'telefone', label: 'Telefone', placeholder: 'ex.: +55 11 98888-4472' },
  { value: 'user_id', label: 'User ID', placeholder: 'ex.: cus_9f2a7c41e8b3' },
  { value: 'order_id', label: 'Order ID', placeholder: 'ex.: #TRV-13205' },
];

const EXAMPLE_QUERIES: { type: SearchType; value: string }[] = [
  { type: 'email', value: 'marina@gmail.com' },
  { type: 'user_id', value: 'cus_9f2a7c41e8b3' },
  { type: 'order_id', value: '#TRV-13205' },
];

// ----------------------------------------------------------------------------
// Ligação com a API real (M-profiles) — fallback demo via useLive
// GET /v1/profiles/search?q=<q>&type=<t>  → { query:{type}, results:[Candidate] }
// ----------------------------------------------------------------------------

/** searchType (UI) → type (API). email/telefone já hasheados no back. */
const API_SEARCH_TYPE: Record<SearchType, string> = {
  email: 'email_hash',
  telefone: 'phone_hash',
  user_id: 'user_id',
  order_id: 'order_id',
};

interface ApiProfileMetrics {
  ltv: number | null;
  orders_count: number | null;
  aov: number | null;
  sessions_count: number | null;
  events_count: number | null;
  days_since_first_touch: number | null;
  currency: string | null;
}

interface ApiProfileCandidate {
  canonical_id: string;
  status: 'anonymous' | 'identified';
  email_hash: string | null;
  phone_hash: string | null;
  anonymous_ids_count: number | null;
  metrics: ApiProfileMetrics | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
}

interface ApiProfileSearchResponse {
  query: { type: string };
  results: ApiProfileCandidate[];
}

/** Encurta um hash para exibição (font-mono) sem quebrar em null. */
const shortHash = (h: string | null | undefined): string =>
  h ? `${h.slice(0, 12)}…` : '—';

/**
 * Mapeia um ProfileCandidate da API para a MESMA forma (CustomerProfile) que o
 * JSX já consome. Campos que o endpoint não fornece permanecem vazios.
 */
function adaptCandidate(c: ApiProfileCandidate): CustomerProfile {
  const m = c.metrics;
  const identified = c.status === 'identified';

  const tags: string[] = [];
  if (identified) tags.push('Identificado');
  else tags.push('Anônimo');
  if ((m?.orders_count ?? 0) > 0) tags.push('Comprador');

  return {
    name: identified ? 'Perfil Identificado' : 'Visitante Anônimo',
    initials: identified ? 'ID' : 'AN',
    canonicalId: c.canonical_id ?? '—',
    emailMasked: shortHash(c.email_hash),
    phoneMasked: shortHash(c.phone_hash),
    devices: c.anonymous_ids_count ?? 0,
    firstTouch: c.first_seen_at ?? '',
    lastTouch: c.last_seen_at ?? '',
    status: identified ? 'ativo' : 'novo',
    ltv: m?.ltv ?? 0,
    orders: m?.orders_count ?? 0,
    avgTicket: m?.aov ?? 0,
    sessions: m?.sessions_count ?? 0,
    events: m?.events_count ?? 0,
    daysSinceFirstTouch: m?.days_since_first_touch ?? 0,
    tags,
    channels: [],
    deviceList: [],
    weekly: [],
    timeline: [],
  };
}

// ----------------------------------------------------------------------------
// UI atoms
// ----------------------------------------------------------------------------

interface KpiCardProps {
  label: string;
  value: string;
  icon: IconType;
  hint?: string;
  accent?: string;
}

function KpiCard({ label, value, icon: Icon, hint, accent = 'text-slate-400' }: KpiCardProps) {
  return (
    <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs">
      <div className="flex items-center gap-2">
        <Icon className={`w-4 h-4 ${accent}`} />
        <span className="text-xs font-semibold text-slate-500 font-mono uppercase tracking-wider">
          {label}
        </span>
      </div>
      <h3 className="text-2xl font-bold text-slate-900 tracking-tight font-mono mt-3">{value}</h3>
      {hint && <p className="text-[10px] text-slate-400 mt-1 font-mono">{hint}</p>}
    </div>
  );
}

function UtmChip({ prefix, value }: { prefix: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[9px] font-mono bg-slate-50 border border-slate-100 text-slate-600 px-1.5 py-0.5 rounded-md">
      <span className="text-slate-400">{prefix}</span>
      <span className="font-semibold text-slate-700">{value}</span>
    </span>
  );
}

// ----------------------------------------------------------------------------
// Componente principal
// ----------------------------------------------------------------------------

export default function ProfilesView() {
  const [query, setQuery] = useState<string>('');
  const [searchType, setSearchType] = useState<SearchType>('email');
  // Estado da simulação demo (loading/resultado). Em 'live' o gating vem do fetch.
  const [demoLoading, setDemoLoading] = useState<boolean>(false);
  const [demoHasResult, setDemoHasResult] = useState<boolean>(false);
  const [order, setOrder] = useState<'recent' | 'chrono'>('recent');
  const [copied, setCopied] = useState<boolean>(false);
  // Busca submetida (dispara o useLive). null até o primeiro "Buscar".
  const [submitted, setSubmitted] = useState<{ q: string; type: SearchType } | null>(null);

  const { isLive } = useSession();

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  // Live usa apenas o resultado submetido; demo seleciona o perfil sintético explicitamente.
  const livePath = submitted
    ? `/v1/profiles/search?q=${encodeURIComponent(submitted.q)}&type=${API_SEARCH_TYPE[submitted.type]}`
    : null;
  const search = useLive<ApiProfileSearchResponse>(livePath, [submitted?.q, submitted?.type]);

  const candidate = isLive && search.status === 'success' ? (search.data?.results?.[0] ?? null) : null;
  const profile = search.status === 'demo'
    ? MOCK_PROFILE
    : candidate
      ? adaptCandidate(candidate)
      : EMPTY_PROFILE;

  // Gating do render: em 'live' derivado do fetch; em demo, da simulação.
  const liveLoading = !!submitted && search.status === 'loading';
  const liveHasResult = search.status === 'success' && !!search.data?.results?.length;
  const loading = isLive ? liveLoading : demoLoading;
  const hasResult = isLive ? liveHasResult && !liveLoading : demoHasResult;

  const runSearch = (): void => {
    const q = query.trim();
    if (!q) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    setSubmitted({ q, type: searchType });
    if (!isLive) {
      setDemoLoading(true);
      setDemoHasResult(false);
      timerRef.current = setTimeout(() => {
        setDemoLoading(false);
        setDemoHasResult(true);
      }, 480);
    }
  };

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    runSearch();
  };

  const handleExample = (type: SearchType, value: string): void => {
    setSearchType(type);
    setQuery(value);
    if (timerRef.current) clearTimeout(timerRef.current);
    setSubmitted({ q: value.trim(), type });
    if (!isLive) {
      setDemoLoading(true);
      setDemoHasResult(false);
      timerRef.current = setTimeout(() => {
        setDemoLoading(false);
        setDemoHasResult(true);
      }, 480);
    }
  };

  const handleCopyId = (): void => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(profile.canonicalId);
    }
    setCopied(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopied(false), 1600);
  };

  const placeholder = useMemo<string>(() => {
    const found = SEARCH_TYPES.find((t) => t.value === searchType);
    return found ? found.placeholder : 'Buscar…';
  }, [searchType]);

  const orderedTimeline = useMemo<TimelineEvent[]>(() => {
    const sorted = [...profile.timeline].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    return order === 'recent' ? sorted.reverse() : sorted;
  }, [profile.timeline, order]);

  const status = STATUS_META[profile.status];

  return (
    <LiveDataBoundary
      states={submitted ? [search] : []}
      empty={!!submitted && search.status === 'success' && !candidate}
      label="Busca de perfil"
    >
    <div className="space-y-6">
      {/* Toolbar de busca */}
      <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">
              Customer 360
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              Busque um usuário por e-mail, telefone, user_id ou order_id para ver o perfil unificado
              e a linha do tempo de eventos.
            </p>
          </div>
          <UserSearch className="w-5 h-5 text-teal-500 shrink-0" />
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-2.5">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={placeholder}
              className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-xl text-xs font-medium text-slate-800 placeholder:text-slate-400 focus:border-teal-500 focus:ring-2 focus:ring-teal-500/10 outline-none transition-all"
            />
          </div>

          <select
            value={searchType}
            onChange={(e) => setSearchType(e.target.value as SearchType)}
            className="px-3 py-2 border border-slate-200 rounded-xl text-xs font-semibold text-slate-700 bg-white outline-none focus:border-teal-500 cursor-pointer sm:w-40"
          >
            {SEARCH_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>

          <button
            type="submit"
            disabled={!query.trim() || loading}
            className="px-4 py-2 bg-teal-600 hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer sm:w-32"
          >
            {loading ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Buscando</span>
              </>
            ) : (
              <>
                <Search className="w-3.5 h-3.5" />
                <span>Buscar</span>
              </>
            )}
          </button>
        </form>

        {/* Exemplos rápidos */}
        <div className="flex flex-wrap items-center gap-2 mt-3">
          <span className="text-[10px] font-mono text-slate-400 uppercase tracking-wider">
            Tente:
          </span>
          {EXAMPLE_QUERIES.map((ex) => (
            <button
              key={ex.value}
              type="button"
              onClick={() => handleExample(ex.type, ex.value)}
              className="text-[10px] font-mono text-slate-600 bg-slate-50 hover:bg-slate-100 border border-slate-150 px-2 py-0.5 rounded-md transition-colors cursor-pointer"
            >
              {ex.value}
            </button>
          ))}
        </div>
      </div>

      {/* Estado vazio */}
      {!hasResult && !loading && (
        <div className="bg-white p-16 rounded-2xl border border-slate-100 shadow-xs flex flex-col items-center justify-center text-center">
          <div className="w-16 h-16 rounded-2xl bg-slate-50 border border-slate-100 flex items-center justify-center mb-4">
            <UserSearch className="w-7 h-7 text-slate-300" />
          </div>
          <h3 className="text-sm font-bold text-slate-700">Busque um usuário</h3>
          <p className="text-xs text-slate-400 mt-1.5 max-w-sm">
            Informe um e-mail, telefone, user_id ou order_id acima para carregar o perfil unificado,
            os KPIs e a linha do tempo completa de eventos.
          </p>
        </div>
      )}

      {/* Estado carregando */}
      {loading && (
        <div className="bg-white p-16 rounded-2xl border border-slate-100 shadow-xs flex flex-col items-center justify-center text-center">
          <Loader2 className="w-7 h-7 text-teal-500 animate-spin mb-3" />
          <p className="text-xs text-slate-500 font-mono">Resolvendo identidade unificada…</p>
        </div>
      )}

      {/* Resultado */}
      {hasResult && !loading && (
        <div className="space-y-6">
          {/* Cabeçalho de identidade */}
          <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-5">
              <div className="flex items-start gap-4">
                <div className="w-14 h-14 rounded-2xl bg-linear-to-br from-teal-500 to-emerald-600 flex items-center justify-center text-white text-lg font-bold shrink-0 shadow-sm shadow-teal-600/20">
                  {profile.initials}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-lg font-bold text-slate-900 tracking-tight">
                      {profile.name}
                    </h2>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase ${status.cls}`}
                    >
                      {status.label}
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={handleCopyId}
                    className="flex items-center gap-1.5 mt-1.5 text-[11px] font-mono text-slate-500 hover:text-teal-700 transition-colors cursor-pointer group"
                    title="Copiar canonical_id"
                  >
                    <Fingerprint className="w-3.5 h-3.5 text-slate-400 group-hover:text-teal-600" />
                    <span>{profile.canonicalId}</span>
                    {copied ? (
                      <Check className="w-3 h-3 text-emerald-600" />
                    ) : (
                      <Copy className="w-3 h-3 text-slate-300 group-hover:text-teal-600" />
                    )}
                  </button>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2.5 text-[11px] text-slate-600">
                    <span className="flex items-center gap-1.5 font-mono">
                      <Mail className="w-3.5 h-3.5 text-slate-400" />
                      {profile.emailMasked}
                    </span>
                    <span className="flex items-center gap-1.5 font-mono">
                      <Phone className="w-3.5 h-3.5 text-slate-400" />
                      {profile.phoneMasked}
                    </span>
                    <span className="flex items-center gap-1.5 font-mono">
                      <Smartphone className="w-3.5 h-3.5 text-slate-400" />
                      {profile.devices} dispositivos
                    </span>
                  </div>
                </div>
              </div>

              {/* Primeiro / último toque */}
              <div className="flex items-stretch gap-3 shrink-0">
                <div className="bg-slate-50/70 border border-slate-100 rounded-xl px-4 py-3">
                  <div className="flex items-center gap-1.5 text-[10px] font-mono text-slate-400 uppercase tracking-wider">
                    <Clock className="w-3.5 h-3.5" />
                    Primeiro toque
                  </div>
                  <p className="text-xs font-bold text-slate-800 font-mono mt-1.5">
                    {fmtDate(profile.firstTouch)}
                  </p>
                </div>
                <div className="bg-slate-50/70 border border-slate-100 rounded-xl px-4 py-3">
                  <div className="flex items-center gap-1.5 text-[10px] font-mono text-slate-400 uppercase tracking-wider">
                    <CalendarClock className="w-3.5 h-3.5" />
                    Último toque
                  </div>
                  <p className="text-xs font-bold text-slate-800 font-mono mt-1.5">
                    {fmtDate(profile.lastTouch)}
                  </p>
                </div>
              </div>
            </div>

            {/* Tags / segmentos */}
            {profile.tags.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 mt-5 pt-4 border-t border-slate-50">
                <Tag className="w-3.5 h-3.5 text-slate-300" />
                {profile.tags.map((t) => (
                  <span
                    key={t}
                    className="px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase bg-slate-100 text-slate-600"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* KPI row */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <KpiCard
              label="LTV"
              value={brl(profile.ltv)}
              icon={DollarSign}
              accent="text-emerald-500"
              hint="Receita total atribuída"
            />
            <KpiCard
              label="Pedidos"
              value={num(profile.orders)}
              icon={ShoppingBag}
              accent="text-teal-500"
              hint="Compras concluídas"
            />
            <KpiCard
              label="Ticket Médio"
              value={brl(profile.avgTicket)}
              icon={Receipt}
              accent="text-teal-500"
              hint="LTV / pedidos"
            />
            <KpiCard
              label="Sessões"
              value={num(profile.sessions)}
              icon={Activity}
              accent="text-slate-400"
              hint="Visitas rastreadas"
            />
            <KpiCard
              label="Eventos"
              value={num(profile.events)}
              icon={MousePointerClick}
              accent="text-slate-400"
              hint={`${profile.timeline.length} recentes`}
            />
            <KpiCard
              label="Dias 1º Toque"
              value={num(profile.daysSinceFirstTouch)}
              icon={CalendarDays}
              accent="text-slate-400"
              hint="Tempo de relacionamento"
            />
          </div>

          {/* Corpo: timeline + rail */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Timeline */}
            <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs lg:col-span-8">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">
                    Linha do Tempo de Eventos
                  </h3>
                  <p className="text-xs text-slate-500 mt-1">
                    Jornada completa do usuário através de canais e dispositivos
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setOrder((o) => (o === 'recent' ? 'chrono' : 'recent'))}
                  className="flex items-center gap-1.5 border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-xl px-3 py-1.5 text-[11px] font-bold transition-colors cursor-pointer"
                >
                  <ArrowUpDown className="w-3.5 h-3.5 text-slate-400" />
                  {order === 'recent' ? 'Mais recentes' : 'Cronológico'}
                </button>
              </div>

              <ol className="relative">
                {orderedTimeline.map((ev, idx) => {
                  const meta = EVENT_META[ev.kind];
                  const Icon = meta.icon;
                  const isLast = idx === orderedTimeline.length - 1;
                  return (
                    <li key={ev.id} className="relative flex gap-4 pb-6 last:pb-0">
                      {/* Conector vertical */}
                      {!isLast && (
                        <span className="absolute left-[19px] top-11 -bottom-0 w-px bg-slate-150" />
                      )}

                      {/* Ícone */}
                      <div
                        className={`relative z-10 w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 ${meta.ring}`}
                      >
                        <Icon className="w-4.5 h-4.5" />
                      </div>

                      {/* Conteúdo */}
                      <div className="flex-1 min-w-0 bg-slate-50/40 border border-slate-100/80 rounded-xl px-4 py-3 hover:border-slate-200 transition-colors">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <h4 className="text-xs font-bold text-slate-800">{meta.label}</h4>
                              <span className="text-[9px] font-mono text-slate-400 bg-white border border-slate-100 px-1.5 py-0.5 rounded">
                                {ev.kind}
                              </span>
                              {ev.order && (
                                <span className="text-[9px] font-mono font-bold text-teal-700 bg-teal-50 border border-teal-100 px-1.5 py-0.5 rounded">
                                  {ev.order}
                                </span>
                              )}
                            </div>
                            {ev.detail && (
                              <p className="text-[11px] text-slate-600 mt-1 truncate">{ev.detail}</p>
                            )}
                          </div>

                          {/* Valor */}
                          {typeof ev.value === 'number' && (
                            <span
                              className={`text-xs font-bold font-mono shrink-0 ${
                                ev.kind === 'purchase' ? 'text-emerald-600' : 'text-slate-500'
                              }`}
                            >
                              {ev.kind === 'purchase' ? '+' : ''}
                              {brl(ev.value)}
                            </span>
                          )}
                        </div>

                        {/* Meta: timestamp + device + utm */}
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mt-2.5">
                          <span className="flex items-center gap-1 text-[10px] font-mono text-slate-400">
                            <Clock className="w-3 h-3" />
                            {fmtDateTime(ev.timestamp)}
                          </span>
                          <span className="flex items-center gap-1 text-[10px] font-mono text-slate-400">
                            <Smartphone className="w-3 h-3" />
                            {ev.device}
                          </span>
                          {ev.utm?.source && <UtmChip prefix="src" value={ev.utm.source} />}
                          {ev.utm?.medium && <UtmChip prefix="med" value={ev.utm.medium} />}
                          {ev.utm?.campaign && <UtmChip prefix="cmp" value={ev.utm.campaign} />}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>

            {/* Rail lateral */}
            <div className="lg:col-span-4 space-y-6">
              {/* Atividade 30 dias */}
              <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs">
                <div className="flex items-center gap-1.5 mb-4">
                  <TrendingUp className="w-4 h-4 text-teal-500" />
                  <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">
                    Atividade · 30 dias
                  </h3>
                </div>
                <div className="h-28 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={profile.weekly} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
                      <XAxis
                        dataKey="semana"
                        stroke="#94a3b8"
                        fontSize={8}
                        fontFamily="monospace"
                        tickLine={false}
                        axisLine={false}
                        interval={0}
                      />
                      <Tooltip
                        cursor={{ fill: '#f1f5f9' }}
                        contentStyle={{
                          backgroundColor: '#ffffff',
                          border: '1px solid #e2e8f0',
                          borderRadius: '10px',
                          fontFamily: 'monospace',
                          fontSize: '11px',
                          boxShadow: '0 4px 12px rgba(0,0,0,0.05)',
                        }}
                        formatter={(value) => [`${value ?? 0} eventos`, '']}
                        labelStyle={{ color: '#64748b' }}
                      />
                      <Bar dataKey="eventos" radius={[5, 5, 0, 0]} barSize={26}>
                        {profile.weekly.map((_, i) => (
                          <Cell key={i} fill={i === profile.weekly.length - 1 ? '#14b8a6' : '#99f6e4'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Canais de aquisição */}
              <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs">
                <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono mb-4">
                  Canais de Aquisição
                </h3>
                <div className="space-y-3.5">
                  {profile.channels.map((c) => (
                    <div key={c.label}>
                      <div className="flex items-center justify-between text-[11px] mb-1.5">
                        <span className="font-mono text-slate-600">{c.label}</span>
                        <span className="font-mono font-bold text-slate-800">{c.share}%</span>
                      </div>
                      <div className="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full bg-linear-to-r from-teal-500 to-emerald-500"
                          style={{ width: `${c.share}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Dispositivos */}
              <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs">
                <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono mb-4">
                  Dispositivos
                </h3>
                <div className="space-y-3">
                  {profile.deviceList.map((d) => {
                    const DIcon = DEVICE_ICON[d.type];
                    return (
                      <div key={d.name} className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-lg bg-slate-50 border border-slate-100 flex items-center justify-center text-slate-500 shrink-0">
                          <DIcon className="w-4 h-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <span className="text-xs font-bold text-slate-800 block truncate">
                            {d.name}
                          </span>
                          <span className="text-[10px] text-slate-400 font-mono block truncate">
                            {d.os}
                          </span>
                        </div>
                        <span className="text-[9px] font-mono text-slate-400 shrink-0 text-right">
                          {fmtDate(d.lastSeen)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
    </LiveDataBoundary>
  );
}
