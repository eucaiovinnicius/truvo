'use client';

import React, { useState } from 'react';
import {
  CreditCard,
  Check,
  Zap,
  TrendingUp,
  Building2,
  Rocket,
  Download,
  Info,
  AlertTriangle,
  Sparkles,
  Lock,
  ShieldCheck,
  Receipt,
  Calendar,
  ArrowRight,
  Gauge,
} from 'lucide-react';
import { useLive } from '@/lib/live';
import { LiveDataBoundary } from '@/lib/live-ui';
import { selectLiveData } from '@/lib/live-state';
import { useSession } from '@/lib/session';
import { api } from '@/lib/api';

// ---- Tipos ----
type PlanId = 'starter' | 'growth' | 'agency' | 'enterprise';
type BillingCycle = 'mensal' | 'anual';
type InvoiceStatus = 'pago' | 'pendente';

interface Plan {
  id: PlanId;
  name: string;
  tagline: string;
  monthly: number | null; // null = sob consulta
  eventsLabel: string;
  icon: React.ComponentType<{ className?: string }>;
  features: string[];
  badge?: string;
}

interface Invoice {
  id: string;
  date: string;
  desc: string;
  amount: number;
  status: InvoiceStatus;
}

// ---- Formas da API real (billing) ----
interface PlanApi {
  id: PlanId;
  name: string;
  price_brl_cents: number | null; // em CENTAVOS; null = sob consulta
  events_included: number | null;
  workspaces_included: number | null;
  contact_sales: boolean;
  features: string[];
}
interface PlansResponse {
  currency: string;
  plans: PlanApi[];
}
interface SubscriptionResponse {
  plan: string;
  status: string;
  entitled: boolean;
  cancel_at_period_end: boolean;
  current_period_end: string | null;
  limits: { events_included: number | null; workspaces: number | null };
  usage: {
    periodMonth: string;
    eventsUsed: number;
    eventsIncluded: number;
    overage: number;
    usagePct: number; // camelCase — percentual 0..100
    approachingLimit: boolean;
  };
  features: string[];
}

function isPlanId(v: string): v is PlanId {
  return v === 'starter' || v === 'growth' || v === 'agency' || v === 'enterprise';
}

// ---- Formatação pt-BR ----
const brl = (n: number): string =>
  n.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const brl0 = (n: number): string =>
  n.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });

const int = (n: number): string => n.toLocaleString('pt-BR');

const pct1 = (n: number): string =>
  n.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

// ---- Dados MOCK (pt-BR) ----
const CURRENT_PLAN: PlanId = 'growth';
const PLAN_ORDER: PlanId[] = ['starter', 'growth', 'agency', 'enterprise'];

