'use client';

import { useMemo, useState } from 'react';
import {
  Page,
  Section,
  Toolbar,
  StatRow,
  StatTile,
  DataTable,
  Badge,
  Field,
  Select,
  AsyncBoundary,
  type Column,
  type BadgeVariant,
} from '@/components/ui';
import { useApi } from '@/lib/use-api';

/**
 * M10 — Creative Analytics. O "delta" do produto: o que a plataforma REPORTA vs. o
 * que o Truvo mede de verdade, por criativo. GET /v1/creatives (grid).
 */

// ─────────────────────────── tipos da resposta (best-effort do controller) ───────────────────────────

interface ReportedMetrics {
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number | null;
  conversions: number;
  revenue: number;
  roas: number | null;
  cac: number | null;
}
interface RealMetrics {
  conversions: number;
  revenue: number;
  sessions: number;
  checkouts: number;
  roas: number | null;
  cac: number | null;
  cvr: number | null;
}
type DeltaVerdict = 'overstated' | 'understated' | 'aligned' | 'unknown';
interface DeltaMetrics {
  roas: number | null;
  percent: number | null;
  revenue: number | null;
  conversions: number | null;
  verdict: DeltaVerdict;
}

/** Linha do grid — `type` (não interface) p/ satisfazer DataTable<Record<string,unknown>>. */
type CreativeItem = {
  platform: string;
  ad_id: string;
  ad_name: string;
  campaign_name: string;
  creative_type: string;
  phase: string;
  reported: ReportedMetrics;
  real: RealMetrics;
  delta: DeltaMetrics;
  reported_available: boolean;
  real_available: boolean;
};

interface GridResult {
  range: { start: string; end: string };
  reported_available: boolean;
  totals: {
    creatives: number;
    spend: number;
    reported_revenue: number;
    real_revenue: number;
    real_conversions: number;
  };
  count: number;
  items: CreativeItem[];
}

// ─────────────────────────── opções de filtro ───────────────────────────

const PLATFORMS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Todas as plataformas' },
  { value: 'meta', label: 'Meta' },
  { value: 'google', label: 'Google' },
  { value: 'tiktok', label: 'TikTok' },
];

const PERIODS: Array<{ value: string; label: string }> = [
  { value: '7', label: 'Últimos 7 dias' },
  { value: '14', label: 'Últimos 14 dias' },
  { value: '30', label: 'Últimos 30 dias' },
  { value: '90', label: 'Últimos 90 dias' },
];

const PLATFORM_LABEL: Record<string, string> = { meta: 'Meta', google: 'Google', tiktok: 'TikTok' };

// ─────────────────────────── helpers de formatação ───────────────────────────

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

const intFmt = new Intl.NumberFormat('pt-BR');
const moneyFmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

const fmtInt = (n: number | null | undefined): string => (n == null ? '—' : intFmt.format(n));
const fmtMoney = (n: number | null | undefined): string => (n == null ? '—' : moneyFmt.format(n));
const fmtRoas = (n: number | null | undefined): string => (n == null ? '—' : `${n.toFixed(2)}x`);
const fmtPct = (n: number | null | undefined): string =>
  n == null ? '—' : `${n > 0 ? '+' : ''}${(n * 100).toFixed(0)}%`;

