'use client';

import { type FormEvent } from 'react';
import {
  Page,
  Section,
  Card,
  StatRow,
  StatTile,
  DataTable,
  Badge,
  Button,
  Input,
  Select,
  Field,
  AsyncBoundary,
  type Column,
  type BadgeVariant,
} from '@/components/ui';
import { useApi } from '@/lib/use-api';

/**
 * /settings — modules/auth + modules/events.
 * Workspace (GET /v1/workspaces), Membros (GET /v1/workspaces/:id/members),
 * API Keys (GET /v1/api-keys). Forms estáticos (não submetem).
 */

// ─────────────────────────── tipos (best-effort do DTO/service) ───────────────────────────

/** GET /v1/workspaces → Workspace[] (com o papel do usuário) */
type Workspace = {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  timezone: string;
  currency: string;
  dataRetentionDays: number;
  role: string;
  status: string;
  createdAt: string;
};

/** GET /v1/workspaces/:id/members → Member[] */
type Member = {
  userId: string;
  role: string;
  status: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  createdAt: string;
};

/** GET /v1/api-keys → { apiKeys: ApiKey[] } */
type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  status: string; // active | revoked
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
};

// ─────────────────────────── helpers ───────────────────────────

const BASE_TIMEZONES = ['America/Sao_Paulo', 'America/New_York', 'Europe/London', 'UTC'];
const BASE_CURRENCIES = ['BRL', 'USD', 'EUR', 'GBP'];

function withCurrent(list: string[], current: string | undefined): string[] {
  if (current && !list.includes(current)) return [current, ...list];
  return list;
}

function roleVariant(role: string): BadgeVariant {
  switch (role) {
    case 'owner':
      return 'good';
    case 'admin':
      return 'info';
    default:
      return 'neutral';
  }
}

function memberStatusVariant(status: string): BadgeVariant {
  switch (status) {
    case 'active':
      return 'good';
    case 'invited':
      return 'warning';
    default:
      return 'neutral';
  }
}

