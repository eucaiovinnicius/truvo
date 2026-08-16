'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  Database,
  Sigma,
  Layers,
  Filter,
  Calendar,
  Play,
  Plus,
  Trash2,
  X,
  Check,
  Copy,
  Save,
  BarChart3,
  LineChart as LineChartIcon,
  Braces,
  Bookmark,
  ArrowUpRight,
  ArrowDownRight,
  Sparkles,
  RotateCcw,
  Crown,
} from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
} from 'recharts';
import { useLive } from '@/lib/live';
import { LiveDataBoundary } from '@/lib/live-ui';
import { selectLiveData } from '@/lib/live-state';
import { useSession } from '@/lib/session';
import { api } from '@/lib/api';

/* ------------------------------------------------------------------ */
/* Tipos do construtor de consultas                                    */
/* ------------------------------------------------------------------ */

type Source = 'events' | 'touchpoints';
type Measure = 'revenue' | 'conversions' | 'sessions' | 'events' | 'aov' | 'cvr';
type ChartKind = 'bar' | 'line';
type MeasureKind = 'currency' | 'int' | 'percent';

interface FilterRow {
  id: string;
  field: string;
  operator: string;
  value: string;
}

interface QuerySpec {
  source: Source;
  measure: Measure;
  dimensions: string[];
  filters: FilterRow[];
  dateRange: string;
}

interface SavedInsight {
  id: string;
  name: string;
  spec: QuerySpec;
  chart: ChartKind;
  updated: string;
}

interface ResultRow {
  key: string;
  label: string;
  value: number;
  share: number;
  delta: number;
}

interface ChartDatum {
  key: string;
  label: string;
  value: number;
}

/* ------------------------------------------------------------------ */
/* Catálogo de campos / medidas (pt-BR)                                */
/* ------------------------------------------------------------------ */

const SOURCES: { id: Source; label: string; hint: string }[] = [
  { id: 'events', label: 'events', hint: 'Eventos de conversão (pageview, purchase...)' },
  { id: 'touchpoints', label: 'touchpoints', hint: 'Pontos de contato de mídia (clicks/impressões)' },
];

const MEASURES: Record<Measure, { label: string; kind: MeasureKind; agg: 'soma' | 'média' }> = {
  revenue: { label: 'Receita', kind: 'currency', agg: 'soma' },
  conversions: { label: 'Conversões', kind: 'int', agg: 'soma' },
  sessions: { label: 'Sessões', kind: 'int', agg: 'soma' },
  events: { label: 'Eventos', kind: 'int', agg: 'soma' },
  aov: { label: 'Ticket médio (AOV)', kind: 'currency', agg: 'média' },
  cvr: { label: 'Taxa de conversão (CVR)', kind: 'percent', agg: 'média' },
};

const MEASURE_ORDER: Measure[] = ['revenue', 'conversions', 'sessions', 'events', 'aov', 'cvr'];

const DIMENSIONS: { id: string; label: string }[] = [
  { id: 'utm_source', label: 'utm_source' },
  { id: 'utm_medium', label: 'utm_medium' },
  { id: 'utm_campaign', label: 'utm_campaign' },
  { id: 'device_type', label: 'device_type' },
  { id: 'ip_country', label: 'ip_country' },
  { id: 'page_path', label: 'page_path' },
  { id: 'referrer_domain', label: 'referrer_domain' },
];

const FILTER_FIELDS: string[] = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'device_type',
  'ip_country',
  'page_path',
  'referrer_domain',
  'revenue',
];

const OPERATORS: { id: string; label: string }[] = [
  { id: 'equals', label: 'igual a' },
  { id: 'not_equals', label: 'diferente de' },
  { id: 'contains', label: 'contém' },
  { id: 'starts_with', label: 'começa com' },
  { id: 'greater_than', label: 'maior que' },
  { id: 'less_than', label: 'menor que' },
];

const DATE_PRESETS: { id: string; label: string }[] = [
  { id: 'today', label: 'Hoje' },
  { id: 'yesterday', label: 'Ontem' },
  { id: 'last_7_days', label: 'Últimos 7 dias' },
  { id: 'last_30_days', label: 'Últimos 30 dias' },
  { id: 'this_month', label: 'Este mês' },
  { id: 'last_quarter', label: 'Último trimestre' },
];

const DIMENSION_VALUES: Record<string, string[]> = {
  utm_source: ['meta', 'google', 'tiktok', 'instagram', 'newsletter', '(direto)'],
  utm_medium: ['cpc', 'social', 'email', 'organic', 'referral', 'affiliate'],
  utm_campaign: [
    'black-friday-2026',
    'remarketing-abandono',
    'lookalike-1pc',
    'branding-video',
    'promo-frete-gratis',
    'colecao-verao',
  ],
  device_type: ['mobile', 'desktop', 'tablet'],
  ip_country: ['Brasil', 'Portugal', 'Estados Unidos', 'Argentina', 'México'],
  page_path: ['/checkout', '/produto/tenis-runner', '/carrinho', '/colecao/verao', '/'],
  referrer_domain: ['google.com', 'instagram.com', 'facebook.com', 'youtube.com', 't.co'],
};

