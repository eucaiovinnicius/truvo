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
  /** Order 063 — an opt-in, provider-declared gate `ConnectorDestinationService`
   * enforces BEFORE calling `DestinationAdapter.write()` for the listed `kind`s.
   * Absent on every prior provider (HubSpot/Stripe/Shopify never declare it) —
   * zero behavior change for them. Klaviyo is the first to need it: "any Truvo
   * custom event intended to trigger a messaging flow must pass current provider
   * + Truvo eligibility rules before dispatch" (§4). Kept generic/provider-neutral
   * rather than hard-coded to Klaviyo so a future messaging destination can reuse
   * the same mechanism without another framework change. */
  activationEligibility?: ActivationEligibilityRule;
}

/** Order 063 §4 — "provider subscription state is activation eligibility context,
 * not permission invented by Truvo" + "Truvo privacy suppression remains
 * fail-closed." `ConnectorDestinationService.write()` reads the ALREADY-SYNCED
 * `customer_traits` row (never a live re-fetch mid-write — same freshness model
 * every other canonical trait uses) and blocks fail-closed when the trait is
 * absent, unknown, or not in `subscribedValues`. It also refuses a write for any
 * customer whose canonical identity was privacy-erased (`customers.deletedAt`),
 * covering the "Truvo eligibility rules" half of §4 without a second suppression
 * mechanism. */
