'use client';

import React, { useMemo, useState } from 'react';
import {
  ShieldCheck,
  Scale,
  Landmark,
  AlertTriangle,
  Bot,
  Users,
  Activity,
  Fingerprint,
  Server,
  Gauge,
  Info,
  ArrowUpRight,
  ArrowDownRight,
  CheckCircle2,
} from 'lucide-react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

type ReconStatus = 'reconciliado' | 'incerto' | 'sem_ground_truth';

interface ReconInput {
  /** ISO date (YYYY-MM-DD) */
  date: string;
  /** Receita atribuída pela Truvo (R$). */
  truvo: number;
  /** Receita confirmada pelo gateway (R$). null = sem ground truth. */
  gateway: number | null;
}

interface ReconRow extends ReconInput {
  /** Gap absoluto em % vs gateway (0 quando não há ground truth). */
  gapPct: number;
  status: ReconStatus;
}

interface BotReason {
  rule: string;
  category: 'user-agent' | 'datacenter-ip' | 'rate';
  count: number;
  /** Tendência vs período anterior (%). Positivo = mais eventos filtrados. */
  trend: number;
}

// ---------------------------------------------------------------------------
// Helpers de formatação (pt-BR)
// ---------------------------------------------------------------------------

const brl = (n: number): string =>
  n.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const brlCompact = (n: number): string =>
  `R$ ${n.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}`;

const int = (n: number): string => n.toLocaleString('pt-BR');

