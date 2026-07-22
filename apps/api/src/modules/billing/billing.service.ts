import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import Stripe from 'stripe';
import {
  subscriptions,
  type PlanId,
  type Subscription,
  type SubscriptionStatus,
} from '@truvo/db';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { NotificationService } from '../notifications/notifications.service';
import { getStripe, isStripeConfigured } from './infra';
import { UsageService } from './usage.service';
import { featuresForPlan } from './feature-gates';
import {
  PLAN_CATALOG,
  checkoutCancelUrl,
  checkoutSuccessUrl,
  defaultPlan,
  eventsIncludedForPlan,
  isEntitledStatus,
  isPlanId,
  meteredPriceIdForPlan,
  planForPriceId,
  portalReturnUrl,
  priceIdForPlan,
} from './plans';
import type { CreateCheckoutDto } from './dto/billing.dto';

/**
 * M11 — BILLING (orquestração Stripe + projeção local).
 *
 * O Stripe é a fonte de verdade; este service (a) cria Checkout/Portal Sessions,
 * (b) lê o estado consolidado para `/subscription` e (c) processa os webhooks
 * mantendo a tabela `subscriptions` em sincronia. Fail-closed: sem chaves Stripe
 * (STRIPE_SECRET_KEY), as ações que dependem do Stripe respondem 503.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly usage: UsageService,
    private readonly notifications: NotificationService,
  ) {}

  // ─────────────────────────────── catálogo ────────────────────────────────

  /** GET /v1/billing/plans — catálogo estático (preços/limites/gates). */
  getCatalog() {
    return {
      currency: 'BRL',
      plans: Object.values(PLAN_CATALOG).map((p) => ({
        id: p.id,
        name: p.name,
        price_brl_cents: p.priceBrlCents,
        events_included: p.eventsIncluded,
        workspaces_included: p.workspacesIncluded,
        contact_sales: p.contactSales,
        features: featuresForPlan(p.id),
      })),
    };
  }

  // ─────────────────────────────── leitura ─────────────────────────────────

  /** GET /v1/billing/subscription — estado + consumo do mês. */
  async getSubscriptionView(workspaceId: string) {
    const sub = await this.getRow(workspaceId);
    const plan = this.effectivePlan(sub);
    const eventsIncluded =
      sub?.eventsLimit != null ? sub.eventsLimit : eventsIncludedForPlan(plan);
    const usage = await this.usage.buildSummary(workspaceId, plan, eventsIncluded);

    return {
      plan,
      status: sub?.status ?? 'none',
      entitled: sub ? isEntitledStatus(sub.status) : false,
      cancel_at_period_end: sub?.cancelAtPeriodEnd ?? false,
      current_period_end: sub?.currentPeriodEnd?.toISOString() ?? null,
      current_period_start: sub?.currentPeriodStart?.toISOString() ?? null,
      limits: {
        events_included: eventsIncluded,
        workspaces: PLAN_CATALOG[plan].workspacesIncluded,
      },
      usage,
      features: featuresForPlan(plan),
      stripe: {
        has_customer: Boolean(sub?.stripeCustomerId),
        has_subscription: Boolean(sub?.stripeSubscriptionId),
      },
    };
  }

  // ────────────────────────────── checkout ─────────────────────────────────

  /** POST /v1/billing/checkout — Checkout Session para upgrade/assinatura. */
  async createCheckout(workspaceId: string, userEmail: string | undefined, dto: CreateCheckoutDto) {
    this.assertStripe();
    if (!isPlanId(dto.plan)) throw new BadRequestException('plano inválido');
    const plan = dto.plan;

    const catalog = PLAN_CATALOG[plan];
    if (catalog.contactSales) {
      throw new BadRequestException(
        `Plano ${catalog.name} é sob consulta — fale com o comercial (sem checkout self-service).`,
      );
    }

    const priceId = priceIdForPlan(plan);
    if (!priceId) {
      // Fail-closed: sem Price configurado no env, não inventamos id.
      throw new ServiceUnavailableException(
        `Price do plano ${plan} não configurado (STRIPE_PRICE_${plan.toUpperCase()}).`,
      );
    }

    const stripe = getStripe();
    const customerId = await this.ensureCustomer(workspaceId, userEmail);

    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
      { price: priceId, quantity: 1 },
    ];
    // Excedente: item metered opcional (sem quantity). TODO(live): configurar Price
    // metered no Stripe (STRIPE_PRICE_<PLANO>_METERED) para cobrar Usage Records.
    const meteredPrice = meteredPriceIdForPlan(plan);
    if (meteredPrice) lineItems.push({ price: meteredPrice });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: lineItems,
      client_reference_id: workspaceId,
      subscription_data: { metadata: { workspace_id: workspaceId } },
      metadata: { workspace_id: workspaceId, plan },
      success_url: dto.successUrl ?? checkoutSuccessUrl(),
      cancel_url: dto.cancelUrl ?? checkoutCancelUrl(),
      allow_promotion_codes: true,
    });

    return { url: session.url, session_id: session.id };
  }

  // ──────────────────────────────── portal ─────────────────────────────────

  /** GET /v1/billing/portal — Customer Portal para gerenciar a assinatura. */
  async createPortal(workspaceId: string) {
    this.assertStripe();
    const sub = await this.getRow(workspaceId);
    const customerId = sub?.stripeCustomerId;
    if (!customerId) {
      throw new ConflictException(
        'Workspace sem cliente Stripe — inicie um checkout antes de abrir o portal.',
      );
    }
    const session = await getStripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: portalReturnUrl(),
    });
    return { url: session.url };
  }

  // ────────────────────────── metering / alertas ───────────────────────────

  /**
   * Varredura de metering de um workspace — pensada para um JOB PERIÓDICO
   * (TODO(live): agendar via cron do M12 / infra de jobs). (1) dispara alerta de
   * "aproximando do limite" quando o consumo cruza o limiar; (2) reporta o
   * excedente ao Stripe (Usage Records) e audita em `usage_records`.
   *
   * PRD §7 M11 (alertas de billing) + §7 M12 (roteamento de notificações).
   */
  async sweepUsage(workspaceId: string): Promise<void> {
    const sub = await this.getRow(workspaceId);
    const plan = this.effectivePlan(sub);
    const eventsIncluded =
      sub?.eventsLimit != null ? sub.eventsLimit : eventsIncludedForPlan(plan);
    const summary = await this.usage.buildSummary(workspaceId, plan, eventsIncluded);

    if (summary.approachingLimit) {
      this.emitBillingAlert('approaching_limit', workspaceId, {
        usagePct: summary.usagePct,
        eventsUsed: summary.eventsUsed,
        eventsIncluded: summary.eventsIncluded,
      });
    }
    await this.usage.reportOverage(workspaceId);
  }

  // ─────────────────────────────── webhooks ────────────────────────────────

  /**
   * Processa um evento Stripe já VERIFICADO (a verificação de assinatura acontece
   * no WebhookController). Idempotente por natureza (upsert por workspace).
   */
  async handleStripeEvent(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await this.upsertFromSubscription(event.data.object as Stripe.Subscription);
        break;
      case 'customer.subscription.deleted':
        await this.onSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;
      case 'invoice.paid':
        await this.onInvoicePaid(event.data.object as Stripe.Invoice);
        break;
      case 'invoice.payment_failed':
        await this.onInvoiceFailed(event.data.object as Stripe.Invoice);
        break;
      default:
        this.logger.debug(`evento Stripe ignorado: ${event.type}`);
    }
  }

  private async upsertFromSubscription(sub: Stripe.Subscription): Promise<void> {
    const workspaceId = await this.resolveWorkspaceId(sub);
    if (!workspaceId) {
      this.logger.warn(
        `subscription ${sub.id} sem workspace atribuível (metadata/customer) — ignorada.`,
      );
      return;
    }

    const items = sub.items?.data ?? [];
    const baseItem = items.find((it) => it.price?.recurring?.usage_type !== 'metered') ?? items[0];
    const meteredItem = items.find((it) => it.price?.recurring?.usage_type === 'metered');

    const resolvedPlan = planForPriceId(baseItem?.price?.id);
    const plan: PlanId = resolvedPlan ?? defaultPlan();
    if (!resolvedPlan) {
      this.logger.warn(
        `price ${baseItem?.price?.id ?? '?'} não mapeado a um plano — usando ${plan}. Configure STRIPE_PRICE_*.`,
      );
    }

    const customerId = extractId(sub.customer);
    await this.db
      .insert(subscriptions)
      .values({
        workspaceId,
        plan,
        status: sub.status as SubscriptionStatus,
        stripeCustomerId: customerId,
        stripeSubscriptionId: sub.id,
        stripePriceId: baseItem?.price?.id ?? null,
        stripeUsageItemId: meteredItem?.id ?? null,
        eventsLimit: eventsIncludedForPlan(plan),
        currentPeriodStart: unixToDate(subPeriodStart(sub)),
        currentPeriodEnd: unixToDate(subPeriodEnd(sub)),
        cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: subscriptions.workspaceId,
        set: {
          plan,
          status: sub.status as SubscriptionStatus,
          stripeCustomerId: customerId,
          stripeSubscriptionId: sub.id,
          stripePriceId: baseItem?.price?.id ?? null,
          stripeUsageItemId: meteredItem?.id ?? null,
          eventsLimit: eventsIncludedForPlan(plan),
          currentPeriodStart: unixToDate(subPeriodStart(sub)),
          currentPeriodEnd: unixToDate(subPeriodEnd(sub)),
          cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
          updatedAt: new Date(),
        },
      });

    this.logger.log(`subscription ${sub.id} → ws=${workspaceId} plano=${plan} status=${sub.status}`);
  }

  private async onSubscriptionDeleted(sub: Stripe.Subscription): Promise<void> {
    const workspaceId = await this.resolveWorkspaceId(sub);
    // Marca cancelada; o gating cai para o plano default (fail-closed).
    if (workspaceId) {
      await this.db
        .update(subscriptions)
        .set({ status: 'canceled', cancelAtPeriodEnd: false, updatedAt: new Date() })
        .where(eq(subscriptions.workspaceId, workspaceId));
    } else {
      await this.db
        .update(subscriptions)
        .set({ status: 'canceled', cancelAtPeriodEnd: false, updatedAt: new Date() })
        .where(eq(subscriptions.stripeSubscriptionId, sub.id));
    }
    this.logger.log(`subscription ${sub.id} cancelada (ws=${workspaceId ?? '?'}).`);
  }

  private async onInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
    const subId = extractId(invoiceSubscription(invoice));
    if (!subId) return;
    await this.db
      .update(subscriptions)
      .set({ status: 'active', updatedAt: new Date() })
      .where(eq(subscriptions.stripeSubscriptionId, subId));
    this.logger.log(`invoice ${invoice.id} paga → subscription ${subId} ativa.`);
  }

  private async onInvoiceFailed(invoice: Stripe.Invoice): Promise<void> {
    const subId = extractId(invoiceSubscription(invoice));
    if (!subId) return;
    const rows = await this.db
      .update(subscriptions)
      .set({ status: 'past_due', updatedAt: new Date() })
      .where(eq(subscriptions.stripeSubscriptionId, subId))
      .returning({ workspaceId: subscriptions.workspaceId });
    const workspaceId = rows[0]?.workspaceId;
    this.emitBillingAlert('payment_failed', workspaceId, { invoiceId: invoice.id });
  }

  // ─────────────────────────────── helpers ─────────────────────────────────

  private assertStripe(): void {
    if (!isStripeConfigured()) {
      throw new ServiceUnavailableException(
        'Billing indisponível: STRIPE_SECRET_KEY não configurado.',
      );
    }
  }

  /** Garante um customer Stripe para o workspace, persistindo o id localmente. */
  private async ensureCustomer(
    workspaceId: string,
    userEmail: string | undefined,
  ): Promise<string> {
    const sub = await this.getRow(workspaceId);
    if (sub?.stripeCustomerId) return sub.stripeCustomerId;

    const customer = await getStripe().customers.create({
      email: userEmail,
      metadata: { workspace_id: workspaceId },
    });

    await this.db
      .insert(subscriptions)
      .values({ workspaceId, stripeCustomerId: customer.id, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: subscriptions.workspaceId,
        set: { stripeCustomerId: customer.id, updatedAt: new Date() },
      });

    return customer.id;
  }

  private async getRow(workspaceId: string): Promise<Subscription | undefined> {
    const rows = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.workspaceId, workspaceId))
      .limit(1);
    return rows[0];
  }

  /** Plano efetivo a partir da linha local (fail-closed → default). */
  private effectivePlan(sub: Subscription | undefined): PlanId {
    if (!sub) return defaultPlan();
    if (!isEntitledStatus(sub.status)) return defaultPlan();
    return isPlanId(sub.plan) ? sub.plan : defaultPlan();
  }

  /** Resolve o workspace de uma subscription: metadata → subId local → customer local. */
  private async resolveWorkspaceId(sub: Stripe.Subscription): Promise<string | undefined> {
    const fromMeta = sub.metadata?.workspace_id;
    if (fromMeta) return fromMeta;

    const bySub = await this.db
      .select({ workspaceId: subscriptions.workspaceId })
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, sub.id))
      .limit(1);
    if (bySub[0]) return bySub[0].workspaceId;

    const customerId = extractId(sub.customer);
    if (customerId) {
      const byCustomer = await this.db
        .select({ workspaceId: subscriptions.workspaceId })
        .from(subscriptions)
        .where(eq(subscriptions.stripeCustomerId, customerId))
        .limit(1);
      if (byCustomer[0]) return byCustomer[0].workspaceId;
    }
    return undefined;
  }

  /**
   * Emite alerta de billing pelo M12 (NotificationService): in-app/email/Slack com
   * dedup por tipo. Best-effort — a falha de entrega não derruba o fluxo de billing
   * (o webhook do Stripe precisa responder 2xx). Sem workspace resolvido, só loga.
   */
  private emitBillingAlert(
    type: 'payment_failed' | 'approaching_limit',
    workspaceId: string | undefined,
    meta?: Record<string, unknown>,
  ): void {
    if (!workspaceId) {
      this.logger.warn(`[billing-alert] ${type} sem workspace resolvido ${meta ? JSON.stringify(meta) : ''}`);
      return;
    }
    const alertType =
      type === 'payment_failed' ? 'billing.payment_failed' : 'billing.usage_approaching_limit';
    this.notifications
      .dispatch(workspaceId, alertType, { data: meta ?? {}, dedupId: type })
      .catch((e) => this.logger.warn(`falha ao despachar alerta billing ${type}: ${(e as Error).message}`));
  }
}

