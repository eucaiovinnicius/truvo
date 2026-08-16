import type {
  ConnectorConnectionRow,
  ConnectorCredentialStatus,
  ConnectorLifecycleState,
  ConnectorRole,
  CustomerIdentifierType,
  CustomerTraitValueType,
} from '@truvo/db';

export type { ConnectorRole, ConnectorCredentialStatus, ConnectorLifecycleState };

/**
 * Order 050 — CONNECTOR FRAMEWORK contracts.
 *
 * Provider-neutral by construction: nothing here names a real provider. Adapters
 * (Orders 60–63) implement `SourceAdapter`/`DestinationAdapter` against these types
 * only — the orchestrator, canonical mapping, retry/backoff, and idempotency logic
 * never change per-provider. `payload`/`config` fields are deliberately opaque
 * (`Record<string, unknown>`) so provider-specific data stays namespaced inside
 * them rather than leaking into the shared contract shape.
 */

export const CONNECTOR_CAPABILITIES = [
  'webhook_ingest',
  'initial_backfill',
  'incremental_pull',
  'outbound_profile',
  'outbound_audience',
  'outbound_event',
  'outbound_score',
  'outbound_action',
] as const;
export type ConnectorCapability = (typeof CONNECTOR_CAPABILITIES)[number];

export type ConnectorCredentialKind = 'oauth' | 'api_key';

/** Provider metadata + capabilities — a code-level manifest, not a DB row (mirrors
 * how EVENT_SOURCES/STANDARD_EVENTS are code constants, not tables). One definition
 * per provider; connections are workspace-scoped installations of a definition. */
export interface ConnectorDefinition {
  provider: string;
  displayName: string;
  role: ConnectorRole;
  capabilities: readonly ConnectorCapability[];
  credentialKind: ConnectorCredentialKind;
  /** Order 061 — named backfill/incremental streams this provider walks
   * independently (e.g. HubSpot's `['contacts', 'companies', 'deals']`, each with
   * its OWN checkpoint). Absent/omitted → the framework's single default stream
   * (`['default']`), same as Shopify (Order 060) — every existing single-stream
   * provider is unaffected. Both `ConnectorsController#triggerBackfill` and the
   * scheduler's `connector-incremental-sync` job iterate this list instead of
   * assuming one stream per connection — no second scheduler, no provider-specific
   * branch in either caller. */
  incrementalStreams?: readonly string[];
}

/** Workspace-scoped installation/configuration state — the public (non-secret) view of `connector_connections`. */
export type ConnectorConnection = Omit<ConnectorConnectionRow, 'credentialsEncrypted'>;

export interface ConnectionTestResult {
  ok: boolean;
  credentialStatus: ConnectorCredentialStatus;
  checks: Record<string, boolean>;
  message: string;
  /** Set only on a genuine auth failure (401/invalid token) — distinct from any
   * other permanent failure, since only THIS should ever downgrade credentialStatus. */
  authFailure?: boolean;
}

export interface SyncCheckpoint {
  streamKey: string;
  cursor: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed';
  processedCount: number;
}

/** A single canonical identifier the framework resolves/creates a customer from —
 * never matched by the adapter itself (no provider-specific identity heuristics). */
export interface NormalizedIdentifier {
  providerNamespace: string;
  identifierType: CustomerIdentifierType;
  identifierValue: string;
}

export interface NormalizedTrait {
  traitNamespace: string;
  traitKey: string;
  valueType: CustomerTraitValueType;
  value: unknown;
}

/** Order 060 — provider-neutral commerce order (see `packages/db/src/schema/commerce.ts`).
 * `providerLineItemId`/`providerRefundId` are the idempotency keys for their own
 * rows — the SAME order re-synced (backfill replay, webhook redelivery, an edited
 * order) upserts in place rather than duplicating. */