const pct = (n: number, digits = 1): string =>
  `${n.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;

/** dd/mm a partir de YYYY-MM-DD. */
const shortDate = (iso: string): string => {
  const parts = iso.split('-');
  return parts.length === 3 ? `${parts[2]}/${parts[1]}` : iso;
};

// ---------------------------------------------------------------------------
// Mock — reconciliação diária (últimos 14 dias)
// ---------------------------------------------------------------------------

const RAW_RECON: ReconInput[] = [
  { date: '2026-07-06', truvo: 48210.5, gateway: 47980.0 },
  { date: '2026-07-07', truvo: 52840.9, gateway: 52610.4 },
  { date: '2026-07-08', truvo: 61120.0, gateway: 59340.8 },
  { date: '2026-07-09', truvo: 57430.2, gateway: 57190.6 },
  { date: '2026-07-10', truvo: 66980.7, gateway: null },
  { date: '2026-07-11', truvo: 71240.3, gateway: 70880.1 },
  { date: '2026-07-12', truvo: 69410.8, gateway: 64120.5 },
  { date: '2026-07-13', truvo: 58720.4, gateway: 58510.9 },
  { date: '2026-07-14', truvo: 63180.0, gateway: 62940.2 },
  { date: '2026-07-15', truvo: 74620.6, gateway: 69210.3 },
  { date: '2026-07-16', truvo: 78310.1, gateway: 78040.7 },
  { date: '2026-07-17', truvo: 81990.5, gateway: null },
  { date: '2026-07-18', truvo: 85240.9, gateway: 84870.2 },
  { date: '2026-07-19', truvo: 79880.3, gateway: 74520.6 },
];

const UNCERTAIN_THRESHOLD = 2; // gap % a partir do qual o dia vira "incerto"

function classify(input: ReconInput): ReconRow {
  if (input.gateway === null || input.gateway <= 0) {
    return { ...input, gapPct: 0, status: 'sem_ground_truth' };
  }
  const gapPct = (Math.abs(input.truvo - input.gateway) / input.gateway) * 100;
  const status: ReconStatus = gapPct < UNCERTAIN_THRESHOLD ? 'reconciliado' : 'incerto';
  return { ...input, gapPct, status };
}

// ---------------------------------------------------------------------------
// Mock — filtro de bots
// ---------------------------------------------------------------------------

const TOTAL_EVENTS = 1_284_503;
const BOT_EVENTS = 150_287;
const HUMAN_EVENTS = TOTAL_EVENTS - BOT_EVENTS;

const BOT_REASONS: BotReason[] = [
  { rule: 'User-agent de crawler conhecido', category: 'user-agent', count: 41230, trend: 6.4 },
  { rule: 'IP em datacenter (AWS / GCP / Azure)', category: 'datacenter-ip', count: 38610, trend: 12.1 },
  { rule: 'Rate anômalo por sessão (> 40 ev/min)', category: 'rate', count: 27980, trend: -3.2 },
  { rule: 'Navegador headless (Puppeteer/Selenium)', category: 'user-agent', count: 18740, trend: 9.8 },
  { rule: 'Faixa de IP em blocklist (proxy/VPN)', category: 'datacenter-ip', count: 13120, trend: 1.5 },
  { rule: 'Cadência de cliques sub-humana (< 80ms)', category: 'rate', count: 10607, trend: -1.1 },
];

const CATEGORY_META: Record<
  BotReason['category'],
  { label: string; badge: string; icon: React.ComponentType<{ className?: string }> }
> = {
  'user-agent': {
    label: 'User-Agent',
    badge: 'bg-teal-100 text-teal-800',
    icon: Fingerprint,
  },
  'datacenter-ip': {
    label: 'Datacenter IP',
    badge: 'bg-amber-100 text-amber-800',
    icon: Server,
  },
  rate: {
    label: 'Rate',
    badge: 'bg-slate-100 text-slate-600',
    icon: Gauge,
  },
};

const STATUS_META: Record<ReconStatus, { label: string; badge: string }> = {
  reconciliado: { label: 'Reconciliado', badge: 'bg-emerald-100 text-emerald-800' },
  incerto: { label: 'Incerto', badge: 'bg-amber-100 text-amber-800' },
  sem_ground_truth: { label: 'Sem Ground Truth', badge: 'bg-slate-100 text-slate-600' },
};

// ---------------------------------------------------------------------------
// Tooltip do gráfico
// ---------------------------------------------------------------------------

interface ChartPoint {
  label: string;
  status: ReconStatus;
  Truvo: number;
  Gateway: number | null;
}

interface TooltipEntry {
  name?: string;
  value?: number | null;
  color?: string;
}

function ReconTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string;
}): React.ReactElement | null {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-md px-3 py-2.5 text-[11px]">
      <p className="font-mono font-bold text-slate-700 mb-1.5">{label}</p>
      {payload.map((entry) => (
        <div key={entry.name} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-slate-500">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
            {entry.name}
          </span>
          <span className="font-mono font-semibold text-slate-800">
            {entry.value == null ? '—' : brl(entry.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Componente
// ---------------------------------------------------------------------------

type ReconFilter = 'todos' | ReconStatus;

export default function DataQualityView(): React.ReactElement {
  const [filter, setFilter] = useState<ReconFilter>('todos');

  const rows: ReconRow[] = useMemo(() => RAW_RECON.map(classify), []);

  // Agregados para os KPIs
  const {
    totalTruvo,
    totalGateway,
    globalGapPct,
    uncertainDays,
  } = useMemo(() => {
    let tTruvo = 0;
    let tGateway = 0;
    let tTruvoWithGt = 0;
    let uncertain = 0;
    for (const r of rows) {
      tTruvo += r.truvo;
      if (r.gateway !== null) {
        tGateway += r.gateway;
        tTruvoWithGt += r.truvo;
      }
      if (r.status !== 'reconciliado') uncertain += 1;
    }
    const gap = tGateway > 0 ? (Math.abs(tTruvoWithGt - tGateway) / tGateway) * 100 : 0;
    return {
      totalTruvo: tTruvo,
      totalGateway: tGateway,
      globalGapPct: gap,
      uncertainDays: uncertain,
    };
  }, [rows]);

  const chartData: ChartPoint[] = useMemo(
    () =>
      rows.map((r) => ({
        label: shortDate(r.date),
        status: r.status,
        Truvo: r.truvo,
        Gateway: r.gateway,
      })),
    [rows],
  );

  const visibleRows: ReconRow[] = useMemo(
    () => (filter === 'todos' ? rows : rows.filter((r) => r.status === filter)),
    [rows, filter],
  );

  const botPct = (BOT_EVENTS / TOTAL_EVENTS) * 100;
  const humanPct = (HUMAN_EVENTS / TOTAL_EVENTS) * 100;
  const maxReason = Math.max(...BOT_REASONS.map((b) => b.count));

  const filterTabs: { id: ReconFilter; label: string }[] = [
    { id: 'todos', label: 'Todos' },
    { id: 'reconciliado', label: 'Reconciliados' },
    { id: 'incerto', label: 'Incertos' },
    { id: 'sem_ground_truth', label: 'Sem Ground Truth' },
  ];

  return (
    <div id="data-quality-view-container" className="space-y-6">
      {/* ---- Header ---- */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-teal-600" />
            Data Quality
          </h2>
          <p className="text-xs text-slate-500 mt-1 font-sans">
            Reconciliação de receita contra o gateway de pagamento e filtragem de tráfego não-humano.
            <span className="text-teal-600 font-semibold ml-1">
              Ground truth = valor liquidado confirmado pelo provedor.
            </span>
          </p>
        </div>
        <span className="self-start inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 bg-white text-[10px] font-mono font-bold uppercase tracking-wider text-slate-500">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          Sync a cada 6h
        </span>
      </div>

      {/* ---- KPI Row ---- */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
        {/* Gap de reconciliação */}
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 font-mono uppercase tracking-wider">
              Gap de Reconciliação
            </span>
            <span
              className={`flex items-center gap-0.5 text-[10px] font-bold px-2 py-0.5 rounded-full ${
                globalGapPct < UNCERTAIN_THRESHOLD
                  ? 'text-emerald-600 bg-emerald-50'
                  : 'text-amber-600 bg-amber-50'
              }`}
            >
              {globalGapPct < UNCERTAIN_THRESHOLD ? (
                <CheckCircle2 className="w-3 h-3" />
              ) : (
                <AlertTriangle className="w-3 h-3" />
              )}
              {globalGapPct < UNCERTAIN_THRESHOLD ? 'OK' : 'Atenção'}
            </span>
          </div>
          <div className="mt-3">
            <h3 className="text-2xl font-bold text-slate-900 tracking-tight font-mono">
              {pct(globalGapPct)}
            </h3>
            <p className="text-[10px] text-slate-400 mt-1 flex items-center gap-1 font-mono">
              <Scale className="w-3.5 h-3.5 shrink-0" />
              Truvo vs Gateway (14d)
            </p>
          </div>
          <div className="mt-4 h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full ${
                globalGapPct < UNCERTAIN_THRESHOLD ? 'bg-emerald-500' : 'bg-amber-500'
              }`}
              style={{ width: `${Math.min(100, (globalGapPct / (UNCERTAIN_THRESHOLD * 3)) * 100)}%` }}
            />
          </div>
        </div>

        {/* Receita Truvo */}
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 font-mono uppercase tracking-wider">
              Receita Truvo
            </span>
            <span className="flex items-center gap-0.5 text-[10px] font-bold text-teal-600 bg-teal-50 px-2 py-0.5 rounded-full">
              <ArrowUpRight className="w-3 h-3" />
              Atribuída
            </span>
          </div>
          <div className="mt-3">
            <h3 className="text-2xl font-bold text-slate-900 tracking-tight font-mono">
              {brlCompact(totalTruvo)}
            </h3>
            <p className="text-[10px] text-slate-400 mt-1 flex items-center gap-1 font-mono">
              <Activity className="w-3.5 h-3.5 shrink-0" />
              Modelo de atribuição Truvo
            </p>
          </div>
          <div className="mt-4 h-10 w-full">
            <svg
              className="w-full h-full text-teal-500 overflow-visible"
              viewBox="0 0 120 40"
              preserveAspectRatio="none"
            >
              <defs>
                <linearGradient id="dq-grad-truvo" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="currentColor" stopOpacity="0.15" />
                  <stop offset="100%" stopColor="currentColor" stopOpacity="0.0" />
                </linearGradient>
              </defs>
              <path
                d="M 0 30 C 20 28, 40 22, 60 20 C 80 18, 100 10, 120 8 L 120 40 L 0 40 Z"
                fill="url(#dq-grad-truvo)"
              />
              <path
                d="M 0 30 C 20 28, 40 22, 60 20 C 80 18, 100 10, 120 8"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </div>
        </div>

        {/* Receita Gateway */}
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 font-mono uppercase tracking-wider">
              Receita Gateway
            </span>
            <span className="flex items-center gap-0.5 text-[10px] font-bold text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">
              <Landmark className="w-3 h-3" />
              Liquidada
            </span>
          </div>
          <div className="mt-3">
            <h3 className="text-2xl font-bold text-slate-900 tracking-tight font-mono">
              {brlCompact(totalGateway)}
            </h3>
            <p className="text-[10px] text-slate-400 mt-1 flex items-center gap-1 font-mono">
              <Landmark className="w-3.5 h-3.5 shrink-0" />
              Confirmada pelo provedor
            </p>
          </div>
          <div className="mt-4 h-10 w-full">
            <svg
              className="w-full h-full text-slate-800 overflow-visible"
              viewBox="0 0 120 40"
              preserveAspectRatio="none"
            >
              <defs>
                <linearGradient id="dq-grad-gateway" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="currentColor" stopOpacity="0.12" />
                  <stop offset="100%" stopColor="currentColor" stopOpacity="0.0" />
                </linearGradient>
              </defs>
              <path
                d="M 0 32 C 20 30, 40 24, 60 23 C 80 22, 100 13, 120 11 L 120 40 L 0 40 Z"
                fill="url(#dq-grad-gateway)"
              />
              <path
                d="M 0 32 C 20 30, 40 24, 60 23 C 80 22, 100 13, 120 11"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </div>
        </div>

        {/* Dias incertos */}
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 font-mono uppercase tracking-wider">
              Dias Incertos
            </span>
            <span
              className={`flex items-center gap-0.5 text-[10px] font-bold px-2 py-0.5 rounded-full ${
                uncertainDays <= 2 ? 'text-emerald-600 bg-emerald-50' : 'text-amber-600 bg-amber-50'
              }`}
            >
              {uncertainDays <= 2 ? (
                <ArrowDownRight className="w-3 h-3" />
              ) : (
                <ArrowUpRight className="w-3 h-3" />
              )}
              de {rows.length}
            </span>
          </div>
          <div className="mt-3">
            <h3 className="text-2xl font-bold text-slate-900 tracking-tight font-mono">
              {int(uncertainDays)}
            </h3>
            <p className="text-[10px] text-slate-400 mt-1 flex items-center gap-1 font-mono">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              Gap ≥ {UNCERTAIN_THRESHOLD}% ou sem GT
            </p>
          </div>
          <div className="mt-4 flex items-center gap-1">
            {rows.map((r) => (
              <div
                key={r.date}
                title={`${shortDate(r.date)} — ${STATUS_META[r.status].label}`}
                className={`h-2 flex-1 rounded-full ${
                  r.status === 'reconciliado'
                    ? 'bg-emerald-400'
                    : r.status === 'incerto'
                      ? 'bg-amber-400'
                      : 'bg-slate-300'
                }`}
              />
            ))}
          </div>
        </div>
      </div>

      {/* ---- Seção Reconciliação: gráfico ---- */}
      <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">
              Reconciliação de Receita
            </h3>
            <p className="text-xs text-slate-500 mt-1 font-sans">
              Receita atribuída (Truvo) vs receita liquidada (gateway) ao longo dos últimos 14 dias.
            </p>
          </div>
          <div className="flex items-center gap-4 text-xs font-mono">
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 bg-teal-500 rounded-xs" />
              <span className="text-slate-600 font-medium">Truvo</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 bg-slate-800 rounded-xs" />
              <span className="text-slate-600 font-medium">Gateway</span>
            </div>
          </div>
        </div>

        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 10, right: 4, left: -8, bottom: 0 }}>
              <defs>
                <linearGradient id="dq-area-truvo" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#14b8a6" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="#14b8a6" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="dq-area-gateway" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#0f172a" stopOpacity={0.14} />
                  <stop offset="95%" stopColor="#0f172a" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis
                dataKey="label"
                stroke="#94a3b8"
                fontSize={10}
                fontFamily="monospace"
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                stroke="#94a3b8"
                fontSize={10}
                fontFamily="monospace"
                tickLine={false}
                axisLine={false}
                width={54}
                tickFormatter={(v: number) => `R$${Math.round(v / 1000)}k`}
              />
              <Tooltip content={<ReconTooltip />} />
              <Legend
                wrapperStyle={{ fontSize: '11px', fontFamily: 'monospace' }}
                iconType="circle"
              />
              <Area
                type="monotone"
                dataKey="Gateway"
                stroke="#0f172a"
                strokeWidth={2}
                fill="url(#dq-area-gateway)"
                connectNulls={false}
                dot={{ r: 2, fill: '#0f172a', strokeWidth: 0 }}
                activeDot={{ r: 4 }}
              />
              <Area
                type="monotone"
                dataKey="Truvo"
                stroke="#14b8a6"
                strokeWidth={2.5}
                fill="url(#dq-area-truvo)"
                dot={{ r: 2, fill: '#14b8a6', strokeWidth: 0 }}
                activeDot={{ r: 4 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ---- Seção Reconciliação: tabela por dia ---- */}
      <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 mb-4">
          <div>
            <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">
              Detalhe Diário
            </h3>
            <p className="text-xs text-slate-500 mt-1 font-sans">
              Um dia é <b className="text-emerald-700">reconciliado</b> quando o gap fica abaixo de{' '}
              {UNCERTAIN_THRESHOLD}%.
            </p>
          </div>

          {/* Filtro por status (interação local) */}
          <div className="flex flex-wrap items-center gap-1.5 bg-slate-50 p-1.5 rounded-xl border border-slate-100/80 self-start">
            {filterTabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setFilter(tab.id)}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all cursor-pointer ${
                  filter === tab.id
                    ? 'bg-slate-900 text-white shadow-xs'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/50'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-100 text-[10px] font-mono text-slate-400 uppercase tracking-wider">
                <th className="py-3 font-semibold">Data</th>
                <th className="py-3 font-semibold text-right">Receita Truvo</th>
                <th className="py-3 font-semibold text-right">Receita Gateway</th>
                <th className="py-3 font-semibold text-right">Gap %</th>
                <th className="py-3 font-semibold text-center">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {visibleRows.map((r) => {
                const signed =
                  r.gateway === null ? 0 : ((r.truvo - r.gateway) / r.gateway) * 100;
                return (
                  <tr
                    key={r.date}
                    className="hover:bg-slate-50/50 transition-colors text-xs font-sans text-slate-700"
                  >
                    <td className="py-3.5">
                      <span className="font-mono text-xs font-medium text-slate-900">
                        {r.date.split('-').reverse().join('/')}
                      </span>
                    </td>
                    <td className="py-3.5 text-right font-mono font-semibold text-slate-900">
                      {brl(r.truvo)}
                    </td>
                    <td className="py-3.5 text-right font-mono text-slate-600">
                      {r.gateway === null ? (
                        <span className="text-slate-300">—</span>
                      ) : (
                        brl(r.gateway)
                      )}
                    </td>
                    <td className="py-3.5 text-right font-mono font-semibold">
                      {r.status === 'sem_ground_truth' ? (
                        <span className="text-slate-300">—</span>
                      ) : (
                        <span
                          className={
                            r.status === 'reconciliado' ? 'text-emerald-600' : 'text-amber-600'
                          }
                        >
                          {signed >= 0 ? '+' : ''}
                          {pct(signed)}
                        </span>
                      )}
                    </td>
                    <td className="py-3.5 text-center">
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase ${STATUS_META[r.status].badge}`}
                      >
                        {STATUS_META[r.status].label}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {visibleRows.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-10 text-center text-xs text-slate-400 font-sans">
                    Nenhum dia com este status no período.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ---- Seção Bots: KPIs ---- */}
      <div>
        <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono flex items-center gap-2 mb-4">
          <Bot className="w-4 h-4 text-teal-600" />
          Filtro de Bots
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {/* Total eventos */}
          <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs">
            <div className="flex items-center gap-2 text-slate-400 mb-2">
              <Activity className="w-4 h-4 text-slate-400" />
              <span className="text-xs font-semibold text-slate-500 font-mono uppercase tracking-wider">
                Total de Eventos
              </span>
            </div>
            <h3 className="text-2xl font-bold text-slate-900 tracking-tight font-mono">
              {int(TOTAL_EVENTS)}
            </h3>
            <p className="text-[10px] text-slate-400 mt-1 font-mono">Coletados nos últimos 14 dias</p>
          </div>

          {/* % Bots */}
          <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 text-slate-400">
                <Bot className="w-4 h-4 text-rose-400" />
                <span className="text-xs font-semibold text-slate-500 font-mono uppercase tracking-wider">
                  Tráfego Bot
                </span>
              </div>
              <span className="px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase bg-rose-100 text-rose-800">
                Filtrado
              </span>
            </div>
            <h3 className="text-2xl font-bold text-slate-900 tracking-tight font-mono">
              {pct(botPct)}
            </h3>
            <p className="text-[10px] text-slate-400 mt-1 font-mono">
              {int(BOT_EVENTS)} eventos descartados
            </p>
            <div className="mt-3 h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
              <div className="h-full rounded-full bg-rose-400" style={{ width: `${botPct}%` }} />
            </div>
          </div>

          {/* % Humanos */}
          <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 text-slate-400">
                <Users className="w-4 h-4 text-emerald-500" />
                <span className="text-xs font-semibold text-slate-500 font-mono uppercase tracking-wider">
                  Tráfego Humano
                </span>
              </div>
              <span className="px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase bg-emerald-100 text-emerald-800">
                Válido
              </span>
            </div>
            <h3 className="text-2xl font-bold text-slate-900 tracking-tight font-mono">
              {pct(humanPct)}
            </h3>
            <p className="text-[10px] text-slate-400 mt-1 font-mono">
              {int(HUMAN_EVENTS)} eventos contabilizados
            </p>
            <div className="mt-3 h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
              <div className="h-full rounded-full bg-emerald-500" style={{ width: `${humanPct}%` }} />
            </div>
          </div>
        </div>
      </div>

      {/* ---- Seção Bots: tabela de motivos ---- */}
      <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">
              Principais Motivos de Bloqueio
            </h3>
            <p className="text-xs text-slate-500 mt-1 font-sans">
              Regras que mais filtraram tráfego não-humano no período.
            </p>
          </div>
          <span className="hidden sm:inline-flex items-center gap-1.5 text-[10px] font-mono text-slate-400 uppercase tracking-wider">
            <Info className="w-3.5 h-3.5" />
            {int(BOT_EVENTS)} eventos filtrados
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-100 text-[10px] font-mono text-slate-400 uppercase tracking-wider">
                <th className="py-3 font-semibold">Regra de Detecção</th>
                <th className="py-3 font-semibold">Categoria</th>
                <th className="py-3 font-semibold">Distribuição</th>
                <th className="py-3 font-semibold text-right">Eventos</th>
                <th className="py-3 font-semibold text-right">% Bots</th>
                <th className="py-3 font-semibold text-right">Tendência</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {BOT_REASONS.map((b) => {
                const meta = CATEGORY_META[b.category];
                const CategoryIcon = meta.icon;
                const shareOfBots = (b.count / BOT_EVENTS) * 100;
                return (
                  <tr
                    key={b.rule}
                    className="hover:bg-slate-50/50 transition-colors text-xs font-sans text-slate-700"
                  >
                    <td className="py-3.5 pr-4">
                      <span className="flex items-center gap-2">
                        <CategoryIcon className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                        <span className="font-medium text-slate-800">{b.rule}</span>
                      </span>
                    </td>
                    <td className="py-3.5">
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase ${meta.badge}`}
                      >
                        {meta.label}
                      </span>
                    </td>
                    <td className="py-3.5 pr-6 min-w-[120px]">
                      <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full bg-teal-500"
                          style={{ width: `${(b.count / maxReason) * 100}%` }}
                        />
                      </div>
                    </td>
                    <td className="py-3.5 text-right font-mono font-semibold text-slate-900">
                      {int(b.count)}
                    </td>
                    <td className="py-3.5 text-right font-mono text-slate-600">
                      {pct(shareOfBots)}
                    </td>
                    <td className="py-3.5 text-right">
                      <span
                        className={`inline-flex items-center gap-0.5 font-mono font-semibold ${
                          b.trend >= 0 ? 'text-emerald-600' : 'text-rose-500'
                        }`}
                      >
                        {b.trend >= 0 ? (
                          <ArrowUpRight className="w-3 h-3" />
                        ) : (
                          <ArrowDownRight className="w-3 h-3" />
                        )}
                        {pct(Math.abs(b.trend))}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
