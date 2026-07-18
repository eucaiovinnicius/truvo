'use client';

import { useState } from 'react';
import {
  AsyncBoundary,
  Badge,
  Button,
  DataTable,
  Field,
  Input,
  Section,
  StatRow,
  StatTile,
  Page,
  Toolbar,
  type BadgeVariant,
  type Column,
} from '@/components/ui';
import { useApi } from '@/lib/use-api';

// ─────────────────────────── tipos (best-effort do controller M14) ───────────────────────────
// GET /v1/data-quality/reconciliation?start=&end=
// GET /v1/data-quality/bot-report?start=&end=

type DayStatus = 'reconciled' | 'uncertain' | 'no_ground_truth';

type ReconciliationDay = {
  day: string;
  truvo_revenue: number;
  truvo_orders: number;
  gateway_revenue: number;
  gateway_orders: number;
  gap: number | null;
  status: DayStatus;
};

type ReconciliationSummary = {
  threshold: number;
  has_ground_truth: boolean;
  period_truvo_revenue: number;
  period_gateway_revenue: number;
  period_truvo_orders: number;
  period_gateway_orders: number;
  period_gap: number | null;
  worst_day_gap: number | null;
  days_uncertain: number;
  reconciliation: DayStatus;
  trusted: boolean;
};

type ReconciliationResult = {
  range: { start: string; end: string };
  summary: ReconciliationSummary;
  days: ReconciliationDay[];
};

type BotSourceRow = {
  source: string;
  total: number;
  bots: number;
  humans: number;
  bot_rate: number;
};

type BotReport = {
  range: { start: string; end: string };
  totals: { events: number; bots: number; humans: number; bot_rate: number };
  by_day: Array<{ day: string; total: number; bots: number; humans: number; bot_rate: number }>;
  by_source: BotSourceRow[];
  top_bot_user_agents: Array<{ user_agent: string; events: number }>;
};

// Limiar de confiança default do M14 (gap aceitável). O período usa o threshold do workspace.
const GAP_OK = 0.02;