function fmtDateTime(v: string | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

// ─────────────────────────── página ───────────────────────────

export default function SettingsPage() {
  const wsState = useApi<Workspace[]>('/v1/workspaces');
  const currentWs = wsState.data?.[0] ?? null;

  // Membros dependem do workspace atual; enquanto não houver id, o path é null
  // (useApi degrada para estado vazio, sem quebrar).
  const membersState = useApi<Member[]>(
    currentWs ? `/v1/workspaces/${currentWs.id}/members` : null,
    [currentWs?.id],
  );

  const keysState = useApi<{ apiKeys: ApiKey[] }>('/v1/api-keys');

  const members = membersState.data ?? [];
  const keys = keysState.data?.apiKeys ?? [];

  const owners = members.filter((m) => m.role === 'owner').length;
  const activeKeys = keys.filter((k) => k.status === 'active').length;

  const tzOptions = withCurrent(BASE_TIMEZONES, currentWs?.timezone);
  const currencyOptions = withCurrent(BASE_CURRENCIES, currentWs?.currency);

  const noSubmit = (e: FormEvent) => e.preventDefault();

  const memberColumns: Column<Member>[] = [
    {
      key: 'name',
      header: 'Membro',
      render: (r) => (
        <div>
          <div className="text-slate-200">{r.name ?? r.email}</div>
          <div className="text-xs text-slate-600">{r.email}</div>
        </div>
      ),
    },
    { key: 'role', header: 'Papel', render: (r) => <Badge variant={roleVariant(r.role)}>{r.role}</Badge> },
    {
      key: 'status',
      header: 'Status',
      render: (r) => <Badge variant={memberStatusVariant(r.status)}>{r.status}</Badge>,
    },
    {
      key: 'createdAt',
      header: 'Desde',
      align: 'right',
      render: (r) => <span className="whitespace-nowrap text-slate-400">{fmtDateTime(r.createdAt)}</span>,
    },
  ];

  const keyColumns: Column<ApiKey>[] = [
    { key: 'name', header: 'Nome', render: (r) => <span className="text-slate-200">{r.name}</span> },
    {
      key: 'prefix',
      header: 'Prefixo',
      render: (r) => <span className="font-mono text-xs text-slate-400">{r.prefix}…</span>,
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) =>
        r.status === 'active' ? (
          <Badge variant="good">Ativa</Badge>
        ) : (
          <Badge variant="neutral">Revogada</Badge>
        ),
    },
    {
      key: 'lastUsedAt',
      header: 'Último uso',
      render: (r) => <span className="text-slate-400">{fmtDateTime(r.lastUsedAt)}</span>,
    },
    {
      key: 'createdAt',
      header: 'Criada',
      align: 'right',
      render: (r) => <span className="whitespace-nowrap text-slate-400">{fmtDateTime(r.createdAt)}</span>,
    },
  ];

  return (
    <Page title="Configurações">
      <StatRow>
        <StatTile label="Membros" value={membersState.data ? members.length : '—'} />
        <StatTile label="Owners" value={membersState.data ? owners : '—'} />
        <StatTile label="API keys ativas" value={keysState.data ? activeKeys : '—'} />
        <StatTile
          label="Retenção de dados"
          value={currentWs ? `${currentWs.dataRetentionDays}` : '—'}
          hint="dias"
        />
      </StatRow>

      <div className="mt-8">
        {/* Workspace */}
        <Section title="Workspace" description="Identidade e localização do tenant.">
          {wsState.error ? (
            <p className="mb-3 text-xs text-slate-600">
              Não foi possível carregar o workspace — exibindo campos vazios.
            </p>
          ) : null}
          <Card className="p-5">
            <form key={currentWs?.id ?? 'empty'} onSubmit={noSubmit} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Nome">
                  <Input name="name" defaultValue={currentWs?.name ?? ''} placeholder="Minha empresa" />
                </Field>
                <Field label="Slug">
                  <Input name="slug" defaultValue={currentWs?.slug ?? ''} placeholder="minha-empresa" />
                </Field>
                <Field label="Timezone">
                  <Select name="timezone" defaultValue={currentWs?.timezone ?? 'America/Sao_Paulo'}>
                    {tzOptions.map((tz) => (
                      <option key={tz} value={tz}>
                        {tz}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Moeda">
                  <Select name="currency" defaultValue={currentWs?.currency ?? 'BRL'}>
                    {currencyOptions.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div className="flex items-center justify-between border-t border-slate-800 pt-4">
                <span className="text-xs text-slate-600">
                  {currentWs ? (
                    <>
                      Seu papel: <span className="text-slate-400">{currentWs.role}</span>
                    </>
                  ) : (
                    'Conecte a API para editar.'
                  )}
                </span>
                <Button type="submit" variant="primary">
                  Salvar alterações
                </Button>
              </div>
            </form>
          </Card>
        </Section>

        {/* Membros */}
        <Section title="Membros" description="Pessoas com acesso a este workspace e seus papéis.">
          <div className="mb-3 flex items-center justify-end">
            <Button variant="default">+ Convidar membro</Button>
          </div>
          <AsyncBoundary
            state={membersState}
            emptyHint="Os membros aparecem após carregar o workspace atual."
          >
            {(rows) => (
              <DataTable columns={memberColumns} rows={rows} empty="Nenhum membro neste workspace." />
            )}
          </AsyncBoundary>
        </Section>

        {/* API Keys */}
        <Section
          title="API Keys"
          description="Chaves de ingestão (SDK/servidor). O segredo aparece só uma vez, na geração."
        >
          <div className="mb-3 flex items-center justify-end">
            <Button variant="primary">Gerar chave</Button>
          </div>
          <AsyncBoundary state={keysState} emptyHint="Gere uma chave para começar a enviar eventos.">
            {(data) => (
              <DataTable columns={keyColumns} rows={data.apiKeys} empty="Nenhuma API key criada." />
            )}
          </AsyncBoundary>
        </Section>
      </div>
    </Page>
  );
}
