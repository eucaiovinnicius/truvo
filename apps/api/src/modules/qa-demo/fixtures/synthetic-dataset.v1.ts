/**
 * ORDER 130 — SPEC-21: Synthetic Dataset v1.0.0
 * Fully deterministic, zero-secrets, zero-real-PII dataset with stable IDs and fixed clock.
 */

import { createHash } from 'node:crypto';
import type { PersonaType, SyntheticDatasetV1 } from '../qa-demo.contracts';

export const FIXED_CLOCK = '2026-08-01T12:00:00.000Z';

export function hashContact(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

export const SYNTHETIC_DATASET_V1: SyntheticDatasetV1 = {
  version: '1.0.0',
  fixedClock: FIXED_CLOCK,
  products: [
    {
      id: 'prod_sneaker_pro',
      title: 'Tênis Running Pro Carbon',
      category: 'footwear',
      price: '599.90',
      currency: 'BRL',
    },
    {
      id: 'prod_subscription_starter',
      title: 'Plano Starter Anual',
      category: 'saas_plan',
      price: '990.00',
      currency: 'BRL',
    },
    {
      id: 'prod_subscription_pro',
      title: 'Plano Pro Enterprise',
      category: 'saas_plan',
      price: '2490.00',
      currency: 'BRL',
    },
    {
      id: 'prod_running_socks',
      title: 'Meia Performance Anti-Bolha (Pack 3)',
      category: 'apparel',
      price: '79.90',
      currency: 'BRL',
    },
  ],
  accounts: [
    {
      id: 'acc_acme_retail',
      name: 'Acme Retail Group',
      domain: 'acme.retail.example.invalid',
      tier: 'enterprise',
    },
    {
      id: 'acc_startup_hub',
      name: 'InovaTech Labs',
      domain: 'inovatech.example.invalid',
      tier: 'growth',
    },
  ],
  targetOutcomes: [
    {
      id: 'outcome_purchase',
      outcomeNamespace: 'canonical',
      outcomeKey: 'purchase',
      name: 'Purchase Confirmation',
      kind: 'event',
    },
    {
      id: 'outcome_upgrade',
      outcomeNamespace: 'canonical',
      outcomeKey: 'upgrade',
      name: 'Plan Upgrade',
      kind: 'event',
    },
    {
      id: 'outcome_churn',
      outcomeNamespace: 'canonical',
      outcomeKey: 'churn',
      name: 'Customer Churn',
      kind: 'event',
    },
  ],
  personas: {
    // 1. Likely Buyer (Provável comprador)
    likely_buyer: {
      type: 'likely_buyer',
      name: 'Clara Intent',
      description: 'Lead com navegação recente, intenção alta no produto premium, carrinho abandonado há 2 horas',
      expectedPropensityBand: 'high',
      expectedPropensityScore: 0.92,
      customer: {
        id: 'cust_demo_likely_buyer',
        externalId: 'ext_likely_001',
        email: 'clara.compra@example.invalid',
        phone: '+5511999990001',
        status: 'identified',
        anonymousId: 'anon_shopper_001',
      },
      traits: [
        { namespace: 'truvo.crm', key: 'lifecycle_stage', valueType: 'string', value: 'lead' },
        { namespace: 'truvo.intent', key: 'intent_score', valueType: 'number', value: 92 },
        { namespace: 'truvo.intent', key: 'cart_abandoned', valueType: 'boolean', value: true },
        { namespace: 'truvo.intent', key: 'high_value_target', valueType: 'boolean', value: true },
        { namespace: 'truvo.ecommerce', key: 'target_product_id', valueType: 'string', value: 'prod_sneaker_pro' },
      ],
      engagementEvents: [
        {
          providerEventId: 'evt_view_sneaker_001',
          metricName: 'Product Viewed',
          engagementKind: 'other',
          occurredAt: '2026-08-01T10:00:00.000Z',
          properties: { productId: 'prod_sneaker_pro', durationSeconds: 120 },
        },
        {
          providerEventId: 'evt_cart_add_001',
          metricName: 'Added to Cart',
          engagementKind: 'clicked',
          occurredAt: '2026-08-01T10:15:00.000Z',
          properties: { productId: 'prod_sneaker_pro', value: 599.90 },
        },
      ],
      identityTransition: {
        anonymousCustomerId: 'cust_demo_anon_shopper_001',
        anonymousIdentifierValue: 'cookie_likely_8829',
        transitionedAt: '2026-08-01T10:20:00.000Z',
        reason: 'Identified via checkout form email input',
      },
    },

    // 2. Non-Buyer (Não comprador)
    non_buyer: {
      type: 'non_buyer',
      name: 'Marcos Cold',
      description: 'Visitante frio e esporádico que apenas olhou o blog e saiu sem demonstrar interesse comercial',
      expectedPropensityBand: 'low',
      expectedPropensityScore: 0.11,
      customer: {
        id: 'cust_demo_non_buyer',
        externalId: 'ext_nonbuyer_002',
        email: 'marcos.frio@example.invalid',
        status: 'identified',
      },
      traits: [
        { namespace: 'truvo.crm', key: 'lifecycle_stage', valueType: 'string', value: 'visitor' },
        { namespace: 'truvo.intent', key: 'intent_score', valueType: 'number', value: 11 },
        { namespace: 'truvo.intent', key: 'bounce_count', valueType: 'number', value: 3 },
      ],
      engagementEvents: [
        {
          providerEventId: 'evt_blog_visit_002',
          metricName: 'Blog Article Viewed',
          engagementKind: 'other',
          occurredAt: '2026-07-28T14:30:00.000Z',
          properties: { path: '/blog/corrida-de-rua-dicas', durationSeconds: 8 },
        },
      ],
    },

    // 3. Repeat Buyer (Comprador recorrente)
    repeat_buyer: {
      type: 'repeat_buyer',
      name: 'Helena VIP',
      description: 'Cliente fiel e recorrente com 3 compras anteriores e LTV de alto valor',
      expectedPropensityBand: 'high',
      expectedPropensityScore: 0.86,
      customer: {
        id: 'cust_demo_repeat_buyer',
        externalId: 'ext_repeat_003',
        email: 'helena.vip@example.invalid',
        phone: '+5511999990003',
        status: 'identified',
      },
      traits: [
        { namespace: 'truvo.crm', key: 'lifecycle_stage', valueType: 'string', value: 'customer' },
        { namespace: 'truvo.ecommerce', key: 'orders_count', valueType: 'number', value: 3 },
        { namespace: 'truvo.ecommerce', key: 'total_spent_brl', valueType: 'number', value: 1450.00 },
        { namespace: 'truvo.segment', key: 'vip_tier', valueType: 'string', value: 'gold' },
      ],
      orders: [
        {
          id: 'ord_demo_vip_001',
          providerOrderId: 'gid://shopify/Order/9001',
          financialStatus: 'paid',
          currency: 'BRL',
          totalAmount: '450.00',
          processedAt: '2026-05-10T11:00:00.000Z',
          lineItems: [
            { productId: 'prod_running_socks', title: 'Meia Performance', quantity: 3, unitPrice: '79.90' },
          ],
        },
        {
          id: 'ord_demo_vip_002',
          providerOrderId: 'gid://shopify/Order/9002',
          financialStatus: 'paid',
          currency: 'BRL',
          totalAmount: '599.90',
          processedAt: '2026-06-15T15:30:00.000Z',
          lineItems: [
            { productId: 'prod_sneaker_pro', title: 'Tênis Running Pro Carbon', quantity: 1, unitPrice: '599.90' },
          ],
        },
        {
          id: 'ord_demo_vip_003',
          providerOrderId: 'gid://shopify/Order/9003',
          financialStatus: 'paid',
          currency: 'BRL',
          totalAmount: '400.10',
          processedAt: '2026-07-20T18:00:00.000Z',
          lineItems: [
            { productId: 'prod_running_socks', title: 'Meia Performance', quantity: 5, unitPrice: '79.90' },
          ],
        },
      ],
      engagementEvents: [
        {
          providerEventId: 'evt_email_click_003',
          metricName: 'Email Clicked',
          engagementKind: 'clicked',
          occurredAt: '2026-08-01T09:00:00.000Z',
          properties: { campaign: 'vip_exclusive_preview' },
        },
      ],
    },

    // 4. Subscription Upgrade Candidate (Candidato a upgrade)
    subscription_upgrade_candidate: {
      type: 'subscription_upgrade_candidate',
      name: 'Rodrigo Pro Candidate',
      description: 'Assinante ativo do plano Starter batendo limites de assentos e volume de requisições',
      expectedPropensityBand: 'high',
      expectedPropensityScore: 0.84,
      customer: {
        id: 'cust_demo_sub_upgrade',
        externalId: 'ext_upgrade_004',
        email: 'rodrigo.pro@example.invalid',
        status: 'identified',
      },
      traits: [
        { namespace: 'truvo.saas', key: 'current_plan', valueType: 'string', value: 'starter' },
        { namespace: 'truvo.saas', key: 'seat_usage_pct', valueType: 'number', value: 96 },
        { namespace: 'truvo.saas', key: 'api_requests_30d', valueType: 'number', value: 89400 },
        { namespace: 'truvo.saas', key: 'limit_warning_shown', valueType: 'boolean', value: true },
      ],
      subscriptions: [
        {
          id: 'sub_demo_001',
          providerSubscriptionId: 'sub_stripe_starter_001',
          status: 'active',
          currency: 'BRL',
          currentPeriodEnd: '2026-08-30T00:00:00.000Z',
          plan: 'starter',
          amount: '99.00',
        },
      ],
      engagementEvents: [
        {
          providerEventId: 'evt_pricing_view_004',
          metricName: 'Upgrade Page Visited',
          engagementKind: 'clicked',
          occurredAt: '2026-08-01T11:45:00.000Z',
          properties: { targetPlan: 'enterprise' },
        },
      ],
    },

    // 5. Churn-like History (Histórico semelhante a churn)
    churn_like_history: {
      type: 'churn_like_history',
      name: 'Lucas Churn Risk',
      description: 'Cliente outrora ativo sem atividade recente nos últimos 75 dias e com NPS negativo',
      expectedPropensityBand: 'low',
      expectedPropensityScore: 0.22,
      customer: {
        id: 'cust_demo_churn_risk',
        externalId: 'ext_churn_005',
        email: 'lucas.inativo@example.invalid',
        status: 'identified',
      },
      traits: [
        { namespace: 'truvo.crm', key: 'lifecycle_stage', valueType: 'string', value: 'at_risk' },
        { namespace: 'truvo.health', key: 'days_since_last_seen', valueType: 'number', value: 75 },
        { namespace: 'truvo.health', key: 'nps_score', valueType: 'number', value: 4 },
        { namespace: 'truvo.health', key: 'open_support_tickets', valueType: 'number', value: 3 },
      ],
      subscriptions: [
        {
          id: 'sub_demo_002',
          providerSubscriptionId: 'sub_stripe_paused_002',
          status: 'canceled',
          currency: 'BRL',
          currentPeriodEnd: '2026-06-01T00:00:00.000Z',
          plan: 'starter',
          amount: '99.00',
        },
      ],
      engagementEvents: [
        {
          providerEventId: 'evt_support_ticket_005',
          metricName: 'Ticket Opened',
          engagementKind: 'delivery',
          occurredAt: '2026-05-18T16:00:00.000Z',
          properties: { category: 'cancellation_inquiry' },
        },
      ],
    },

    // 6. Insufficient History (Histórico insuficiente)
    insufficient_history: {
      type: 'insufficient_history',
      name: 'Novo Visitante Anônimo',
      description: 'Visitante recém-chegado com apenas 1 evento superficial e dados insuficientes para score preditivo',
      expectedPropensityBand: 'unscored',
      expectedPropensityScore: null,
      customer: {
        id: 'cust_demo_insufficient',
        externalId: 'ext_insufficient_006',
        email: 'novo.visitante@example.invalid',
        status: 'identified',
      },
      traits: [
        { namespace: 'truvo.crm', key: 'lifecycle_stage', valueType: 'string', value: 'unqualified' },
        { namespace: 'truvo.profile', key: 'is_new_profile', valueType: 'boolean', value: true },
      ],
      engagementEvents: [
        {
          providerEventId: 'evt_first_touch_006',
          metricName: 'Page Landed',
          engagementKind: 'received',
          occurredAt: '2026-08-01T11:59:00.000Z',
          properties: { path: '/' },
        },
      ],
    },
  },
};

/**
 * Returns a deep copy of the synthetic dataset for safety across runs.
 */
export function getSyntheticDatasetV1(): SyntheticDatasetV1 {
  return JSON.parse(JSON.stringify(SYNTHETIC_DATASET_V1));
}

/**
 * Validates that all six personas exist and satisfy contract rules.
 */
export function validateSyntheticDataset(dataset: SyntheticDatasetV1): {
  valid: boolean;
  personasCount: number;
  errors: string[];
} {
  const errors: string[] = [];
  const expectedPersonas: PersonaType[] = [
    'likely_buyer',
    'non_buyer',
    'repeat_buyer',
    'subscription_upgrade_candidate',
    'churn_like_history',
    'insufficient_history',
  ];

  for (const p of expectedPersonas) {
    const persona = dataset.personas[p];
    if (!persona) {
      errors.push(`Missing expected persona: ${p}`);
      continue;
    }
    if (!persona.customer.id || !persona.customer.email) {
      errors.push(`Persona ${p} missing customer id or email`);
    }
    if (!persona.customer.email.endsWith('@example.invalid')) {
      errors.push(`Persona ${p} email must use @example.invalid RFC-2606 domain`);
    }
    if (!Array.isArray(persona.traits) || persona.traits.length === 0) {
      errors.push(`Persona ${p} must have traits`);
    }
  }

  return {
    valid: errors.length === 0,
    personasCount: Object.keys(dataset.personas).length,
    errors,
  };
}
