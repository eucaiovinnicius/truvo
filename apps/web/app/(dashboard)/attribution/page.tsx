'use client';

import { useMemo, useState } from 'react';
import {
  Page,
  Toolbar,
  Section,
  StatRow,
  StatTile,
  DataTable,
  Badge,
  Select,
  Field,
  AsyncBoundary,
  type Column,
} from '@/components/ui';
import { useApi } from '@/lib/use-api';

/**
 * /attribution — M7 Attribution Engine.
 *   · GET /v1/attribution/report?model=&start=&end=&window=  → breakdown por canal
 *   · GET /v1/attribution/paths?start=&end=&limit=&window=     → top caminhos
 * Modelo/janela vêm de enums fechados no backend; período vira start/end ISO.
 */

const MODELS = [
  { value: 'last_click', label: 'Último clique' },
  { value: 'first_click', label: 'Primeiro clique' },
  { value: 'linear', label: 'Linear' },
  { value: 'position_based', label: 'Baseado em posição' },
  { value: 'time_decay', label: 'Decaimento temporal' },
];

const PERIODS = [
  { value: '7', label: 'Últimos 7 dias' },
  { value: '14', label: 'Últimos 14 dias' },
  { value: '30', label: 'Últimos 30 dias' },
  { value: '90', label: 'Últimos 90 dias' },
];

// Janela de ATRIBUIÇÃO (lookback por conversão) — allowlist do backend: 1/7/14/30.
const WINDOWS = [
  { value: '1', label: '1 dia' },
  { value: '7', label: '7 dias' },
  { value: '14', label: '14 dias' },
  { value: '30', label: '30 dias' },
];

const CHANNEL_LABELS: Record<string, string> = {
  paid_social: 'Paid Social',
  paid_search: 'Paid Search',
  organic_social: 'Organic Social',
  organic: 'Orgânico',
  email: 'E-mail',
  referral: 'Referral',
  direct: 'Direto',
};

function channelLabel(c: string): string {
  return CHANNEL_LABELS[c] ?? c;
}

const numberFmt = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
const currencyFmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

// ── Tipos de resposta (best-effort a partir do AttributionService) ──
type ReportChannel = {
  channel: string;
  attributed_conversions: number;
  attributed_revenue: number;
  last_touch_conversions: number;
  assisted_conversions: number;
  revenue_share: number;
};

type ReportResponse = {
  model: string;
  window_days: number;
  report_window: { start: string; end: string };
  totals: { conversions: number; revenue: number };
  channels: ReportChannel[];
};

type PathRow = {
  path: string[];
  conversions: number;
  revenue: number;
  avg_path_length: number;
};

type PathsResponse = {
  window_days: number;
  totals: { conversions: number; revenue: number; unique_paths: number };
  paths: PathRow[];
};

const channelColumns: Column<ReportChannel>[] = [
  {
    key: 'channel',
    header: 'Canal',
    render: (r) => <span className="font-medium text-slate-100">{channelLabel(r.channel)}</span>,
  },
  {
    key: 'attributed_conversions',
    header: 'Conversões atrib.',
    align: 'right',
    render: (r) => <span className="tabular-nums text-slate-200">{numberFmt.format(r.attributed_conversions)}</span>,
  },
  {
    key: 'attributed_revenue',
    header: 'Receita atrib.',
    align: 'right',
    render: (r) => <span className="tabular-nums text-slate-200">{currencyFmt.format(r.attributed_revenue)}</span>,
  },
  {
    key: 'revenue_share',
    header: 'Share',
    align: 'right',
    render: (r) => <span className="tabular-nums text-slate-400">{pct(r.revenue_share)}</span>,
  },
  {
    key: 'last_touch_conversions',
    header: 'Last-touch',
    align: 'right',
    render: (r) => <span className="tabular-nums text-slate-400">{numberFmt.format(r.last_touch_conversions)}</span>,
  },
  {
    key: 'assisted_conversions',
    header: 'Assistidas',
    align: 'right',
    render: (r) => <span className="tabular-nums text-slate-400">{numberFmt.format(r.assisted_conversions)}</span>,
  },
];

