import assert from 'node:assert/strict';
import test from 'node:test';
import { LEGACY_IDENTITY_NAMESPACE } from '../../../customer-context/customer-context.service';
import { FINANCIAL_STATUS_UNCHANGED } from '../../commerce/commerce-write.service';
import { SHOPIFY_PROVIDER } from './shopify.constants';
import { mapShopifyOrder, mapShopifyRefundWebhook, type ShopifyOrderNode } from './shopify.mapper';

/**
 * Order 060 §4/§8 — pure mapper proofs: guest checkout, identified customer, the
 * shared-vs-provider identity namespace split, multi-currency, deleted
 * product/variant, and the refund-only webhook shape.
 */

function baseOrder(overrides: Partial<ShopifyOrderNode> = {}): ShopifyOrderNode {
  return {
    id: 'gid://shopify/Order/1001',
    displayFinancialStatus: 'PAID',
    processedAt: '2026-08-01T12:00:00Z',
    currentTotalPriceSet: { shopMoney: { amount: '49.90', currencyCode: 'BRL' } },
    customer: { id: 'gid://shopify/Customer/2001', email: 'Jane.Doe@Example.com', phone: '+1 (555) 123-4567' },
    lineItems: { nodes: [] },
    refunds: [],
    ...overrides,
  };
}

test('mapShopifyOrder: identified customer emits shopify GID (provider-namespaced) + shared-namespace email/phone hashes', () => {
  const record = mapShopifyOrder(baseOrder());
  const gid = record.identifiers.find((i) => i.identifierType === 'external_id');
  assert.equal(gid?.providerNamespace, SHOPIFY_PROVIDER, 'opaque provider id stays provider-scoped');
  assert.equal(gid?.identifierValue, 'gid://shopify/Customer/2001');

  const emailHash = record.identifiers.find((i) => i.identifierType === 'email_hash');
  const phoneHash = record.identifiers.find((i) => i.identifierType === 'phone_hash');
  assert.equal(emailHash?.providerNamespace, LEGACY_IDENTITY_NAMESPACE, 'hashed contact identifiers use the SHARED cross-provider namespace');
  assert.equal(phoneHash?.providerNamespace, LEGACY_IDENTITY_NAMESPACE);
  assert.notEqual(emailHash?.identifierValue, 'jane.doe@example.com', 'never emits raw PII');
});

test('mapShopifyOrder: guest checkout (customer: null) → zero identifiers, order still carried', () => {
  const record = mapShopifyOrder(baseOrder({ customer: null }));
  assert.equal(record.identifiers.length, 0);
  assert.ok(record.commerceOrder, 'guest order must still be emitted for unattached recording');
  assert.equal(record.commerceOrder!.providerOrderId, 'gid://shopify/Order/1001');
});

test('mapShopifyOrder: financial status is lowercased to the provider-neutral vocabulary', () => {
  const record = mapShopifyOrder(baseOrder({ displayFinancialStatus: 'PARTIALLY_REFUNDED' }));
  assert.equal(record.commerceOrder!.financialStatus, 'partially_refunded');
});

test('mapShopifyOrder: line items preserve product/variant ids and per-item currency (multi-currency safe)', () => {
  const record = mapShopifyOrder(
    baseOrder({
      lineItems: {
        nodes: [
          {
            id: 'gid://shopify/LineItem/1',
            name: 'Widget',
            quantity: 2,
            discountedUnitPriceSet: { shopMoney: { amount: '10.00', currencyCode: 'BRL' } },
            product: { id: 'gid://shopify/Product/9' },
            variant: { id: 'gid://shopify/ProductVariant/99' },
          },
        ],
      },
    }),
  );
  const item = record.commerceOrder!.lineItems[0]!;
  assert.equal(item.providerProductId, 'gid://shopify/Product/9');
  assert.equal(item.providerVariantId, 'gid://shopify/ProductVariant/99');
  assert.equal(item.currency, 'BRL');
});

test('mapShopifyOrder: line item with product/variant deleted after purchase → undefined ids, item still recorded', () => {
  const record = mapShopifyOrder(
    baseOrder({
      lineItems: {
        nodes: [
          {
            id: 'gid://shopify/LineItem/1',
            name: 'Discontinued Widget',
            quantity: 1,
            discountedUnitPriceSet: { shopMoney: { amount: '10.00', currencyCode: 'BRL' } },
            product: null,
            variant: null,
          },
        ],
      },
    }),
  );
  const item = record.commerceOrder!.lineItems[0]!;
  assert.equal(item.providerProductId, undefined);
  assert.equal(item.providerVariantId, undefined);
  assert.equal(item.name, 'Discontinued Widget', 'purchase history line item text is preserved even after the catalog entry is gone');
});

test('mapShopifyOrder: refunds are mapped as linked adjustments, never mutate the order total', () => {
  const record = mapShopifyOrder(
    baseOrder({
      refunds: [{ id: 'gid://shopify/Refund/1', createdAt: '2026-08-02T00:00:00Z', totalRefundedSet: { shopMoney: { amount: '5.00', currencyCode: 'BRL' } }, note: 'damaged' }],
    }),
  );
  assert.equal(record.commerceOrder!.refunds?.length, 1);
  assert.equal(record.commerceOrder!.refunds![0]!.amount, 5);
  assert.equal(record.commerceOrder!.totalAmount, 49.9, 'refund never rewrites the order total — separate adjustment');
});

test('mapShopifyRefundWebhook: refund-only payload uses FINANCIAL_STATUS_UNCHANGED sentinel (order status unknown from this payload shape)', () => {
  const record = mapShopifyRefundWebhook({
    id: '555',
    order_id: '1001',
    created_at: '2026-08-02T00:00:00Z',
    transactions: [{ amount: '5.00', currency: 'BRL' }],
  });
  assert.ok(record);
  assert.equal(record!.commerceOrder!.financialStatus, FINANCIAL_STATUS_UNCHANGED);
  assert.equal(record!.commerceOrder!.providerOrderId, 'gid://shopify/Order/1001');
  assert.equal(record!.commerceOrder!.refunds![0]!.amount, 5);
  assert.equal(record!.identifiers.length, 0, 'refund webhook carries no customer identity — order already has one on file');
});

test('mapShopifyRefundWebhook: no usable currency in the payload → safely skipped (null), never guesses', () => {
  const record = mapShopifyRefundWebhook({ id: '555', order_id: '1001', created_at: '2026-08-02T00:00:00Z' });
  assert.equal(record, null);
});
