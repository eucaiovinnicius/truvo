'use client';

import { useState } from 'react';
import {
  AsyncBoundary,
  Badge,
  Button,
  Card,
  DataTable,
  Field,
  Input,
  Section,
  Select,
  StatRow,
  StatTile,
  Page,
  type BadgeVariant,
  type Column,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useApi } from '@/lib/use-api';

// ─────────────────────────── tipos (best-effort do controller M13) ───────────────────────────
// GET /v1/reports → ReportView[]

type ReportFrequency = 'manual' | 'daily' | 'weekly' | 'monthly';
type ReportTemplate = 'client_report' | 'ads_performance' | 'monthly_funnel' | 'custom';
type ReportPeriod =
  | 'today'
  | 'last_7_days'
  | 'last_14_days'
  | 'last_30_days'
  | 'last_90_days'
  | 'last_180_days'
  | 'last_365_days';

type ReportView = {
  id: string;
  name: string;
  dashboard_id: string;
  template: ReportTemplate;
  period: string;
  frequency: ReportFrequency;
  recipients: string[];
  enabled: boolean;
  is_public: boolean;
  public_url: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
};

const FREQUENCIES: { value: ReportFrequency; label: string }[] = [
  { value: 'manual', label: 'Manual' },
  { value: 'daily', label: 'Diário' },
  { value: 'weekly', label: 'Semanal' },
  { value: 'monthly', label: 'Mensal' },
];

const TEMPLATES: { value: ReportTemplate; label: string }[] = [
  { value: 'client_report', label: 'Relatório de cliente' },
  { value: 'ads_performance', label: 'Performance de anúncios' },
  { value: 'monthly_funnel', label: 'Funil mensal' },
  { value: 'custom', label: 'Personalizado' },
];

const PERIODS: { value: ReportPeriod; label: string }[] = [
  { value: 'today', label: 'Hoje' },
  { value: 'last_7_days', label: 'Últimos 7 dias' },
  { value: 'last_14_days', label: 'Últimos 14 dias' },
  { value: 'last_30_days', label: 'Últimos 30 dias' },
  { value: 'last_90_days', label: 'Últimos 90 dias' },
  { value: 'last_180_days', label: 'Últimos 180 dias' },
  { value: 'last_365_days', label: 'Últimos 365 dias' },
];

export default function ReportsPage() {
  const [reloadKey, setReloadKey] = useState(0);
  const state = useApi<ReportView[]>('/v1/reports', [reloadKey]);

  const [showForm, setShowForm] = useState(false);

  const columns: Column<ReportView>[] = [
    {
      key: 'name',
      header: 'Nome',
      render: (r) => (
        <div>
          <div className="text-slate-100">{r.name}</div>
          <div className="text-xs text-slate-500">{templateLabel(r.template)}</div>
        </div>
      ),
    },
    { key: 'frequency', header: 'Frequência', render: (r) => frequencyLabel(r.frequency) },
    { key: 'format', header: 'Formato', render: (r) => reportFormat(r) },
    { key: 'last_run_at', header: 'Último envio', render: (r) => fmtDateTime(r.last_run_at) },
    { key: 'status', header: 'Status', render: (r) => statusBadge(r) },
  ];

  return (
    <Page
      title="Relatórios"
      actions={
        <Button variant="primary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Fechar' : 'Novo relatório'}
        </Button>
      }
    >
      {showForm ? (
        <div className="mb-6">
          <NewReportForm
            onCreated={() => {
              setShowForm(false);
              setReloadKey((k) => k + 1);
            }}
          />
        </div>
      ) : null}

      <Section title="Agendados">
        <AsyncBoundary
          state={state}
          empty={(d) => d.length === 0}
          emptyHint="Nenhum relatório configurado ainda. Crie um em “Novo relatório”."
        >
          {(reports) => {
            const total = reports.length;
            const ativos = reports.filter((r) => r.enabled && r.frequency !== 'manual').length;
            const publicos = reports.filter((r) => r.is_public).length;
            const manuais = reports.filter((r) => r.frequency === 'manual').length;
            return (
              <>
                <StatRow>
                  <StatTile label="Total" value={total} />
                  <StatTile label="Agendados ativos" value={ativos} />
                  <StatTile label="Públicos" value={publicos} />
                  <StatTile label="Manuais" value={manuais} />
                </StatRow>
                <div className="mt-4">
                  <DataTable columns={columns} rows={reports} empty="Nenhum relatório configurado." />
                </div>
              </>
            );
          }}
        </AsyncBoundary>
      </Section>
    </Page>
  );
}

