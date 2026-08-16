'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  Plus,
  Send,
  Edit,
  Pause,
  Play,
  FileText,
  FileSpreadsheet,
  MessageSquare,
  BarChart3,
  Shuffle,
  Sparkles,
  Crown,
  Clock,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Mail,
  Users,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useLive } from '@/lib/live';
import { LiveDataBoundary } from '@/lib/live-ui';
import { useSession } from '@/lib/session';
import { api } from '@/lib/api';

/** Frequência (pt-BR) → enum da API (M13). */
function frequencyToApi(freq: Frequency): 'daily' | 'weekly' | 'monthly' {
  if (freq === 'Diário') return 'daily';
  if (freq === 'Mensal') return 'monthly';
  return 'weekly';
}

/** Tipo de relatório (badge) → template da API (M13). */
function typeToApiTemplate(
  type: ReportType,
): 'client_report' | 'ads_performance' | 'monthly_funnel' | 'custom' {
  if (type === 'Performance') return 'ads_performance';
  if (type === 'Executivo') return 'client_report';
  return 'custom';
}

/** Item de POST /v1/reports (resposta) — só o necessário p/ adaptar de volta. */
interface DashboardApiItem {
  id: string;
  name?: string;
}

// ---------------------------------------------------------------------------
// Tipos locais (self-contained — mock puro nesta fase)
// ---------------------------------------------------------------------------
type ReportType = 'Performance' | 'Attribution' | 'Criativos' | 'Executivo';
type Frequency = 'Diário' | 'Semanal' | 'Mensal';
type ReportFormat = 'PDF' | 'CSV' | 'Slack' | '—';
type ReportStatus = 'ativo' | 'pausado';
type StatusFilter = 'todos' | 'ativo' | 'pausado';

interface Recipient {
  name: string;
  email: string;
}

interface ScheduledReport {
  id: string;
  name: string;
  type: ReportType;
  frequency: Frequency;
  format: ReportFormat;
  recipients: Recipient[];
  lastSent: string;
  nextSend: string;
  status: ReportStatus;
}

interface ReportTemplate {
  id: string;
  name: string;
  description: string;
  type: ReportType;
  frequency: Frequency;
  format: ReportFormat;
  icon: LucideIcon;
  iconWrap: string;
}

// ---------------------------------------------------------------------------
// Mapeamentos de estilo (badges / ícones)
// ---------------------------------------------------------------------------
const TYPE_META: Record<ReportType, { icon: LucideIcon; wrap: string }> = {
  Performance: { icon: BarChart3, wrap: 'bg-teal-50 text-teal-600 border-teal-100' },
  Attribution: { icon: Shuffle, wrap: 'bg-indigo-50 text-indigo-600 border-indigo-100' },
  Criativos: { icon: Sparkles, wrap: 'bg-violet-50 text-violet-600 border-violet-100' },
  Executivo: { icon: Crown, wrap: 'bg-amber-50 text-amber-600 border-amber-100' },
};

const FREQUENCY_BADGE: Record<Frequency, string> = {
  Diário: 'bg-teal-100 text-teal-800',
  Semanal: 'bg-indigo-100 text-indigo-800',
  Mensal: 'bg-slate-100 text-slate-600',
};