export interface NormalizedCommerceLineItem {
  providerLineItemId: string;
  providerProductId?: string;
  providerVariantId?: string;
  name: string;
  quantity: number;
  price: number;
  currency: string;
}

export interface NormalizedCommerceRefund {
  providerRefundId: string;
  amount: number;
  currency: string;
  refundedAt: string;
  reason?: string;
}

export interface NormalizedCommerceOrder {
  providerNamespace: string;
  providerOrderId: string;
  financialStatus: string;
  currency: string;
  totalAmount: number;
  orderTimestamp: string;
  lineItems: NormalizedCommerceLineItem[];
  refunds?: NormalizedCommerceRefund[];
}

/** Order 061 — provider-neutral CRM account/company (see `packages/db/src/schema/crm.ts`).
 * `traits` carries ONLY the workspace's explicitly configured/selected properties
 * — never an indiscriminate copy of every custom property (Order 061 §2). */
export interface NormalizedCrmAccount {
  providerNamespace: string;
  providerObjectId: string;
  name?: string;
  traits: Record<string, unknown>;
}

/** A HubSpot deal is NOT a purchase by default (Order 061 §4/§5) — this shape
 * carries the commercial-opportunity facts only; whether/which outcome it maps to
 * is a SEPARATE, explicit, workspace-configured decision applied downstream. */
export interface NormalizedCrmDeal {
  providerNamespace: string;
  providerObjectId: string;
  name?: string;
  amount?: number;
  currency?: string;
  pipeline?: string;
  stage?: string;
  status?: string;
  dealTimestamp: string;
  traits: Record<string, unknown>;
}

/** Contact↔Company / Contact↔Deal / Company↔Deal edge, still in PROVIDER object-id
 * space — `CrmWriteService` resolves both sides to their LOCAL canonical ids at
 * write time. Naturally idempotent/order-independent: re-synced from either side
 * in any page order, the SAME natural key converges (Order 061 §3). */
export interface NormalizedCrmAssociation {
  providerNamespace: string;
  fromObjectType: 'contact' | 'company' | 'deal';
  fromProviderObjectId: string;
  toObjectType: 'contact' | 'company' | 'deal';
  toProviderObjectId: string;
  associationType: string;
}

/**
 * Order 061 §6/§9 — "deletion/restoration behavior explicit." `deleted`/`restored`
 * mark the provider's OWN record lifecycle (e.g. a HubSpot user deleted/undeleted a
 * contact in their CRM) — visible, non-destructive (sets `deletedAt`, never drops a
 * row). `privacy_deleted` is a GENUINE subject-erasure signal (HubSpot's
 * `contact.privacyDeletion`, a GDPR/CCPA request) — routed to the EXISTING Order 55
 * `SuppressionService`, so the identifier can never silently reconstruct canonical
 * identity again, without reinventing a second suppression mechanism.
 */
export interface NormalizedCrmDeletionSignal {
  objectType: 'contact' | 'company' | 'deal';
  providerNamespace: string;
  providerObjectId: string;
  action: 'deleted' | 'restored' | 'privacy_deleted';
  reason?: string;
}

/**
 * One provider object translated into canonical shape — the ONLY thing an adapter
 * hands back for identity/trait/commerce/CRM resolution. `identifiers` may be EMPTY
 * for a genuinely anonymous commerce record (Order 060 §8: "guest checkout without
 * Shopify customer") — the order still gets recorded, unattached
 * (`commerce_orders.customer_id IS NULL`), until a later signal identifies the
 * guest and the SAME order (matched by `providerOrderId`) gets re-attached. It may
 * ALSO be empty for a `crmAccount`/`crmDeal`-only record (Order 061: a HubSpot
 * company or deal is not itself a person Identity Graph v2 resolves).
 */