export interface ActivationEligibilityRule {
  /** `DestinationWriteInput.kind` values this rule gates — e.g. `['custom_event']`.
   * A kind NOT listed here (e.g. Klaviyo's own `'profile_upsert'`) is never gated:
   * "profile trait writeback may update non-messaging metadata without implying
   * consent" (§4). */
  requiredForKinds: readonly string[];
  consentTraitNamespace: string;
  consentTraitKey: string;
  /** Raw provider consent values that count as "eligible to receive messaging." */
  subscribedValues: readonly string[];
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

/** Order 062 — provider-neutral billing facts. These are intentionally separate
 * from commerce orders: a recurring invoice/payment is billing context, not an
 * ecommerce purchase by default. Provider ids remain the replay-safe natural keys. */
export interface NormalizedBillingSubscription {
  providerNamespace: string;
  providerSubscriptionId: string;
  providerCustomerId?: string;
  status: string;
  productReference?: string;
  priceReference?: string;
  quantity?: number;
  startedAt?: string;
  trialStartAt?: string;
  trialEndAt?: string;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  cancelAt?: string;
  cancelledAt?: string;
  endedAt?: string;
  collectionMethod?: string;
  paymentBehavior?: string;
  sourceUpdatedAt: string;
}

export interface NormalizedBillingInvoice {
  providerNamespace: string;
  providerInvoiceId: string;
  providerCustomerId?: string;
  providerSubscriptionId?: string;
  status: string;
  currency: string;
  amountDue?: number;
  amountPaid?: number;
  amountRemaining?: number;
  createdAt?: string;
  finalizedAt?: string;
  paidAt?: string;
  voidedAt?: string;
  uncollectibleAt?: string;
  sourceUpdatedAt: string;
}

export interface NormalizedBillingPayment {
  providerNamespace: string;
  providerPaymentId: string;
  providerCustomerId?: string;
  providerSubscriptionId?: string;
  providerInvoiceId?: string;
  status: string;
  amount: number;
  currency: string;
  failureCode?: string;
  failureMessage?: string;
  succeededAt?: string;
  failedAt?: string;
  sourceUpdatedAt: string;
}

export interface NormalizedBillingAdjustment {
  providerNamespace: string;
  providerAdjustmentId: string;
  providerCustomerId?: string;
  providerPaymentId?: string;
  providerInvoiceId?: string;
  status: string;
  amount: number;
  currency: string;
  occurredAt: string;
  sourceUpdatedAt: string;
}

/** Order 063 — a provider-attributed canonical ENGAGEMENT observation (email/SMS
 * delivery, open, click, bounce, unsubscribe, or a Truvo-originated custom event
 * read back through the normal source path). Deliberately separate from
 * `NormalizedTrait`/outcomes: an engagement event is an immutable append-only
 * fact ("this profile opened this message at this time"), never upserted-in-place
 * the way a mutable trait/billing row is. `providerEventId` is the sole natural
 * key — insert-once, never updated (Order 063 §7 "duplicate engagement event").
 */
export interface NormalizedEngagementEvent {
  providerNamespace: string;
  providerEventId: string;
  metricName: string;
  engagementKind: 'received' | 'delivery' | 'opened' | 'clicked' | 'bounced' | 'unsubscribed' | 'marked_spam' | 'other';
  campaignId?: string;
  flowId?: string;
  /** Set ONLY when deterministic evidence exists — e.g. this is Truvo's OWN custom
   * event read back through the source path, carrying the SAME `activation_id`
   * Truvo itself wrote when creating it (Order 063 §7: "do not fabricate
   * attribution when correlation evidence is absent"). */
  correlationId?: string;
  occurredAt: string;
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
 * Order 061 (association + contract closure) — declares that `crmAssociations`
 * (filtered to `fromObjectType`/one of `toObjectTypes`) represents the COMPLETE
 * current set of edges the provider reports for this object, as of `observedAt` —
 * i.e. this came from a full object fetch (backfill/incremental reconciliation),
 * not a partial webhook update. Only when this is present does
 * `CrmWriteService` RECONCILE (upsert current + tombstone active edges now
 * absent) instead of purely additively upserting — a record with associations
 * but no scope (none currently exist — webhooks never carry associations) stays
 * additive-only, a safe default for any future partial-association source.
 */
export interface NormalizedCrmAssociationScope {
  providerNamespace: string;
  fromObjectType: 'contact' | 'company' | 'deal';
  fromProviderObjectId: string;
  toObjectTypes: readonly ('contact' | 'company' | 'deal')[];
  observedAt: string;
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
  billingSubscription?: NormalizedBillingSubscription;
  billingInvoice?: NormalizedBillingInvoice;
  billingPayment?: NormalizedBillingPayment;
  billingAdjustment?: NormalizedBillingAdjustment;
  engagementEvent?: NormalizedEngagementEvent;
  crmAccount?: NormalizedCrmAccount;
  crmDeal?: NormalizedCrmDeal;
  crmAssociations?: NormalizedCrmAssociation[];
  crmAssociationScope?: NormalizedCrmAssociationScope;
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
  /** Order 063 — when the destination adapter's `ConnectorDefinition.activationEligibility.requiredForKinds`
   * includes this write's `kind`, `payload.customerId` (Truvo's own canonical
   * customer id, NOT a provider object id) MUST be present — it is how
   * `ConnectorDestinationService.write()` looks up the eligibility-gating trait
   * and erasure state before ever calling the adapter. Every other kind/provider
   * ignores this convention entirely. */
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
  state?: string;
}
export interface OAuthExchangeResult {
  /** Opaque credential bag — stored via the SAME `ConnectorConnectionService.setCredentials`
   * secret handling every other provider uses; never returned to the client. */
  credentials: Record<string, unknown>;
  /** Immutable connection metadata (e.g. portal/account id) — merged into `connection.config`. */
  connectionMetadata?: Record<string, unknown>;
}

/**
 * Provider-neutral OAuth refresh seam.  The Connector Framework owns encrypted
 * persistence and connection-scoped locking; an adapter owns only its provider's
 * refresh grant.  Keeping that boundary here prevents each OAuth provider from
 * inventing a second credential store or a process-local refresh lock.
 */
export interface OAuthRefreshAdapter {
  /** True when the persisted credential should be renewed before the next call. */
  shouldRefreshOAuthCredentials(credentials: Record<string, unknown>): boolean;
  /** Exchanges the current credential for its replacement. Must not mutate input. */
  refreshOAuthCredentials(connection: ConnectorConnection, credentials: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Invalid/revoked refresh credentials need an explicit new authorization. */
  isOAuthRefreshReauthorizationFailure?(error: unknown): boolean;
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
  oauthRefresh?: OAuthRefreshAdapter;
  /** Optional provider revocation hook. It is deliberately separate from a sync
   * failure: revoked authorization invalidates credentials, whereas a 5xx does not. */
  deauthorize?(connection: ConnectorConnection, credentials: Record<string, unknown>): Promise<void>;
  isAuthorizationRevokedWebhook?(connection: ConnectorConnection, request: RawWebhookRequest): boolean;
}

export interface DestinationAdapter {
  definition: ConnectorDefinition;
  testConnection(connection: ConnectorConnection, credentials: Record<string, unknown>): Promise<ConnectionTestResult>;
  write(
    connection: ConnectorConnection,
    credentials: Record<string, unknown>,
    input: DestinationWriteInput,
  ): Promise<DestinationWriteResult>;
  oauthRefresh?: OAuthRefreshAdapter;
}