const PLANS: Plan[] = [
  {
    id: 'starter',
    name: 'Starter',
    tagline: 'Para lojas começando a medir atribuição de verdade.',
    monthly: 297,
    eventsLabel: '100 mil eventos / mês',
    icon: Rocket,
    features: [
      'Até 100 mil eventos rastreados por mês',
      '3 funis de conversão',
      '1 workspace',
      'Atribuição last-click',
      'Integração Meta Ads e Google Ads',
      'Suporte por e-mail',
    ],
  },
  {
    id: 'growth',
    name: 'Growth',
    tagline: 'Para operações em escala que já investem forte em mídia paga.',
    monthly: 697,
    eventsLabel: '500 mil eventos / mês',
    icon: TrendingUp,
    features: [
      'Até 500 mil eventos rastreados por mês',
      'Funis de conversão ilimitados',
      'Até 5 membros de equipe',
      'Truvo AI Graph (atribuição multi-touch)',
      'Todas as integrações de anúncios',
      'Suporte prioritário em até 4h',
    ],
  },
  {
    id: 'agency',
    name: 'Agency',
    tagline: 'Para agências gerenciando múltiplos clientes e verbas.',
    monthly: 1997,
    eventsLabel: '2 milhões de eventos / mês',
    icon: Building2,
    badge: 'Mais popular',
    features: [
      'Até 2 milhões de eventos por mês',
      'Multi-workspace (clientes ilimitados)',
      'Membros de equipe ilimitados',
      'Relatórios white-label',
      'API de dados e webhooks',
      'Gerente de conta dedicado',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    tagline: 'Para grandes operações com necessidades sob medida.',
    monthly: null,
    eventsLabel: 'Volume sob demanda',
    icon: ShieldCheck,
    features: [
      'Volume de eventos sob demanda',
      'SSO / SAML e permissões avançadas',
      'Sincronização com data warehouse',
      'SLA de uptime de 99,9%',
      'Onboarding e treinamento dedicados',
      'Suporte 24/7 e canal no Slack',
    ],
  },
];

const INVOICES: Invoice[] = [
  { id: 'TRV-2026-0008', date: '10/07/2026', desc: 'Membro adicional de equipe', amount: 49, status: 'pendente' },
  { id: 'TRV-2026-0007', date: '01/07/2026', desc: 'Plano Growth — Jul/2026', amount: 697, status: 'pago' },
  { id: 'TRV-2026-0006', date: '01/06/2026', desc: 'Plano Growth — Jun/2026', amount: 697, status: 'pago' },
  { id: 'TRV-2026-0005', date: '01/05/2026', desc: 'Plano Growth — Mai/2026', amount: 697, status: 'pago' },
  { id: 'TRV-2026-0004', date: '01/04/2026', desc: 'Plano Starter — Abr/2026', amount: 297, status: 'pago' },
  { id: 'TRV-2026-0003', date: '01/03/2026', desc: 'Plano Starter — Mar/2026', amount: 297, status: 'pago' },
];

// Uso de eventos no ciclo atual
const USAGE_USED = 428500;
const USAGE_LIMIT = 500000;
const RENEWAL_DATE = '01/08/2026';
const RENEWAL_DAYS = 13;

// ---- Helpers de UI ----
function priceForCycle(base: number, cycle: BillingCycle): number {
  // Anual: ~20% de desconto no valor mensal equivalente.
  return cycle === 'anual' ? Math.round(base * 0.8) : base;
}

// adapt(): mapeia o JSON de /v1/billing/plans para a MESMA forma (Plan) que o JSX
// já consome. price_brl_cents está em CENTAVOS (÷100). tagline/icon/badge não vêm
// da API → reaproveitamos o mock existente por id. Nunca quebra em null/undefined.
function adaptPlans(res: PlansResponse): Plan[] {
  return (res?.plans ?? []).map((p) => {
    const base = PLANS.find((m) => m.id === p?.id);
    const events = p?.events_included;
    return {
      id: p?.id ?? base?.id ?? 'starter',
      name: p?.name ?? base?.name ?? '',
      tagline: base?.tagline ?? '',
      monthly: p?.price_brl_cents != null ? p.price_brl_cents / 100 : null,
      eventsLabel:
        events != null ? `${int(events)} eventos / mês` : base?.eventsLabel ?? 'Volume sob demanda',
      icon: base?.icon ?? Rocket,
      features: p?.features ?? base?.features ?? [],
      badge: base?.badge,
    };
  });
}

// current_period_end → data pt-BR + dias restantes; null/inválido → fallback ao mock.
function fmtRenewal(iso: string | null | undefined): { date: string; days: number } | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const days = Math.max(0, Math.ceil((d.getTime() - Date.now()) / 86_400_000));
  return { date: d.toLocaleDateString('pt-BR'), days };
}

interface CtaSpec {
  label: string;
  className: string;
  disabled: boolean;
}

function ctaFor(planId: PlanId, currentPlan: PlanId, order: PlanId[]): CtaSpec {
  const currentIdx = order.indexOf(currentPlan);
  const idx = order.indexOf(planId);

  if (planId === currentPlan) {
    return {
      label: 'Plano atual',
      disabled: true,
      className:
        'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed',
    };
  }
  if (planId === 'enterprise') {
    return {
      label: 'Falar com vendas',
      disabled: false,
      className:
        'bg-slate-900 hover:bg-slate-800 text-white border border-slate-900 cursor-pointer',
    };
  }
  if (idx > currentIdx) {
    return {
      label: 'Fazer upgrade',
      disabled: false,
      className: 'bg-teal-600 hover:bg-teal-700 text-white cursor-pointer',
    };
  }
  return {
    label: 'Fazer downgrade',
    disabled: false,
    className:
      'bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 cursor-pointer',
  };
}

