'use client';

import { useState } from 'react';
import {
  Page,
  Toolbar,
  Section,
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
 * /funnels — M5 Funnel Engine. Lista de funis (GET /v1/funnels → FunnelView[]).
 * A conversão % de cada funil vem de GET /v1/funnels/:id/stats (não do list),
 * então a coluna mostra '—' até haver esse dado.
 */

type FunnelStatus = 'active' | 'archived' | 'draft';

type FunnelStep = {
  step_id: string;
  name: string;
  event: string;
};

type FunnelRow = {
  id: string;
  name: string;
  status: FunnelStatus;
  attribution_window_days: number;
  steps: FunnelStep[];
  alert: { enabled: boolean; min_overall_conversion_rate: number };
  sparkline: number[];
  created_at: string;
  updated_at: string;
};

const STATUS_META: Record<FunnelStatus, { label: string; variant: BadgeVariant }> = {
  active: { label: 'Ativo', variant: 'good' },
  draft: { label: 'Rascunho', variant: 'info' },
  archived: { label: 'Arquivado', variant: 'neutral' },
};

const PERIODS = [
  { value: '7', label: 'Últimos 7 dias' },
  { value: '14', label: 'Últimos 14 dias' },
  { value: '30', label: 'Últimos 30 dias' },
  { value: '90', label: 'Últimos 90 dias' },
];

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
}

const columns: Column<FunnelRow>[] = [
  {
    key: 'name',
    header: 'Funil',
    render: (r) => (
      <div>
        <div className="font-medium text-slate-100">{r.name}</div>
        <div className="text-xs text-slate-500">
          Janela de atribuição: {r.attribution_window_days}d
        </div>
      </div>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    render: (r) => {
      const meta = STATUS_META[r.status] ?? { label: r.status, variant: 'neutral' as BadgeVariant };
      return <Badge variant={meta.variant}>{meta.label}</Badge>;
    },
  },
  {
    key: 'conversion',
    header: 'Conversão',
    align: 'right',
    render: () => <span className="tabular-nums text-slate-500">—</span>,
  },
  {
    key: 'steps',
    header: 'Steps',
    align: 'right',
    render: (r) => <span className="tabular-nums text-slate-200">{r.steps?.length ?? 0}</span>,
  },
  {
    key: 'alert',
    header: 'Alerta',
    render: (r) =>
      r.alert?.enabled ? (
        <Badge variant="warning">≥ {r.alert.min_overall_conversion_rate}%</Badge>
      ) : (
        <span className="text-xs text-slate-600">Desligado</span>
      ),
  },
  {
    key: 'updated_at',
    header: 'Atualizado',
    align: 'right',
    render: (r) => <span className="text-slate-400">{fmtDate(r.updated_at)}</span>,
  },
];

function NewFunnelPanel({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [status, setStatus] = useState<FunnelStatus>('active');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit() {
    if (!name.trim()) {
      setMsg({ ok: false, text: 'Informe um nome para o funil.' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      // Skeleton mínimo válido (≥ 2 steps). O builder detalha os steps depois.
      await api('/v1/funnels', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          status,
          attribution_window_days: 7,
          steps: [
            { name: 'Visitou', event: 'page_view', conditions: {} },
            { name: 'Converteu', event: 'purchase', conditions: {} },
          ],
        }),
      });
      setMsg({ ok: true, text: 'Funil criado.' });
      setName('');
      onCreated();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Falha ao criar o funil.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-6 rounded-xl border border-slate-800 bg-slate-950 p-4">
      <div className="mb-3 text-sm font-semibold text-slate-200">Novo funil</div>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Nome">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex.: Checkout"
            className="w-64"
          />
        </Field>
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value as FunnelStatus)}>
            <option value="active">Ativo</option>
            <option value="draft">Rascunho</option>
            <option value="archived">Arquivado</option>
          </Select>
        </Field>
        <Button variant="primary" onClick={submit} disabled={busy}>
          {busy ? 'Criando…' : 'Criar funil'}
        </Button>
      </div>
      {msg ? (
        <div className={`mt-3 text-xs ${msg.ok ? 'text-emerald-400' : 'text-rose-400'}`}>{msg.text}</div>
      ) : (
        <div className="mt-3 text-xs text-slate-600">
          Cria um esqueleto de 2 steps (page_view → purchase); ajuste os steps no builder do funil.
        </div>
      )}
    </div>
  );
}

export default function FunnelsPage() {
  const [period, setPeriod] = useState('7');
  const [showForm, setShowForm] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const state = useApi<FunnelRow[]>('/v1/funnels', [refreshKey]);
  const funnels = state.data ?? [];

  const total = funnels.length;
  const active = funnels.filter((f) => f.status === 'active').length;
  const drafts = funnels.filter((f) => f.status === 'draft').length;
  const archived = funnels.filter((f) => f.status === 'archived').length;
  const has = state.data != null;

  return (
    <Page title="Funis">
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
        <Button
          variant="primary"
          className="ml-auto self-end"
          onClick={() => setShowForm((v) => !v)}
        >
          {showForm ? 'Fechar' : '+ Novo funil'}
        </Button>
      </Toolbar>

      {showForm ? (
        <NewFunnelPanel
          onCreated={() => {
            setRefreshKey((k) => k + 1);
          }}
        />
      ) : null}

      <Section>
        <StatRow>
          <StatTile label="Total de funis" value={has ? total : '—'} />
          <StatTile label="Ativos" value={has ? active : '—'} hint="status = ativo" />
          <StatTile label="Rascunhos" value={has ? drafts : '—'} />
          <StatTile label="Arquivados" value={has ? archived : '—'} />
        </StatRow>
      </Section>

      <Section title="Funis" description="Funis de conversão configurados neste workspace.">
        <AsyncBoundary
          state={state}
          empty={(d) => d.length === 0}
          emptyHint="Crie o primeiro funil para acompanhar a conversão passo a passo."
        >
          {(rows) => <DataTable columns={columns} rows={rows} empty="Nenhum funil ainda." />}
        </AsyncBoundary>
      </Section>
    </Page>
  );
}
