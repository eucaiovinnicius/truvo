import { createHash } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { connectorDestinationWrites, customers, customerTraits } from '@truvo/db';
import { classifyFailure } from '@truvo/observability';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { AuditService } from '../audit/audit.service';
import { ConnectorConnectionService } from './connector-connection.service';
import { ConnectorRegistryService } from './connector-registry.service';
import type { ActivationEligibilityRule, DestinationWriteInput, DestinationWriteResult } from './contracts';

function deterministicId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('')).digest('hex').slice(0, 26)}`;
}

/**
 * Order 050 §"Destination writes" — idempotency key, correlation id, external
 * result id, retry classification, and an activation/exposure audit event (via the
 * existing `AuditService`) for every write. Duplicate `idempotencyKey` for the same
 * connection is detected BEFORE calling the adapter — never a second live call to
 * the provider for a write already recorded.
 */
@Injectable()
export class ConnectorDestinationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly connections: ConnectorConnectionService,
    private readonly registry: ConnectorRegistryService,
    private readonly audit: AuditService,
  ) {}

  async write(workspaceId: string, connectionId: string, input: DestinationWriteInput): Promise<DestinationWriteResult> {
    const [existing] = await this.db
      .select()
      .from(connectorDestinationWrites)
      .where(
        and(
          eq(connectorDestinationWrites.workspaceId, workspaceId),
          eq(connectorDestinationWrites.connectionId, connectionId),
          eq(connectorDestinationWrites.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing) {
      return { status: existing.status === 'sent' ? 'sent' : 'failed', externalResultId: existing.externalResultId ?? undefined, error: existing.error ?? undefined };
    }

    const { connection, credentials } = await this.connections.getConnectionWithCredentials(workspaceId, connectionId);
    const adapter = this.registry.getDestinationAdapter(connection.provider);
    if (!adapter) throw new BadRequestException(`provider '${connection.provider}' não tem DestinationAdapter registrado`);

    let result: DestinationWriteResult;
    const ineligible = adapter.definition.activationEligibility?.requiredForKinds.includes(input.kind)
      ? await this.checkEligibility(workspaceId, adapter.definition.activationEligibility, input)
      : null;
    if (ineligible) {
      result = ineligible;
    } else {
      try {
        result = await adapter.write(connection, credentials, input);
      } catch (err) {
        const failure = classifyFailure(err);
        result = { status: 'failed', retryable: failure.kind === 'transient', error: failure.reason };
      }
    }

    const id = deterministicId('cdw', workspaceId, connectionId, input.idempotencyKey);
    const [inserted] = await this.db
      .insert(connectorDestinationWrites)
      .values({
        workspaceId,
        id,
        connectionId,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId,
        kind: input.kind,
        status: result.status,
        externalResultId: result.externalResultId ?? null,
        retryable: result.retryable ?? null,
        error: result.error ?? null,
      })
      // Race safety: two concurrent callers with the SAME idempotencyKey — only one
      // wins the insert; the loser's in-flight provider call already happened (can't
      // be undone), but the persisted record of truth stays singular either way.
      .onConflictDoNothing({ target: [connectorDestinationWrites.workspaceId, connectorDestinationWrites.connectionId, connectorDestinationWrites.idempotencyKey] })
      .returning();

    await this.audit.record({
      workspaceId,
      category: 'connector',
      action: 'connector.activation_exposed',
      resourceType: 'connector_destination_write',
      resourceId: inserted?.id ?? id,
      metadata: { provider: connection.provider, kind: input.kind, status: result.status, correlation_id: input.correlationId },
    });

    return result;
  }

  /**
   * Order 063 §4 — fail-closed activation eligibility. Returns a `failed,
   * non-retryable` result when the write must be refused, or `null` when the
   * adapter should proceed. Deliberately reads the ALREADY-SYNCED
   * `customer_traits` row rather than making a live provider call mid-write —
   * the same freshness model every other canonical trait already uses — and
   * refuses fail-closed (never "unknown → allow") both when the customer's
   * canonical identity was privacy-erased and when consent was never observed.
   */
  private async checkEligibility(workspaceId: string, rule: ActivationEligibilityRule, input: DestinationWriteInput): Promise<DestinationWriteResult | null> {
    const customerId = input.payload.customerId as string | undefined;
    if (!customerId) return { status: 'failed', retryable: false, error: 'eligibility_missing_customer_id' };

    const [customerRow] = await this.db.select({ deletedAt: customers.deletedAt }).from(customers).where(and(eq(customers.workspaceId, workspaceId), eq(customers.id, customerId))).limit(1);
    if (!customerRow || customerRow.deletedAt) {
      return { status: 'failed', retryable: false, error: 'eligibility_customer_suppressed' };
    }

    const [traitRow] = await this.db
      .select({ value: customerTraits.value })
      .from(customerTraits)
      .where(and(eq(customerTraits.workspaceId, workspaceId), eq(customerTraits.customerId, customerId), eq(customerTraits.traitNamespace, rule.consentTraitNamespace), eq(customerTraits.traitKey, rule.consentTraitKey)))
      .limit(1);
    if (!traitRow || !rule.subscribedValues.includes(String(traitRow.value))) {
      return { status: 'failed', retryable: false, error: 'eligibility_not_subscribed' };
    }

    return null;
  }
}
