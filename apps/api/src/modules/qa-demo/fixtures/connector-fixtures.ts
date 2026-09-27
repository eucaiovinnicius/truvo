/**
 * ORDER 130 — SPEC-21: Sanitized Connector Fixtures
 * Portable fixtures for Shopify, Stripe, HubSpot, Klaviyo.
 * Zero secrets, zero live credentials, deterministic provider IDs.
 */

import assert from 'node:assert/strict';
import type { ShopifyOrderNode } from '../../connectors/adapters/shopify/shopify.mapper';
import type { HubspotObjectNode } from '../../connectors/adapters/hubspot/hubspot.mapper';
import type { KlaviyoProfileNode } from '../../connectors/adapters/klaviyo/klaviyo.mapper';

/**
 * 1. SHOPIFY FIXTURES
 */
export const SHOPIFY_ORDER_VALID: ShopifyOrderNode = {
  id: 'gid://shopify/Order/7001',
  displayFinancialStatus: 'PAID',
  processedAt: '2026-08-01T10:00:00Z',
  currentTotalPriceSet: {
    shopMoney: {
      amount: '599.90',
      currencyCode: 'BRL',
    },
  },
  customer: {
    id: 'gid://shopify/Customer/8001',
    email: 'clara.compra@example.invalid',
    phone: '+5511999990001',
  },
  lineItems: {
    nodes: [
      {
        id: 'gid://shopify/LineItem/9001',
        name: 'Tênis Running Pro Carbon',
        quantity: 1,
        discountedUnitPriceSet: {
          shopMoney: {
            amount: '599.90',
            currencyCode: 'BRL',
          },
        },
        product: { id: 'gid://shopify/Product/1001' },
        variant: { id: 'gid://shopify/ProductVariant/2001' },
      },
    ],
  },
  refunds: [],
};

export const SHOPIFY_ORDER_INVALID = {
  id: 'invalid-id-without-gid',
  displayFinancialStatus: 'UNKNOWN_STATUS',
  currentTotalPriceSet: null,
  customer: null,
  lineItems: { nodes: [] },
};

/**
 * 2. STRIPE FIXTURES
 */
export const STRIPE_CUSTOMER_VALID = {
  id: 'cus_demo_rodrigo_001',
  object: 'customer',
  created: 1775044800, // 2026-04-01T12:00:00Z
  email: 'rodrigo.pro@example.invalid',
  phone: '+5511999990004',
  metadata: {
    tier: 'starter',
    source: 'qa_demo',
  },
};

export const STRIPE_SUBSCRIPTION_VALID = {
  id: 'sub_demo_rodrigo_starter_001',
  object: 'subscription',
  created: 1775044800,
  customer: 'cus_demo_rodrigo_001',
  status: 'active',
  start_date: 1775044800,
  current_period_start: 1785585600, // 2026-08-01T12:00:00Z
  current_period_end: 1788264000,   // 2026-08-31T12:00:00Z
  collection_method: 'charge_automatically',
  items: {
    data: [
      {
        id: 'si_demo_001',
        quantity: 1,
        price: {
          id: 'price_starter_monthly',
          product: 'prod_subscription_starter',
          unit_amount: 9900,
          currency: 'brl',
        },
      },
    ],
  },
};

export const STRIPE_INVOICE_VALID = {
  id: 'in_demo_rodrigo_001',
  object: 'invoice',
  customer: 'cus_demo_rodrigo_001',
  subscription: 'sub_demo_rodrigo_starter_001',
  status: 'paid',
  currency: 'brl',
  amount_due: 9900,
  amount_paid: 9900,
  amount_remaining: 0,
  created: 1785585600,
  status_transitions: {
    finalized_at: 1785585600,
    paid_at: 1785585600,
  },
};

export const STRIPE_PAYLOAD_INVALID = {
  object: 'subscription',
  // Missing id and customer
  status: 'invalid_status',
  items: null,
};

/**
 * 3. HUBSPOT FIXTURES
 */
