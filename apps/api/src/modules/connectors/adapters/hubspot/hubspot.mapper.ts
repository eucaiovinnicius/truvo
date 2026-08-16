import { sha256 } from '../../../events/crypto.util';
import { LEGACY_IDENTITY_NAMESPACE } from '../../../customer-context/customer-context.service';
import { HUBSPOT_PROVIDER } from './hubspot.constants';
import type {
  NormalizedCrmAccount,
  NormalizedCrmAssociation,
  NormalizedCrmDeal,
  NormalizedCrmDeletionSignal,
  NormalizedIdentifier,
  NormalizedRecord,
} from '../../contracts';

/**
 * Order 061 §2/§4 — pure translation from HubSpot's CRM object/webhook shapes into
 * provider-neutral canonical records. NO identity matching happens here (no
 * lookups, no DB) — that stays `IdentityGraphService`'s job via
 * `CanonicalMappingService`. This file only EMITS namespaced identifiers/CRM
 * data; it never resolves them.
 *
 * Email/phone hashes use `LEGACY_IDENTITY_NAMESPACE` — the SAME shared namespace
 * every other provider (Shopify, the legacy v1 bridge) uses for approved hashed
 * contact identifiers, so a HubSpot contact and a Shopify customer sharing the
 * SAME approved hashed email resolve to the SAME canonical customer. The HubSpot
 * contact ID itself stays provider-namespaced (`HUBSPOT_PROVIDER`).
 */

export interface HubspotObjectNode {
  id: string;
  properties: Record<string, string | null>;
  associations?: Record<string, { results: Array<{ id: string; type: string }> }>;
}

/** Only these properties are EVER imported as traits — the workspace's own
 * explicit selection (Order 061 §2), never an indiscriminate copy of every custom
 * property HubSpot happens to return. `email`/`phone` are handled separately (they
 * become identifiers, not traits) even if included in the selection. */
export type ConfiguredProperties = readonly string[];

/** HubSpot's `hs_lastmodifieddate`/`hs_createdate` (and their legacy aliases
 * `lastmodifieddate`/`createdate`) come back as a STRING containing epoch
 * MILLISECONDS (e.g. `"1735689600000"`), never an ISO string — `new Date(epochMs)`
 * needs the numeric form, not the raw string, or every downstream `new
 * Date(record.observedAt)` in `CanonicalMappingService` parses to `Invalid Date`. */
function observedAtFromProperties(properties: Record<string, string | null>): string {
  const raw = properties.hs_lastmodifieddate ?? properties.lastmodifieddate ?? properties.hs_createdate ?? properties.createdate;
  const epochMs = raw != null ? Number(raw) : NaN;
  return Number.isFinite(epochMs) ? new Date(epochMs).toISOString() : new Date(0).toISOString();
}

function pickTraits(properties: Record<string, string | null>, configured: ConfiguredProperties, exclude: readonly string[]) {
  return configured
    .filter((key) => !exclude.includes(key) && properties[key] != null)
    .map((key) => ({ traitNamespace: 'hubspot', traitKey: key, valueType: 'string' as const, value: properties[key]! }));
}

function contactIdentifiers(contactId: string, properties: Record<string, string | null>): NormalizedIdentifier[] {
  const identifiers: NormalizedIdentifier[] = [
    { providerNamespace: HUBSPOT_PROVIDER, identifierType: 'external_id', identifierValue: contactId },
  ];
  const email = properties.email?.trim().toLowerCase();
  if (email) identifiers.push({ providerNamespace: LEGACY_IDENTITY_NAMESPACE, identifierType: 'email_hash', identifierValue: sha256(email) });
  const phoneDigits = properties.phone?.replace(/[^\d]/g, '');
  if (phoneDigits) identifiers.push({ providerNamespace: LEGACY_IDENTITY_NAMESPACE, identifierType: 'phone_hash', identifierValue: sha256(phoneDigits) });
  return identifiers;
}