// ─────────────────────────── formulário de criação ───────────────────────────

function NewReportForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [dashboardId, setDashboardId] = useState('');
  const [template, setTemplate] = useState<ReportTemplate>('custom');
  const [period, setPeriod] = useState<ReportPeriod>('last_30_days');
  const [frequency, setFrequency] = useState<ReportFrequency>('manual');
  const [recipients, setRecipients] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [isPublic, setIsPublic] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !dashboardId.trim()) {
      setError('Nome e dashboard de origem são obrigatórios.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api('/v1/reports', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          dashboard_id: dashboardId.trim(),
          template,
          period,
          frequency,
          recipients: recipients
            .split(',')
            .map((r) => r.trim())
            .filter(Boolean),
          enabled,
          is_public: isPublic,
        }),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao criar o relatório.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="p-5">
      <h3 className="mb-4 text-sm font-semibold text-slate-200">Novo relatório</h3>
      <form onSubmit={onSubmit} className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Nome">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Relatório mensal — Cliente X" />
        </Field>
        <Field label="Dashboard de origem (ID)">
          <Input value={dashboardId} onChange={(e) => setDashboardId(e.target.value)} placeholder="dsh_…" />
        </Field>
        <Field label="Modelo">
          <Select value={template} onChange={(e) => setTemplate(e.target.value as ReportTemplate)}>
            {TEMPLATES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Período">
          <Select value={period} onChange={(e) => setPeriod(e.target.value as ReportPeriod)}>
            {PERIODS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Frequência">
          <Select value={frequency} onChange={(e) => setFrequency(e.target.value as ReportFrequency)}>
            {FREQUENCIES.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Destinatários (e-mails, separados por vírgula)">
          <Input
            value={recipients}
            onChange={(e) => setRecipients(e.target.value)}
            placeholder="ana@cliente.com, bruno@cliente.com"
          />
        </Field>
        <label className="flex items-center gap-2 text-xs text-slate-400">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-slate-700 bg-slate-950 accent-teal-500"
          />
          Ativar agendamento (ignorado se frequência = manual)
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-400">
          <input
            type="checkbox"
            checked={isPublic}
            onChange={(e) => setIsPublic(e.target.checked)}
            className="h-4 w-4 rounded border-slate-700 bg-slate-950 accent-teal-500"
          />
          Gerar link público (read-only)
        </label>

        {error ? (
          <div className="md:col-span-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
            {error}
          </div>
        ) : null}

        <div className="md:col-span-2 flex items-center gap-2">
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? 'Criando…' : 'Criar relatório'}
          </Button>
          <span className="text-xs text-slate-600">
            A criação exige a API no ar; sem ela o envio falha graciosamente com um aviso.
          </span>
        </div>
      </form>
    </Card>
  );
}

// ─────────────────────────── labels & badges ───────────────────────────

function statusBadge(r: ReportView) {
  let variant: BadgeVariant = 'neutral';
  let label = 'Manual';
  if (r.frequency !== 'manual') {
    variant = r.enabled ? 'good' : 'warning';
    label = r.enabled ? 'Ativo' : 'Pausado';
  }
  return <Badge variant={variant}>{label}</Badge>;
}

function reportFormat(r: ReportView): string {
  const hasEmail = r.recipients.length > 0;
  if (r.is_public && hasEmail) return 'Web + E-mail';
  if (r.is_public) return 'Web';
  if (hasEmail) return 'E-mail';
  return '—';
}

function frequencyLabel(f: ReportFrequency): string {
  return FREQUENCIES.find((x) => x.value === f)?.label ?? f;
}

function templateLabel(t: ReportTemplate): string {
  return TEMPLATES.find((x) => x.value === t)?.label ?? t;
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}
