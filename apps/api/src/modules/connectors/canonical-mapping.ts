import { Inject, Injectable } from '@nestjs/common';
import { IdentityGraphService, SuppressedIdentifierError } from '../identity/identity-graph.service';
import { CustomerContextService } from '../customer-context/customer-context.service';
import type { TypedTraitValue } from '../customer-context/customer-context.contracts';
import { CommerceWriteService } from './commerce/commerce-write.service';
import { BillingContextWriteService } from './billing/billing-context-write.service';
import { CrmWriteService, type CrmOutcomeMapping } from './crm/crm-write.service';
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
  billingObjectsWritten: number;
  /** Order 061: CRM accounts/deals written (companies/deals — not customer identity). */
  crmObjectsWritten: number;
  /** Order 061: association edges actually resolved+written (both sides already known). */
  crmAssociationsWritten: number;
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
    @Inject(BillingContextWriteService) private readonly billing: BillingContextWriteService,
    @Inject(CrmWriteService) private readonly crm: CrmWriteService,
  ) {}

  /**
   * `connectionId` is required only for records carrying a `commerceOrder`/CRM
   * payload (Orders 060/061) — the respective FKs need it; identifier/trait-only
   * records (Order 050's original shape) never touch it. `outcomeMappings` (Order
   * 061 §5) is opaque, caller-supplied config — this service never reads
   * `connector_connections` itself, keeping it DB-dependency-neutral per provider.
   */
  async apply(
    workspaceId: string,
    connectionId: string,
    sourceNamespace: string,
    records: NormalizedRecord[],
    outcomeMappings: CrmOutcomeMapping[] = [],
  ): Promise<ApplyRecordsResult> {
    const result: ApplyRecordsResult = {
      customersResolved: 0, identifiersAttached: 0, traitsWritten: 0, conflicts: 0, suppressed: 0,
      commerceOrdersWritten: 0, billingObjectsWritten: 0, crmObjectsWritten: 0, crmAssociationsWritten: 0,
    };

    for (const record of records) {
      const hasCrmPayload = !!record.crmAccount || !!record.crmDeal || !!record.crmAssociations?.length || !!record.crmAssociationScope || !!record.crmDeletion;
      const hasBillingPayload = !!record.billingSubscription || !!record.billingInvoice || !!record.billingPayment || !!record.billingAdjustment;
      // Order 060 §8 "guest checkout without Shopify customer" / Order 061 "company
      // and deal are not people": a record with NO identifiers is still worth
      // applying if it carries a commerce order or a CRM company/deal/association/
      // deletion signal — those resolve independently of (or before) any personal identity.
      if (record.identifiers.length === 0 && !record.commerceOrder && !hasCrmPayload && !hasBillingPayload) continue;

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

      // Order 062: billing facts follow the same identity/suppression boundary as
      // commerce. A genuinely unlinked payment is durable but stays unattached;
      // no provider-local matching is fabricated. Each writer returns the current
      // row owner so a later identity merge converges traits on the surviving id.
      const billingOwners = await Promise.all([
        record.billingSubscription ? this.billing.upsertSubscription(workspaceId, connectionId, customerId, record.billingSubscription) : null,
        record.billingInvoice ? this.billing.upsertInvoice(workspaceId, connectionId, customerId, record.billingInvoice) : null,
        record.billingPayment ? this.billing.upsertPayment(workspaceId, connectionId, customerId, record.billingPayment) : null,
        record.billingAdjustment ? this.billing.upsertAdjustment(workspaceId, connectionId, customerId, record.billingAdjustment) : null,
      ]);
      if (hasBillingPayload) {
        result.billingObjectsWritten += billingOwners.filter((owner, index) => owner !== null || [record.billingSubscription, record.billingInvoice, record.billingPayment, record.billingAdjustment][index]).length;
        for (const owner of new Set(billingOwners.filter((id): id is string => !!id))) await this.billing.recomputeDerivedTraits(workspaceId, owner);
      }

      if (record.crmAccount) {
        await this.crm.upsertAccount(workspaceId, connectionId, sourceNamespace, record.crmAccount);
        result.crmObjectsWritten += 1;
      }
      if (record.crmDeal) {
        await this.crm.upsertDeal(workspaceId, connectionId, sourceNamespace, record.crmDeal);
        result.crmObjectsWritten += 1;
      }
      if (record.crmAssociationScope) {
        // Order 061 (association+contract closure) — this record carries the
        // COMPLETE current edge set for (fromObject, each toObjectType): RECONCILE
        // (upsert current + tombstone active edges now absent), not just add.
        const { active } = await this.crm.reconcileAssociations(
          workspaceId, connectionId, record.crmAssociationScope.providerNamespace, record.crmAssociationScope,
          record.crmAssociationScope.fromProviderObjectId, record.crmAssociations ?? [],
        );
        result.crmAssociationsWritten += active;
      } else {
        // No scope declared (no current source emits this) — purely additive
        // fallback, safe default for a future partial-association source.
        for (const association of record.crmAssociations ?? []) {
          const { written } = await this.crm.upsertAssociation(workspaceId, connectionId, association);
          if (written) result.crmAssociationsWritten += 1;
        }
      }
      if (record.crmDeal) {
        // AFTER associations: resolving the deal's primary contact for outcome
        // mapping needs THIS record's own deal→contact edge to already be written.
        await this.crm.applyOutcomeMappingIfConfigured(workspaceId, record.crmDeal, sourceNamespace, outcomeMappings);
      }
      if (record.crmDeletion) {
        await this.crm.applyDeletionSignal(workspaceId, record.crmDeletion);
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