function associationsFrom(fromType: 'contact' | 'company' | 'deal', fromId: string, node: HubspotObjectNode): NormalizedCrmAssociation[] {
  const out: NormalizedCrmAssociation[] = [];
  const toType = (key: string): 'contact' | 'company' | 'deal' | null => {
    if (key === 'companies' || key === 'company') return 'company';
    if (key === 'contacts' || key === 'contact') return 'contact';
    if (key === 'deals' || key === 'deal') return 'deal';
    return null;
  };
  for (const [key, edge] of Object.entries(node.associations ?? {})) {
    const t = toType(key);
    if (!t || t === fromType) continue;
    for (const result of edge.results) {
      out.push({
        providerNamespace: HUBSPOT_PROVIDER,
        fromObjectType: fromType, fromProviderObjectId: fromId,
        toObjectType: t, toProviderObjectId: result.id,
        associationType: `${fromType}_to_${t}`,
      });
    }
  }
  return out;
}

/** Full contact object (backfill/incremental search result, or a `contact.creation`
 * webhook payload enriched with properties) → canonical record. */
export function mapHubspotContact(node: HubspotObjectNode, configured: ConfiguredProperties): NormalizedRecord {
  const associations = associationsFrom('contact', node.id, node);
  return {
    identifiers: contactIdentifiers(node.id, node.properties),
    traits: pickTraits(node.properties, configured, ['email', 'phone']),
    crmAssociations: associations.length > 0 ? associations : undefined,
    observedAt: observedAtFromProperties(node.properties),
  };
}

/** `contact.propertyChange` webhook — carries exactly ONE changed property (see
 * HubSpot's webhook payload shape). Never re-derives the contact's full property
 * set (the webhook doesn't carry it) — `CanonicalMappingService`/`CustomerContextService`
 * already treat individual trait writes as field-granular, so a single-property
 * update composes safely with whatever was known before. */
export function mapContactPropertyChangeWebhook(objectId: string, propertyName: string, propertyValue: string | null, occurredAtMs: number, configured: ConfiguredProperties): NormalizedRecord | null {
  const observedAt = new Date(occurredAtMs).toISOString();
  if (propertyName === 'email' || propertyName === 'phone') {
    const properties: Record<string, string | null> = { [propertyName]: propertyValue };
    return { identifiers: contactIdentifiers(objectId, properties), observedAt };
  }
  if (!configured.includes(propertyName) || propertyValue == null) {
    // Not a tracked property — still worth touching the contact's `lastSeenAt`
    // (identity signal), but no trait to write.
    return { identifiers: [{ providerNamespace: HUBSPOT_PROVIDER, identifierType: 'external_id', identifierValue: objectId }], observedAt };
  }
  return {
    identifiers: [{ providerNamespace: HUBSPOT_PROVIDER, identifierType: 'external_id', identifierValue: objectId }],
    traits: [{ traitNamespace: 'hubspot', traitKey: propertyName, valueType: 'string', value: propertyValue }],
    observedAt,
  };
}

/** Full company object → canonical record. */
export function mapHubspotCompany(node: HubspotObjectNode, configured: ConfiguredProperties): NormalizedRecord {
  const account: NormalizedCrmAccount = {
    providerNamespace: HUBSPOT_PROVIDER,
    providerObjectId: node.id,
    name: node.properties.name ?? undefined,
    traits: Object.fromEntries(pickTraits(node.properties, configured, ['name']).map((t) => [t.traitKey, t.value])),
  };
  const associations = associationsFrom('company', node.id, node);
  return { identifiers: [], crmAccount: account, crmAssociations: associations.length > 0 ? associations : undefined, observedAt: observedAtFromProperties(node.properties) };
}

/** `company.propertyChange` webhook — same single-property tolerance as contacts;
 * `CrmWriteService.upsertAccount` MERGES `traits` (never replaces wholesale), so
 * this partial update composes safely with a prior full sync. */
