'use client';

import { useState } from 'react';
import {
  Page,
  Section,
  Card,
  StatRow,
  StatTile,
  Badge,
  Button,
  AsyncBoundary,
  type BadgeVariant,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useApi } from '@/lib/use-api';

/**
 * Billing (M11) — catálogo de planos + assinatura atual e consumo.
 *
 * Fontes:
 *  · GET  /v1/billing/plans        → catálogo (preço/eventos/features)
 *  · GET  /v1/billing/subscription → plano atual + status + uso do mês
 *  · POST /v1/billing/checkout     → inicia upgrade (redireciona ao Stripe)
 *  · GET  /v1/billing/portal       → abre o Customer Portal do Stripe
 */

interface PlanCatalogItem {
  id: string;
  name: string;
  price_brl_cents: number | null;
  events_included: number | null;
  workspaces_included: number | null;
  contact_sales: boolean;
  features: string[];
}

interface PlansResponse {
  currency: string;
  plans: PlanCatalogItem[];
}

interface UsageSummary {
  periodMonth: string;
  eventsUsed: number;
  eventsIncluded: number | null;
  overage: number;
  usagePct: number | null;
  approachingLimit: boolean;
}

interface SubscriptionResponse {
  plan: string;
  status: string;
  entitled: boolean;
  cancel_at_period_end: boolean;
  current_period_end: string | null;
  current_period_start: string | null;
  limits: { events_included: number | null; workspaces: number | null };
  usage: UsageSummary;
  features: string[];
  stripe: { has_customer: boolean; has_subscription: boolean };
}

const PLAN_NAMES: Record<string, string> = {
  starter: 'Starter',
  growth: 'Growth',
  agency: 'Agency',
  enterprise: 'Enterprise',
};

/** Rótulos amigáveis das capacidades gateadas por plano (feature-gates do M11). */
const FEATURE_LABELS: Record<string, string> = {
  pixel: 'Pixel de tracking',
  url_tracking: 'Rastreamento de URLs',
  funnels_3: 'Até 3 funis',
  funnels_unlimited: 'Funis ilimitados',
  dashboard_basic: 'Dashboards básicos',
  dashboard_full: 'Dashboards completos',
  server_side: 'Server-side tracking',
  attribution_basic: 'Atribuição básica',
  attribution_advanced: 'Atribuição avançada',
  integrations: 'Integrações',
  identity_resolution: 'Resolução de identidade',
  creative_analytics: 'Análise de criativos',
  white_label: 'White label',
  explorer_visual: 'Data Explorer visual',
  retention_path: 'Retenção e caminhos',
  user_360: 'Perfis User 360',
  explorer_sql: 'Data Explorer SQL',
  ai_journey: 'AI Journey',
  sla: 'SLA dedicado',
  dedicated_infra: 'Infra dedicada',
};

const brl0 = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  maximumFractionDigits: 0,
});
const int = new Intl.NumberFormat('pt-BR');

function statusBadge(status: string): { variant: BadgeVariant; label: string } {
  switch (status) {
    case 'active':
      return { variant: 'good', label: 'Ativo' };
    case 'trialing':
      return { variant: 'info', label: 'Em teste' };
    case 'past_due':
      return { variant: 'warning', label: 'Pagamento pendente' };
    case 'canceled':
      return { variant: 'critical', label: 'Cancelado' };
    case 'unpaid':
      return { variant: 'critical', label: 'Não pago' };
    case 'none':
      return { variant: 'neutral', label: 'Sem assinatura' };
    default:
      return { variant: 'neutral', label: status };
  }
}

function usageBadge(u: UsageSummary): { variant: BadgeVariant; label: string } {
  if (u.eventsIncluded == null) return { variant: 'info', label: 'Ilimitado' };
  if (u.overage > 0) return { variant: 'critical', label: 'Excedido' };
  if (u.approachingLimit) return { variant: 'warning', label: 'Próximo do limite' };
  return { variant: 'good', label: 'Dentro do limite' };
}

