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
  Input,
  Field,
  AsyncBoundary,
  type Column,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useApi } from '@/lib/use-api';

/**
 * /dashboards — M6 Dashboard Builder. Lista de dashboards
 * (GET /v1/dashboards → DashboardView[]). "Share" reflete is_public.
 */

type DashboardWidget = { id: string; type: string; title?: string | null };

type DashboardRow = {
  id: string;
  name: string;
  description: string | null;
  layout: { widgets?: DashboardWidget[] } | null;
  is_public: boolean;
  public_token: string | null;
  created_at: string;
  updated_at: string;
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
}

function widgetCount(r: DashboardRow): number {
  return r.layout?.widgets?.length ?? 0;
}

const columns: Column<DashboardRow>[] = [
  {
    key: 'name',
    header: 'Dashboard',
    render: (r) => (
      <div>
        <div className="font-medium text-slate-100">{r.name}</div>
        {r.description ? (
          <div className="max-w-md truncate text-xs text-slate-500">{r.description}</div>
        ) : null}
      </div>
    ),
  },
  {
    key: 'widgets',
    header: 'Widgets',
    align: 'right',
    render: (r) => <span className="tabular-nums text-slate-200">{widgetCount(r)}</span>,
  },
  {
    key: 'share',
    header: 'Compartilhamento',
    render: (r) =>
      r.is_public ? (
        <Badge variant="info">Público</Badge>
      ) : (
        <Badge variant="neutral">Privado</Badge>
      ),
  },
  {
    key: 'updated_at',
    header: 'Atualizado',
    align: 'right',
    render: (r) => <span className="text-slate-400">{fmtDate(r.updated_at)}</span>,
  },
];

function NewDashboardPanel({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit() {
    if (!name.trim()) {
      setMsg({ ok: false, text: 'Informe um nome para o dashboard.' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await api('/v1/dashboards', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          layout: { widgets: [] },
        }),
      });
      setMsg({ ok: true, text: 'Dashboard criado.' });
      setName('');
      setDescription('');
      onCreated();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Falha ao criar o dashboard.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-6 rounded-xl border border-slate-800 bg-slate-950 p-4">
      <div className="mb-3 text-sm font-semibold text-slate-200">Novo dashboard</div>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Nome">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex.: Aquisição"
            className="w-64"
          />
        </Field>
        <Field label="Descrição (opcional)">
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Para que serve este dashboard"
            className="w-80"
          />
        </Field>
        <Button variant="primary" onClick={submit} disabled={busy}>
          {busy ? 'Criando…' : 'Criar dashboard'}
        </Button>
      </div>
      {msg ? (
        <div className={`mt-3 text-xs ${msg.ok ? 'text-emerald-400' : 'text-rose-400'}`}>{msg.text}</div>
      ) : (
        <div className="mt-3 text-xs text-slate-600">
          Cria um dashboard vazio; adicione widgets no builder depois.
        </div>
      )}
    </div>
  );
}

export default function DashboardsPage() {
  const [showForm, setShowForm] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const state = useApi<DashboardRow[]>('/v1/dashboards', [refreshKey]);
  const dashboards = state.data ?? [];

  const total = dashboards.length;
  const publicCount = dashboards.filter((d) => d.is_public).length;
  const privateCount = total - publicCount;
  const totalWidgets = dashboards.reduce((acc, d) => acc + widgetCount(d), 0);
  const has = state.data != null;

  return (
    <Page title="Dashboards">
      <Toolbar>
        <Button
          variant="primary"
          className="ml-auto"
          onClick={() => setShowForm((v) => !v)}
        >
          {showForm ? 'Fechar' : '+ Novo dashboard'}
        </Button>
      </Toolbar>

      {showForm ? (
        <NewDashboardPanel
          onCreated={() => {
            setRefreshKey((k) => k + 1);
          }}
        />
      ) : null}

      <Section>
        <StatRow>
          <StatTile label="Total de dashboards" value={has ? total : '—'} />
          <StatTile label="Públicos" value={has ? publicCount : '—'} hint="com link de share" />
          <StatTile label="Privados" value={has ? privateCount : '—'} />
          <StatTile label="Widgets no total" value={has ? totalWidgets : '—'} />
        </StatRow>
      </Section>

      <Section
        title="Dashboards"
        description="Dashboards montados no builder. O link público (share) só existe quando ligado."
      >
        <AsyncBoundary
          state={state}
          empty={(d) => d.length === 0}
          emptyHint="Crie um dashboard e monte widgets de KPIs, séries e breakdowns."
        >
          {(rows) => <DataTable columns={columns} rows={rows} empty="Nenhum dashboard ainda." />}
        </AsyncBoundary>
      </Section>
    </Page>
  );
}