export function mapCompanyPropertyChangeWebhook(objectId: string, propertyName: string, propertyValue: string | null, occurredAtMs: number, configured: ConfiguredProperties): NormalizedRecord {
  const observedAt = new Date(occurredAtMs).toISOString();
  const isName = propertyName === 'name';
  const account: NormalizedCrmAccount = {
    providerNamespace: HUBSPOT_PROVIDER,
    providerObjectId: objectId,
    name: isName ? (propertyValue ?? undefined) : undefined,
    traits: !isName && configured.includes(propertyName) && propertyValue != null ? { [propertyName]: propertyValue } : {},
  };
  return { identifiers: [], crmAccount: account, observedAt };
}

/** Full deal object → canonical record. A deal is NOT a purchase by default —
 * outcome mapping is applied downstream (`CrmWriteService`), driven entirely by
 * workspace config, never inferred here. */
export function mapHubspotDeal(node: HubspotObjectNode, configured: ConfiguredProperties): NormalizedRecord {
  const p = node.properties;
  const deal: NormalizedCrmDeal = {
    providerNamespace: HUBSPOT_PROVIDER,
    providerObjectId: node.id,
    name: p.dealname ?? undefined,
    amount: p.amount != null && p.amount !== '' ? Number(p.amount) : undefined,
    currency: p.deal_currency_code ?? undefined,
    pipeline: p.pipeline ?? undefined,
    stage: p.dealstage ?? undefined,
    status: p.hs_is_closed_won === 'true' ? 'won' : p.hs_is_closed === 'true' ? 'lost' : 'open',
    dealTimestamp: observedAtFromProperties(p),
    traits: Object.fromEntries(pickTraits(p, configured, ['dealname', 'amount', 'deal_currency_code', 'pipeline', 'dealstage']).map((t) => [t.traitKey, t.value])),
  };
  const associations = associationsFrom('deal', node.id, node);
  return { identifiers: [], crmDeal: deal, crmAssociations: associations.length > 0 ? associations : undefined, observedAt: observedAtFromProperties(p) };
}

/** `deal.propertyChange` webhook — single-property tolerance; core fields the
 * event didn't mention stay `undefined` so `CrmWriteService.upsertDeal` preserves
 * whatever was already known instead of wiping it. */
export function mapDealPropertyChangeWebhook(objectId: string, propertyName: string, propertyValue: string | null, occurredAtMs: number, configured: ConfiguredProperties): NormalizedRecord {
  const observedAt = new Date(occurredAtMs).toISOString();
  const deal: NormalizedCrmDeal = {
    providerNamespace: HUBSPOT_PROVIDER,
    providerObjectId: objectId,
    dealTimestamp: observedAt,
    name: propertyName === 'dealname' ? (propertyValue ?? undefined) : undefined,
    amount: propertyName === 'amount' && propertyValue != null ? Number(propertyValue) : undefined,
    currency: propertyName === 'deal_currency_code' ? (propertyValue ?? undefined) : undefined,
    pipeline: propertyName === 'pipeline' ? (propertyValue ?? undefined) : undefined,
    stage: propertyName === 'dealstage' ? (propertyValue ?? undefined) : undefined,
    status: undefined,
    traits: !['dealname', 'amount', 'deal_currency_code', 'pipeline', 'dealstage'].includes(propertyName) && configured.includes(propertyName) && propertyValue != null ? { [propertyName]: propertyValue } : {},
  };
  return { identifiers: [], crmDeal: deal, observedAt };
}

/** `*.deletion` / `*.restore` / `contact.privacyDeletion` webhook → explicit
 * deletion signal (see `NormalizedCrmDeletionSignal` doc comment). */
export function mapDeletionWebhook(objectType: 'contact' | 'company' | 'deal', objectId: string, action: 'deleted' | 'restored' | 'privacy_deleted', occurredAtMs: number): NormalizedRecord {
  const signal: NormalizedCrmDeletionSignal = { objectType, providerNamespace: HUBSPOT_PROVIDER, providerObjectId: objectId, action, reason: `hubspot.${objectType}.${action === 'privacy_deleted' ? 'privacyDeletion' : action}` };
  return { identifiers: [], crmDeletion: signal, observedAt: new Date(occurredAtMs).toISOString() };
}