const MEASURE_RANGE: Record<Measure, [number, number]> = {
  revenue: [1800, 92000],
  conversions: [8, 1400],
  sessions: [420, 46000],
  events: [1500, 180000],
  aov: [70, 680],
  cvr: [0.6, 8.4],
};

/* ------------------------------------------------------------------ */
/* Helpers de formatação (pt-BR / R$)                                  */
/* ------------------------------------------------------------------ */

const fmtBRL = (n: number): string =>
  n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });

const fmtBRLc = (n: number): string =>
  n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtInt = (n: number): string => Math.round(n).toLocaleString('pt-BR');

const fmtPct = (n: number): string =>
  `${n.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;

function fmtMeasure(measure: Measure, value: number): string {
  const kind = MEASURES[measure].kind;
  if (kind === 'currency') return value >= 10000 ? fmtBRL(value) : fmtBRLc(value);
  if (kind === 'percent') return fmtPct(value);
  return fmtInt(value);
}

/* Hash determinístico → mesma consulta gera sempre os mesmos números */
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function matchOp(key: string, operator: string, value: string): boolean {
  const a = key.toLowerCase();
  const b = value.toLowerCase();
  switch (operator) {
    case 'equals':
      return a === b;
    case 'not_equals':
      return a !== b;
    case 'contains':
      return a.includes(b);
    case 'starts_with':
      return a.startsWith(b);
    default:
      return true; // operadores numéricos não se aplicam a dimensões string → mantém a linha
  }
}

/* ------------------------------------------------------------------ */
/* Execução da consulta (mock determinístico)                          */
/* ------------------------------------------------------------------ */

function runQuery(spec: QuerySpec): ResultRow[] {
  const measure = spec.measure;
  const [min, max] = MEASURE_RANGE[measure];
  const kind = MEASURES[measure].kind;
  const primaryDim = spec.dimensions[0] ?? null;
  const values = primaryDim ? DIMENSION_VALUES[primaryDim] ?? [] : ['todos-os-registros'];

  const activeFilters = spec.filters.filter((f) => f.value.trim() !== '');
  const narrowFactor = Math.pow(0.78, activeFilters.length);

  let rows: ResultRow[] = values.map((v) => {
    const seed = hashStr(`${v}|${measure}|${spec.source}|${spec.dateRange}`);
    const frac = (seed % 10000) / 10000;
    let raw = min + frac * (max - min);
    raw *= narrowFactor;
    const value = kind === 'currency' && measure === 'aov' ? Math.round(raw * 100) / 100 : kind === 'percent' ? Math.round(raw * 10) / 10 : Math.round(raw);

    const dSeed = hashStr(`${v}|${measure}|delta|${spec.dateRange}`);
    const delta = Math.round(((dSeed % 700) / 10 - 25) * 10) / 10; // -25.0 .. +44.9

    return {
      key: v,
      label: primaryDim === null ? 'Todos os registros' : v,
      value,
      share: 0,
      delta,
    };
  });

  // aplica filtros que incidem sobre a dimensão primária
  if (primaryDim) {
    for (const f of activeFilters) {
      if (f.field === primaryDim) {
        rows = rows.filter((r) => matchOp(r.key, f.operator, f.value));
      }
    }
  }

  const total = rows.reduce((acc, r) => acc + r.value, 0);
  rows = rows.map((r) => ({ ...r, share: total > 0 ? (r.value / total) * 100 : 0 }));
  rows.sort((a, b) => b.value - a.value);
  return rows;
}

/* ------------------------------------------------------------------ */
/* Tooltip do gráfico (props opcionais → strict-safe)                  */
/* ------------------------------------------------------------------ */

interface ChartTipProps {
  active?: boolean;
  label?: string | number;
  payload?: ReadonlyArray<{ value?: number | string; payload?: ChartDatum }>;
  measure?: Measure;
}

function ChartTip({ active, payload, measure }: ChartTipProps): React.ReactElement | null {
  if (!active || !payload || payload.length === 0) return null;
  const datum = payload[0]?.payload;
  if (!datum) return null;
  const m = measure ?? 'revenue';
  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-lg px-3 py-2">
      <p className="text-[10px] font-mono font-bold text-slate-800">{datum.label}</p>
      <p className="text-[11px] font-mono text-teal-600 font-bold mt-0.5">{fmtMeasure(m, datum.value)}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Dados iniciais                                                      */
/* ------------------------------------------------------------------ */

const INITIAL_SPEC: QuerySpec = {
  source: 'events',
  measure: 'revenue',
  dimensions: ['utm_source'],
  filters: [{ id: 'f-seed', field: 'device_type', operator: 'equals', value: 'mobile' }],
  dateRange: 'last_30_days',
};

const INITIAL_SAVED: SavedInsight[] = [
  {
    id: 's1',
    name: 'Receita por canal — mobile',
    spec: {
      source: 'events',
      measure: 'revenue',
      dimensions: ['utm_source'],
      filters: [{ id: 'a', field: 'device_type', operator: 'equals', value: 'mobile' }],
      dateRange: 'last_30_days',
    },
    chart: 'bar',
    updated: 'há 2 horas',
  },
  {
    id: 's2',
    name: 'CVR por país (últimos 7d)',
    spec: {
      source: 'events',
      measure: 'cvr',
      dimensions: ['ip_country'],
      filters: [],
      dateRange: 'last_7_days',
    },
    chart: 'line',
    updated: 'ontem',
  },
  {
    id: 's3',
    name: 'Touchpoints por campanha',
    spec: {
      source: 'touchpoints',
      measure: 'events',
      dimensions: ['utm_campaign'],
      filters: [{ id: 'b', field: 'utm_medium', operator: 'equals', value: 'cpc' }],
      dateRange: 'last_quarter',
    },
    chart: 'bar',
    updated: 'há 3 dias',
  },
];

/* ------------------------------------------------------------------ */
/* Ligação API real (M16) — fallback demo nos dois lados               */
/* ------------------------------------------------------------------ */

/** GET /v1/insights → ARRAY BARE. */
interface ApiInsight {
  id: string;
  name: string;
  description?: string | null;
  kind?: 'visual' | 'sql';
  insight_type?: string;
  spec?: unknown;
  current_version?: number;
  created_at?: string;
  updated_at?: string;
}

/** Forma (parcial) do ExplorerQuerySpec guardado no insight. */
interface ApiSpecShape {
  source?: string;
  insight_type?: string;
  measures?: Array<{ id?: string; metric?: string; property?: string; on?: string }>;
  dimensions?: string[];
  date_range?: { preset?: string } | { from?: string; to?: string };
}

/** Corpo do POST /v1/explorer/query (spec visual). */
interface ApiMeasureSpec {
  id: string;
  metric: string;
  property?: string;
  on?: string;
}
interface ExplorerQueryBody {
  insight_type: 'breakdown' | 'trends';
  source: Source;
  measures: ApiMeasureSpec[];
  dimensions: string[];
  date_range: { preset: string };
  limit: number;
}

/** Resposta do POST /v1/explorer/query. */
interface ExplorerQueryResponse {
  status?: string;
  columns?: string[];
  rows?: Array<Record<string, unknown>>;
  cost?: { result_rows?: number; duration_ms?: number };
  query_id?: string;
}

/** dim local (chip) → campo do catálogo da API. */
const DIM_TO_API_FIELD: Record<string, string> = {
  utm_source: 'context.utm_source',
  utm_medium: 'context.utm_medium',
  utm_campaign: 'context.utm_campaign',
  device_type: 'context.device_type',
  ip_country: 'context.ip_country',
  page_path: 'context.page_url',
  referrer_domain: 'context.referrer',
};
/** caminho inverso (campo da API → dim local do chip). */
const API_FIELD_TO_DIM: Record<string, string> = {
  'context.utm_source': 'utm_source',
  'context.utm_medium': 'utm_medium',
  'context.utm_campaign': 'utm_campaign',
  'context.device_type': 'device_type',
  'context.ip_country': 'ip_country',
  'context.page_url': 'page_path',
  'context.referrer': 'referrer_domain',
};

/** medida local → measure da API (metric do vocabulário fechado). */
function measureToApi(measure: Measure): ApiMeasureSpec {
  switch (measure) {
    case 'revenue':
      return { id: 'revenue', metric: 'sum', property: 'value' };
    case 'aov':
      return { id: 'aov', metric: 'avg', property: 'value' };
    case 'sessions':
      return { id: 'sessions', metric: 'unique', on: 'session_id' };
    case 'cvr':
      return { id: 'cvr', metric: 'rate' };
    case 'conversions':
      return { id: 'conversions', metric: 'count' };
    case 'events':
    default:
      return { id: 'events', metric: 'count' };
  }
}

/** Monta o ExplorerQuerySpec (breakdown) a partir do estado do construtor. */
function buildExplorerBody(spec: QuerySpec): ExplorerQueryBody {
  return {
    insight_type: 'breakdown',
    source: spec.source,
    measures: [measureToApi(spec.measure)],
    dimensions: (spec.dimensions ?? []).map((d) => DIM_TO_API_FIELD[d] ?? d),
    date_range: { preset: spec.dateRange },
    limit: 100,
  };
}

/** columns/rows da API → ResultRow[] (mesma forma que o JSX já consome). */
function adaptResults(res: ExplorerQueryResponse): ResultRow[] {
  const columns = res?.columns ?? [];
  const rows = res?.rows ?? [];
  const valCol = columns.find((c) => /^m\d+$/.test(c)) ?? columns[columns.length - 1];
  const dimCol = columns.find((c) => /^d\d+$/.test(c)) ?? columns.find((c) => c !== valCol);
  const mapped: ResultRow[] = rows.map((row, i) => {
    const rawVal = valCol != null ? row[valCol] : undefined;
    const value = typeof rawVal === 'number' ? rawVal : Number(rawVal ?? 0) || 0;
    const rawLabel = dimCol != null ? row[dimCol] : undefined;
    const label =
      rawLabel === null || rawLabel === undefined || rawLabel === ''
        ? 'Todos os registros'
        : String(rawLabel);
    return { key: `${label}-${i}`, label, value, share: 0, delta: 0 };
  });
  const total = mapped.reduce((acc, r) => acc + r.value, 0);
  const withShare = mapped.map((r) => ({ ...r, share: total > 0 ? (r.value / total) * 100 : 0 }));
  withShare.sort((a, b) => b.value - a.value);
  return withShare;
}

/** metric da API → medida local (sempre uma chave VÁLIDA de MEASURES). */
function apiMetricToMeasure(spec: ApiSpecShape | null): Measure {
  const m = spec?.measures?.[0];
  const metric = m?.metric;
  if (metric === 'avg') return 'aov';
  if (metric === 'rate') return 'cvr';
  if (metric === 'unique') return 'sessions';
  if (metric === 'count') return 'conversions';
  return 'revenue'; // sum e desconhecidos → revenue
}

/** updated_at ISO → texto curto p/ a coluna "Atualizado". */
function fmtUpdated(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** insight da API → SavedInsight (mesma forma que a tabela/loadInsight consomem). */
function adaptInsight(ins: ApiInsight): SavedInsight {
  const spec = (ins?.spec ?? null) as ApiSpecShape | null;
  const source: Source = spec?.source === 'touchpoints' ? 'touchpoints' : 'events';
  const dims = (spec?.dimensions ?? []).map((f) => API_FIELD_TO_DIM[f] ?? f.replace(/^context\./, ''));
  const dr = spec?.date_range as { preset?: string } | undefined;
  const localSpec: QuerySpec = {
    source,
    measure: apiMetricToMeasure(spec),
    dimensions: dims,
    filters: [], // TODO(live): converter árvore de filtros da API p/ FilterRow[]
    dateRange: dr?.preset ?? 'last_30_days',
  };
  const type = spec?.insight_type ?? ins?.insight_type;
  return {
    id: ins?.id ?? `live-${Math.random().toString(36).slice(2)}`,
    name: ins?.name ?? 'Insight',
    spec: localSpec,
    chart: type === 'trends' ? 'line' : 'bar',
    updated: fmtUpdated(ins?.updated_at),
  };
}

/* ------------------------------------------------------------------ */
/* Componente                                                          */
/* ------------------------------------------------------------------ */

export default function ExplorerView(): React.ReactElement {
  const [source, setSource] = useState<Source>(INITIAL_SPEC.source);
  const [measure, setMeasure] = useState<Measure>(INITIAL_SPEC.measure);
  const [dimensions, setDimensions] = useState<string[]>(INITIAL_SPEC.dimensions);
  const [filters, setFilters] = useState<FilterRow[]>(INITIAL_SPEC.filters);
  const [dateRange, setDateRange] = useState<string>(INITIAL_SPEC.dateRange);
  const [chartKind, setChartKind] = useState<ChartKind>('bar');

  const [runSpec, setRunSpec] = useState<QuerySpec>(INITIAL_SPEC);
  const [saved, setSaved] = useState<SavedInsight[]>(INITIAL_SAVED);
  const [insightName, setInsightName] = useState<string>('');
  const [copied, setCopied] = useState<boolean>(false);

  // ---- Ligação API real (M16) ----
  const { isLive, workspace } = useSession();
  // (1) Insights salvos: API em live; coleção determinística apenas em demo.
  const insightsLive = useLive<ApiInsight[]>('/v1/insights', []);
  const savedRows: SavedInsight[] = selectLiveData(
    insightsLive,
    saved,
    [],
    (rows) => rows.map(adaptInsight),
  );
  // (2) Resultado da execução ao vivo, com estados próprios de loading/error.
  const [liveResults, setLiveResults] = useState<ResultRow[]>([]);
  const [queryStatus, setQueryStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');

  useEffect(() => {
    setLiveResults([]);
    setQueryStatus('idle');
  }, [isLive, workspace?.id]);

  const draftSpec: QuerySpec = useMemo(
    () => ({ source, measure, dimensions, filters, dateRange }),
    [source, measure, dimensions, filters, dateRange],
  );

  const isDirty = useMemo(
    () => JSON.stringify(draftSpec) !== JSON.stringify(runSpec),
    [draftSpec, runSpec],
  );

  // O gerador local é usado exclusivamente no modo demo.
  const results = useMemo(
    () => (isLive ? liveResults : runQuery(runSpec)),
    [isLive, liveResults, runSpec],
  );

  const chartData: ChartDatum[] = useMemo(
    () =>
      results.slice(0, 8).map((r) => ({
        key: r.key,
        label: r.label.length > 14 ? `${r.label.slice(0, 13)}…` : r.label,
        value: r.value,
      })),
    [results],
  );

  const runMeasureMeta = MEASURES[runSpec.measure];
  const totalValue = useMemo(() => {
    if (results.length === 0) return 0;
    const sum = results.reduce((acc, r) => acc + r.value, 0);
    return runMeasureMeta.agg === 'média' ? sum / results.length : sum;
  }, [results, runMeasureMeta.agg]);

  const topRow = results[0] ?? null;

  const specJson = useMemo(
    () => JSON.stringify({ ...draftSpec, chart: chartKind }, null, 2),
    [draftSpec, chartKind],
  );

  /* ---------------- handlers ---------------- */

  const toggleDimension = (id: string): void => {
    setDimensions((prev) => (prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id]));
  };

  const addFilter = (): void => {
    setFilters((prev) => [
      ...prev,
      { id: `f-${Date.now()}`, field: 'utm_source', operator: 'equals', value: '' },
    ]);
  };

  const updateFilter = (id: string, field: keyof FilterRow, value: string): void => {
    setFilters((prev) => prev.map((f) => (f.id === id ? { ...f, [field]: value } : f)));
  };

  const removeFilter = (id: string): void => {
    setFilters((prev) => prev.filter((f) => f.id !== id));
  };

  const executeQuery = (): void => {
    const spec = JSON.parse(JSON.stringify(draftSpec)) as QuerySpec;
    setRunSpec(spec);
    // Demo → não busca; a tabela usa o mock runQuery (fallback).
    if (!isLive) {
      setQueryStatus('success');
      return;
    }
    // Live → POST /v1/explorer/query com o spec do construtor. useLive só faz GET,
    // então usamos api() direto. Falhas ficam explícitas e limpam resultados antigos.
    setLiveResults([]);
    setQueryStatus('loading');
    void api<ExplorerQueryResponse>('/v1/explorer/query', {
      method: 'POST',
      body: JSON.stringify(buildExplorerBody(spec)),
    })
      .then((res) => {
        if (res?.status === 'ok') {
          setLiveResults(adaptResults(res));
          setQueryStatus('success');
        } else {
          setLiveResults([]);
          setQueryStatus('error');
        }
      })
      .catch(() => {
        setLiveResults([]);
        setQueryStatus('error');
      });
  };

  const resetBuilder = (): void => {
    setSource('events');
    setMeasure('revenue');
    setDimensions(['utm_source']);
    setFilters([]);
    setDateRange('last_30_days');
  };

  const loadInsight = (ins: SavedInsight): void => {
    const spec = JSON.parse(JSON.stringify(ins.spec)) as QuerySpec;
    setSource(spec.source);
    setMeasure(spec.measure);
    setDimensions(spec.dimensions);
    setFilters(spec.filters);
    setDateRange(spec.dateRange);
    setChartKind(ins.chart);
    setRunSpec(spec);
  };

  const saveInsight = (): void => {
    const name =
      insightName.trim() !== ''
        ? insightName.trim()
        : `${MEASURES[measure].label} por ${dimensions[0] ?? 'total'}`;
    const newInsight: SavedInsight = {
      id: `s-${Date.now()}`,
      name,
      spec: JSON.parse(JSON.stringify(draftSpec)) as QuerySpec,
      chart: chartKind,
      updated: 'agora mesmo',
    };
    setSaved((prev) => [newInsight, ...prev]);
    setInsightName('');
    setRunSpec(JSON.parse(JSON.stringify(draftSpec)) as QuerySpec);
  };

  const deleteInsight = (id: string): void => {
    setSaved((prev) => prev.filter((s) => s.id !== id));
  };

  const copySpec = (): void => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(specJson);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  /* ---------------- render ---------------- */

  const inputCls =
    'w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-semibold text-slate-800 focus:ring-1 focus:ring-teal-500 focus:border-teal-500 outline-none';

  return (
    <LiveDataBoundary states={[insightsLive]} empty={false} label="Explorador de dados">
    <div id="explorer-view-container" className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono flex items-center gap-2">
            <Sparkles className="w-3.5 h-3.5 text-teal-600" />
            Data Explorer
          </h2>
          <p className="text-xs text-slate-500 mt-1 font-sans">
            Construtor visual de consultas sobre seus eventos e pontos de contato — monte, execute e salve como insight.
          </p>
        </div>
        <div className="flex items-center gap-2 self-start">
          <button
            onClick={resetBuilder}
            className="px-4 py-2 border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-xl text-xs font-semibold transition-colors cursor-pointer flex items-center gap-1.5"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Limpar
          </button>
          <button
            onClick={executeQuery}
            className="px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center gap-1.5 shadow-sm shadow-teal-600/20"
          >
            <Play className="w-3.5 h-3.5" />
            Executar
            {isDirty && <span className="w-1.5 h-1.5 rounded-full bg-amber-300" title="Alterações não executadas" />}
          </button>
        </div>
      </div>

      {isLive && queryStatus === 'loading' && (
        <div aria-live="polite" className="rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-600">
          Executando consulta com dados ao vivo deste workspace…
        </div>
      )}
      {isLive && queryStatus === 'error' && (
        <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
          A consulta ao vivo falhou. Nenhum resultado de demonstração foi usado.
        </div>
      )}

      {/* Grid principal */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* ---------------- ESQUERDA: builder + spec ---------------- */}
        <div className="lg:col-span-5 space-y-6">
          {/* Builder card */}
          <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs space-y-5">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">Construtor de Consulta</h3>
              <span className="text-[9px] font-mono font-bold uppercase px-2 py-0.5 rounded-full bg-teal-100 text-teal-800">
                {isDirty ? 'rascunho' : 'sincronizado'}
              </span>
            </div>

            {/* Fonte */}
            <div>
              <label className="text-[10px] font-mono text-slate-400 uppercase font-bold mb-1.5 flex items-center gap-1.5">
                <Database className="w-3 h-3" /> Fonte de dados
              </label>
              <div className="grid grid-cols-2 gap-2">
                {SOURCES.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setSource(s.id)}
                    title={s.hint}
                    className={`px-3 py-2 rounded-lg border text-xs font-mono font-bold transition-all text-left cursor-pointer ${
                      source === s.id
                        ? 'bg-teal-50 border-teal-300 text-teal-800'
                        : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300'
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Medida */}
            <div>
              <label className="text-[10px] font-mono text-slate-400 uppercase font-bold mb-1.5 flex items-center gap-1.5">
                <Sigma className="w-3 h-3" /> Medida
              </label>
              <select
                value={measure}
                onChange={(e) => setMeasure(e.target.value as Measure)}
                className={inputCls}
              >
                {MEASURE_ORDER.map((m) => (
                  <option key={m} value={m}>
                    {MEASURES[m].label} · {m}
                  </option>
                ))}
              </select>
            </div>

            {/* Dimensões (chips) */}
            <div>
              <label className="text-[10px] font-mono text-slate-400 uppercase font-bold mb-1.5 flex items-center gap-1.5">
                <Layers className="w-3 h-3" /> Dimensões
                <span className="text-slate-300 normal-case font-sans">(1ª define o agrupamento)</span>
              </label>
              <div className="flex flex-wrap gap-1.5">
                {DIMENSIONS.map((d) => {
                  const active = dimensions.includes(d.id);
                  const isPrimary = dimensions[0] === d.id;
                  return (
                    <button
                      key={d.id}
                      onClick={() => toggleDimension(d.id)}
                      className={`px-2.5 py-1 rounded-full text-[10px] font-mono font-bold border transition-all cursor-pointer flex items-center gap-1 ${
                        active
                          ? 'bg-teal-600 border-teal-600 text-white'
                          : 'bg-white border-slate-200 text-slate-500 hover:border-teal-300 hover:text-teal-700'
                      }`}
                    >
                      {active ? <Check className="w-2.5 h-2.5" /> : <Plus className="w-2.5 h-2.5" />}
                      {d.label}
                      {isPrimary && <Crown className="w-2.5 h-2.5 text-amber-300" />}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Filtros */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[10px] font-mono text-slate-400 uppercase font-bold flex items-center gap-1.5">
                  <Filter className="w-3 h-3" /> Filtros
                </label>
                <button
                  onClick={addFilter}
                  className="text-[10px] font-mono font-bold text-teal-600 hover:text-teal-700 flex items-center gap-0.5 cursor-pointer"
                >
                  <Plus className="w-3 h-3" /> Adicionar
                </button>
              </div>

              {filters.length === 0 ? (
                <p className="text-[10px] text-slate-400 italic font-sans py-1">
                  Nenhum filtro — a consulta abrange todos os registros da fonte.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {filters.map((f) => (
                    <div key={f.id} className="flex items-center gap-1.5">
                      <select
                        value={f.field}
                        onChange={(e) => updateFilter(f.id, 'field', e.target.value)}
                        className="px-1.5 py-1 bg-white border border-slate-200 rounded-md text-[10px] font-mono font-semibold text-slate-600 outline-none focus:ring-1 focus:ring-teal-500 min-w-0 flex-1"
                      >
                        {FILTER_FIELDS.map((ff) => (
                          <option key={ff} value={ff}>
                            {ff}
                          </option>
                        ))}
                      </select>
                      <select
                        value={f.operator}
                        onChange={(e) => updateFilter(f.id, 'operator', e.target.value)}
                        className="px-1.5 py-1 bg-white border border-slate-200 rounded-md text-[10px] font-mono font-semibold text-slate-600 outline-none focus:ring-1 focus:ring-teal-500"
                      >
                        {OPERATORS.map((op) => (
                          <option key={op.id} value={op.id}>
                            {op.label}
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        value={f.value}
                        onChange={(e) => updateFilter(f.id, 'value', e.target.value)}
                        placeholder="valor…"
                        className="flex-1 min-w-0 px-2 py-1 bg-white border border-slate-200 rounded-md text-[10px] text-slate-700 outline-none focus:ring-1 focus:ring-teal-500"
                      />
                      <button
                        onClick={() => removeFilter(f.id)}
                        className="p-1 hover:bg-rose-50 text-slate-400 hover:text-rose-600 rounded-md transition-colors cursor-pointer shrink-0"
                        title="Remover filtro"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Período */}
            <div>
              <label className="text-[10px] font-mono text-slate-400 uppercase font-bold mb-1.5 flex items-center gap-1.5">
                <Calendar className="w-3 h-3" /> Período
              </label>
              <select
                value={dateRange}
                onChange={(e) => setDateRange(e.target.value)}
                className={inputCls}
              >
                {DATE_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Ações do builder */}
            <div className="pt-3 border-t border-slate-100 space-y-2.5">
              <button
                onClick={executeQuery}
                className="w-full px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center justify-center gap-1.5 shadow-sm shadow-teal-600/20"
              >
                <Play className="w-3.5 h-3.5" />
                Executar consulta
              </button>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={insightName}
                  onChange={(e) => setInsightName(e.target.value)}
                  placeholder="Nomear insight…"
                  className="flex-1 min-w-0 px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-xs text-slate-800 outline-none focus:ring-1 focus:ring-teal-500"
                />
                <button
                  onClick={saveInsight}
                  className="px-3 py-1.5 border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-lg text-xs font-bold transition-colors cursor-pointer flex items-center gap-1.5 shrink-0"
                >
                  <Save className="w-3.5 h-3.5" />
                  Salvar
                </button>
              </div>
            </div>
          </div>

          {/* Spec JSON ao vivo */}
          <div className="bg-white rounded-2xl border border-slate-100 shadow-xs overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-100">
              <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                <Braces className="w-3.5 h-3.5 text-teal-600" /> spec.json
              </span>
              <button
                onClick={copySpec}
                className="text-[10px] font-mono font-bold text-slate-500 hover:text-teal-700 flex items-center gap-1 cursor-pointer"
              >
                {copied ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                {copied ? 'copiado' : 'copiar'}
              </button>
            </div>
            <pre className="bg-slate-950 text-[11px] leading-relaxed font-mono text-teal-300 p-4 overflow-x-auto">
              {specJson}
            </pre>
          </div>
        </div>

        {/* ---------------- DIREITA: resultado ---------------- */}
        <div className="lg:col-span-7 space-y-6">
          {/* KPIs do resultado */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs">
              <span className="text-xs font-semibold text-slate-500 font-mono uppercase tracking-wider">
                {runMeasureMeta.agg === 'média' ? 'Média' : 'Total'} · {runMeasureMeta.label}
              </span>
              <h3 className="text-2xl font-bold text-slate-900 tracking-tight font-mono mt-2">
                {fmtMeasure(runSpec.measure, totalValue)}
              </h3>
              <p className="text-[10px] text-slate-400 mt-1 font-mono">{DATE_PRESETS.find((p) => p.id === runSpec.dateRange)?.label ?? runSpec.dateRange}</p>
            </div>
            <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs">
              <span className="text-xs font-semibold text-slate-500 font-mono uppercase tracking-wider">Segmentos</span>
              <h3 className="text-2xl font-bold text-slate-900 tracking-tight font-mono mt-2">{fmtInt(results.length)}</h3>
              <p className="text-[10px] text-slate-400 mt-1 font-mono">
                agrupado por {runSpec.dimensions[0] ?? '—'}
              </p>
            </div>
            <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs">
              <span className="text-xs font-semibold text-slate-500 font-mono uppercase tracking-wider">Top segmento</span>
              <h3 className="text-lg font-bold text-slate-900 tracking-tight font-mono mt-2 truncate">
                {topRow ? topRow.label : '—'}
              </h3>
              <p className="text-[10px] text-teal-600 mt-1 font-mono font-bold">
                {topRow ? fmtMeasure(runSpec.measure, topRow.value) : '—'}
              </p>
            </div>
          </div>

          {/* Gráfico */}
          <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">Resultado da consulta</h3>
                <p className="text-xs text-slate-500 mt-1 font-sans">
                  {runMeasureMeta.label} por {runSpec.dimensions[0] ?? 'total'} · top {Math.min(8, results.length)}
                </p>
              </div>
              <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-0.5">
                <button
                  onClick={() => setChartKind('bar')}
                  title="Barras"
                  className={`p-1.5 rounded-md transition-all cursor-pointer ${
                    chartKind === 'bar' ? 'bg-white text-teal-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'
                  }`}
                >
                  <BarChart3 className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setChartKind('line')}
                  title="Linha"
                  className={`p-1.5 rounded-md transition-all cursor-pointer ${
                    chartKind === 'line' ? 'bg-white text-teal-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'
                  }`}
                >
                  <LineChartIcon className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="h-72 w-full">
              {chartData.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-slate-400">
                  <Filter className="w-8 h-8 text-slate-300 mb-2" />
                  <p className="text-xs font-sans">Nenhum resultado para os filtros atuais.</p>
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  {chartKind === 'bar' ? (
                    <BarChart data={chartData} margin={{ top: 10, right: 4, left: -12, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                      <XAxis
                        dataKey="label"
                        stroke="#94a3b8"
                        fontSize={10}
                        fontFamily="JetBrains Mono"
                        tickLine={false}
                        axisLine={false}
                        interval={0}
                        angle={-18}
                        textAnchor="end"
                        height={48}
                      />
                      <YAxis stroke="#94a3b8" fontSize={10} fontFamily="JetBrains Mono" tickLine={false} axisLine={false} width={54} />
                      <Tooltip cursor={{ fill: 'rgba(20,184,166,0.06)' }} content={<ChartTip measure={runSpec.measure} />} />
                      <Bar dataKey="value" radius={[6, 6, 0, 0]} barSize={34}>
                        {chartData.map((entry, idx) => (
                          <Cell key={entry.key} fill={idx === 0 ? '#0f766e' : '#14b8a6'} fillOpacity={idx === 0 ? 1 : 0.8} />
                        ))}
                      </Bar>
                    </BarChart>
                  ) : (
                    <LineChart data={chartData} margin={{ top: 10, right: 8, left: -12, bottom: 0 }}>
                      <defs>
                        <linearGradient id="explorerLine" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#14b8a6" stopOpacity={0.25} />
                          <stop offset="95%" stopColor="#14b8a6" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                      <XAxis
                        dataKey="label"
                        stroke="#94a3b8"
                        fontSize={10}
                        fontFamily="JetBrains Mono"
                        tickLine={false}
                        axisLine={false}
                        interval={0}
                        angle={-18}
                        textAnchor="end"
                        height={48}
                      />
                      <YAxis stroke="#94a3b8" fontSize={10} fontFamily="JetBrains Mono" tickLine={false} axisLine={false} width={54} />
                      <Tooltip cursor={{ stroke: '#14b8a6', strokeWidth: 1 }} content={<ChartTip measure={runSpec.measure} />} />
                      <Line
                        type="monotone"
                        dataKey="value"
                        stroke="#14b8a6"
                        strokeWidth={2.5}
                        dot={{ r: 3, fill: '#14b8a6', strokeWidth: 0 }}
                        activeDot={{ r: 5 }}
                        fill="url(#explorerLine)"
                      />
                    </LineChart>
                  )}
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* Tabela de resultados */}
          <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs">
            <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono mb-4">Linhas ({results.length})</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-100 text-[10px] font-mono text-slate-400 uppercase tracking-wider">
                    <th className="py-3 font-semibold">{runSpec.dimensions[0] ?? 'Registro'}</th>
                    <th className="py-3 font-semibold text-right">{runMeasureMeta.label}</th>
                    <th className="py-3 font-semibold text-right">Part. %</th>
                    <th className="py-3 font-semibold text-right">Variação</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {results.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-8 text-center text-xs text-slate-400 font-sans italic">
                        Sem linhas para os filtros selecionados.
                      </td>
                    </tr>
                  ) : (
                    results.map((r) => (
                      <tr key={r.key} className="hover:bg-slate-50/50 transition-colors text-xs font-sans text-slate-700">
                        <td className="py-3">
                          <span className="font-mono text-xs font-medium text-slate-900 bg-slate-50 border border-slate-100 px-2 py-1 rounded-md">
                            {r.label}
                          </span>
                        </td>
                        <td className="py-3 text-right font-semibold text-slate-900 font-mono">
                          {fmtMeasure(runSpec.measure, r.value)}
                        </td>
                        <td className="py-3 text-right font-mono text-slate-500">{fmtPct(r.share)}</td>
                        <td className="py-3 text-right">
                          <span
                            className={`inline-flex items-center gap-0.5 font-mono font-bold ${
                              r.delta >= 0 ? 'text-emerald-600' : 'text-rose-500'
                            }`}
                          >
                            {r.delta >= 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                            {Math.abs(r.delta).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {/* ---------------- Insights salvos ---------------- */}
      <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono flex items-center gap-2">
              <Bookmark className="w-3.5 h-3.5 text-teal-600" /> Insights salvos
            </h3>
            <p className="text-xs text-slate-500 mt-1 font-sans">Consultas guardadas — clique para recarregar no construtor.</p>
          </div>
          <span className="text-[10px] font-mono bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full font-semibold">
            {savedRows.length} salvos
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-100 text-[10px] font-mono text-slate-400 uppercase tracking-wider">
                <th className="py-3 font-semibold">Nome</th>
                <th className="py-3 font-semibold">Tipo</th>
                <th className="py-3 font-semibold">Medida</th>
                <th className="py-3 font-semibold">Dimensões</th>
                <th className="py-3 font-semibold">Atualizado</th>
                <th className="py-3 font-semibold text-center">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {savedRows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-xs text-slate-400 font-sans italic">
                    Nenhum insight salvo ainda — monte uma consulta e clique em “Salvar”.
                  </td>
                </tr>
              ) : (
                savedRows.map((ins) => (
                  <tr
                    key={ins.id}
                    onClick={() => loadInsight(ins)}
                    className="hover:bg-slate-50/50 transition-colors text-xs font-sans text-slate-700 cursor-pointer"
                  >
                    <td className="py-3.5 font-bold text-slate-800">{ins.name}</td>
                    <td className="py-3.5">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase ${
                          ins.spec.source === 'events' ? 'bg-teal-100 text-teal-800' : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {ins.chart === 'bar' ? <BarChart3 className="w-2.5 h-2.5" /> : <LineChartIcon className="w-2.5 h-2.5" />}
                        {ins.spec.source}
                      </span>
                    </td>
                    <td className="py-3.5 font-mono text-slate-600">{MEASURES[ins.spec.measure].label}</td>
                    <td className="py-3.5">
                      <div className="flex flex-wrap gap-1">
                        {ins.spec.dimensions.length === 0 ? (
                          <span className="text-[10px] text-slate-400 italic">—</span>
                        ) : (
                          ins.spec.dimensions.map((d) => (
                            <span
                              key={d}
                              className="font-mono text-[9px] text-slate-500 bg-slate-50 border border-slate-100 px-1.5 py-0.5 rounded"
                            >
                              {d}
                            </span>
                          ))
                        )}
                      </div>
                    </td>
                    <td className="py-3.5 font-mono text-[10px] text-slate-400">{ins.updated}</td>
                    <td className="py-3.5 text-center">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteInsight(ins.id);
                        }}
                        className="p-1 hover:bg-rose-50 text-slate-400 hover:text-rose-600 rounded-md transition-colors cursor-pointer"
                        title="Excluir insight"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
    </LiveDataBoundary>
  );
}