export interface NormalizedRecord {
  identifiers: NormalizedIdentifier[];
  traits?: NormalizedTrait[];
  commerceOrder?: NormalizedCommerceOrder;
  crmAccount?: NormalizedCrmAccount;
  crmDeal?: NormalizedCrmDeal;
  crmAssociations?: NormalizedCrmAssociation[];
  crmDeletion?: NormalizedCrmDeletionSignal;
  observedAt: string;
}

export interface SourcePullResult {
  records: NormalizedRecord[];
  /** Opaque high-water mark to resume from on the NEXT call (backfill continuation
   * or the next incremental pull) — always set, even once caught up. `hasMore` is
   * the separate signal for whether the orchestrator should keep paginating now. */
  nextCursor: string | null;
  hasMore: boolean;
}

export interface RawWebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody?: Buffer;
  /** Provider-assigned delivery/event id — the idempotency key for "duplicate
   * delivery must be harmless." Adapters must extract a stable one when possible. */
  deliveryId?: string;
  /** Order 061 — the exact registered callback URL/method, needed by signature
   * schemes that sign over the request line itself (HubSpot webhook signature v3:
   * `METHOD + URL + BODY + TIMESTAMP`). Optional — only providers that need it
   * (mirrors the SAME `requestUrl` construction `webhooks.service.ts`'s legacy M4
   * HubSpot path already does) read it; Shopify's HMAC never touches it. */
  url?: string;
  method?: string;
}

export interface DestinationWriteInput {
  idempotencyKey: string;
  correlationId: string;
  kind: string;
  payload: Record<string, unknown>;
}

export interface DestinationWriteResult {
  status: 'sent' | 'failed';
  externalResultId?: string;
  retryable?: boolean;
  error?: string;
}

/** Order 061 §1 — minimal, provider-neutral OAuth code→token exchange hook. Only
 * providers with `credentialKind: 'oauth'` implement it; `api_key` providers
 * (Shopify) never do. Kept OUT of `testConnection` (which validates an ALREADY-
 * stored credential) — this is the one-time authorization-code redemption step. */
export interface OAuthAuthorizeUrlResult {
  url: string;
}
export interface OAuthExchangeInput {
  code: string;
  redirectUri: string;
}
export interface OAuthExchangeResult {
  /** Opaque credential bag — stored via the SAME `ConnectorConnectionService.setCredentials`
   * secret handling every other provider uses; never returned to the client. */
  credentials: Record<string, unknown>;
  /** Immutable connection metadata (e.g. portal/account id) — merged into `connection.config`. */
  connectionMetadata?: Record<string, unknown>;
}

export interface SourceAdapter {
  definition: ConnectorDefinition;
  testConnection(connection: ConnectorConnection, credentials: Record<string, unknown>): Promise<ConnectionTestResult>;
  initialBackfill?(
    connection: ConnectorConnection,
    credentials: Record<string, unknown>,
    checkpoint: SyncCheckpoint,
  ): Promise<SourcePullResult>;
  incrementalPull?(
    connection: ConnectorConnection,
    credentials: Record<string, unknown>,
    checkpoint: SyncCheckpoint,
  ): Promise<SourcePullResult>;
  verifyWebhook?(connection: ConnectorConnection, credentials: Record<string, unknown>, request: RawWebhookRequest): boolean;
  normalizeWebhook?(connection: ConnectorConnection, request: RawWebhookRequest): NormalizedRecord[] | null;
  getOAuthAuthorizeUrl?(connection: ConnectorConnection, redirectUri: string): OAuthAuthorizeUrlResult;
  exchangeOAuthCode?(connection: ConnectorConnection, input: OAuthExchangeInput): Promise<OAuthExchangeResult>;
}

export interface DestinationAdapter {
  definition: ConnectorDefinition;
  testConnection(connection: ConnectorConnection, credentials: Record<string, unknown>): Promise<ConnectionTestResult>;
  write(
    connection: ConnectorConnection,
    credentials: Record<string, unknown>,
    input: DestinationWriteInput,
  ): Promise<DestinationWriteResult>;
}
