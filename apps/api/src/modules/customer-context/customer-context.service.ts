import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import {
  customerIdentifiers,
  customerRelationships,
  customerTraits,
  customers,
  type CustomerIdentifierType,
  type ContextProvenance,
} from '@truvo/db';
import { DRIZZLE, type Database } from '../auth/database.provider';
import {
  assertNamespace,
  normalizeTraitValue,
  traitType,
  type CustomerContext,
  type TraitWrite,
  type TraitWriteResult,
} from './customer-context.contracts';

export const LEGACY_IDENTITY_NAMESPACE = 'truvo.identity';

export interface LegacyIdentityRef {
  identifier: string;
  type: CustomerIdentifierType;
}

function deterministicId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('\u001f')).digest('hex').slice(0, 32)}`;
}

@Injectable()
export class CustomerContextService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async getContext(workspaceId: string, customerId: string): Promise<CustomerContext | null> {
    const now = new Date();
    const [customer] = await this.db.select().from(customers).where(and(
      eq(customers.workspaceId, workspaceId), eq(customers.id, customerId), isNull(customers.deletedAt),
    )).limit(1);
    if (!customer) return null;

    const [identifiers, traits, relationships] = await Promise.all([
      this.db.select().from(customerIdentifiers).where(and(
        eq(customerIdentifiers.workspaceId, workspaceId), eq(customerIdentifiers.customerId, customerId),
        isNull(customerIdentifiers.deletedAt),
      )).orderBy(customerIdentifiers.providerNamespace, customerIdentifiers.identifierType, customerIdentifiers.id),
      this.db.select().from(customerTraits).where(and(
        eq(customerTraits.workspaceId, workspaceId), eq(customerTraits.customerId, customerId),
        isNull(customerTraits.deletedAt), or(isNull(customerTraits.expiresAt), gt(customerTraits.expiresAt, now)),
      )).orderBy(customerTraits.traitNamespace, customerTraits.traitKey),
      this.db.select().from(customerRelationships).where(and(
        eq(customerRelationships.workspaceId, workspaceId), isNull(customerRelationships.deletedAt),
        or(eq(customerRelationships.fromCustomerId, customerId), eq(customerRelationships.toCustomerId, customerId)),
      )).orderBy(customerRelationships.relationshipNamespace, customerRelationships.relationshipType, customerRelationships.id),
    ]);

    const referenceId = customer.legacyCanonicalId ?? customer.id;
    return {
      customer,
      identifiers,
      current_traits: traits,
      relationships,
      behavior_references: [{
        store: 'clickhouse', dataset: 'events', workspace_id: workspaceId,
        customer_id: customer.id, legacy_canonical_id: customer.legacyCanonicalId,
      }],
      context_references: [
        { kind: 'identity_graph', workspace_id: workspaceId, reference_id: referenceId },
        { kind: 'legacy_profile', workspace_id: workspaceId, reference_id: referenceId },
      ],
    };
  }

  /** Uma trait atual (não expirada, não deletada) de uma pessoa por namespace+key.
   * Base de leitura reusada pela ActivationGuardService (Order 035 §3). */
  async getTrait(
    workspaceId: string,
    customerId: string,
    traitNamespace: string,
    traitKey: string,
  ): Promise<import('@truvo/db').CustomerTrait | null> {
    const now = new Date();
    const [trait] = await this.db.select().from(customerTraits).where(and(
      eq(customerTraits.workspaceId, workspaceId),
      eq(customerTraits.customerId, customerId),
      eq(customerTraits.traitNamespace, traitNamespace),
      eq(customerTraits.traitKey, traitKey),
      isNull(customerTraits.deletedAt),
      or(isNull(customerTraits.expiresAt), gt(customerTraits.expiresAt, now)),
    )).limit(1);
    return trait ?? null;
  }

  async resolveIdentifier(
    workspaceId: string,
    providerNamespace: string,
    type: CustomerIdentifierType,
    identifierValue: string,
  ): Promise<string | null> {
    const provider = assertNamespace(providerNamespace, 'providerNamespace');
    const [row] = await this.db.select({ customerId: customerIdentifiers.customerId })
      .from(customerIdentifiers).where(and(
        eq(customerIdentifiers.workspaceId, workspaceId),
        eq(customerIdentifiers.providerNamespace, provider),
        eq(customerIdentifiers.identifierType, type),
        eq(customerIdentifiers.identifierValue, identifierValue),
        isNull(customerIdentifiers.deletedAt),
      )).limit(1);
    return row?.customerId ?? null;
  }

  async upsertTrait(input: TraitWrite): Promise<TraitWriteResult> {
    const traitNamespace = assertNamespace(input.traitNamespace, 'traitNamespace');
    const sourceNamespace = assertNamespace(input.sourceNamespace, 'sourceNamespace');
    const traitKey = input.traitKey.trim();
    if (!traitKey) throw new Error('traitKey must be non-empty');
    const now = new Date();
    const value = normalizeTraitValue(input);
    const id = deterministicId('ctr', input.workspaceId, input.customerId, traitNamespace, traitKey);

    const [written] = await this.db.insert(customerTraits).values({
      workspaceId: input.workspaceId, id, customerId: input.customerId,
      traitNamespace, traitKey, valueType: traitType(input), value,
      sourceNamespace, provenance: (input.provenance ?? {}) as ContextProvenance,
      observedAt: input.observedAt, expiresAt: input.expiresAt ?? null, updatedAt: now,
    }).onConflictDoUpdate({
      target: [customerTraits.workspaceId, customerTraits.customerId, customerTraits.traitNamespace, customerTraits.traitKey],
      set: {
        valueType: traitType(input), value, sourceNamespace,
        provenance: (input.provenance ?? {}) as ContextProvenance,
        observedAt: input.observedAt, expiresAt: input.expiresAt ?? null,
        deletedAt: null, updatedAt: now,
      },
      // Deterministic precedence: newest observation wins. Equal timestamps use
      // source namespace, value type and canonical jsonb text as stable tie-breaks.
      setWhere: or(
        lt(customerTraits.observedAt, input.observedAt),
        and(
          eq(customerTraits.observedAt, input.observedAt),
          sql`(
            ${customerTraits.sourceNamespace} < ${sourceNamespace}
            OR (
              ${customerTraits.sourceNamespace} = ${sourceNamespace}
              AND (
                ${customerTraits.valueType}::text < ${traitType(input)}
                OR (
                  ${customerTraits.valueType}::text = ${traitType(input)}
                  AND ${customerTraits.value}::text <= ${JSON.stringify(value)}
                )
              )
            )
          )`,
        ),
      ),
    }).returning();

    if (written) return { accepted: true, current: written };
    const [current] = await this.db.select().from(customerTraits).where(and(
      eq(customerTraits.workspaceId, input.workspaceId), eq(customerTraits.customerId, input.customerId),
      eq(customerTraits.traitNamespace, traitNamespace), eq(customerTraits.traitKey, traitKey),
    )).limit(1);
    if (!current) throw new Error('trait upsert did not return or preserve a row');
    return { accepted: false, current };
  }

  /** Mirrors the existing, authoritative M8 graph without introducing merge heuristics. */
  async synchronizeLegacyIdentity(
    workspaceId: string,
    targetCanonicalId: string,
    refs: LegacyIdentityRef[],
    mergedFrom: string[],
    observedAt: Date,
  ): Promise<void> {
    const identified = targetCanonicalId.startsWith('usr_') || refs.some((r) => r.type === 'user_id' || r.type === 'email_hash');
    await this.db.transaction(async (tx) => {
      await tx.insert(customers).values({
        workspaceId, id: targetCanonicalId, legacyCanonicalId: targetCanonicalId,
        status: identified ? 'identified' : 'anonymous', sourceNamespace: LEGACY_IDENTITY_NAMESPACE,
        firstSeenAt: observedAt, lastSeenAt: observedAt,
        provenance: { imported_by: 'identity-service' },
      }).onConflictDoUpdate({
        target: [customers.workspaceId, customers.id],
        set: {
          status: identified ? 'identified' : 'anonymous',
          lastSeenAt: sql`greatest(${customers.lastSeenAt}, excluded.last_seen_at)`,
          updatedAt: observedAt,
        },
      });

      for (const loser of mergedFrom) {
        await tx.insert(customers).values({
          workspaceId, id: loser, legacyCanonicalId: loser, status: 'merged',
          mergedIntoCustomerId: targetCanonicalId, sourceNamespace: LEGACY_IDENTITY_NAMESPACE,
          firstSeenAt: observedAt, lastSeenAt: observedAt,
          provenance: { imported_by: 'identity-service' },
        }).onConflictDoUpdate({
          target: [customers.workspaceId, customers.id],
          set: {
            status: 'merged',
            mergedIntoCustomerId: targetCanonicalId,
            lastSeenAt: sql`greatest(${customers.lastSeenAt}, excluded.last_seen_at)`,
            updatedAt: observedAt,
          },
        });
        // M8 already decided the merge. Move every previously mirrored identifier,
        // including identifiers not repeated in the current identify payload.
        await tx.update(customerIdentifiers).set({
          customerId: targetCanonicalId,
          updatedAt: observedAt,
        }).where(and(
          eq(customerIdentifiers.workspaceId, workspaceId),
          eq(customerIdentifiers.customerId, loser),
        ));
      }

      for (const ref of refs) {
        const id = deterministicId('cid', workspaceId, LEGACY_IDENTITY_NAMESPACE, ref.type, ref.identifier);
        await tx.insert(customerIdentifiers).values({
          workspaceId, id, customerId: targetCanonicalId, identifierType: ref.type,
          providerNamespace: LEGACY_IDENTITY_NAMESPACE, identifierValue: ref.identifier,
          sourceNamespace: LEGACY_IDENTITY_NAMESPACE, firstSeenAt: observedAt, lastSeenAt: observedAt,
          provenance: { imported_by: 'identity-service' },
        }).onConflictDoUpdate({
          target: [customerIdentifiers.workspaceId, customerIdentifiers.providerNamespace, customerIdentifiers.identifierType, customerIdentifiers.identifierValue],
          set: {
            customerId: targetCanonicalId,
            lastSeenAt: sql`greatest(${customerIdentifiers.lastSeenAt}, excluded.last_seen_at)`,
            deletedAt: null,
            updatedAt: observedAt,
          },
        });
      }
    });
  }
}
