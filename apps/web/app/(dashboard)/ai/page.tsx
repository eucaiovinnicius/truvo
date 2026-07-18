'use client';

import { useMemo, useState } from 'react';
import {
  Page,
  Section,
  Toolbar,
  Card,
  StatRow,
  StatTile,
  DataTable,
  Badge,
  Button,
  Select,
  Input,
  Field,
  AsyncBoundary,
  type Column,
  type BadgeVariant,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useApi } from '@/lib/use-api';

/**
 * M17 — AI Journey Intelligence. Melhores jornadas por canal (determinístico,
 * GET /v1/ai/journeys/best) + Q&A sobre as jornadas (POST /v1/ai/ask).
 */

// ─────────────────────────── vocabulário (espelha ai.constants.ts) ───────────────────────────

const GOALS = [
  { value: 'maximize_roas', label: 'Maximizar ROAS' },
  { value: 'minimize_cac', label: 'Minimizar CAC' },
  { value: 'maximize_ltv', label: 'Maximizar LTV' },
  { value: 'maximize_cvr', label: 'Maximizar CVR' },
  { value: 'maximize_revenue', label: 'Maximizar receita' },
] as const;
type Goal = (typeof GOALS)[number]['value'];

const GOAL_LABEL: Record<string, string> = Object.fromEntries(GOALS.map((g) => [g.value, g.label]));

// ─────────────────────────── tipos da resposta ───────────────────────────

/** Canal ranqueado — `type` p/ satisfazer DataTable<Record<string,unknown>>. */
type ChannelRow = {
  rank: number;
  channel: string;
  persons: number;
  converters: number;
  cvr: number | null;
  cvr_wilson_lower: number | null;
  attributed_revenue: number | null;
  spend: number | null;
  roas: number | null;
  cac: number | null;
  ltv_proxy: number | null;
  goal_score: number | null;
};

type JourneyRow = {
  path: string[] | string;
  conversions: number;
  revenue: number;
  avg_path_length: number | null;
};

type ReconStatus = 'reconciled' | 'uncertain' | 'no_ground_truth';
interface BestResult {
  goal: string;
  window: { start: string; end: string; days: number };
  spend_available: boolean;
  attribution_model: string;
  uncertain: boolean;
  reconciliation: {
    truvo_revenue: number;
    gateway_revenue: number | null;
    reconciliation_gap: number | null;
    uncertain_days: number;
    status: ReconStatus;
  };
  best_channels: ChannelRow[];
  top_journeys: JourneyRow[];
}

interface AskResult {
  conversation_id: string;
  answer: string;
  uncertain: boolean;
  status: string;
  reason?: string;
}

// ─────────────────────────── helpers ───────────────────────────

const intFmt = new Intl.NumberFormat('pt-BR');
const moneyFmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

const fmtInt = (n: number | null | undefined): string => (n == null ? '—' : intFmt.format(n));
const fmtMoney = (n: number | null | undefined): string => (n == null ? '—' : moneyFmt.format(n));
const fmtRoas = (n: number | null | undefined): string => (n == null ? '—' : `${n.toFixed(2)}x`);
const fmtPct = (n: number | null | undefined): string => (n == null ? '—' : `${(n * 100).toFixed(1)}%`);
const fmtNum = (n: number | null | undefined): string => (n == null ? '—' : n.toFixed(2));

const RECON_BADGE: Record<ReconStatus, { variant: BadgeVariant; label: string }> = {
  reconciled: { variant: 'good', label: 'Reconciliado' },
  uncertain: { variant: 'warning', label: 'Incerto' },
  no_ground_truth: { variant: 'neutral', label: 'Sem ground truth' },
};

const channelColumns: Column<ChannelRow>[] = [
  { key: 'rank', header: '#', render: (r) => <span className="text-slate-500">{r.rank}</span> },
  {
    key: 'channel',
    header: 'Canal',
    render: (r) => <span className="font-medium text-slate-100">{r.channel || 'direct'}</span>,
  },
  { key: 'persons', header: 'Pessoas', align: 'right', render: (r) => fmtInt(r.persons) },
  { key: 'converters', header: 'Conversores', align: 'right', render: (r) => fmtInt(r.converters) },
  {
    key: 'cvr',
    header: 'CVR (Wilson)',
    align: 'right',
    render: (r) => <span className="text-slate-300">{fmtPct(r.cvr_wilson_lower ?? r.cvr)}</span>,
  },
  { key: 'roas', header: 'ROAS', align: 'right', render: (r) => fmtRoas(r.roas) },
  { key: 'cac', header: 'CAC', align: 'right', render: (r) => fmtMoney(r.cac) },
  {
    key: 'attributed_revenue',
    header: 'Receita atribuída',
    align: 'right',
    render: (r) => <span className="text-slate-100">{fmtMoney(r.attributed_revenue)}</span>,
  },
];

const journeyColumns: Column<JourneyRow>[] = [
  {
    key: 'path',
    header: 'Sequência de canais',
    render: (r) => (
      <span className="font-medium text-slate-100">
        {Array.isArray(r.path) ? r.path.join(' → ') : String(r.path)}
      </span>
    ),
  },
  { key: 'conversions', header: 'Conversões', align: 'right', render: (r) => fmtInt(r.conversions) },
  { key: 'revenue', header: 'Receita', align: 'right', render: (r) => fmtMoney(r.revenue) },
  {
    key: 'avg_path_length',
    header: 'Tam. médio',
    align: 'right',
    render: (r) => fmtNum(r.avg_path_length),
  },
];

