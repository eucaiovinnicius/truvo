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

/**
 * One provider object translated into canonical shape — the ONLY thing an adapter
 * hands back for identity/trait/commerce resolution. `identifiers` may be EMPTY
 * for a genuinely anonymous commerce record (Order 060 §8: "guest checkout without
 * Shopify customer") — the order still gets recorded, unattached
 * (`commerce_orders.customer_id IS NULL`), until a later signal identifies the
 * guest and the SAME order (matched by `providerOrderId`) gets re-attached.
 */
export interface NormalizedRecord {
  identifiers: NormalizedIdentifier[];
  traits?: NormalizedTrait[];
  commerceOrder?: NormalizedCommerceOrder;
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
