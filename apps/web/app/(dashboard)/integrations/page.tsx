'use client';

import {
  Page,
  Section,
  Card,
  StatRow,
  StatTile,
  DataTable,
  Badge,
  Button,
  AsyncBoundary,
  type Column,
  type BadgeVariant,
} from '@/components/ui';
import { useApi } from '@/lib/use-api';

/**
 * /integrations — modules/webhooks (entrada) + modules/integrations-out (saída).
 * Entrada: GET /v1/integrations (shopify/stripe/hotmart/kiwify).
 * Saída:   GET /v1/integrations-out/status (meta_capi/google_enhanced/tiktok_events + EMQ).
 */

// ─────────────────────────── tipos (best-effort do DTO/service) ───────────────────────────

/** GET /v1/integrations → IntegrationPublic[] */
type Integration = {
  id: string;
  workspaceId: string;
  type: string; // shopify | stripe | hotmart | kiwify
  name: string;
  externalId: string | null;
  status: string; // pending | active | inactive | error
  config: Record<string, unknown>;
  lastError: string | null;
  lastEventAt: string | null;
  hasCredentials: boolean;
  createdAt: string;
  updatedAt: string;
};

type OutStats = {
  sent: number;
  failed: number;
  skipped: number;
  avgMatchQuality: number | null;
  byStatus: Record<string, number>;
};

/** GET /v1/integrations-out/status → { platforms: OutPlatform[] } */
type OutPlatform = {
  platform: string; // meta_capi | google_enhanced | tiktok_events
  configured: boolean;
  enabled: boolean;
  has_credentials: boolean;
  status: string; // not_configured | pending | active | inactive | error
  consent_required: boolean;
  last_error: string | null;
  last_forward_at: string | null;
  stats: OutStats;
};

// ─────────────────────────── helpers ───────────────────────────

const PROVIDER_LABELS: Record<string, string> = {
  shopify: 'Shopify',
  stripe: 'Stripe',
  hotmart: 'Hotmart',
  kiwify: 'Kiwify',
};

const PLATFORM_LABELS: Record<string, string> = {
  meta_capi: 'Meta CAPI',
  google_enhanced: 'Google Enhanced',
  tiktok_events: 'TikTok Events',
};

function statusVariant(status: string): BadgeVariant {
  switch (status) {
    case 'active':
      return 'good';
    case 'pending':
      return 'warning';
    case 'error':
      return 'critical';
    case 'inactive':
    case 'not_configured':
    default:
      return 'neutral';
  }
}

