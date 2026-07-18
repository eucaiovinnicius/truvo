import { PLAN_IDS, type PlanId, type SubscriptionStatus } from '@truvo/db';

/**
 * M11 — catálogo de planos (PRD §7 M11) + mapeamento plano ⇄ Stripe Price.
 *
 * Preços/limites são product data (ficam AQUI, não no schema). O mapeamento para
 * os Price ids do Stripe vem do ENV (fail-closed): sem `STRIPE_PRICE_<PLANO>`
 * configurado, o Checkout daquele plano responde erro claro — nunca inventa id.
 */

export interface PlanDef {
  id: PlanId;
  name: string;
  /** Preço mensal em centavos de BRL. `null` = sob consulta (Enterprise). */
  priceBrlCents: number | null;
  /** Eventos/mês inclusos. `null` = ilimitado/custom (Enterprise). */
  eventsIncluded: number | null;
  /** Workspaces inclusos. `null` = ilimitado. */
  workspacesIncluded: number | null;
  /** Requer contato comercial (não há Checkout self-service). */
  contactSales: boolean;
}

/**
 * Catálogo (PRD §7 M11):
 * | Plano | Preço | Eventos/mês | Workspaces |
 * | Starter    | R$297   | 100k | 1         |
 * | Growth     | R$697   | 1M   | 3         |
 * | Agency     | R$1.997 | 10M  | ilimitado |
 * | Enterprise | custom  | custom | ilimitado |
 */
export const PLAN_CATALOG: Record<PlanId, PlanDef> = {
  starter: {
    id: 'starter',
    name: 'Starter',
    priceBrlCents: 29_700,
    eventsIncluded: 100_000,
    workspacesIncluded: 1,
    contactSales: false,
  },
  growth: {
    id: 'growth',
    name: 'Growth',
    priceBrlCents: 69_700,
    eventsIncluded: 1_000_000,
    workspacesIncluded: 3,
    contactSales: false,
  },
  agency: {
    id: 'agency',
    name: 'Agency',
    priceBrlCents: 199_700,
    eventsIncluded: 10_000_000,
    workspacesIncluded: null,
    contactSales: false,
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    priceBrlCents: null,
    eventsIncluded: null,
    workspacesIncluded: null,
    contactSales: true,
  },
};

/** Fatia de eventos inclusa por plano (`null` = ilimitado). */
export function eventsIncludedForPlan(plan: PlanId): number | null {
  return PLAN_CATALOG[plan].eventsIncluded;
}

/** Plano default para workspaces sem assinatura ativa (fail-closed → menor tier). */
export function defaultPlan(): PlanId {
  const env = process.env.BILLING_DEFAULT_PLAN;
  return isPlanId(env) ? env : 'starter';
}

export function isPlanId(v: unknown): v is PlanId {
  return typeof v === 'string' && (PLAN_IDS as readonly string[]).includes(v);
}

/**
 * Status Stripe que mantêm o workspace com direito ao plano pago. `past_due` conta
 * como direito durante a janela de graça (o dunning do Stripe pode recuperar o
 * pagamento); `canceled`/`unpaid`/`incomplete*`/`paused` caem para o plano default.
 */
const ENTITLED_STATUSES: readonly SubscriptionStatus[] = ['active', 'trialing', 'past_due'];

export function isEntitledStatus(status: string): boolean {
  return (ENTITLED_STATUSES as readonly string[]).includes(status);
}

// ─────────────────────────── Stripe Price ⇄ plano ───────────────────────────

const PLAN_PRICE_ENV: Record<PlanId, string> = {
  starter: 'STRIPE_PRICE_STARTER',
  growth: 'STRIPE_PRICE_GROWTH',
  agency: 'STRIPE_PRICE_AGENCY',
  enterprise: 'STRIPE_PRICE_ENTERPRISE',
};

const PLAN_METERED_PRICE_ENV: Record<PlanId, string> = {
  starter: 'STRIPE_PRICE_STARTER_METERED',
  growth: 'STRIPE_PRICE_GROWTH_METERED',
  agency: 'STRIPE_PRICE_AGENCY_METERED',
  enterprise: 'STRIPE_PRICE_ENTERPRISE_METERED',
};

/** Price recorrente base do plano (env). `undefined` quando não configurado. */
export function priceIdForPlan(plan: PlanId): string | undefined {
  const v = process.env[PLAN_PRICE_ENV[plan]];
  return v && v.length > 0 ? v : undefined;
}

/**
 * Price metered do plano (excedente/Usage Records). Opcional — quando ausente, o
 * Checkout não inclui item metered e o reporter de overage grava mas não envia
 * (TODO(live)).
 */
export function meteredPriceIdForPlan(plan: PlanId): string | undefined {
  const v = process.env[PLAN_METERED_PRICE_ENV[plan]];
  return v && v.length > 0 ? v : undefined;
}

/**
 * Resolve o plano a partir de um Price id do Stripe (base OU metered), lendo o
 * ENV. Usado pelo webhook para mapear a assinatura recebida → plano local.
 */
export function planForPriceId(priceId: string | null | undefined): PlanId | undefined {
  if (!priceId) return undefined;
  for (const plan of PLAN_IDS) {
    if (priceIdForPlan(plan) === priceId) return plan;
    if (meteredPriceIdForPlan(plan) === priceId) return plan;
  }
  return undefined;
}

// ─────────────────────────── URLs de retorno (env) ──────────────────────────

function appBaseUrl(): string {
  return (
    process.env.BILLING_APP_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    'http://localhost:3000'
  );
}

/** URL de sucesso do Checkout (env com fallback para a base do app). */
export function checkoutSuccessUrl(): string {
  return (
    process.env.BILLING_CHECKOUT_SUCCESS_URL ?? `${appBaseUrl()}/settings/billing?checkout=success`
  );
}

/** URL de cancelamento do Checkout. */
export function checkoutCancelUrl(): string {
  return (
    process.env.BILLING_CHECKOUT_CANCEL_URL ?? `${appBaseUrl()}/settings/billing?checkout=cancel`
  );
}

/** URL de retorno do Customer Portal. */
export function portalReturnUrl(): string {
  return process.env.BILLING_PORTAL_RETURN_URL ?? `${appBaseUrl()}/settings/billing`;
}
