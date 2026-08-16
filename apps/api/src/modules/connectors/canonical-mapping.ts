import { Inject, Injectable } from '@nestjs/common';
import { IdentityGraphService, SuppressedIdentifierError } from '../identity/identity-graph.service';
import { CustomerContextService } from '../customer-context/customer-context.service';
import type { TypedTraitValue } from '../customer-context/customer-context.contracts';
import { CommerceWriteService } from './commerce/commerce-write.service';
import type { NormalizedRecord, NormalizedTrait } from './contracts';

/** Narrows the generic `{valueType, value}` shape into the discriminated union
 * `CustomerContextService.upsertTrait` expects — no `as` cast, exhaustive per type. */
function toTypedTraitValue(trait: NormalizedTrait): TypedTraitValue {
  switch (trait.valueType) {
    case 'string':
      return { type: 'string', value: String(trait.value) };
    case 'number':
      return { type: 'number', value: Number(trait.value) };
    case 'boolean':
      return { type: 'boolean', value: Boolean(trait.value) };
    case 'datetime':
      return { type: 'datetime', value: String(trait.value) };
    case 'json':
      return { type: 'json', value: trait.value };
  }
}

export interface ApplyRecordsResult {
  customersResolved: number;
  identifiersAttached: number;
  traitsWritten: number;
  conflicts: number;
  /** Order 055 §3: records whose identifier belonged to a deleted, suppressed
   * subject — skipped (not applied), never a batch-wide failure. */
  suppressed: number;
  /** Order 060: commerce orders written (identified or guest — `customerId: null`). */
  commerceOrdersWritten: number;
}

/**
 * Order 050 §"Canonical mapping" — "Adapters map provider objects into existing
 * canonical services... Do not let adapters write their own identity matching
 * rules." This is the ONE place that calls `IdentityGraphService`
 * (Order 045)/`CustomerContextService` (Order 30) — every adapter, present or
 * future, returns plain `NormalizedRecord[]` and NEVER touches these services
 * directly. A disagreement between identifiers becomes an explicit
 * `identity_conflicts` row (Order 045's existing behavior) — never a silent
 * reassignment, regardless of which provider supplied the data.
 */
@Injectable()
export class CanonicalMappingService {
  constructor(
    @Inject(IdentityGraphService) private readonly identityGraph: IdentityGraphService,
    @Inject(CustomerContextService) private readonly customerContext: CustomerContextService,
    @Inject(CommerceWriteService) private readonly commerce: CommerceWriteService,
  ) {}

  /**
   * `connectionId` is required only for records carrying a `commerceOrder`
   * (Order 060) — the FK `commerce_orders.connection_id` needs it; identifier/trait-
   * only records (Order 050's original shape) never touch it.
   */
  async apply(workspaceId: string, connectionId: string, sourceNamespace: string, records: NormalizedRecord[]): Promise<ApplyRecordsResult> {
    const result: ApplyRecordsResult = { customersResolved: 0, identifiersAttached: 0, traitsWritten: 0, conflicts: 0, suppressed: 0, commerceOrdersWritten: 0 };

    for (const record of records) {
      // Order 060 §8 "guest checkout without Shopify customer": a record with NO
      // identifiers is still worth applying if it carries a commerce order — it
      // just resolves to no customer (recorded unattached, see CommerceWriteService).
      if (record.identifiers.length === 0 && !record.commerceOrder) continue;

      const observedAt = new Date(record.observedAt);
      let customerId: string | null = null;

      if (record.identifiers.length > 0) {
        const [primary, ...rest] = record.identifiers;
        try {
          const resolved = await this.identityGraph.resolveOrCreateCustomer({
            workspaceId,
            providerNamespace: primary!.providerNamespace,
            identifierType: primary!.identifierType,
            identifierValue: primary!.identifierValue,
            sourceNamespace,
            observedAt,
          });
          customerId = resolved.customerId;
          result.customersResolved += 1;
        } catch (err) {
          if (!(err instanceof SuppressedIdentifierError)) throw err;
          result.suppressed += 1;
          // primary identifier suppressed — no owner to attach anything else to,
          // but a commerce order can still be recorded unattached (customerId stays null).
        }

        if (customerId) {
          for (const identifier of rest) {
            try {
              const attach = await this.identityGraph.attachIdentifier({
                workspaceId,
                customerId,
                providerNamespace: identifier.providerNamespace,
                identifierType: identifier.identifierType,
                identifierValue: identifier.identifierValue,
                sourceNamespace,
                observedAt,
              });
              if (attach.status === 'conflict') result.conflicts += 1;
              else result.identifiersAttached += 1;
            } catch (err) {
              if (err instanceof SuppressedIdentifierError) {
                result.suppressed += 1;
                continue; // this ONE identifier is skipped; the record's primary customer/traits still apply.
              }
              throw err;
            }
          }
        }
      }

      if (record.commerceOrder) {
        const upserted = await this.commerce.upsertOrder(workspaceId, connectionId, customerId, sourceNamespace, record.commerceOrder);
        result.commerceOrdersWritten += 1;
        // Use the order's ACTUAL post-upsert customerId, not this record's own
        // (possibly null) `customerId` — a refund/partial-update webhook carries no
        // identifiers of its own, but the order it touches may already belong to a
        // customer a PREVIOUS sync identified; that customer's derived traits still
        // need recomputing or refund/order-count history would go stale.
        if (upserted.customerId) await this.commerce.recomputeDerivedTraits(workspaceId, upserted.customerId);
      }

      if (customerId) {
        for (const trait of record.traits ?? []) {
          await this.customerContext.upsertTrait({
            ...toTypedTraitValue(trait),
            workspaceId,
            customerId,
            traitNamespace: trait.traitNamespace,
            traitKey: trait.traitKey,
            sourceNamespace,
            observedAt,
          });
          result.traitsWritten += 1;
        }
      }
    }

    return result;
  }
}