// ─────────────────────────── util (Stripe shapes) ───────────────────────────

/** Extrai o id de um campo expandível do Stripe (string | objeto | deletado). */
function extractId(
  ref: string | { id: string } | null | undefined,
): string | null {
  if (!ref) return null;
  return typeof ref === 'string' ? ref : ref.id;
}

function unixToDate(seconds: number | null | undefined): Date | null {
  return typeof seconds === 'number' && Number.isFinite(seconds)
    ? new Date(seconds * 1000)
    : null;
}

/**
 * `current_period_start/end` migraram para o item da assinatura em versões novas
 * da API. Lemos o top-level (compat) e caímos para o primeiro item — defensivo
 * contra a versão fixada na conta.
 */
function subPeriodStart(sub: Stripe.Subscription): number | undefined {
  const s = sub as unknown as {
    current_period_start?: number;
    items?: { data?: Array<{ current_period_start?: number }> };
  };
  if (typeof s.current_period_start === 'number') return s.current_period_start;
  return s.items?.data?.[0]?.current_period_start;
}

function subPeriodEnd(sub: Stripe.Subscription): number | undefined {
  const s = sub as unknown as {
    current_period_end?: number;
    items?: { data?: Array<{ current_period_end?: number }> };
  };
  if (typeof s.current_period_end === 'number') return s.current_period_end;
  return s.items?.data?.[0]?.current_period_end;
}

/** `invoice.subscription` também é expandível; extrai a referência de forma tolerante. */
function invoiceSubscription(
  invoice: Stripe.Invoice,
): string | { id: string } | null | undefined {
  return (invoice as unknown as { subscription?: string | { id: string } | null }).subscription;
}