const FORMAT_META: Record<ReportFormat, { icon: LucideIcon; badge: string }> = {
  PDF: { icon: FileText, badge: 'bg-rose-100 text-rose-700 border-rose-200' },
  CSV: { icon: FileSpreadsheet, badge: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  Slack: { icon: MessageSquare, badge: 'bg-violet-100 text-violet-700 border-violet-200' },
  '—': { icon: FileText, badge: 'bg-slate-100 text-slate-600 border-slate-200' },
};

const AVATAR_TINTS: string[] = [
  'bg-teal-100 text-teal-700',
  'bg-indigo-100 text-indigo-700',
  'bg-amber-100 text-amber-700',
  'bg-rose-100 text-rose-700',
  'bg-emerald-100 text-emerald-700',
];

// ---------------------------------------------------------------------------
// Dados MOCK (pt-BR) — referência: hoje = 19/07/2026
// ---------------------------------------------------------------------------
const INITIAL_REPORTS: ScheduledReport[] = [
  {
    id: 'rep-001',
    name: 'Performance Diária — Visão Geral',
    type: 'Performance',
    frequency: 'Diário',
    format: 'Slack',
    recipients: [
      { name: 'Alex Mercer', email: 'alex@truvo.ai' },
      { name: 'Samantha Cole', email: 'sam@truvo.ai' },
      { name: 'Growth Squad', email: 'growth@truvo.ai' },
    ],
    lastSent: 'Hoje, 08:00',
    nextSend: 'Amanhã, 08:00',
    status: 'ativo',
  },
  {
    id: 'rep-002',
    name: 'Atribuição Semanal por Canal',
    type: 'Attribution',
    frequency: 'Semanal',
    format: 'PDF',
    recipients: [
      { name: 'Alex Mercer', email: 'alex@truvo.ai' },
      { name: 'Diretoria', email: 'board@truvo.ai' },
    ],
    lastSent: '14 jul, 07:30',
    nextSend: '21 jul, 07:30',
    status: 'ativo',
  },
  {
    id: 'rep-003',
    name: 'Ranking de Criativos — Top 20',
    type: 'Criativos',
    frequency: 'Semanal',
    format: 'CSV',
    recipients: [
      { name: 'Samantha Cole', email: 'sam@truvo.ai' },
      { name: 'João Sterling', email: 'joao@truvo.ai' },
      { name: 'Mídia Paga', email: 'midia@truvo.ai' },
      { name: 'Estúdio Criativo', email: 'estudio@truvo.ai' },
    ],
    lastSent: '15 jul, 09:00',
    nextSend: '22 jul, 09:00',
    status: 'ativo',
  },
  {
    id: 'rep-004',
    name: 'Relatório Executivo Mensal (C-Level)',
    type: 'Executivo',
    frequency: 'Mensal',
    format: 'PDF',
    recipients: [
      { name: 'Alex Mercer', email: 'alex@truvo.ai' },
      { name: 'Conselho', email: 'conselho@truvo.ai' },
    ],
    lastSent: '01 jul, 06:00',
    nextSend: '01 ago, 06:00',
    status: 'ativo',
  },
  {
    id: 'rep-005',
    name: 'Performance Mensal — Fechamento',
    type: 'Performance',
    frequency: 'Mensal',
    format: 'CSV',
    recipients: [{ name: 'Financeiro', email: 'financeiro@truvo.ai' }],
    lastSent: '01 jul, 06:15',
    nextSend: '01 ago, 06:15',
    status: 'pausado',
  },
  {
    id: 'rep-006',
    name: 'Atribuição Diária — Mídia Paga',
    type: 'Attribution',
    frequency: 'Diário',
    format: 'Slack',
    recipients: [
      { name: 'Mídia Paga', email: 'midia@truvo.ai' },
      { name: 'Samantha Cole', email: 'sam@truvo.ai' },
    ],
    lastSent: '12 jul, 08:05',
    nextSend: 'Pausado',
    status: 'pausado',
  },
];

const TEMPLATES: ReportTemplate[] = [
  {
    id: 'tpl-perf',
    name: 'Performance Semanal',
    description: 'ROAS, CAC e receita atribuída consolidados dos últimos 7 dias.',
    type: 'Performance',
    frequency: 'Semanal',
    format: 'PDF',
    icon: BarChart3,
    iconWrap: 'bg-teal-50 text-teal-600 border-teal-100',
  },
  {
    id: 'tpl-attr',
    name: 'Atribuição Mensal',
    description: 'Contribuição real por canal via Truvo AI Graph, com comparativo.',
    type: 'Attribution',
    frequency: 'Mensal',
    format: 'PDF',
    icon: Shuffle,
    iconWrap: 'bg-indigo-50 text-indigo-600 border-indigo-100',
  },
  {
    id: 'tpl-creative',
    name: 'Top Criativos',
    description: 'Ranking de anúncios por conversão e retenção, ideal para o time.',
    type: 'Criativos',
    frequency: 'Semanal',
    format: 'CSV',
    icon: Sparkles,
    iconWrap: 'bg-violet-50 text-violet-600 border-violet-100',
  },
  {
    id: 'tpl-exec',
    name: 'Executivo (C-Level)',
    description: 'Visão enxuta e consolidada para diretoria e conselho.',
    type: 'Executivo',
    frequency: 'Mensal',
    format: 'PDF',
    icon: Crown,
    iconWrap: 'bg-amber-50 text-amber-600 border-amber-100',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

const nextSendFromFrequency: Record<Frequency, string> = {
  Diário: 'Amanhã, 08:00',
  Semanal: '26 jul, 08:00',
  Mensal: '01 ago, 08:00',
};

// ---------------------------------------------------------------------------
// Live wiring (GET /v1/reports) — fallback demo.
// INITIAL_REPORTS é selecionado apenas no estado demo; live mapeia o JSON real.
// Contrato (ARRAY BARE): o flag é "enabled" (booleano, NÃO "status"); datas são
// "next_run_at"/"last_run_at"; "format" NÃO vem no item da lista → default 'PDF'.
// ---------------------------------------------------------------------------
interface ReportApiItem {
  id: string;
  name: string;
  dashboard_id?: string | null;
  template?: string | null;
  period?: string | null;
  frequency?: string | null;
  schedule?: string | null;
  recipients?: string[] | null;
  branding?: unknown;
  enabled?: boolean;
  is_public?: boolean;
  public_url?: string | null;
  next_run_at?: string | null;
  last_run_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/** template (API) → ReportType (badge/ícone). Best-effort; default Performance. */
function mapReportType(template?: string | null): ReportType {
  const t = (template ?? '').toLowerCase();
  if (t.includes('attrib') || t.includes('atrib')) return 'Attribution';
  if (t.includes('creativ') || t.includes('criativ')) return 'Criativos';
  if (t.includes('exec')) return 'Executivo';
  return 'Performance';
}

/** frequency (API) → Frequency (pt-BR). Default Semanal. */
function mapFrequency(frequency?: string | null): Frequency {
  const f = (frequency ?? '').toLowerCase();
  if (f.includes('dia') || f.includes('dai')) return 'Diário';
  if (f.includes('mes') || f.includes('month')) return 'Mensal';
  return 'Semanal';
}

/** recipients:string[] (e-mails) → Recipient[] (nome derivado do local-part). */
function mapRecipients(emails?: string[] | null): Recipient[] {
  return (emails ?? []).map((email) => {
    const safe = email ?? '';
    const local = safe.split('@')[0] ?? '';
    return { name: local || safe, email: safe };
  });
}

/** ISO → data curta pt-BR ("14 de jul., 08:00"); vazio/ inválido → '—'. */
function fmtDateTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Mapeia o ARRAY BARE da API para a MESMA forma que o JSX já consome. */
function adaptReports(items: ReportApiItem[]): ScheduledReport[] {
  return (items ?? []).map((r) => {
    const enabled = r?.enabled === true;
    return {
      id: r?.id ?? '',
      name: r?.name ?? 'Relatório sem título',
      type: mapReportType(r?.template),
      frequency: mapFrequency(r?.frequency),
      format: '—',
      recipients: mapRecipients(r?.recipients),
      lastSent: fmtDateTime(r?.last_run_at),
      nextSend: enabled ? fmtDateTime(r?.next_run_at) : 'Pausado',
      status: enabled ? 'ativo' : 'pausado',
    };
  });
}

// ---------------------------------------------------------------------------
// Subcomponentes
// ---------------------------------------------------------------------------
function RecipientAvatars({ recipients }: { recipients: Recipient[] }) {
  const shown = recipients.slice(0, 3);
  const extra = recipients.length - shown.length;
  const title = recipients.map((r) => `${r.name} <${r.email}>`).join('\n');

  return (
    <div className="flex items-center gap-2" title={title}>
      <div className="flex -space-x-2">
        {shown.map((r, idx) => (
          <span
            key={r.email}
            className={`w-7 h-7 rounded-full border-2 border-white flex items-center justify-center text-[9px] font-mono font-bold ${
              AVATAR_TINTS[idx % AVATAR_TINTS.length]
            }`}
          >
            {initials(r.name)}
          </span>
        ))}
        {extra > 0 && (
          <span className="w-7 h-7 rounded-full border-2 border-white bg-slate-100 text-slate-500 flex items-center justify-center text-[9px] font-mono font-bold">
            +{extra}
          </span>
        )}
      </div>
      <span className="text-[10px] text-slate-400 font-mono hidden xl:inline">
        {recipients.length} {recipients.length === 1 ? 'destinatário' : 'destinatários'}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Componente principal
// ---------------------------------------------------------------------------
export default function ReportsView() {
  const { isLive } = useSession();
  const [reports, setReports] = useState<ScheduledReport[]>([]);
  const [filter, setFilter] = useState<StatusFilter>('todos');
  const [toast, setToast] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);

  // Live substitui o estado local mesmo quando a resposta é uma lista vazia.
  // Quando 'live', a resposta (array bare) substitui o mock via adapt(). As ações
  // locais (enviar/pausar/editar) continuam operando sobre esse estado.
  const reportsLive = useLive<ReportApiItem[]>('/v1/reports');
  useEffect(() => {
    if (reportsLive.status === 'demo') setReports(INITIAL_REPORTS);
    else if (reportsLive.status === 'success') setReports(adaptReports(reportsLive.data ?? []));
    else setReports([]);
  }, [reportsLive.status, reportsLive.data]);

  // Escrita: criar exige um dashboard_id (M13) → usamos o 1º dashboard do workspace.
  const dashboardsLive = useLive<DashboardApiItem[]>('/v1/dashboards');
  const defaultDashboardId = Array.isArray(dashboardsLive.data)
    ? dashboardsLive.data[0]?.id ?? null
    : null;

  const notify = (message: string, reportId?: string): void => {
    setToast(message);
    if (reportId) {
      setFlashId(reportId);
      window.setTimeout(() => setFlashId((cur) => (cur === reportId ? null : cur)), 1200);
    }
    window.setTimeout(() => setToast((cur) => (cur === message ? null : cur)), 2600);
  };

  // Enviar agora — demo: só local; live: POST /v1/reports/:id/send { format:'web' }.
  const handleSendNow = (report: ScheduledReport): void => {
    const markSent = () => {
      setReports((prev) =>
        prev.map((r) => (r.id === report.id ? { ...r, lastSent: 'Agora mesmo' } : r)),
      );
      notify(`Relatório "${report.name}" enviado agora.`, report.id);
    };
    if (!isLive) {
      markSent();
      return;
    }
    void api(`/v1/reports/${report.id}/send`, {
      method: 'POST',
      body: JSON.stringify({ format: 'web' }),
    })
      .then(markSent)
      .catch(() =>
        notify(`Falha ao enviar "${report.name}". Verifique a configuração de envio.`, report.id),
      );
  };

  const handleEdit = (report: ScheduledReport): void => {
    notify(
      isLive
        ? 'A edição ao vivo ainda não está disponível. Nenhuma alteração foi feita.'
        : `Editando "${report.name}"…`,
      report.id,
    );
  };

  // Pausar/ativar — demo: só local; live: PATCH /v1/reports/:id { enabled }.
  const handleToggle = (report: ScheduledReport): void => {
    const nextStatus: ReportStatus = report.status === 'ativo' ? 'pausado' : 'ativo';
    const applyToggle = () => {
      setReports((prev) =>
        prev.map((r) =>
          r.id !== report.id
            ? r
            : {
                ...r,
                status: nextStatus,
                nextSend: nextStatus === 'pausado' ? 'Pausado' : nextSendFromFrequency[r.frequency],
              },
        ),
      );
      notify(
        report.status === 'ativo'
          ? `Relatório "${report.name}" pausado.`
          : `Relatório "${report.name}" reativado.`,
        report.id,
      );
    };
    if (!isLive) {
      applyToggle();
      return;
    }
    void api(`/v1/reports/${report.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: nextStatus === 'ativo' }),
    })
      .then(applyToggle)
      .catch(() => notify('Não foi possível atualizar o relatório na API.', report.id));
  };

  // Criar a partir de um modelo — demo: local; live: POST /v1/reports.
  const handleUseTemplate = (tpl: ReportTemplate): void => {
    if (!isLive) {
      const newReport: ScheduledReport = {
        id: `rep-${Date.now()}`,
        name: `${tpl.name} — Novo`,
        type: tpl.type,
        frequency: tpl.frequency,
        format: tpl.format,
        recipients: [{ name: 'Alex Mercer', email: 'alex@truvo.ai' }],
        lastSent: '—',
        nextSend: nextSendFromFrequency[tpl.frequency],
        status: 'ativo',
      };
      setReports((prev) => [newReport, ...prev]);
      notify(`Relatório criado a partir do modelo "${tpl.name}".`, newReport.id);
      return;
    }
    if (!defaultDashboardId) {
      notify('Crie um dashboard antes de agendar um relatório.');
      return;
    }
    void api<ReportApiItem>('/v1/reports', {
      method: 'POST',
      body: JSON.stringify({
        name: `${tpl.name} — Novo`,
        dashboard_id: defaultDashboardId,
        template: typeToApiTemplate(tpl.type),
        frequency: frequencyToApi(tpl.frequency),
        enabled: true,
      }),
    })
      .then((res) => {
        const created = adaptReports([res])[0];
        if (created) setReports((prev) => [created, ...prev]);
        notify(`Relatório criado a partir do modelo "${tpl.name}".`, created?.id);
      })
      .catch(() => notify('Não foi possível criar o relatório na API.'));
  };

  // Novo relatório em branco — demo: local; live: POST /v1/reports (pausado).
  const handleNewReport = (): void => {
    if (!isLive) {
      const newReport: ScheduledReport = {
        id: `rep-${Date.now()}`,
        name: 'Novo relatório sem título',
        type: 'Performance',
        frequency: 'Semanal',
        format: 'PDF',
        recipients: [{ name: 'Alex Mercer', email: 'alex@truvo.ai' }],
        lastSent: '—',
        nextSend: nextSendFromFrequency['Semanal'],
        status: 'pausado',
      };
      setReports((prev) => [newReport, ...prev]);
      notify('Novo relatório criado. Configure e ative quando quiser.', newReport.id);
      return;
    }
    if (!defaultDashboardId) {
      notify('Crie um dashboard antes de agendar um relatório.');
      return;
    }
    void api<ReportApiItem>('/v1/reports', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Novo relatório sem título',
        dashboard_id: defaultDashboardId,
        template: 'custom',
        frequency: 'weekly',
        enabled: false,
      }),
    })
      .then((res) => {
        const created = adaptReports([res])[0];
        if (created) setReports((prev) => [created, ...prev]);
        notify('Novo relatório criado. Configure e ative quando quiser.', created?.id);
      })
      .catch(() => notify('Não foi possível criar o relatório na API.'));
  };

  const counts = useMemo(() => {
    const ativos = reports.filter((r) => r.status === 'ativo').length;
    return {
      total: reports.length,
      ativos,
      pausados: reports.length - ativos,
    };
  }, [reports]);

  const filtered = useMemo(
    () => (filter === 'todos' ? reports : reports.filter((r) => r.status === filter)),
    [reports, filter],
  );

  const filterTabs: { id: StatusFilter; label: string; count: number }[] = [
    { id: 'todos', label: 'Todos', count: counts.total },
    { id: 'ativo', label: 'Ativos', count: counts.ativos },
    { id: 'pausado', label: 'Pausados', count: counts.pausados },
  ];

  return (
    <LiveDataBoundary states={[reportsLive, dashboardsLive]} empty={reports.length === 0} label="Relatórios">
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold text-slate-900 tracking-tight">Relatórios agendados</h1>
          <p className="text-xs text-slate-500 mt-1">
            Entregas automáticas de performance, atribuição e criativos direto para a sua equipe.
          </p>
        </div>
        <button
          onClick={handleNewReport}
          className="px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer self-start md:self-auto shadow-xs"
        >
          <Plus className="w-4 h-4" />
          <span>Novo relatório</span>
        </button>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs">
          <div className="flex items-center gap-2 text-slate-500">
            <FileText className="w-4 h-4 text-slate-400" />
            <span className="text-xs font-semibold font-mono uppercase tracking-wider">
              Relatórios
            </span>
          </div>
          <h3 className="text-2xl font-bold text-slate-900 tracking-tight font-mono mt-2">
            {counts.total}
          </h3>
          <p className="text-[10px] text-slate-400 mt-1 font-mono">agendas configuradas</p>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs">
          <div className="flex items-center gap-2 text-slate-500">
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            <span className="text-xs font-semibold font-mono uppercase tracking-wider">Ativos</span>
          </div>
          <h3 className="text-2xl font-bold text-slate-900 tracking-tight font-mono mt-2">
            {counts.ativos}
          </h3>
          <p className="text-[10px] text-slate-400 mt-1 font-mono">enviando no cronograma</p>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-xs">
          <div className="flex items-center gap-2 text-slate-500">
            <CalendarClock className="w-4 h-4 text-teal-500" />
            <span className="text-xs font-semibold font-mono uppercase tracking-wider">
              Próximo envio
            </span>
          </div>
          <h3 className="text-2xl font-bold text-slate-900 tracking-tight font-mono mt-2">08:00</h3>
          <p className="text-[10px] text-slate-400 mt-1 font-mono">amanhã · performance diária</p>
        </div>
      </div>

      {/* Modelos de relatório */}
      <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">
              Modelos de relatório
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              Comece a partir de um modelo pronto — nós preenchemos métricas e formato.
            </p>
          </div>
          <span className="hidden sm:flex items-center gap-1.5 text-[10px] font-mono text-teal-600 bg-teal-50 border border-teal-100 px-2.5 py-1 rounded-full font-bold uppercase tracking-wider">
            <Sparkles className="w-3 h-3" />
            {TEMPLATES.length} modelos
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {TEMPLATES.map((tpl) => {
            const Icon = tpl.icon;
            return (
              <div
                key={tpl.id}
                className="group p-4 rounded-xl border border-slate-100 bg-slate-50/40 hover:bg-white hover:border-slate-200 hover:shadow-xs transition-all flex flex-col"
              >
                <div
                  className={`w-10 h-10 rounded-xl border flex items-center justify-center ${tpl.iconWrap}`}
                >
                  <Icon className="w-5 h-5" />
                </div>
                <h4 className="text-xs font-bold text-slate-800 mt-3">{tpl.name}</h4>
                <p className="text-[11px] text-slate-500 mt-1 leading-relaxed flex-1">
                  {tpl.description}
                </p>
                <div className="flex items-center gap-1.5 mt-3">
                  <span
                    className={`px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase ${FREQUENCY_BADGE[tpl.frequency]}`}
                  >
                    {tpl.frequency}
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase border ${FORMAT_META[tpl.format].badge}`}
                  >
                    {tpl.format}
                  </span>
                </div>
                <button
                  onClick={() => handleUseTemplate(tpl)}
                  className="mt-4 w-full py-2 border border-slate-200 group-hover:border-teal-200 group-hover:bg-teal-50 group-hover:text-teal-700 text-slate-700 rounded-xl text-[11px] font-bold flex items-center justify-center gap-1 transition-colors cursor-pointer"
                >
                  <span>Usar modelo</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Tabela de relatórios */}
      <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5">
          <div>
            <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">
              Agenda de relatórios
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              Envie na hora, edite a agenda ou pause quando precisar.
            </p>
          </div>

          {/* Filtro de status */}
          <div className="flex items-center gap-1 bg-slate-50 p-1 rounded-xl border border-slate-100 self-start">
            {filterTabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setFilter(tab.id)}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                  filter === tab.id
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                <span>{tab.label}</span>
                <span
                  className={`font-mono text-[9px] px-1.5 py-0.5 rounded-full ${
                    filter === tab.id ? 'bg-teal-100 text-teal-700' : 'bg-slate-200 text-slate-500'
                  }`}
                >
                  {tab.count}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[880px]">
            <thead>
              <tr className="border-b border-slate-100 text-[10px] font-mono text-slate-400 uppercase tracking-wider">
                <th className="py-3 font-semibold">Relatório</th>
                <th className="py-3 font-semibold">Frequência</th>
                <th className="py-3 font-semibold">Formato</th>
                <th className="py-3 font-semibold">Destinatários</th>
                <th className="py-3 font-semibold">Último envio</th>
                <th className="py-3 font-semibold">Próximo envio</th>
                <th className="py-3 font-semibold text-center">Status</th>
                <th className="py-3 font-semibold text-right">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {filtered.map((report) => {
                const typeMeta = TYPE_META[report.type];
                const TypeIcon = typeMeta.icon;
                const formatMeta = FORMAT_META[report.format];
                const FormatIcon = formatMeta.icon;
                const isActive = report.status === 'ativo';

                return (
                  <tr
                    key={report.id}
                    className={`transition-colors text-xs text-slate-700 ${
                      flashId === report.id ? 'bg-teal-50/60' : 'hover:bg-slate-50/50'
                    }`}
                  >
                    {/* Relatório (ícone + nome + tipo) */}
                    <td className="py-3.5 pr-4">
                      <div className="flex items-center gap-3">
                        <span
                          className={`w-9 h-9 rounded-xl border flex items-center justify-center shrink-0 ${typeMeta.wrap}`}
                        >
                          <TypeIcon className="w-4 h-4" />
                        </span>
                        <div className="min-w-0">
                          <span className="font-bold text-slate-900 block truncate">
                            {report.name}
                          </span>
                          <span className="text-[10px] text-slate-400 font-mono">
                            {report.type}
                          </span>
                        </div>
                      </div>
                    </td>

                    {/* Frequência */}
                    <td className="py-3.5 pr-4">
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase ${FREQUENCY_BADGE[report.frequency]}`}
                      >
                        {report.frequency}
                      </span>
                    </td>

                    {/* Formato */}
                    <td className="py-3.5 pr-4">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase border ${formatMeta.badge}`}
                      >
                        <FormatIcon className="w-3 h-3" />
                        {report.format}
                      </span>
                    </td>

                    {/* Destinatários */}
                    <td className="py-3.5 pr-4">
                      <RecipientAvatars recipients={report.recipients} />
                    </td>

                    {/* Último envio */}
                    <td className="py-3.5 pr-4 font-mono text-[11px] text-slate-600 whitespace-nowrap">
                      <span className="inline-flex items-center gap-1">
                        <Clock className="w-3 h-3 text-slate-300" />
                        {report.lastSent}
                      </span>
                    </td>

                    {/* Próximo envio */}
                    <td className="py-3.5 pr-4 font-mono text-[11px] whitespace-nowrap">
                      {isActive ? (
                        <span className="text-teal-700 font-semibold">{report.nextSend}</span>
                      ) : (
                        <span className="text-slate-400">{report.nextSend}</span>
                      )}
                    </td>

                    {/* Status */}
                    <td className="py-3.5 pr-4 text-center">
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase ${
                          isActive ? 'bg-teal-100 text-teal-800' : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {report.status}
                      </span>
                    </td>

                    {/* Ações */}
                    <td className="py-3.5">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => handleSendNow(report)}
                          title="Enviar agora"
                          className="p-1.5 rounded-lg text-slate-400 hover:text-teal-600 hover:bg-teal-50 transition-colors cursor-pointer"
                        >
                          <Send className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleEdit(report)}
                          title="Editar"
                          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-800 hover:bg-slate-100 transition-colors cursor-pointer"
                        >
                          <Edit className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleToggle(report)}
                          title={isActive ? 'Pausar' : 'Ativar'}
                          className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                            isActive
                              ? 'text-slate-400 hover:text-amber-600 hover:bg-amber-50'
                              : 'text-slate-400 hover:text-emerald-600 hover:bg-emerald-50'
                          }`}
                        >
                          {isActive ? (
                            <Pause className="w-3.5 h-3.5" />
                          ) : (
                            <Play className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {filtered.length === 0 && (
            <div className="text-center py-14">
              <div className="w-12 h-12 rounded-2xl bg-slate-50 border border-slate-100 flex items-center justify-center mx-auto">
                <Mail className="w-5 h-5 text-slate-300" />
              </div>
              <p className="text-xs text-slate-500 font-semibold mt-3">
                Nenhum relatório {filter === 'ativo' ? 'ativo' : 'pausado'} no momento.
              </p>
              <p className="text-[11px] text-slate-400 mt-1">
                Ajuste o filtro ou crie um novo relatório para começar.
              </p>
            </div>
          )}
        </div>

        {/* Rodapé informativo */}
        <div className="mt-5 pt-4 border-t border-slate-100 flex items-center gap-2 text-[10px] text-slate-400 font-mono">
          <Users className="w-3.5 h-3.5" />
          <span>
            Fuso horário de envio: America/Sao_Paulo (BRT). Horários exibidos no fuso do workspace.
          </span>
        </div>
      </div>

      {/* Toast flutuante */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2.5 bg-slate-900 text-white text-xs font-semibold px-4 py-3 rounded-xl shadow-lg border border-slate-800 animate-fadeIn">
          <CheckCircle2 className="w-4 h-4 text-teal-400 shrink-0" />
          <span>{toast}</span>
          <button
            onClick={() => setToast(null)}
            className="ml-1 text-slate-400 hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
    </LiveDataBoundary>
  );
}