export default function DataQualityPage() {
  const [draftStart, setDraftStart] = useState('');
  const [draftEnd, setDraftEnd] = useState('');
  const [range, setRange] = useState<{ start: string; end: string }>({ start: '', end: '' });

  const qs = buildRangeQuery(range.start, range.end);
  const recon = useApi<ReconciliationResult>(`/v1/data-quality/reconciliation${qs}`);
  const bots = useApi<BotReport>(`/v1/data-quality/bot-report${qs}`);

  function onApply(e: React.FormEvent) {
    e.preventDefault();
    setRange({ start: draftStart, end: draftEnd });
  }

  const dayColumns: Column<ReconciliationDay>[] = [
    { key: 'day', header: 'Dia', render: (r) => fmtDay(r.day) },
    { key: 'truvo_revenue', header: 'Receita Truvo', align: 'right', render: (r) => fmtMoney(r.truvo_revenue) },
    { key: 'gateway_revenue', header: 'Receita gateway', align: 'right', render: (r) => fmtMoney(r.gateway_revenue) },
    { key: 'truvo_orders', header: 'Pedidos Truvo', align: 'right', render: (r) => fmtInt(r.truvo_orders) },
    { key: 'gateway_orders', header: 'Pedidos gateway', align: 'right', render: (r) => fmtInt(r.gateway_orders) },
    { key: 'gap', header: 'Gap', align: 'right', render: (r) => fmtPct(r.gap) },
    { key: 'status', header: 'Status', render: (r) => statusBadge(r.status) },
  ];

  const sourceColumns: Column<BotSourceRow>[] = [
    { key: 'source', header: 'Origem' },
    { key: 'total', header: 'Eventos', align: 'right', render: (r) => fmtInt(r.total) },
    { key: 'bots', header: 'Bots', align: 'right', render: (r) => fmtInt(r.bots) },
    { key: 'humans', header: 'Humanos', align: 'right', render: (r) => fmtInt(r.humans) },
    {
      key: 'bot_rate',
      header: 'Taxa de bots',
      align: 'right',
      render: (r) => (
        <span className="inline-flex items-center gap-2">
          {fmtPct(r.bot_rate)}
          <Badge variant={r.bot_rate > 0.3 ? 'warning' : 'neutral'}>
            {r.bot_rate > 0.3 ? 'alta' : 'ok'}
          </Badge>
        </span>
      ),
    },
  ];

  return (
    <Page title="Qualidade de Dados">
      <form onSubmit={onApply}>
        <Toolbar>
          <Field label="Início">
            <Input type="date" value={draftStart} onChange={(e) => setDraftStart(e.target.value)} />
          </Field>
          <Field label="Fim">
            <Input type="date" value={draftEnd} onChange={(e) => setDraftEnd(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary">
            Aplicar
          </Button>
        </Toolbar>
      </form>

      <Section
        title="Reconciliação de receita"
        description="Receita medida pelo Truvo (is_bot = 0) versus o total real do gateway de pagamento, por dia."
      >
        <AsyncBoundary state={recon} empty={(d) => d.days.length === 0}>
          {(d) => {
            const s = d.summary;
            return (
              <>
                <StatRow>
                  <StatTile
                    label="Reconciliation gap"
                    value={
                      <span className="inline-flex items-center gap-2">
                        {fmtPct(s.period_gap)}
                        {gapBadge(s.period_gap, s.threshold)}
                      </span>
                    }
                    hint={`Limiar do workspace: ${fmtPct(s.threshold)}`}
                  />
                  <StatTile
                    label="Receita Truvo"
                    value={fmtMoney(s.period_truvo_revenue)}
                    hint={`${fmtInt(s.period_truvo_orders)} pedidos`}
                  />
                  <StatTile
                    label="Receita gateway"
                    value={s.has_ground_truth ? fmtMoney(s.period_gateway_revenue) : '—'}
                    hint={s.has_ground_truth ? `${fmtInt(s.period_gateway_orders)} pedidos` : 'sem ground truth'}
                  />
                  <StatTile
                    label="Dias incertos"
                    value={fmtInt(s.days_uncertain)}
                    hint={`pior gap: ${fmtPct(s.worst_day_gap)}`}
                  />
                </StatRow>

                <div className="mt-4">
                  <DataTable columns={dayColumns} rows={d.days} empty="Sem dias no intervalo." />
                </div>
              </>
            );
          }}
        </AsyncBoundary>
      </Section>

      <Section
        title="Detecção de bots"
        description="Volume de tráfego classificado como bot e filtrado da análise (regra 11), por origem."
      >
        <AsyncBoundary state={bots} empty={(d) => d.totals.events === 0}>
          {(d) => (
            <>
              <StatRow>
                <StatTile label="Eventos" value={fmtInt(d.totals.events)} />
                <StatTile label="Bots filtrados" value={fmtInt(d.totals.bots)} />
                <StatTile label="Humanos" value={fmtInt(d.totals.humans)} />
                <StatTile
                  label="Taxa de bots"
                  value={
                    <span className="inline-flex items-center gap-2">
                      {fmtPct(d.totals.bot_rate)}
                      <Badge variant={d.totals.bot_rate > 0.3 ? 'warning' : 'good'}>
                        {d.totals.bot_rate > 0.3 ? 'atenção' : 'saudável'}
                      </Badge>
                    </span>
                  }
                />
              </StatRow>

              <div className="mt-4">
                <DataTable columns={sourceColumns} rows={d.by_source} empty="Sem tráfego no intervalo." />
              </div>
            </>
          )}
        </AsyncBoundary>
      </Section>
    </Page>
  );
}

// ─────────────────────────── badges de status ───────────────────────────

function statusBadge(status: DayStatus) {
  const map: Record<DayStatus, { variant: BadgeVariant; label: string }> = {
    reconciled: { variant: 'good', label: 'Reconciliado' },
    uncertain: { variant: 'warning', label: 'Incerto' },
    no_ground_truth: { variant: 'neutral', label: 'Sem base' },
  };
  const { variant, label } = map[status];
  return <Badge variant={variant}>{label}</Badge>;
}

/** Badge do gap do período: good quando dentro do limiar (default 2%), warning acima. */
function gapBadge(gap: number | null, threshold: number) {
  if (gap == null) return <Badge variant="neutral">sem base</Badge>;
  const limit = Number.isFinite(threshold) && threshold > 0 ? threshold : GAP_OK;
  return gap < limit ? <Badge variant="good">ok</Badge> : <Badge variant="warning">acima</Badge>;
}

// ─────────────────────────── helpers ───────────────────────────

function buildRangeQuery(start: string, end: string): string {
  const params = new URLSearchParams();
  if (start) params.set('start', start);
  if (end) params.set('end', end);
  const s = params.toString();
  return s ? `?${s}` : '';
}

function fmtInt(n: number | null | undefined): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('pt-BR').format(n);
}

function fmtMoney(n: number | null | undefined): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n);
}

function fmtPct(ratio: number | null | undefined): string {
  if (ratio == null) return '—';
  return `${(ratio * 100).toFixed(2)}%`;
}

function fmtDay(day: string | null | undefined): string {
  if (!day) return '—';
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', timeZone: 'UTC' });
}