function usagePercent(u: UsageSummary): number | null {
  if (u.usagePct != null) return u.usagePct;
  if (u.eventsIncluded && u.eventsIncluded > 0) return u.eventsUsed / u.eventsIncluded;
  return null;
}

function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('pt-BR');
}

interface Notice {
  kind: 'error' | 'info';
  text: string;
}

export default function BillingPage() {
  const plans = useApi<PlansResponse>('/v1/billing/plans');
  const sub = useApi<SubscriptionResponse>('/v1/billing/subscription');

  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [portalBusy, setPortalBusy] = useState<boolean>(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const currentPlan = sub.data?.plan ?? null;

  async function handleSubscribe(planId: string): Promise<void> {
    setBusyPlan(planId);
    setNotice(null);
    try {
      const res = await api<{ url: string | null; session_id?: string }>('/v1/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ plan: planId }),
      });
      if (res.url) {
        window.location.href = res.url;
        return;
      }
      setNotice({ kind: 'error', text: 'Checkout indisponível no momento.' });
    } catch (e) {
      setNotice({ kind: 'error', text: e instanceof Error ? e.message : 'Falha ao iniciar o checkout.' });
    } finally {
      setBusyPlan(null);
    }
  }

  async function openPortal(): Promise<void> {
    setPortalBusy(true);
    setNotice(null);
    try {
      const res = await api<{ url: string }>('/v1/billing/portal');
      if (res.url) {
        window.location.href = res.url;
        return;
      }
      setNotice({ kind: 'error', text: 'Portal indisponível no momento.' });
    } catch (e) {
      setNotice({ kind: 'error', text: e instanceof Error ? e.message : 'Falha ao abrir o portal.' });
    } finally {
      setPortalBusy(false);
    }
  }

  return (
    <Page
      title="Billing"
      actions={
        <Button onClick={openPortal} disabled={portalBusy}>
          {portalBusy ? 'Abrindo…' : 'Portal de cobrança'}
        </Button>
      }
    >
      {notice ? (
        <div
          className={`mb-4 rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-xs ${
            notice.kind === 'error' ? 'text-rose-300' : 'text-sky-300'
          }`}
        >
          {notice.text}
        </div>
      ) : null}

      <Section
        title="Assinatura atual"
        description="Plano, status e consumo de eventos do mês vigente."
      >
        <AsyncBoundary state={sub} emptyHint="Nenhuma assinatura encontrada para este workspace.">
          {(s) => {
            const sb = statusBadge(s.status);
            const ub = usageBadge(s.usage);
            const pct = usagePercent(s.usage);
            const width = pct == null ? 0 : Math.min(100, Math.round(pct * 100));
            const barColor =
              s.usage.eventsIncluded == null
                ? 'bg-sky-400'
                : s.usage.overage > 0
                  ? 'bg-rose-400'
                  : s.usage.approachingLimit
                    ? 'bg-amber-400'
                    : 'bg-teal-400';
            const periodEnd = fmtDate(s.current_period_end);

            return (
              <>
                <StatRow>
                  <StatTile label="Eventos no mês" value={int.format(s.usage.eventsUsed)} />
                  <StatTile
                    label="Incluídos"
                    value={s.usage.eventsIncluded == null ? 'Ilimitado' : int.format(s.usage.eventsIncluded)}
                  />
                  <StatTile label="Uso" value={pct == null ? '—' : `${width}%`} />
                  <StatTile label="Excedente" value={int.format(s.usage.overage)} />
                </StatRow>

                <Card className="mt-4 p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-xs uppercase tracking-wide text-slate-500">Plano atual</div>
                      <div className="mt-0.5 text-lg font-semibold text-slate-100">
                        {PLAN_NAMES[s.plan] ?? s.plan}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={sb.variant}>{sb.label}</Badge>
                      <Badge variant={ub.variant}>{ub.label}</Badge>
                      {s.cancel_at_period_end ? (
                        <Badge variant="warning">Cancela no fim do período</Badge>
                      ) : null}
                    </div>
                  </div>

                  <div className="mt-4">
                    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
                      <div className={`h-full rounded-full ${barColor}`} style={{ width: `${width}%` }} />
                    </div>
                    <div className="mt-1.5 flex justify-between text-xs text-slate-500">
                      <span className="tabular-nums">{int.format(s.usage.eventsUsed)} eventos</span>
                      <span className="tabular-nums">
                        {s.usage.eventsIncluded == null
                          ? 'ilimitado'
                          : `${int.format(s.usage.eventsIncluded)} incluídos`}
                      </span>
                    </div>
                  </div>

                  {periodEnd ? (
                    <div className="mt-3 text-xs text-slate-500">
                      {s.cancel_at_period_end ? 'Encerra em ' : 'Renova em '}
                      <span className="text-slate-400">{periodEnd}</span>
                    </div>
                  ) : null}
                </Card>
              </>
            );
          }}
        </AsyncBoundary>
      </Section>

      <Section
        title="Planos"
        description="Escolha o plano ideal para o volume de eventos do workspace."
      >
        <AsyncBoundary
          state={plans}
          empty={(d) => d.plans.length === 0}
          emptyHint="Catálogo de planos indisponível."
        >
          {(d) => (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {d.plans.map((p) => {
                const isCurrent = currentPlan != null && currentPlan === p.id;
                const price = p.price_brl_cents == null ? 'Sob consulta' : brl0.format(p.price_brl_cents / 100);
                const eventsLabel =
                  p.events_included == null
                    ? 'Eventos ilimitados'
                    : `${int.format(p.events_included)} eventos/mês`;
                const workspacesLabel =
                  p.workspaces_included == null
                    ? 'Workspaces ilimitados'
                    : `${int.format(p.workspaces_included)} workspace${p.workspaces_included === 1 ? '' : 's'}`;

                return (
                  <Card
                    key={p.id}
                    className={`flex flex-col p-5 ${isCurrent ? 'border-teal-500/50' : ''}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-base font-semibold text-slate-100">{p.name}</h3>
                      {isCurrent ? <Badge variant="good">Plano atual</Badge> : null}
                    </div>

                    <div className="mt-2 flex items-baseline gap-1">
                      <span className="text-2xl font-semibold text-slate-100">{price}</span>
                      {p.price_brl_cents != null ? (
                        <span className="text-xs text-slate-500">/mês</span>
                      ) : null}
                    </div>

                    <div className="mt-1 text-xs text-slate-500">{eventsLabel}</div>
                    <div className="text-xs text-slate-500">{workspacesLabel}</div>

                    <ul className="mt-4 flex-1 space-y-1.5 text-xs text-slate-400">
                      {p.features.map((f) => (
                        <li key={f} className="flex gap-1.5">
                          <span aria-hidden className="text-teal-400">
                            ✓
                          </span>
                          <span>{FEATURE_LABELS[f] ?? f}</span>
                        </li>
                      ))}
                    </ul>

                    <div className="mt-5">
                      {isCurrent ? (
                        <Button disabled className="w-full justify-center">
                          Plano atual
                        </Button>
                      ) : p.contact_sales ? (
                        <Button
                          className="w-full justify-center"
                          onClick={() =>
                            setNotice({
                              kind: 'info',
                              text: 'Enterprise é sob consulta — fale com o time comercial para uma proposta.',
                            })
                          }
                        >
                          Falar com vendas
                        </Button>
                      ) : (
                        <Button
                          variant="primary"
                          className="w-full justify-center"
                          disabled={busyPlan === p.id}
                          onClick={() => handleSubscribe(p.id)}
                        >
                          {busyPlan === p.id ? 'Redirecionando…' : 'Assinar'}
                        </Button>
                      )}
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </AsyncBoundary>
      </Section>
    </Page>
  );
}
