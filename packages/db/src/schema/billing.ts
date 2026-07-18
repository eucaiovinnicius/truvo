import {
  bigint,
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * M11 — BILLING (schema Postgres, PRD §7 Módulo 11).
 *
 * O Stripe é a FONTE DE VERDADE da cobrança; o Postgres guarda apenas a projeção
 * mínima necessária para (a) gatear features por plano sem round-trip ao Stripe a
 * cada request e (b) auditar o metering de excedente. Duas tabelas:
 *
 *   - subscriptions  → 1 linha por workspace: plano, status Stripe, ids do Stripe
 *     (customer / subscription / price / item metered) e a fatia de eventos
 *     inclusa. Escrita pelo webhook `POST /v1/webhooks/stripe-billing` (verificado
 *     por assinatura) e lida pelo FeatureGuard / FeatureAccessService.
 *   - usage_records  → auditoria do excedente reportado ao Stripe (Usage Records).
 *     Uma linha por (workspace, mês) com eventos usados vs. inclusos e o overage
 *     efetivamente enviado. O contador mensal de eventos vem do Redis (M2 —
 *     `billing:events:{workspace_id}:{YYYYMM}`, só não-bot; regra 11).
 *
 * Regras respeitadas:
 *   1  — toda leitura/escrita é escopada por workspace_id (PK / índices abaixo).
 *   11 — apenas eventos não-bot contam para o limite (o contador do M2 já filtra).
 *
 * NOTA DE INTEGRAÇÃO: este arquivo precisa ser re-exportado por
 * `packages/db/src/schema/index.ts` (`export * from './billing'`) na onda de
 * integração para que `@truvo/db` exponha `subscriptions` / `usageRecords` e os
 * tipos — MESMO padrão do M5/M6/M7/M8/M14. O barrel NÃO é editado por este módulo
 * (contrato de arquivos) — ver schemaExports / openTODOs.
 *
 * Obs.: `workspace_id` é `text` (não FK) — mesmo padrão do M2..M8/M14 — para
 * permanecer compatível com o formato de id do M1 (Auth, uuid) e com
 * `workspace_id: z.string()` do @truvo/event-schema.
 */

/** Planos comerciais (PRD §7 M11). Fonte de verdade compartilhada (schema↔módulo). */
export const PLAN_IDS = ['starter', 'growth', 'agency', 'enterprise'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

/**
 * Status de assinatura — espelham os status do Stripe
 * (https://stripe.com/docs/api/subscriptions/object#subscription_object-status).
 * Persistidos como `text` (não pgEnum) para não criar um tipo enum do Postgres
 * neste módulo e absorver novos status do Stripe sem migração.
 */
export const SUBSCRIPTION_STATUSES = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/**
 * subscriptions — 1 linha por workspace (PK). Projeção local do estado do Stripe;
 * o webhook a mantém em sincronia. Ausência de linha = workspace sem assinatura
 * (gating cai para o plano default — fail-closed, ver FeatureAccessService).
 */
export const subscriptions = pgTable(
  'subscriptions',
  {
    /** Tenant dono da assinatura (regra 1). PK = 1 assinatura por workspace. */
    workspaceId: text('workspace_id').primaryKey(),
    /** Plano vigente (allowlist PLAN_IDS; validado antes de gravar). */
    plan: text('plan').$type<PlanId>().notNull().default('starter'),
    /** Status Stripe (allowlist SUBSCRIPTION_STATUSES). */
    status: text('status').$type<SubscriptionStatus>().notNull().default('incomplete'),
    /** Cliente Stripe (cus_...). Reusado no Checkout/Portal. */
    stripeCustomerId: text('stripe_customer_id'),
    /** Assinatura Stripe (sub_...). Lookup nos webhooks. */
    stripeSubscriptionId: text('stripe_subscription_id'),
    /** Price recorrente base (price_...) do plano. */
    stripePriceId: text('stripe_price_id'),
    /** Subscription item metered (si_...) usado para reportar Usage Records de excedente. */
    stripeUsageItemId: text('stripe_usage_item_id'),
    /**
     * Fatia de eventos/mês inclusa no plano (snapshot). `null` = ilimitado/custom
     * (Enterprise). Snapshot para suportar limites negociados sem depender do
     * catálogo estático. bigint (mode number) suporta limites > int4 (Enterprise).
     */
    eventsLimit: bigint('events_limit', { mode: 'number' }),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Webhook resolve o workspace pela assinatura/cliente quando o metadata falta.
    subUq: uniqueIndex('subscriptions_stripe_subscription_uq').on(t.stripeSubscriptionId),
    customerIdx: index('subscriptions_stripe_customer_idx').on(t.stripeCustomerId),
  }),
);

/**
 * usage_records — auditoria do metering de excedente por (workspace, mês).
 * Dedup por (workspace_id, period_month): o reporter faz upsert. `reported_to_stripe`
 * marca se o Usage Record foi efetivamente enviado (fail-closed: sem item metered
 * configurado, grava a linha mas não envia — ver openTODOs / TODO(live)).
 */
export const usageRecords = pgTable(
  'usage_records',
  {
    id: text('id').primaryKey(), // ur_<ulid>
    workspaceId: text('workspace_id').notNull(),
    /** Mês de competência no formato YYYYMM (UTC) — casa com a chave Redis do M2. */
    periodMonth: text('period_month').notNull(),
    /** Eventos não-bot contabilizados no mês (contador Redis do M2). */
    eventsUsed: bigint('events_used', { mode: 'number' }).notNull().default(0),
    /** Fatia inclusa no plano no momento do cálculo (`null` = ilimitado). */
    eventsIncluded: bigint('events_included', { mode: 'number' }),
    /** max(0, eventsUsed - eventsIncluded). 0 quando ilimitado. */
    overage: bigint('overage', { mode: 'number' }).notNull().default(0),
    /** Foi enviado ao Stripe como Usage Record? */
    reportedToStripe: boolean('reported_to_stripe').notNull().default(false),
    /** Id do Usage Record no Stripe (mbur_...), quando enviado. */
    stripeUsageRecordId: text('stripe_usage_record_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('usage_records_workspace_idx').on(t.workspaceId),
    // 1 registro por (workspace, mês) — o reporter faz upsert.
    workspaceMonthUq: uniqueIndex('usage_records_workspace_month_uq').on(
      t.workspaceId,
      t.periodMonth,
    ),
  }),
);

export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;
export type UsageRecord = typeof usageRecords.$inferSelect;
export type NewUsageRecord = typeof usageRecords.$inferInsert;