export const HUBSPOT_CONTACT_VALID: HubspotObjectNode = {
  id: 'hs_contact_demo_001',
  properties: {
    email: 'clara.compra@example.invalid',
    phone: '+5511999990001',
    firstname: 'Clara',
    lastname: 'Intent',
    lifecyclestage: 'lead',
    hs_lead_status: 'OPEN',
    hs_lastmodifieddate: '1785585600000', // 2026-08-01T12:00:00.000Z in epoch ms
  },
  associations: {
    deals: {
      results: [{ id: 'hs_deal_demo_001', type: 'contact_to_deal' }],
    },
  },
};

export const HUBSPOT_DEAL_VALID: HubspotObjectNode = {
  id: 'hs_deal_demo_001',
  properties: {
    dealname: 'Upgrade Enterprise Clara',
    amount: '2490.00',
    dealstage: 'qualifiedtobuy',
    pipeline: 'default',
    closedate: '1788264000000',
    hs_lastmodifieddate: '1785585600000',
  },
};

export const HUBSPOT_PAYLOAD_INVALID = {
  id: '',
  properties: {
    // Missing required timestamps and valid types
    hs_lastmodifieddate: 'not-a-number',
  },
};

/**
 * 4. KLAVIYO FIXTURES
 */
export const KLAVIYO_PROFILE_VALID: KlaviyoProfileNode = {
  id: 'klaviyo_prof_demo_001',
  attributes: {
    email: 'helena.vip@example.invalid',
    phone_number: '+5511999990003',
    external_id: 'ext_repeat_003',
    properties: {
      vip_tier: 'gold',
      preferred_category: 'running',
    },
    subscriptions: {
      email: { marketing: { consent: 'SUBSCRIBED' } },
      sms: { marketing: { consent: 'SUBSCRIBED' } },
    },
    created: '2026-04-01T10:00:00Z',
    updated: '2026-08-01T12:00:00Z',
  },
};

export const KLAVIYO_EVENT_DELIVERED_VALID = {
  id: 'klaviyo_evt_delivery_001',
  type: 'event',
  attributes: {
    metric_id: 'metric_delivered',
    profile_id: 'klaviyo_prof_demo_001',
    timestamp: 1785585600, // 2026-08-01T12:00:00Z
    event_properties: {
      $message_interaction: 'delivery',
      $message: 'camp_vip_preview_001',
      campaign_name: 'VIP Preview Exclusiva',
    },
  },
};

export const KLAVIYO_PAYLOAD_INVALID = {
  id: 'klaviyo_empty',
  attributes: {},
};

/**
 * Audit helper: verifies recursively that no secrets, api keys, or real tokens exist.
 */
export function assertNoSecrets(obj: unknown, path = 'root'): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj === 'string') {
    const forbiddenPatterns = [
      /sk_live_[0-9a-zA-Z]+/i,
      /shpat_[0-9a-zA-Z]+/i,
      /shpca_[0-9a-zA-Z]+/i,
      /pk_live_[0-9a-zA-Z]+/i,
      /Bearer\s+[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+/i,
      /ghp_[0-9a-zA-Z]+/i,
      /gho_[0-9a-zA-Z]+/i,
      /api[_-]?key\s*[:=]\s*["']?[a-zA-Z0-9]{16,}/i,
      /client[_-]?secret\s*[:=]\s*["']?[a-zA-Z0-9]{16,}/i,
    ];
    for (const pattern of forbiddenPatterns) {
      assert.equal(
        pattern.test(obj),
        false,
        `Potential secret pattern detected at ${path}: "${obj.slice(0, 30)}..."`,
      );
    }
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
    return;
  }
  if (typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      assert.ok(
        !['access_token', 'refresh_token', 'client_secret', 'api_key', 'authorization'].includes(lowerKey),
        `Prohibited secret key "${key}" found at ${path}`,
      );
      assertNoSecrets(value, `${path}.${key}`);
    }
  }
}