const pathColumns: Column<PathRow>[] = [
  {
    key: 'path',
    header: 'Caminho',
    render: (r) => (
      <div className="flex flex-wrap items-center gap-1">
        {(r.path ?? []).map((step, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 ? <span className="text-slate-600">→</span> : null}
            <Badge variant="neutral">{channelLabel(step)}</Badge>
          </span>
        ))}
      </div>
    ),
  },
  {
    key: 'conversions',
    header: 'Conversões',
    align: 'right',
    render: (r) => <span className="tabular-nums text-slate-200">{numberFmt.format(r.conversions)}</span>,
  },
  {
    key: 'revenue',
    header: 'Receita',
    align: 'right',
    render: (r) => <span className="tabular-nums text-slate-200">{currencyFmt.format(r.revenue)}</span>,
  },
  {
    key: 'avg_path_length',
    header: 'Toques (méd.)',
    align: 'right',
    render: (r) => <span className="tabular-nums text-slate-400">{numberFmt.format(r.avg_path_length)}</span>,
  },
];

export default function AttributionPage() {
  const [model, setModel] = useState('last_click');
  const [period, setPeriod] = useState('30');
  const [win, setWin] = useState('7');

  // Janela de relatório estável por período (evita refetch a cada render).
  const { startIso, endIso } = useMemo(() => {
    const days = Number(period) || 30;
    const end = new Date();
    const start = new Date(end.getTime() - days * 86_400_000);
    return { startIso: start.toISOString(), endIso: end.toISOString() };
  }, [period]);

  const reportPath = useMemo(() => {
    const p = new URLSearchParams({ model, start: startIso, end: endIso, window: win });
    return `/v1/attribution/report?${p.toString()}`;
  }, [model, startIso, endIso, win]);

  const pathsPath = useMemo(() => {
    const p = new URLSearchParams({ start: startIso, end: endIso, window: win, limit: '20' });
    return `/v1/attribution/paths?${p.toString()}`;
  }, [startIso, endIso, win]);

  const report = useApi<ReportResponse>(reportPath);
  const paths = useApi<PathsResponse>(pathsPath);

  const totals = report.data?.totals;
  const channelsCount = report.data?.channels.length ?? null;
  const uniquePaths = paths.data?.totals.unique_paths ?? null;

  return (
    <Page title="Attribution">
      <Toolbar>
        <Field label="Modelo">
          <Select value={model} onChange={(e) => setModel(e.target.value)}>
            {MODELS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Período">
          <Select value={period} onChange={(e) => setPeriod(e.target.value)}>
            {PERIODS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Janela de atribuição">
          <Select value={win} onChange={(e) => setWin(e.target.value)}>
            {WINDOWS.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </Select>
        </Field>
      </Toolbar>

      <Section>
        <StatRow>
          <StatTile
            label="Conversões"
            value={totals ? numberFmt.format(totals.conversions) : '—'}
            hint="no período"
          />
          <StatTile
            label="Receita atribuída"
            value={totals ? currencyFmt.format(totals.revenue) : '—'}
          />
          <StatTile label="Canais" value={channelsCount ?? '—'} />
          <StatTile label="Caminhos únicos" value={uniquePaths ?? '—'} />
        </StatRow>
      </Section>

      <Section
        title="Breakdown por canal"
        description="Crédito de conversão e receita por canal, segundo o modelo selecionado."
      >
        <AsyncBoundary
          state={report}
          empty={(d) => d.channels.length === 0}
          emptyHint="Sem conversões atribuídas neste período/janela."
        >
          {(d) => <DataTable columns={channelColumns} rows={d.channels} empty="Sem canais no período." />}
        </AsyncBoundary>
      </Section>

      <Section
        title="Top caminhos de conversão"
        description="Sequências de canais mais frequentes até a conversão (canais repetidos consecutivos são colapsados)."
      >
        <AsyncBoundary
          state={paths}
          empty={(d) => d.paths.length === 0}
          emptyHint="Sem caminhos de conversão neste período/janela."
        >
          {(d) => <DataTable columns={pathColumns} rows={d.paths} empty="Sem caminhos no período." />}
        </AsyncBoundary>
      </Section>
    </Page>
  );
}