const STATUS_LABELS: Record<string, string> = {
  active: 'Ativa',
  pending: 'Pendente',
  error: 'Erro',
  inactive: 'Inativa',
  not_configured: 'Não configurada',
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

function fmtDateTime(v: string | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

// ─────────────────────────── página ───────────────────────────

export default function IntegrationsPage() {
  const inState = useApi<Integration[]>('/v1/integrations');
  const outState = useApi<{ platforms: OutPlatform[] }>('/v1/integrations-out/status');

  const inbound = inState.data ?? [];
  const outbound = outState.data?.platforms ?? [];

  const activeInbound = inbound.filter((i) => i.status === 'active').length;
  const erroredInbound = inbound.filter((i) => i.status === 'error').length;
  const enabledOutbound = outbound.filter((p) => p.enabled).length;
  const totalSent = outbound.reduce((sum, p) => sum + (p.stats?.sent ?? 0), 0);

  const inboundColumns: Column<Integration>[] = [
    {
      key: 'name',
      header: 'Integração',
      render: (r) => (
        <div>
          <div className="text-slate-200">{r.name}</div>
          <div className="text-xs text-slate-600">{PROVIDER_LABELS[r.type] ?? r.type}</div>
        </div>
      ),
    },
    {
      key: 'externalId',
      header: 'ID externo',
      render: (r) => <span className="font-mono text-xs text-slate-400">{r.externalId ?? '—'}</span>,
    },
    {
      key: 'hasCredentials',
      header: 'Credenciais',
      render: (r) =>
        r.hasCredentials ? (
          <Badge variant="good">Configuradas</Badge>
        ) : (
          <Badge variant="warning">Pendentes</Badge>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => <Badge variant={statusVariant(r.status)}>{statusLabel(r.status)}</Badge>,
    },
    {
      key: 'lastEventAt',
      header: 'Último evento',
      align: 'right',
      render: (r) => (
        <span className="whitespace-nowrap text-slate-400">{fmtDateTime(r.lastEventAt)}</span>
      ),
    },
  ];

  const outboundColumns: Column<OutPlatform>[] = [
    {
      key: 'platform',
      header: 'Plataforma',
      render: (r) => <span className="text-slate-200">{PLATFORM_LABELS[r.platform] ?? r.platform}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => <Badge variant={statusVariant(r.status)}>{statusLabel(r.status)}</Badge>,
    },
    {
      key: 'enabled',
      header: 'Envio',
      render: (r) =>
        r.enabled ? (
          <Badge variant="good">Habilitado</Badge>
        ) : (
          <Badge variant="neutral">Desabilitado</Badge>
        ),
    },
    {
      key: 'emq',
      header: 'EMQ',
      align: 'right',
      render: (r) =>
        r.stats?.avgMatchQuality != null ? (
          <span className="tabular-nums text-slate-200">{r.stats.avgMatchQuality.toFixed(2)}</span>
        ) : (
          '—'
        ),
    },
    {
      key: 'sent',
      header: 'Enviadas',
      align: 'right',
      render: (r) => <span className="tabular-nums text-slate-300">{r.stats?.sent ?? 0}</span>,
    },
    {
      key: 'failed',
      header: 'Falhas',
      align: 'right',
      render: (r) => (
        <span className={`tabular-nums ${(r.stats?.failed ?? 0) > 0 ? 'text-rose-400' : 'text-slate-500'}`}>
          {r.stats?.failed ?? 0}
        </span>
      ),
    },
  ];

  return (
    <Page title="Integrações">
      <StatRow>
        <StatTile
          label="Entradas ativas"
          value={inState.data ? activeInbound : '—'}
          hint="webhooks recebendo"
        />
        <StatTile label="Entradas com erro" value={inState.data ? erroredInbound : '—'} />
        <StatTile
          label="Saídas habilitadas"
          value={outState.data ? enabledOutbound : '—'}
          hint="de 3 plataformas"
        />
        <StatTile
          label="Conversões enviadas"
          value={outState.data ? totalSent.toLocaleString('pt-BR') : '—'}
          hint="soma das plataformas"
        />
      </StatRow>

      <div className="mt-8">
        {/* Entrada — webhooks de e-commerce/checkout */}
        <Section
          title="Entrada"
          description="Webhooks de plataformas de venda. Credenciais cifradas em repouso (AES-256-GCM)."
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1.5">
              {Object.values(PROVIDER_LABELS).map((label) => (
                <span
                  key={label}
                  className="rounded-md border border-slate-800 px-2 py-0.5 text-xs text-slate-500"
                >
                  {label}
                </span>
              ))}
            </div>
            <Button variant="primary">+ Conectar</Button>
          </div>
          <AsyncBoundary
            state={inState}
            emptyHint="Conecte Shopify, Stripe, Hotmart ou Kiwify para receber pedidos."
          >
            {(rows) => (
              <DataTable
                columns={inboundColumns}
                rows={rows}
                empty="Nenhuma integração de entrada conectada."
              />
            )}
          </AsyncBoundary>
        </Section>

        {/* Saída — conversões para plataformas de anúncio */}
        <Section
          title="Saída"
          description="Envio de conversões (server-side) com Event Match Quality por plataforma."
        >
          <div className="mb-3 flex items-center justify-end">
            <Button variant="primary">+ Conectar</Button>
          </div>
          <AsyncBoundary state={outState} emptyHint="Configure Meta CAPI, Google Enhanced ou TikTok Events.">
            {(data) => (
              <DataTable
                columns={outboundColumns}
                rows={data.platforms}
                empty="Nenhuma plataforma de saída disponível."
              />
            )}
          </AsyncBoundary>
          <Card className="mt-3 p-3">
            <p className="text-xs text-slate-600">
              EMQ (Event Match Quality) mede a qualidade dos identificadores enviados. PII só é
              encaminhada com consentimento e sempre como hash (regra 13).
            </p>
          </Card>
        </Section>
      </div>
    </Page>
  );
}
