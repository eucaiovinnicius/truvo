import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { identitySuppressions, type CustomerIdentifierType } from '@truvo/db';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { assertNamespace } from './customer-context.contracts';

export interface SuppressionRef {
  providerNamespace: string;
  identifierType: CustomerIdentifierType;
  identifierValue: string;
}

function deterministicId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('')).digest('hex').slice(0, 26)}`;
}

/**
 * Order 055 §3 — SUPPRESSION / TOMBSTONE AGAINST RECONSTRUCTION.
 *
 * The single source of truth consulted by every write path that could otherwise
 * re-attach/re-create canonical identity for an identifier that belonged to a
 * deleted subject: `CustomerContextService.synchronizeLegacyIdentity` (v1
 * `identify()` bridge — and `IdentityService.identify()` itself, for its OWN v1
 * `identity_links` write), and `IdentityGraphService.attachIdentifier`/
 * `resolveOrCreateCustomer` (v2 — which the Connector Framework's
 * `CanonicalMappingService` already routes through, so it inherits this for free).
 * One check, reused everywhere — not a parallel privacy system per subsystem.
 */
@Injectable()
export class SuppressionService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async isSuppressed(workspaceId: string, ref: SuppressionRef): Promise<boolean> {
    const provider = assertNamespace(ref.providerNamespace, 'providerNamespace');
    const [row] = await this.db
      .select({ id: identitySuppressions.id })
      .from(identitySuppressions)
      .where(
        and(
          eq(identitySuppressions.workspaceId, workspaceId),
          eq(identitySuppressions.providerNamespace, provider),
          eq(identitySuppressions.identifierType, ref.identifierType),
          eq(identitySuppressions.identifierValue, ref.identifierValue),
          isNull(identitySuppressions.reactivatedAt),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  /** Idempotent: suppressing the same identifier twice while active just refreshes
   * the reason/timestamp (upsert on the natural key). */
  async suppress(workspaceId: string, ref: SuppressionRef, input: { reason: string; sourceRequestId?: string }): Promise<void> {
    const provider = assertNamespace(ref.providerNamespace, 'providerNamespace');
    const id = deterministicId('sup', workspaceId, provider, ref.identifierType, ref.identifierValue);
    await this.db
      .insert(identitySuppressions)
      .values({
        workspaceId,
        id,
        providerNamespace: provider,
        identifierType: ref.identifierType,
        identifierValue: ref.identifierValue,
        reason: input.reason,
        sourceRequestId: input.sourceRequestId ?? null,
        suppressedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [identitySuppressions.workspaceId, identitySuppressions.providerNamespace, identitySuppressions.identifierType, identitySuppressions.identifierValue],
        set: {
          reason: input.reason,
          sourceRequestId: input.sourceRequestId ?? null,
          suppressedAt: new Date(),
          reactivatedAt: null,
          reactivatedBy: null,
          reactivationReason: null,
          updatedAt: new Date(),
        },
      });
  }

  /** Explicit, policy-authorized reactivation — distinguishable from an accidental
   * replay by construction: only THIS method ever clears `reactivatedAt`... sets it. */
  async reactivate(workspaceId: string, ref: SuppressionRef, input: { actor: string; reason: string }): Promise<boolean> {
    const provider = assertNamespace(ref.providerNamespace, 'providerNamespace');
    const [row] = await this.db
      .update(identitySuppressions)
      .set({ reactivatedAt: new Date(), reactivatedBy: input.actor, reactivationReason: input.reason, updatedAt: new Date() })
      .where(
        and(
          eq(identitySuppressions.workspaceId, workspaceId),
          eq(identitySuppressions.providerNamespace, provider),
          eq(identitySuppressions.identifierType, ref.identifierType),
          eq(identitySuppressions.identifierValue, ref.identifierValue),
        ),
      )
      .returning({ id: identitySuppressions.id });
    return Boolean(row);
  }
}
