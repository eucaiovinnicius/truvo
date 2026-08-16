import assert from 'node:assert/strict';
import test from 'node:test';
import { LEGACY_IDENTITY_NAMESPACE } from '../../../customer-context/customer-context.service';
import { HUBSPOT_PROVIDER } from './hubspot.constants';
import {
  mapCompanyPropertyChangeWebhook,
  mapContactPropertyChangeWebhook,
  mapDealPropertyChangeWebhook,
  mapDeletionWebhook,
  mapHubspotCompany,
  mapHubspotContact,
  mapHubspotDeal,
  type HubspotObjectNode,
} from './hubspot.mapper';

/** Order 061 §2/§4 — pure mapper proofs: contact/company/deal identity & namespace
 * split, configured-property-only trait selection, associations, deal-is-not-a-
 * purchase-by-default, and partial (webhook) property-change tolerance. */

test('mapHubspotContact/mapHubspotDeal: observedAt/dealTimestamp is a real ISO string, not the raw epoch-ms property string', () => {
  const epochMs = 1735689600000;
  const contact = mapHubspotContact({ id: '1', properties: { hs_lastmodifieddate: String(epochMs) } }, []);
  assert.equal(contact.observedAt, new Date(epochMs).toISOString());
  assert.ok(!Number.isNaN(new Date(contact.observedAt).getTime()), 'must be parseable by new Date(...) downstream (CanonicalMappingService does exactly this)');

  const deal = mapHubspotDeal({ id: '2', properties: { hs_lastmodifieddate: String(epochMs) } }, []);
  assert.equal(deal.crmDeal?.dealTimestamp, new Date(epochMs).toISOString());
});

test('mapHubspotContact: identified contact emits provider-namespaced GID + shared-namespace email/phone hashes', () => {
  const node: HubspotObjectNode = { id: '2001', properties: { email: 'Jane.Doe@Example.com', phone: '+1 (555) 123-4567', lifecyclestage: 'lead', hs_lastmodifieddate: '1735689600000' } };
  const record = mapHubspotContact(node, ['lifecyclestage']);
  const gid = record.identifiers.find((i) => i.identifierType === 'external_id');
  assert.equal(gid?.providerNamespace, HUBSPOT_PROVIDER);
  assert.equal(gid?.identifierValue, '2001');
  const emailHash = record.identifiers.find((i) => i.identifierType === 'email_hash');
  assert.equal(emailHash?.providerNamespace, LEGACY_IDENTITY_NAMESPACE, 'hashed contact identifiers use the SHARED cross-provider namespace');
  assert.notEqual(emailHash?.identifierValue, 'jane.doe@example.com', 'never emits raw PII');
});

test('mapHubspotContact: only CONFIGURED properties become traits — never an indiscriminate copy', () => {
  const node: HubspotObjectNode = { id: '2002', properties: { email: null, lifecyclestage: 'customer', secret_internal_field: 'should_not_leak', hs_lastmodifieddate: '1735689600000' } };
  const record = mapHubspotContact(node, ['lifecyclestage']);
  assert.equal(record.traits?.length, 1);
  assert.equal(record.traits?.[0]?.traitKey, 'lifecyclestage');
  assert.ok(!record.traits?.some((t) => t.traitKey === 'secret_internal_field'), 'unconfigured properties must never become traits');
});

test('mapHubspotContact: no email/phone → identifiers has only the external_id (no fabricated hash)', () => {
  const node: HubspotObjectNode = { id: '2003', properties: {} };
  const record = mapHubspotContact(node, []);
  assert.equal(record.identifiers.length, 1);
  assert.equal(record.identifiers[0]!.identifierType, 'external_id');
});

test('mapHubspotContact: contact→company association is emitted with LOCAL-space provider ids', () => {
  const node: HubspotObjectNode = { id: '2004', properties: {}, associations: { companies: { results: [{ id: '9001', type: 'contact_to_company' }] } } };
  const record = mapHubspotContact(node, []);
  assert.equal(record.crmAssociations?.length, 1);
  assert.equal(record.crmAssociations![0]!.fromObjectType, 'contact');
  assert.equal(record.crmAssociations![0]!.toObjectType, 'company');
  assert.equal(record.crmAssociations![0]!.toProviderObjectId, '9001');
});

