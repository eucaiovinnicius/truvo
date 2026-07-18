'use client';

import { useMemo, useState } from 'react';
import {
  Page,
  Section,
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
 * M16 — Data Explorer (shell). Um construtor visual que monta um ExplorerQuerySpec
 * (measure/dimension/filter) e a biblioteca de insights salvos (GET /v1/insights).
 *
 * A execução real liga em POST /v1/explorer/query quando a infra (ClickHouse) subir
 * — aqui o botão "Executar" já dispara a chamada, e o AsyncBoundary trata a falha
 * graciosamente enquanto a API não responde.
 */

// ─────────────────────────── vocabulário do catálogo (espelha compiler/catalog.ts) ───────────────────────────

const SOURCES = ['events', 'touchpoints'] as const;
type Source = (typeof SOURCES)[number];

const MEASURE_METRICS = ['count', 'unique', 'sum', 'avg', 'min', 'max', 'p50', 'p90', 'p95', 'rate'] as const;
type Metric = (typeof MEASURE_METRICS)[number];
const METRICS_NEED_PROPERTY = new Set<Metric>(['sum', 'avg', 'min', 'max', 'p50', 'p90', 'p95']);

const FILTER_OPS = [
  'eq',
  'neq',
  'in',
  'not_in',
  'gte',
  'lte',
  'gt',
  'lt',
  'contains',
  'not_contains',
  'is_set',
  'is_not_set',
] as const;

const DATE_PRESETS = ['last_7_days', 'last_14_days', 'last_30_days', 'last_90_days', 'this_month', 'last_month'] as const;

/** Dimensões/filtros por fonte (subconjunto do catálogo do M16). */
const DIMENSIONS: Record<Source, string[]> = {
  events: [
    'event_name',
    'source',
    'context.utm_source',
    'context.utm_medium',
    'context.utm_campaign',
    'context.device_type',
    'context.ip_country',
  ],
  touchpoints: ['channel', 'source', 'context.utm_source', 'context.utm_medium', 'context.utm_campaign'],
};

// ─────────────────────────── tipos da resposta ───────────────────────────

/** Insight salvo — `type` p/ satisfazer DataTable<Record<string,unknown>>. */
type InsightRow = {
  id: string;
  name: string;
  description: string | null;
  kind: 'visual' | 'sql';
  insight_type: string;
  current_version: number;
  updated_at: string;
};

interface ExecResult {
  status: 'ok' | 'aborted' | 'error';
  reason?: string;
  columns?: string[];
  rows?: Array<Record<string, unknown>>;
  cost?: { duration_ms: number; result_rows: number };
}

// ─────────────────────────── helpers ───────────────────────────

const KIND_BADGE: Record<string, { variant: BadgeVariant; label: string }> = {
  visual: { variant: 'info', label: 'Visual' },
  sql: { variant: 'neutral', label: 'SQL' },
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR');
}

const insightColumns: Column<InsightRow>[] = [
  {
    key: 'name',
    header: 'Insight',
    render: (r) => (
      <div className="min-w-[12rem]">
        <div className="font-medium text-slate-100">{r.name}</div>
        {r.description ? <div className="text-xs text-slate-500">{r.description}</div> : null}
      </div>
    ),
  },
  {
    key: 'kind',
    header: 'Tipo',
    render: (r) => {
      const b = KIND_BADGE[r.kind] ?? { variant: 'neutral' as BadgeVariant, label: r.kind };
      return <Badge variant={b.variant}>{b.label}</Badge>;
    },
  },
  { key: 'insight_type', header: 'Consulta', render: (r) => <span className="text-slate-300">{r.insight_type}</span> },
  { key: 'current_version', header: 'Versão', align: 'right', render: (r) => `v${r.current_version}` },
  { key: 'updated_at', header: 'Atualizado', align: 'right', render: (r) => fmtDate(r.updated_at) },
];

// ─────────────────────────── página ───────────────────────────

export default function ExplorerPage() {
  // construtor de spec (estático).
  const [source, setSource] = useState<Source>('events');
  const [metric, setMetric] = useState<Metric>('count');
  const [event, setEvent] = useState('');
  const [property, setProperty] = useState('');
  const [dimension, setDimension] = useState('');
  const [filterField, setFilterField] = useState('');
  const [filterOp, setFilterOp] = useState<(typeof FILTER_OPS)[number]>('eq');
  const [filterValue, setFilterValue] = useState('');
  const [preset, setPreset] = useState<(typeof DATE_PRESETS)[number]>('last_30_days');

  // estado da execução (POST /v1/explorer/query).
  const [exec, setExec] = useState<{ loading: boolean; error: string | null; data: ExecResult | null }>({
    loading: false,
    error: null,
    data: null,
  });

  const dims = DIMENSIONS[source];
  const needsProperty = METRICS_NEED_PROPERTY.has(metric);

  const spec = useMemo(() => {
    const measure: Record<string, unknown> = { id: 'm1', metric };
    if (needsProperty && property) measure.property = property;
    if ((metric === 'count' || metric === 'rate') && event) measure.event = event;

    const s: Record<string, unknown> = {
      insight_type: 'breakdown',
      source,
      measures: [measure],
      dimensions: dimension ? [dimension] : [],
      date_range: { preset },
      limit: 50,
    };
    if (filterField && (filterValue || filterOp === 'is_set' || filterOp === 'is_not_set')) {
      s.filters =
        filterOp === 'is_set' || filterOp === 'is_not_set'
          ? { field: filterField, op: filterOp }
          : { field: filterField, op: filterOp, value: filterValue };
    }
    return s;
  }, [source, metric, event, property, dimension, filterField, filterOp, filterValue, preset, needsProperty]);

  const insights = useApi<InsightRow[]>('/v1/insights');

  async function runQuery(): Promise<void> {
    setExec({ loading: true, error: null, data: null });
    try {
      const data = await api<ExecResult>('/v1/explorer/query', {
        method: 'POST',
        body: JSON.stringify(spec),
      });
      setExec({ loading: false, error: null, data });
    } catch (e: unknown) {
      setExec({ loading: false, error: e instanceof Error ? e.message : 'Falha na execução', data: null });
    }
  }

  return (
    <Page title="Data Explorer">
      <Section>
        <StatRow>
          <StatTile label="Insights salvos" value={insights.data ? insights.data.length : '—'} hint="Biblioteca do workspace" />
          <StatTile label="Fonte" value={source === 'events' ? 'Eventos' : 'Touchpoints'} hint="Tabela lógica do explorador" />
          <StatTile label="Métrica" value={metric} hint="Measure do spec atual" />
          <StatTile label="Dimensão" value={dimension || '—'} hint="Group by do spec atual" />
        </StatRow>
      </Section>

      <Section title="Construtor de consulta" description="Monte um ExplorerQuerySpec visualmente. A execução real usa POST /v1/explorer/query quando a infra subir.">
        <Card className="p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Fonte">
              <Select
                value={source}
                onChange={(e) => {
                  setSource(e.target.value as Source);
                  setDimension('');
                  setFilterField('');
                }}
              >
                {SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {s === 'events' ? 'Eventos' : 'Touchpoints'}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Measure (métrica)">
              <Select value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
                {MEASURE_METRICS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
            </Field>

            {needsProperty ? (
              <Field label="Property (numérica)">
                <Input placeholder="ex.: value" value={property} onChange={(e) => setProperty(e.target.value)} />
              </Field>
            ) : (
              <Field label="Event (opcional)">
                <Input placeholder="ex.: purchase" value={event} onChange={(e) => setEvent(e.target.value)} />
              </Field>
            )}

            <Field label="Dimension (group by)">
              <Select value={dimension} onChange={(e) => setDimension(e.target.value)}>
                <option value="">Nenhuma</option>
                {dims.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Filtro — campo">
              <Select value={filterField} onChange={(e) => setFilterField(e.target.value)}>
                <option value="">Sem filtro</option>
                {dims.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Filtro — operador">
              <Select value={filterOp} onChange={(e) => setFilterOp(e.target.value as (typeof FILTER_OPS)[number])}>
                {FILTER_OPS.map((op) => (
                  <option key={op} value={op}>
                    {op}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Filtro — valor">
              <Input
                placeholder="valor"
                value={filterValue}
                onChange={(e) => setFilterValue(e.target.value)}
                disabled={filterOp === 'is_set' || filterOp === 'is_not_set'}
              />
            </Field>

            <Field label="Período">
              <Select value={preset} onChange={(e) => setPreset(e.target.value as (typeof DATE_PRESETS)[number])}>
                {DATE_PRESETS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="mt-4">
            <div className="mb-1 text-xs uppercase tracking-wide text-slate-500">ExplorerQuerySpec</div>
            <pre className="max-h-56 overflow-auto rounded-lg border border-slate-800 bg-slate-900/60 p-3 text-xs text-teal-300">
              {JSON.stringify(spec, null, 2)}
            </pre>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <Button variant="primary" onClick={runQuery} disabled={exec.loading}>
              {exec.loading ? 'Executando…' : 'Executar'}
            </Button>
            <span className="text-xs text-slate-500">Liga em POST /v1/explorer/query quando a infra subir.</span>
          </div>

          {exec.error ? (
            <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs text-slate-500">
              API indisponível: <span className="font-mono">{exec.error}</span>
            </div>
          ) : null}
          {exec.data ? (
            <div className="mt-3 text-xs text-slate-400">
              Status: <span className="text-slate-200">{exec.data.status}</span>
              {exec.data.cost ? ` · ${exec.data.cost.result_rows} linhas · ${exec.data.cost.duration_ms} ms` : null}
              {exec.data.reason ? ` · ${exec.data.reason}` : null}
            </div>
          ) : null}
        </Card>
      </Section>

      <Section title="Insights salvos" description="Biblioteca self-serve do workspace (GET /v1/insights).">
        <AsyncBoundary
          state={insights}
          empty={(d) => d.length === 0}
          emptyHint="Salve uma consulta no construtor para começar a biblioteca."
        >
          {(d) => <DataTable columns={insightColumns} rows={d} empty="Nenhum insight salvo ainda." />}
        </AsyncBoundary>
      </Section>
    </Page>
  );
}