export default function BillingView() {
  const [cycle, setCycle] = useState<BillingCycle>('mensal');
  const [notice, setNotice] = useState<string | null>(null);

  const { isLive } = useSession();

  const flash = (msg: string): void => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 3500);
  };

  // CTA de plano — demo: só aviso; live: POST /v1/billing/checkout { plan } e
  // redireciona à Checkout Session. Depende do Stripe (STRIPE_SECRET_KEY) →
  // sem ele a chamada falha-fechado (503) e mostramos a mensagem.
  const handlePlanCta = (plan: Plan, cta: CtaSpec): void => {
    if (cta.disabled) return;
    if (plan.id === 'enterprise') {
      flash('Nossa equipe de vendas entrará em contato em breve.');
      return;
    }
    if (!isLive) {
      flash(`${cta.label} para o plano ${plan.name} solicitado.`);
      return;
    }
    flash('Redirecionando para o checkout seguro…');
    void api<{ url?: string }>('/v1/billing/checkout', {
      method: 'POST',
      body: JSON.stringify({ plan: plan.id }),
    })
      .then((res) => {
        if (res?.url) window.location.href = res.url;
        else flash('Checkout indisponível no momento. Tente novamente mais tarde.');
      })
      .catch(() =>
        flash('Cobrança indisponível — configure o Stripe (STRIPE_SECRET_KEY) para habilitar o checkout.'),
      );
  };

  // Live (API real) — em modo demo useLive retorna null → caímos nos mocks abaixo.
  const plansLive = useLive<PlansResponse>('/v1/billing/plans', []);
  const subLive = useLive<SubscriptionResponse>('/v1/billing/subscription', []);

  // Grade de planos: real quando 'live', senão o mock existente (fallback demo).
  const plans: Plan[] = selectLiveData(plansLive, PLANS, [], adaptPlans);
  const planOrder: PlanId[] = plans.map((p) => p.id);
  const isDemo = plansLive.status === 'demo';

  // Plano atual vem da assinatura (fallback ao mock CURRENT_PLAN).
  const sub = subLive.status === 'success' ? subLive.data : null;
  const currentPlanId: PlanId = sub?.plan && isPlanId(sub.plan)
    ? sub.plan
    : isDemo
      ? CURRENT_PLAN
      : plans[0]?.id ?? 'free';

  // Medidor de uso — usage.* é camelCase. Fallback aos números mock.
  const usageUsed = sub?.usage?.eventsUsed ?? (isDemo ? USAGE_USED : 0);
  const usageLimit = sub?.usage?.eventsIncluded ?? (isDemo ? USAGE_LIMIT : 0);
  const usagePct = sub?.usage?.usagePct ?? (usageLimit > 0 ? (usageUsed / usageLimit) * 100 : 0);
  const usageRemaining = Math.max(0, usageLimit - usageUsed);

  // Renovação (current_period_end) com fallback ao mock.
  const renewal = fmtRenewal(sub?.current_period_end);
  const renewalDate = renewal?.date ?? (isDemo ? RENEWAL_DATE : '—');
  const renewalDays = renewal?.days ?? (isDemo ? RENEWAL_DAYS : 0);

  const tone: 'good' | 'warn' | 'danger' =
    usagePct >= 90 ? 'danger' : usagePct >= 70 ? 'warn' : 'good';

  const meterClass =
    tone === 'danger'
      ? 'from-rose-500 to-rose-600'
      : tone === 'warn'
      ? 'from-amber-400 to-amber-500'
      : 'from-teal-500 to-emerald-600';

  const currentPlan = plans.find((p) => p.id === currentPlanId) ?? plans[0] ?? PLANS[0];
  const CurrentPlanIcon = currentPlan.icon;
  const invoices = isDemo ? INVOICES : [];
  const nextPaidInvoice = invoices.find((i) => i.status === 'pago');
  const pendingTotal = invoices.filter((i) => i.status === 'pendente').reduce(
    (acc, i) => acc + i.amount,
    0,
  );

  return (
    <LiveDataBoundary states={[plansLive, subLive]} empty={plans.length === 0} label="Cobrança">
    <div id="billing-view-container" className="space-y-6">
      {/* Cabeçalho */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">
            Planos & Cobrança
          </h2>
          <p className="text-xs text-slate-500 mt-1 font-sans">
            Gerencie sua assinatura, acompanhe o consumo de eventos e baixe suas faturas.
          </p>
        </div>

        {/* Toggle de ciclo de cobrança */}
        <div className="flex items-center gap-1.5 bg-slate-100 p-1 rounded-xl border border-slate-150/80 self-start sm:self-auto">
          {(['mensal', 'anual'] as BillingCycle[]).map((c) => (
            <button
              key={c}
              onClick={() => setCycle(c)}
              className={`px-3.5 py-1.5 rounded-lg text-[11px] font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
                cycle === c
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <span className="capitalize">{c}</span>
              {c === 'anual' && (
                <span className="px-1.5 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase bg-emerald-100 text-emerald-800">
                  -20%
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Toast de aviso local */}
      {notice && (
        <div className="bg-teal-50 border border-teal-100 p-3 rounded-xl flex items-center gap-2 text-teal-800 text-xs animate-fadeIn">
          <Info className="w-4 h-4 text-teal-600 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {/* Card do plano atual + medidor de uso */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-xs overflow-hidden">
        <div className="grid grid-cols-1 lg:grid-cols-12">
          {/* Esquerda: identidade do plano */}
          <div className="lg:col-span-5 p-6 border-b lg:border-b-0 lg:border-r border-slate-100">
            <div className="flex items-center gap-2 text-[10px] font-mono font-bold uppercase tracking-wider text-teal-700">
              <Sparkles className="w-3.5 h-3.5" />
              <span>Sua assinatura</span>
            </div>

            <div className="flex items-center gap-3 mt-3">
              <div className="w-11 h-11 rounded-xl bg-teal-50 border border-teal-100 flex items-center justify-center text-teal-600 shrink-0">
                <CurrentPlanIcon className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-bold text-slate-900 tracking-tight">
                    Plano {currentPlan.name}
                  </h3>
                  <span className="px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase bg-teal-100 text-teal-800">
                    Ativo
                  </span>
                </div>
                <p className="text-xs text-slate-500 mt-0.5">{currentPlan.eventsLabel}</p>
              </div>
            </div>

            <div className="mt-5 flex items-end gap-1">
              <span className="text-2xl font-bold text-slate-900 tracking-tight font-mono">
                {currentPlan.monthly !== null ? brl0(currentPlan.monthly) : 'Sob consulta'}
              </span>
              {currentPlan.monthly !== null && (
                <span className="text-xs text-slate-400 font-mono mb-1">/mês</span>
              )}
            </div>

            <div className="mt-4 flex items-center gap-2 text-xs text-slate-500">
              <Calendar className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <span>
                Renova em{' '}
                <b className="text-slate-700 font-semibold font-mono">{renewalDate}</b>
                <span className="text-slate-400"> · em {renewalDays} dias</span>
              </span>
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              <button
                onClick={() => flash('Comparação de planos aberta — escolha um upgrade abaixo.')}
                className="px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <span>Alterar plano</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => flash('Assinatura agendada para cancelamento ao fim do ciclo.')}
                className="px-4 py-2 border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-xl text-xs font-bold transition-colors cursor-pointer"
              >
                Cancelar assinatura
              </button>
            </div>
          </div>

          {/* Direita: medidor de uso de eventos */}
          <div className="lg:col-span-7 p-6 bg-slate-50/40">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-[10px] font-mono font-bold uppercase tracking-wider text-slate-400">
                <Gauge className="w-3.5 h-3.5" />
                <span>Uso de eventos · ciclo atual</span>
              </div>
              <span
                className={`px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase ${
                  tone === 'danger'
                    ? 'bg-rose-100 text-rose-800'
                    : tone === 'warn'
                    ? 'bg-amber-100 text-amber-800'
                    : 'bg-emerald-100 text-emerald-800'
                }`}
              >
                {tone === 'danger' ? 'Limite próximo' : tone === 'warn' ? 'Uso elevado' : 'Saudável'}
              </span>
            </div>

            <div className="mt-4 flex items-end justify-between">
              <div>
                <span className="text-2xl font-bold text-slate-900 tracking-tight font-mono">
                  {int(usageUsed)}
                </span>
                <span className="text-sm text-slate-400 font-mono"> / {int(usageLimit)}</span>
              </div>
              <span className="text-lg font-bold text-slate-800 font-mono">{pct1(usagePct)}%</span>
            </div>

            {/* Barra de progresso */}
            <div className="mt-2 w-full bg-slate-200 h-3 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full bg-linear-to-r ${meterClass}`}
                style={{ width: `${Math.min(100, usagePct)}%` }}
              />
            </div>

            <div className="mt-2 flex items-center justify-between text-[10px] font-mono text-slate-400">
              <span>{int(usageRemaining)} eventos restantes</span>
              <span>Reinicia em {renewalDate}</span>
            </div>

            {/* Aviso de overage */}
            <div className="mt-4 bg-white p-3 rounded-xl border border-slate-100 flex items-start gap-2.5">
              <AlertTriangle
                className={`w-4 h-4 shrink-0 mt-0.5 ${
                  tone === 'danger' ? 'text-rose-500' : 'text-amber-500'
                }`}
              />
              <p className="text-[11px] text-slate-600 leading-relaxed font-sans">
                Você já consumiu <b className="text-slate-800">{pct1(usagePct)}%</b> da cota mensal.
                Ao ultrapassar 100%, eventos excedentes são cobrados a{' '}
                <b className="text-slate-800 font-mono">R$ 1,20</b> a cada mil eventos. Um buffer de
                proteção de 10% mantém o rastreamento ativo antes de qualquer pausa.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Grade de planos */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">
              Planos disponíveis
            </h3>
            <p className="text-xs text-slate-500 mt-1 font-sans">
              Escolha a capacidade de eventos ideal para o seu volume de tráfego
              {cycle === 'anual' ? ' — preços com desconto anual aplicado.' : '.'}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
          {plans.map((plan) => {
            const isCurrent = plan.id === currentPlanId;
            const cta = ctaFor(plan.id, currentPlanId, planOrder);
            const shownPrice =
              plan.monthly !== null ? priceForCycle(plan.monthly, cycle) : null;
            const PlanIcon = plan.icon;

            return (
              <div
                key={plan.id}
                className={`bg-white rounded-2xl border p-6 shadow-xs flex flex-col transition-all ${
                  isCurrent
                    ? 'border-teal-300 ring-1 ring-teal-200'
                    : 'border-slate-100 hover:border-slate-200 hover:-translate-y-0.5'
                }`}
              >
                {/* Cabeçalho do card */}
                <div className="flex items-center justify-between">
                  <div className="w-10 h-10 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-center text-teal-600">
                    <PlanIcon className="w-5 h-5" />
                  </div>
                  {isCurrent ? (
                    <span className="px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase bg-teal-100 text-teal-800">
                      Plano atual
                    </span>
                  ) : plan.badge ? (
                    <span className="px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase bg-slate-900 text-white flex items-center gap-1">
                      <Zap className="w-2.5 h-2.5" />
                      {plan.badge}
                    </span>
                  ) : null}
                </div>

                <h4 className="text-sm font-bold text-slate-900 tracking-tight mt-4">
                  {plan.name}
                </h4>
                <p className="text-[11px] text-slate-500 mt-1 leading-relaxed min-h-[32px]">
                  {plan.tagline}
                </p>

                {/* Preço */}
                <div className="mt-4 pb-4 border-b border-slate-100">
                  {shownPrice !== null ? (
                    <>
                      <div className="flex items-end gap-1">
                        <span className="text-2xl font-bold text-slate-900 tracking-tight font-mono">
                          {brl0(shownPrice)}
                        </span>
                        <span className="text-xs text-slate-400 font-mono mb-1">/mês</span>
                      </div>
                      {cycle === 'anual' && plan.monthly !== null && (
                        <p className="text-[10px] text-slate-400 mt-1 font-mono">
                          {brl0(shownPrice * 12)} cobrado anualmente
                        </p>
                      )}
                      {cycle === 'mensal' && (
                        <p className="text-[10px] text-slate-400 mt-1 font-mono">
                          Cobrança mensal recorrente
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="text-2xl font-bold text-slate-900 tracking-tight">
                        Sob consulta
                      </span>
                      <p className="text-[10px] text-slate-400 mt-1 font-mono">
                        Preço personalizado
                      </p>
                    </>
                  )}
                </div>

                {/* Features */}
                <ul className="mt-4 space-y-2.5 flex-1">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-[11px] text-slate-600">
                      <Check className="w-3.5 h-3.5 text-teal-600 shrink-0 mt-0.5" />
                      <span className="leading-snug">{f}</span>
                    </li>
                  ))}
                </ul>

                {/* CTA */}
                <button
                  disabled={cta.disabled}
                  onClick={() => handlePlanCta(plan, cta)}
                  className={`mt-5 w-full py-2.5 rounded-xl text-xs font-bold transition-colors ${cta.className}`}
                >
                  {cta.label}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Método de pagamento + resumo da próxima fatura */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Método de pagamento */}
        <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs lg:col-span-5">
          <div className="flex items-center gap-1.5 text-[10px] font-mono font-bold uppercase tracking-wider text-slate-400">
            <CreditCard className="w-3.5 h-3.5" />
            <span>Método de pagamento</span>
          </div>

          <div className="mt-4 flex items-center gap-4">
            {/* Cartão visual */}
            <div className="w-16 h-11 rounded-lg bg-linear-to-br from-slate-800 to-slate-900 flex flex-col justify-between p-2 shrink-0 shadow-sm">
              <div className="w-5 h-3.5 rounded-sm bg-linear-to-br from-amber-300 to-amber-500 opacity-90" />
              <span className="text-[7px] font-mono font-bold text-slate-300 tracking-widest">
                VISA
              </span>
            </div>
            <div>
              <span className="text-sm font-bold text-slate-800 font-mono tracking-tight">
                •••• •••• •••• 5894
              </span>
              <div className="flex items-center gap-2 mt-1 text-[10px] text-slate-400 font-mono">
                <span>Expira 09/2028</span>
                <span className="w-1 h-1 rounded-full bg-slate-300" />
                <span>Visa Corporate</span>
              </div>
            </div>
          </div>

          <div className="mt-5 flex items-center gap-2 text-[10px] text-slate-400 bg-slate-50 rounded-lg px-3 py-2 border border-slate-100">
            <Lock className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <span className="font-sans leading-snug">
              Pagamentos processados com segurança via Stripe. Não armazenamos os dados do cartão.
            </span>
          </div>

          <button
            onClick={() => flash('O portal seguro de cobrança do Stripe abriria em produção.')}
            className="mt-4 w-full py-2.5 border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-xl text-xs font-bold transition-colors cursor-pointer"
          >
            Gerenciar método de pagamento
          </button>
        </div>

        {/* Resumo da próxima cobrança */}
        <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs lg:col-span-7">
          <div className="flex items-center gap-1.5 text-[10px] font-mono font-bold uppercase tracking-wider text-slate-400">
            <Receipt className="w-3.5 h-3.5" />
            <span>Próxima cobrança</span>
          </div>

          <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-slate-50/60 rounded-xl border border-slate-100 p-3">
              <span className="text-[9px] font-mono font-semibold uppercase tracking-wider text-slate-400">
                Valor previsto
              </span>
              <p className="text-lg font-bold text-slate-900 font-mono mt-1">
                {currentPlan.monthly !== null ? brl(currentPlan.monthly) : '—'}
              </p>
            </div>
            <div className="bg-slate-50/60 rounded-xl border border-slate-100 p-3">
              <span className="text-[9px] font-mono font-semibold uppercase tracking-wider text-slate-400">
                Data de cobrança
              </span>
              <p className="text-lg font-bold text-slate-900 font-mono mt-1">{renewalDate}</p>
            </div>
            <div className="bg-slate-50/60 rounded-xl border border-slate-100 p-3">
              <span className="text-[9px] font-mono font-semibold uppercase tracking-wider text-slate-400">
                Pendências
              </span>
              <p
                className={`text-lg font-bold font-mono mt-1 ${
                  pendingTotal > 0 ? 'text-amber-600' : 'text-emerald-600'
                }`}
              >
                {pendingTotal > 0 ? brl(pendingTotal) : brl(0)}
              </p>
            </div>
          </div>

          <div className="mt-4 space-y-2 text-xs">
            <div className="flex items-center justify-between py-1.5 border-b border-slate-50">
              <span className="text-slate-500">Plano {currentPlan.name} (mensal)</span>
              <span className="font-mono font-semibold text-slate-800">
                {currentPlan.monthly !== null ? brl(currentPlan.monthly) : '—'}
              </span>
            </div>
            <div className="flex items-center justify-between py-1.5 border-b border-slate-50">
              <span className="text-slate-500">Excedente de eventos estimado</span>
              <span className="font-mono font-semibold text-emerald-600">{brl(0)}</span>
            </div>
            <div className="flex items-center justify-between py-1.5">
              <span className="text-slate-500">Impostos (aprox.)</span>
              <span className="font-mono font-semibold text-slate-800">{brl(0)}</span>
            </div>
          </div>

          <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between">
            <span className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">
              Total
            </span>
            <span className="text-base font-bold text-slate-900 font-mono">
              {currentPlan.monthly !== null ? brl(currentPlan.monthly) : '—'}
              <span className="text-[10px] text-slate-400 font-normal"> /mês</span>
            </span>
          </div>
        </div>
      </div>

      {/* Histórico de faturas */}
      <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-xs">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider font-mono">
              Histórico de faturas
            </h3>
            <p className="text-xs text-slate-500 mt-1 font-sans">
              Últimas cobranças da sua conta · faturas disponíveis em PDF.
            </p>
          </div>
          <button
            onClick={() => flash('Exportando todas as faturas em um arquivo .zip.')}
            className="px-4 py-2 border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <Download className="w-3.5 h-3.5 text-slate-400" />
            <span>Exportar tudo</span>
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-100 text-[10px] font-mono text-slate-400 uppercase tracking-wider">
                <th className="py-3 font-semibold">Fatura</th>
                <th className="py-3 font-semibold">Data</th>
                <th className="py-3 font-semibold text-right">Valor</th>
                <th className="py-3 font-semibold text-center">Status</th>
                <th className="py-3 font-semibold text-right">Recibo</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {invoices.map((inv) => (
                <tr
                  key={inv.id}
                  className="hover:bg-slate-50/50 transition-colors text-xs font-sans text-slate-700"
                >
                  <td className="py-3.5">
                    <span className="font-mono text-[11px] font-semibold text-slate-800 block">
                      {inv.id}
                    </span>
                    <span className="text-[10px] text-slate-400 block mt-0.5">{inv.desc}</span>
                  </td>
                  <td className="py-3.5 font-mono text-slate-500">{inv.date}</td>
                  <td className="py-3.5 text-right font-mono font-semibold text-slate-900">
                    {brl(inv.amount)}
                  </td>
                  <td className="py-3.5 text-center">
                    <span
                      className={`inline-block px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase ${
                        inv.status === 'pago'
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-amber-100 text-amber-800'
                      }`}
                    >
                      {inv.status}
                    </span>
                  </td>
                  <td className="py-3.5 text-right">
                    <button
                      onClick={() => flash(`Baixando recibo ${inv.id} em PDF.`)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-600 hover:text-teal-700 text-[10px] font-bold transition-colors cursor-pointer"
                      title={`Baixar fatura ${inv.id}`}
                    >
                      <Download className="w-3 h-3" />
                      <span>PDF</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
    </LiveDataBoundary>
  );
}