test('mapHubspotCompany: no identifiers (a company is not a person) — carries crmAccount only', () => {
  const node: HubspotObjectNode = { id: '9001', properties: { name: 'Acme Inc', industry: 'software' } };
  const record = mapHubspotCompany(node, ['industry']);
  assert.equal(record.identifiers.length, 0);
  assert.equal(record.crmAccount?.name, 'Acme Inc');
  assert.deepEqual(record.crmAccount?.traits, { industry: 'software' });
});

test('mapHubspotDeal: a deal is NOT a purchase by default — no outcome-related field exists on the normalized shape', () => {
  const node: HubspotObjectNode = { id: '5001', properties: { dealname: 'Acme renewal', amount: '1200.50', deal_currency_code: 'USD', dealstage: 'closedwon', pipeline: 'default', hs_lastmodifieddate: '1735689600000' } };
  const record = mapHubspotDeal(node, []);
  assert.equal(record.crmDeal?.stage, 'closedwon');
  assert.equal(record.crmDeal?.amount, 1200.5);
  assert.equal(record.crmDeal?.currency, 'USD');
  // no `outcome`/`purchase` field anywhere on the deal shape — mapping is a SEPARATE, workspace-configured step.
  assert.ok(!('outcome' in (record.crmDeal as object)));
});

test('mapHubspotDeal: deal→contact and deal→company associations both emitted', () => {
  const node: HubspotObjectNode = {
    id: '5002',
    properties: { hs_lastmodifieddate: '1735689600000' },
    associations: { contacts: { results: [{ id: '2001', type: 'deal_to_contact' }] }, companies: { results: [{ id: '9001', type: 'deal_to_company' }] } },
  };
  const record = mapHubspotDeal(node, []);
  const types = record.crmAssociations!.map((a) => a.toObjectType).sort();
  assert.deepEqual(types, ['company', 'contact']);
});

test('mapContactPropertyChangeWebhook: single-property update carries ONLY that property as a trait', () => {
  const record = mapContactPropertyChangeWebhook('2001', 'lifecyclestage', 'customer', 1735689600000, ['lifecyclestage', 'industry']);
  assert.equal(record?.traits?.length, 1);
  assert.equal(record?.traits?.[0]?.traitKey, 'lifecyclestage');
  assert.equal(record?.traits?.[0]?.value, 'customer');
});

test('mapContactPropertyChangeWebhook: email property change re-derives the identity hash', () => {
  const record = mapContactPropertyChangeWebhook('2001', 'email', 'new@example.com', 1735689600000, []);
  const emailHash = record?.identifiers.find((i) => i.identifierType === 'email_hash');
  assert.ok(emailHash, 'an email property change must re-derive the hashed identifier');
});

test('mapDealPropertyChangeWebhook: only the changed field is set — every other core field is undefined (preserve-on-conflict)', () => {
  const record = mapDealPropertyChangeWebhook('5001', 'dealstage', 'closedwon', 1735689600000, []);
  assert.equal(record.crmDeal?.stage, 'closedwon');
  assert.equal(record.crmDeal?.amount, undefined, 'amount must stay unset — a stage-only webhook never knows the amount');
  assert.equal(record.crmDeal?.currency, undefined);
  assert.equal(record.crmDeal?.name, undefined);
});

test('mapDeletionWebhook: privacy deletion is a distinct action from a routine deletion', () => {
  const routine = mapDeletionWebhook('contact', '2001', 'deleted', 1735689600000);
  const privacy = mapDeletionWebhook('contact', '2001', 'privacy_deleted', 1735689600000);
  assert.equal(routine.crmDeletion?.action, 'deleted');
  assert.equal(privacy.crmDeletion?.action, 'privacy_deleted');
  assert.notEqual(routine.crmDeletion?.reason, privacy.crmDeletion?.reason);
});

test('mapCompanyPropertyChangeWebhook: unconfigured property is dropped, never leaks into traits', () => {
  const record = mapCompanyPropertyChangeWebhook('9001', 'unconfigured_field', 'value', 1735689600000, ['industry']);
  assert.deepEqual(record.crmAccount?.traits, {});
});
