/**
 * ORDER 130 — Acceptance Proof: CONNECTOR FIXTURES
 * Verifies sanitized fixtures, absence of secrets, source -> canonical mapping,
 * and safe handling of invalid/incompatible payloads for Shopify, Stripe, HubSpot, Klaviyo.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { LEGACY_IDENTITY_NAMESPACE } from '../customer-context/customer-context.service';
import { SHOPIFY_PROVIDER } from '../connectors/adapters/shopify/shopify.constants';
import { mapShopifyOrder } from '../connectors/adapters/shopify/shopify.mapper';
import { STRIPE_PROVIDER } from '../connectors/adapters/stripe/stripe.constants';
import {
  mapStripeCustomer,
  mapStripeInvoice,
  mapStripeSubscription,
} from '../connectors/adapters/stripe/stripe.mapper';
import { HUBSPOT_PROVIDER } from '../connectors/adapters/hubspot/hubspot.constants';
import { mapHubspotContact, mapHubspotDeal } from '../connectors/adapters/hubspot/hubspot.mapper';
import { KLAVIYO_PROVIDER } from '../connectors/adapters/klaviyo/klaviyo.constants';
import { mapKlaviyoEvent, mapKlaviyoProfile } from '../connectors/adapters/klaviyo/klaviyo.mapper';
import {
  assertNoSecrets,
  HUBSPOT_CONTACT_VALID,
  HUBSPOT_DEAL_VALID,
  HUBSPOT_PAYLOAD_INVALID,
  KLAVIYO_EVENT_DELIVERED_VALID,
  KLAVIYO_PAYLOAD_INVALID,
  KLAVIYO_PROFILE_VALID,
  SHOPIFY_ORDER_INVALID,
  SHOPIFY_ORDER_VALID,
  STRIPE_CUSTOMER_VALID,
  STRIPE_INVOICE_VALID,
  STRIPE_PAYLOAD_INVALID,
  STRIPE_SUBSCRIPTION_VALID,
} from './fixtures/connector-fixtures';

test('CONNECTOR FIXTURES: zero secrets, tokens, or live credentials across all fixtures', () => {
  assertNoSecrets(SHOPIFY_ORDER_VALID, 'SHOPIFY_ORDER_VALID');
  assertNoSecrets(SHOPIFY_ORDER_INVALID, 'SHOPIFY_ORDER_INVALID');
  assertNoSecrets(STRIPE_CUSTOMER_VALID, 'STRIPE_CUSTOMER_VALID');
  assertNoSecrets(STRIPE_SUBSCRIPTION_VALID, 'STRIPE_SUBSCRIPTION_VALID');
  assertNoSecrets(STRIPE_INVOICE_VALID, 'STRIPE_INVOICE_VALID');
  assertNoSecrets(STRIPE_PAYLOAD_INVALID, 'STRIPE_PAYLOAD_INVALID');
  assertNoSecrets(HUBSPOT_CONTACT_VALID, 'HUBSPOT_CONTACT_VALID');
  assertNoSecrets(HUBSPOT_DEAL_VALID, 'HUBSPOT_DEAL_VALID');
  assertNoSecrets(HUBSPOT_PAYLOAD_INVALID, 'HUBSPOT_PAYLOAD_INVALID');
  assertNoSecrets(KLAVIYO_PROFILE_VALID, 'KLAVIYO_PROFILE_VALID');
  assertNoSecrets(KLAVIYO_EVENT_DELIVERED_VALID, 'KLAVIYO_EVENT_DELIVERED_VALID');
  assertNoSecrets(KLAVIYO_PAYLOAD_INVALID, 'KLAVIYO_PAYLOAD_INVALID');
});

test('CONNECTOR FIXTURES: Shopify source -> canonical transformation', () => {
  const record = mapShopifyOrder(SHOPIFY_ORDER_VALID);

  // Identifiers
  const externalId = record.identifiers.find((i) => i.identifierType === 'external_id');
  assert.equal(externalId?.providerNamespace, SHOPIFY_PROVIDER);
  assert.equal(externalId?.identifierValue, 'gid://shopify/Customer/8001');

  const emailHash = record.identifiers.find((i) => i.identifierType === 'email_hash');
  assert.equal(emailHash?.providerNamespace, LEGACY_IDENTITY_NAMESPACE);
  assert.notEqual(emailHash?.identifierValue, 'clara.compra@example.invalid', 'Must be hashed');

  // Commerce Order
  assert.ok(record.commerceOrder);
  assert.equal(record.commerceOrder?.providerOrderId, 'gid://shopify/Order/7001');
  assert.equal(record.commerceOrder?.currency, 'BRL');
  assert.equal(record.commerceOrder?.totalAmount, 599.9);
  assert.equal(record.commerceOrder?.financialStatus, 'paid');
  assert.equal(record.commerceOrder?.lineItems.length, 1);
  assert.equal(record.commerceOrder?.lineItems[0]!.name, 'Tênis Running Pro Carbon');
});

test('CONNECTOR FIXTURES: Stripe source -> canonical transformation', () => {
  const custRecord = mapStripeCustomer(STRIPE_CUSTOMER_VALID);
  const custExternalId = custRecord.identifiers.find((i) => i.identifierType === 'external_id');
  assert.equal(custExternalId?.providerNamespace, STRIPE_PROVIDER);
  assert.equal(custExternalId?.identifierValue, 'cus_demo_rodrigo_001');

  const subRecord = mapStripeSubscription(STRIPE_SUBSCRIPTION_VALID);
  assert.ok(subRecord.billingSubscription);
  assert.equal(subRecord.billingSubscription?.providerNamespace, STRIPE_PROVIDER);
  assert.equal(subRecord.billingSubscription?.providerSubscriptionId, 'sub_demo_rodrigo_starter_001');
  assert.equal(subRecord.billingSubscription?.status, 'active');
  assert.equal(subRecord.billingSubscription?.providerCustomerId, 'cus_demo_rodrigo_001');

  const invRecord = mapStripeInvoice(STRIPE_INVOICE_VALID);
  assert.ok(invRecord.billingInvoice);
  assert.equal(invRecord.billingInvoice?.providerInvoiceId, 'in_demo_rodrigo_001');
  assert.equal(invRecord.billingInvoice?.status, 'paid');
  assert.equal(invRecord.billingInvoice?.amountPaid, 99.00);
});

test('CONNECTOR FIXTURES: HubSpot source -> canonical transformation', () => {
  const contactRecord = mapHubspotContact(HUBSPOT_CONTACT_VALID, ['lifecyclestage', 'hs_lead_status']);
  const contactId = contactRecord.identifiers.find((i) => i.identifierType === 'external_id');
  assert.equal(contactId?.providerNamespace, HUBSPOT_PROVIDER);
  assert.equal(contactId?.identifierValue, 'hs_contact_demo_001');

  const emailHash = contactRecord.identifiers.find((i) => i.identifierType === 'email_hash');
  assert.equal(emailHash?.providerNamespace, LEGACY_IDENTITY_NAMESPACE);

  const lifecycleTrait = contactRecord.traits.find((t) => t.traitKey === 'lifecyclestage');
  assert.equal(lifecycleTrait?.value, 'lead');

  const dealRecord = mapHubspotDeal(HUBSPOT_DEAL_VALID, ['dealname', 'amount', 'dealstage']);
  assert.ok(dealRecord.crmDeal);
  assert.equal(dealRecord.crmDeal?.providerObjectId, 'hs_deal_demo_001');
  assert.equal(dealRecord.crmDeal?.name, 'Upgrade Enterprise Clara');
  assert.equal(dealRecord.crmDeal?.amount, 2490.00);
});

test('CONNECTOR FIXTURES: Klaviyo source -> canonical transformation', () => {
  const profileRecord = mapKlaviyoProfile(KLAVIYO_PROFILE_VALID, ['vip_tier', 'preferred_category']);
  const profileId = profileRecord.identifiers.find((i) => i.identifierType === 'external_id');
  assert.equal(profileId?.providerNamespace, KLAVIYO_PROVIDER);
  assert.equal(profileId?.identifierValue, 'klaviyo_prof_demo_001');

  const tierTrait = profileRecord.traits.find((t) => t.traitKey === 'vip_tier');
  assert.equal(tierTrait?.value, 'gold');

  const emailConsent = profileRecord.traits.find((t) => t.traitKey === 'email_marketing_consent');
  assert.equal(emailConsent?.value, 'SUBSCRIBED');

  const metricMap = new Map([
    ['metric_delivered', { id: 'metric_delivered', attributes: { name: 'Delivered' } }],
  ]);
  const klaviyoEventNode = {
    type: 'event',
    id: KLAVIYO_EVENT_DELIVERED_VALID.id,
    attributes: {
      timestamp: KLAVIYO_EVENT_DELIVERED_VALID.attributes.timestamp,
      event_properties: KLAVIYO_EVENT_DELIVERED_VALID.attributes.event_properties,
    },
    relationships: {
      metric: { data: { id: 'metric_delivered' } },
      profile: { data: { id: 'klaviyo_prof_demo_001' } },
    },
  };
  const eventRecord = mapKlaviyoEvent(klaviyoEventNode, metricMap, 'Truvo Custom Event');
  assert.ok(eventRecord.engagementEvent);
  assert.equal(eventRecord.engagementEvent?.providerNamespace, KLAVIYO_PROVIDER);
  assert.equal(eventRecord.engagementEvent?.metricName, 'Delivered');
  assert.equal(eventRecord.engagementEvent?.engagementKind, 'delivery');
});

test('CONNECTOR FIXTURES: invalid/incompatible payloads are handled safely without crash', () => {
  // 1. Shopify invalid order
  assert.throws(
    () => mapShopifyOrder(SHOPIFY_ORDER_INVALID as never),
    (err: Error) => {
      assert.ok(err instanceof Error);
      return true;
    },
  );

  // 2. Stripe invalid payload missing id is rejected at adapter boundary
  assert.throws(
    () => mapStripeSubscription(STRIPE_PAYLOAD_INVALID),
    (err: Error) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /missing required id/i);
      return true;
    },
  );

  // 3. HubSpot invalid node
  const hubspotResult = mapHubspotContact(HUBSPOT_PAYLOAD_INVALID as never, []);
  assert.ok(hubspotResult);
  assert.equal(hubspotResult.observedAt, new Date(0).toISOString());

  // 4. Klaviyo invalid node
  const klaviyoResult = mapKlaviyoProfile(KLAVIYO_PAYLOAD_INVALID as never, []);
  assert.ok(klaviyoResult);
  assert.equal(klaviyoResult.identifiers.length, 1);
  assert.equal(klaviyoResult.identifiers[0]!.identifierValue, 'klaviyo_empty');
});
