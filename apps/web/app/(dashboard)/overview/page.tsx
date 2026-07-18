'use client';

import { useEffect, useState } from 'react';
import {
  Page,
  Section,
  Toolbar,
  Field,
  Select,
  StatRow,
  StatTile,
  DataTable,
  AsyncBoundary,
  type Column,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useApi } from '@/lib/use-api';

/**
 * Overview (M6) — KPIs nativos + top fontes de receita.
 *
 * Fontes:
 *  · GET /v1/metrics/kpis        → ROAS/CAC/AOV/CVR (spend_available=false até o M10)
 *  · GET /v1/metrics/breakdown   → receita por utm_source (top N)
 *
 * A janela é controlada por um filtro de período (RELATIVE_PERIODS do M6).
 */

interface KpisResponse {
  window: { start: string; end: string };
  spend_available: boolean;
  totals: {
    revenue: number;
    ad_spend: number;
    orders: number;
    purchases: number;
    conversions: number;
    purchasers: number;
    sessions: number;
    visitors: number;
    leads: number;
  };
  kpis: {
    roas: number | null;
    cac: number | null;
    cpl: number | null;
    ltv: number | null;
    aov: number | null;
    cvr: number | null;
    mrr: number | null;
  };
}

type BreakdownRow = { dimension: string; value: number | null };

interface BreakdownResponse {
  metric: string;
  dimension: string;
  window: { start: string; end: string };
  rows: BreakdownRow[];
}

const PERIODS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'today', label: 'Hoje' },
  { value: 'last_7_days', label: 'Últimos 7 dias' },
  { value: 'last_14_days', label: 'Últimos 14 dias' },
  { value: 'last_30_days', label: 'Últimos 30 dias' },
  { value: 'last_90_days', label: 'Últimos 90 dias' },
];

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

function fmtBrl(v: number | null): string {
  return v == null ? '—' : brl.format(v);
}
function fmtRoas(v: number | null): string {
  return v == null ? '—' : `${v.toFixed(2)}×`;
}
function fmtPct(v: number | null): string {
  return v == null ? '—' : `${v.toFixed(2)}%`;
}

const TOP_COLUMNS: Column<BreakdownRow>[] = [
  {
    key: 'dimension',
    header: 'Fonte (utm_source)',
    render: (r) => <span className="text-slate-200">{r.dimension}</span>,
  },
  {
    key: 'value',
    header: 'Receita',
    align: 'right',
    render: (r) => <span className="tabular-nums text-slate-200">{fmtBrl(r.value)}</span>,
  },
];

export default function OverviewPage() {
  const [period, setPeriod] = useState<string>('last_7_days');
  const [health, setHealth] = useState<string>('checando…');

  const kpisPath = `/v1/metrics/kpis?period=${encodeURIComponent(period)}`;
  const breakdownPath = `/v1/metrics/breakdown?${new URLSearchParams({
    dimension: 'utm_source',
    metric: 'revenue',
    period,
    limit: '10',
  }).toString()}`;

  const kpis = useApi<KpisResponse>(kpisPath);
  const breakdown = useApi<BreakdownResponse>(breakdownPath);

  useEffect(() => {
    api<{ status: string }>('/health')
      .then((d) => setHealth(d.status))
      .catch(() => setHealth('offline'));
  }, []);

  return (
    <Page title="Overview">
      <Toolbar>
        <Field label="Período">
          <Select value={period} onChange={(e) => setPeriod(e.target.value)}>
            {PERIODS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
      </Toolbar>

      <Section
        title="KPIs"
        description="Métricas nativas do workspace na janela selecionada."
      >
        <AsyncBoundary
          state={kpis}
          emptyHint="Conecte o tracking (M2) para popular os KPIs."
        >
          {(d) => (
            <StatRow>
              <StatTile
                label="ROAS"
                value={fmtRoas(d.kpis.roas)}
                hint={d.spend_available ? 'Receita ÷ investimento' : 'Requer conexão de Ads (M10)'}
              />
              <StatTile
                label="CAC"
                value={fmtBrl(d.kpis.cac)}
                hint={d.spend_available ? 'Investimento ÷ compradores' : 'Requer conexão de Ads (M10)'}
              />
              <StatTile label="AOV" value={fmtBrl(d.kpis.aov)} hint="Receita ÷ pedidos" />
              <StatTile label="CVR" value={fmtPct(d.kpis.cvr)} hint="Compras ÷ sessões" />
            </StatRow>
          )}
        </AsyncBoundary>
      </Section>

      <Section
        title="Top fontes"
        description="Receita por utm_source (maior para menor) na janela selecionada."
      >
        <AsyncBoundary
          state={breakdown}
          empty={(d) => d.rows.length === 0}
          emptyHint="Sem receita atribuída a fontes ainda."
        >
          {(d) => <DataTable columns={TOP_COLUMNS} rows={d.rows} empty="Nenhuma fonte com receita." />}
        </AsyncBoundary>
      </Section>

      <p className="mt-8 text-xs text-slate-600">
        API: <span className="font-mono text-teal-300">{health}</span>
      </p>
    </Page>
  );
}
