import { Inject, Injectable } from '@nestjs/common';
import { IdentityGraphService } from '../identity/identity-graph.service';
import { CustomerContextService } from '../customer-context/customer-context.service';
import type { TypedTraitValue } from '../customer-context/customer-context.contracts';
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
  ) {}

  async apply(workspaceId: string, sourceNamespace: string, records: NormalizedRecord[]): Promise<ApplyRecordsResult> {
    const result: ApplyRecordsResult = { customersResolved: 0, identifiersAttached: 0, traitsWritten: 0, conflicts: 0 };

    for (const record of records) {
      if (record.identifiers.length === 0) continue;
      const observedAt = new Date(record.observedAt);
      const [primary, ...rest] = record.identifiers;

      const { customerId } = await this.identityGraph.resolveOrCreateCustomer({
        workspaceId,
        providerNamespace: primary!.providerNamespace,
        identifierType: primary!.identifierType,
        identifierValue: primary!.identifierValue,
        sourceNamespace,
        observedAt,
      });
      result.customersResolved += 1;

      for (const identifier of rest) {
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
      }

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

    return result;
  }
}