/** Divisão segura p/ os KPIs agregados (sem inventar número — regra 12). */
function safeDiv(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

/** Verdict do delta → cor reservada + label (nunca cor sozinha — dataviz). */
function verdictBadge(verdict: DeltaVerdict): { variant: BadgeVariant; label: string } {
  switch (verdict) {
    case 'overstated':
      return { variant: 'critical', label: 'Superestimado' };
    case 'understated':
      return { variant: 'info', label: 'Subestimado' };
    case 'aligned':
      return { variant: 'good', label: 'Alinhado' };
    default:
      return { variant: 'neutral', label: 'Sem base' };
  }
}

// ─────────────────────────── colunas da tabela ───────────────────────────

const columns: Column<CreativeItem>[] = [
  {
    key: 'creative',
    header: 'Criativo',
    render: (r) => (
      <div className="min-w-[12rem]">
        <div className="font-medium text-slate-100">{r.ad_name || r.ad_id}</div>
        <div className="text-xs text-slate-500">
          {[r.campaign_name, r.creative_type, r.phase].filter(Boolean).join(' · ') || '—'}
        </div>
      </div>
    ),
  },
  {
    key: 'platform',
    header: 'Plataforma',
    render: (r) => <Badge variant="neutral">{PLATFORM_LABEL[r.platform] ?? r.platform ?? '—'}</Badge>,
  },
  { key: 'spend', header: 'Investimento', align: 'right', render: (r) => fmtMoney(r.reported.spend) },
  {
    key: 'roas_reported',
    header: 'ROAS reportado',
    align: 'right',
    render: (r) => <span className="text-slate-300">{fmtRoas(r.reported.roas)}</span>,
  },
  {
    key: 'roas_real',
    header: 'ROAS real',
    align: 'right',
    render: (r) => <span className="font-medium text-slate-100">{fmtRoas(r.real.roas)}</span>,
  },
  {
    key: 'delta',
    header: 'Delta (reportado vs. real)',
    align: 'right',
    render: (r) => {
      const b = verdictBadge(r.delta.verdict);
      return (
        <div className="flex items-center justify-end gap-2">
          <span className="text-slate-400">{fmtPct(r.delta.percent)}</span>
          <Badge variant={b.variant}>{b.label}</Badge>
        </div>
      );
    },
  },
];

// ─────────────────────────── página ───────────────────────────

export default function CreativesPage() {
  const [platform, setPlatform] = useState('');
  const [period, setPeriod] = useState('30');

  const path = useMemo(() => {
    const params = new URLSearchParams();
    if (platform) params.set('platform', platform);
    params.set('start', daysAgoIso(Number(period) - 1));
    params.set('end', todayIso());
    params.set('order_by', 'spend');
    params.set('limit', '100');
    return `/v1/creatives?${params.toString()}`;
  }, [platform, period]);

  const grid = useApi<GridResult>(path, [platform, period]);
  const totals = grid.data?.totals;
  const roasReported = totals ? safeDiv(totals.reported_revenue, totals.spend) : null;
  const roasReal = totals ? safeDiv(totals.real_revenue, totals.spend) : null;

  return (
    <Page title="Criativos">
      <Toolbar>
        <Field label="Plataforma">
          <Select value={platform} onChange={(e) => setPlatform(e.target.value)}>
            {PLATFORMS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
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
      </Toolbar>

      <Section>
        <StatRow>
          <StatTile label="Criativos" value={totals ? fmtInt(totals.creatives) : '—'} hint="No período/plataforma" />
          <StatTile label="Investimento" value={totals ? fmtMoney(totals.spend) : '—'} hint="Reportado pelas plataformas" />
          <StatTile label="ROAS reportado" value={fmtRoas(roasReported)} hint="Receita reportada ÷ investimento" />
          <StatTile
            label="ROAS real"
            value={fmtRoas(roasReal)}
            hint="Receita medida pelo Truvo ÷ investimento"
          />
        </StatRow>
      </Section>

      <Section
        title="Reportado vs. real por criativo"
        description="A plataforma tende a superestimar. O delta compara o ROAS reportado pela Ads API com o ROAS real medido server-side pelo Truvo."
      >
        <AsyncBoundary
          state={grid}
          empty={(d) => d.items.length === 0}
          emptyHint="Conecte uma conta de anúncio e rode o sync para popular os criativos."
        >
          {(d) => <DataTable columns={columns} rows={d.items} empty="Nenhum criativo no período." />}
        </AsyncBoundary>
      </Section>
    </Page>
  );
}