// ─────────────────────────── página ───────────────────────────

export default function AiPage() {
  const [pendingGoal, setPendingGoal] = useState<Goal>('maximize_roas');
  const [goal, setGoal] = useState<Goal>('maximize_roas');

  const [question, setQuestion] = useState('');
  const [ask, setAsk] = useState<{ loading: boolean; error: string | null; data: AskResult | null }>({
    loading: false,
    error: null,
    data: null,
  });

  const path = useMemo(() => {
    const params = new URLSearchParams({ goal, limit: '10' });
    return `/v1/ai/journeys/best?${params.toString()}`;
  }, [goal]);

  const best = useApi<BestResult>(path, [goal]);
  const recon = best.data?.reconciliation;

  async function submitQuestion(): Promise<void> {
    const q = question.trim();
    if (q.length < 3) return;
    setAsk({ loading: true, error: null, data: null });
    try {
      const data = await api<AskResult>('/v1/ai/ask', {
        method: 'POST',
        body: JSON.stringify({ question: q }),
      });
      setAsk({ loading: false, error: null, data });
    } catch (e: unknown) {
      setAsk({ loading: false, error: e instanceof Error ? e.message : 'Falha na consulta', data: null });
    }
  }

  return (
    <Page title="AI Journey">
      <Toolbar>
        <Field label="Objetivo">
          <Select value={pendingGoal} onChange={(e) => setPendingGoal(e.target.value as Goal)}>
            {GOALS.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="self-end">
          <Button variant="primary" onClick={() => setGoal(pendingGoal)} disabled={best.loading}>
            {best.loading ? 'Analisando…' : 'Analisar'}
          </Button>
        </div>
      </Toolbar>

      <Section>
        <StatRow>
          <StatTile label="Objetivo" value={GOAL_LABEL[goal] ?? goal} hint="Critério de ranqueamento" />
          <StatTile label="Canais" value={best.data ? fmtInt(best.data.best_channels.length) : '—'} hint="Ranqueados no período" />
          <StatTile
            label="Receita reconciliada"
            value={recon ? fmtMoney(recon.gateway_revenue) : '—'}
            hint="Ground truth do gateway (M14)"
          />
          <StatTile
            label="Reconciliação"
            value={
              recon ? <Badge variant={RECON_BADGE[recon.status].variant}>{RECON_BADGE[recon.status].label}</Badge> : '—'
            }
            hint={recon ? `Gap ${fmtPct(recon.reconciliation_gap)}` : 'Marca de confiança (regra 12)'}
          />
        </StatRow>
      </Section>

      <Section
        title="Melhores canais por objetivo"
        description="Ranqueamento determinístico (sem LLM) das jornadas por canal segundo o objetivo selecionado."
      >
        <AsyncBoundary
          state={best}
          empty={(d) => d.best_channels.length === 0}
          emptyHint="Sem sinal de jornada no período. Conecte o tracking e a atribuição (M7) para popular."
        >
          {(d) => <DataTable columns={channelColumns} rows={d.best_channels} empty="Nenhum canal ranqueado." />}
        </AsyncBoundary>
      </Section>

      <Section title="Top jornadas (sequências)" description="Caminhos de canal mais frequentes até a conversão.">
        <AsyncBoundary
          state={best}
          empty={(d) => d.top_journeys.length === 0}
          emptyHint="As sequências de canal aparecem quando houver touchpoints atribuídos."
        >
          {(d) => <DataTable columns={journeyColumns} rows={d.top_journeys} empty="Nenhuma jornada registrada." />}
        </AsyncBoundary>
      </Section>

      <Section title="Pergunte sobre as jornadas" description="Q&A em linguagem natural (POST /v1/ai/ask) — traduzido para uma consulta segura do explorador (M16).">
        <Card className="p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Field label="Pergunta">
                <Input
                  placeholder="ex.: Qual canal teve o melhor ROAS nos últimos 30 dias?"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submitQuestion();
                  }}
                />
              </Field>
            </div>
            <Button variant="primary" onClick={submitQuestion} disabled={ask.loading || question.trim().length < 3}>
              {ask.loading ? 'Perguntando…' : 'Perguntar'}
            </Button>
          </div>

          {ask.error ? (
            <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs text-slate-500">
              IA indisponível: <span className="font-mono">{ask.error}</span>. Requer ANTHROPIC_API_KEY e a infra no ar.
            </div>
          ) : null}

          {ask.data ? (
            <div className="mt-4 rounded-lg border border-slate-800 bg-slate-900/40 p-4">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-xs uppercase tracking-wide text-slate-500">Resposta</span>
                {ask.data.uncertain ? <Badge variant="warning">Incerto</Badge> : null}
                {ask.data.status !== 'ok' ? <Badge variant="neutral">{ask.data.status}</Badge> : null}
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-200">{ask.data.answer}</p>
            </div>
          ) : null}
        </Card>
      </Section>
    </Page>
  );
}
