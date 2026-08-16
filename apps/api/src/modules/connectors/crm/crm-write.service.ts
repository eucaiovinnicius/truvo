import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  crmAccounts,
  crmDeals,
  crmAssociations,
  customerIdentifiers,
  customerOutcomes,
  outcomeDefinitions,
  type ContextProvenance,
  type CrmObjectType,
} from '@truvo/db';
import { DRIZZLE, type Database } from '../../auth/database.provider';
import { SuppressionService } from '../../customer-context/suppression.service';
import type { NormalizedCrmAccount, NormalizedCrmAssociation, NormalizedCrmDeal, NormalizedCrmDeletionSignal } from '../contracts';

/**
 * Order 061 §2/§4/§5 — a workspace-configured, versionable mapping describing which
 * deal property/value transition maps to which Truvo outcome. Stored inside
 * `connector_connections.config.outcome_mappings` (the SAME jsonb column Order 050
 * already gives every connection — no new config table needed). Deliberately NOT a
 * global `closedwon = purchase` default: absent config, a deal produces NO outcome.
 */
export interface CrmOutcomeMapping {
  objectType: 'deal';
  propertyName: string;
  propertyValue: string;
  outcomeNamespace: string;
  outcomeKey: string;
  name: string;
}

function deterministicId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('')).digest('hex').slice(0, 26)}`;
}

/** Reads the workspace's configured outcome mappings out of a connection's opaque
 * `config` jsonb — the ONE place that knows this shape, so callers (webhook
 * service, sync orchestrator) never need to. Malformed/missing config → no
 * mappings (a deal produces no outcome), never a throw. */
export function readOutcomeMappings(config: Record<string, unknown>): CrmOutcomeMapping[] {
  const raw = config.outcome_mappings;
  if (!Array.isArray(raw)) return [];
  return raw.filter((m): m is CrmOutcomeMapping => {
    return (
      !!m && typeof m === 'object' &&
      (m as CrmOutcomeMapping).objectType === 'deal' &&
      typeof (m as CrmOutcomeMapping).propertyName === 'string' &&
      typeof (m as CrmOutcomeMapping).propertyValue === 'string' &&
      typeof (m as CrmOutcomeMapping).outcomeNamespace === 'string' &&
      typeof (m as CrmOutcomeMapping).outcomeKey === 'string' &&
      typeof (m as CrmOutcomeMapping).name === 'string'
    );
  });
}

/**
 * Order 061 §4 — writes provider-neutral CRM state
 * (`packages/db/src/schema/crm.ts`). Contact identity NEVER flows through here —
 * that stays Identity Graph v2's job via `CanonicalMappingService`; this service
 * only writes company/deal/association rows and, when the workspace explicitly
 * configured a matching outcome mapping, mirrors a deal into `customer_outcomes`
 * (Order 40) — reusing the SAME dedupe/advance-on-merge semantics
 * `CommerceWriteService`/`EventProjectionService` already established.
 */
@Injectable()
export class CrmWriteService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly suppression?: SuppressionService,
  ) {}

  /**
   * Order 061 §6/§9 — see `NormalizedCrmDeletionSignal` doc comment.
   * `deleted`/`restored` are non-destructive, visible flags; `privacy_deleted`
   * suppresses the identifier via the EXISTING Order 55 `SuppressionService` so it
   * can never silently reconstruct canonical identity again.
   */
  async applyDeletionSignal(workspaceId: string, signal: NormalizedCrmDeletionSignal): Promise<void> {
    if (signal.action === 'privacy_deleted') {
      if (!this.suppression) return;
      await this.suppression.suppress(
        workspaceId,
        { providerNamespace: signal.providerNamespace, identifierType: 'external_id', identifierValue: signal.providerObjectId },
        { reason: signal.reason ?? 'hubspot.contact.privacyDeletion' },
      );
      return;
    }

    const deletedAt = signal.action === 'deleted' ? new Date() : null;
    const now = new Date();
    if (signal.objectType === 'contact') {
      await this.db
        .update(customerIdentifiers)
        .set({ deletedAt, updatedAt: now })
        .where(
          and(
            eq(customerIdentifiers.workspaceId, workspaceId),
            eq(customerIdentifiers.providerNamespace, signal.providerNamespace),
            eq(customerIdentifiers.identifierType, 'external_id'),
            eq(customerIdentifiers.identifierValue, signal.providerObjectId),
          ),
        );
      return;
    }
    if (signal.objectType === 'company') {
      await this.db
        .update(crmAccounts)
        .set({ deletedAt, updatedAt: now })
        .where(and(eq(crmAccounts.workspaceId, workspaceId), eq(crmAccounts.providerNamespace, signal.providerNamespace), eq(crmAccounts.providerObjectId, signal.providerObjectId)));
      return;
    }
    await this.db
      .update(crmDeals)
      .set({ deletedAt, updatedAt: now })
      .where(and(eq(crmDeals.workspaceId, workspaceId), eq(crmDeals.providerNamespace, signal.providerNamespace), eq(crmDeals.providerObjectId, signal.providerObjectId)));
  }

  /**
   * `account.name`/`account.traits` may be a PARTIAL update (a single-property
   * HubSpot webhook only ever reports ONE changed property — see
   * `hubspot.mapper.ts#mapCompanyPropertyChange`). `traits` MERGES (jsonb `||`,
   * new keys win, everything else preserved) rather than replacing wholesale, and
   * `name` is left untouched when the incoming record didn't provide one (`undefined`
   * means "unknown from this update," never "clear it") — a full backfill/
   * reconciliation record always supplies both, so it fully overwrites either way.
   */
  async upsertAccount(workspaceId: string, connectionId: string, sourceNamespace: string, account: NormalizedCrmAccount): Promise<{ accountId: string }> {
    const accountId = deterministicId('crma', workspaceId, account.providerNamespace, account.providerObjectId);
    const now = new Date();
    await this.db
      .insert(crmAccounts)
      .values({
        workspaceId, id: accountId, connectionId,
        providerNamespace: account.providerNamespace, providerObjectId: account.providerObjectId,
        name: account.name ?? null, traits: account.traits, sourceNamespace, observedAt: now,
      })
      .onConflictDoUpdate({
        target: [crmAccounts.workspaceId, crmAccounts.providerNamespace, crmAccounts.providerObjectId],
        set: {
          name: account.name !== undefined ? account.name : sql`${crmAccounts.name}`,
          traits: sql`${crmAccounts.traits} || ${JSON.stringify(account.traits)}::jsonb`,
          observedAt: now, updatedAt: now,
        },
      });
    return { accountId };
  }

  /**
   * Same partial-update tolerance as `upsertAccount` — a single-property HubSpot
   * webhook only reports ONE changed field (see
   * `hubspot.mapper.ts#mapDealPropertyChange`); every OTHER core column
   * (`name`/`amount`/`currency`/`pipeline`/`stage`/`status`) is left as-is when
   * the incoming record didn't provide it, never wiped to null. `traits` merges.
   * A full backfill/reconciliation record always supplies every field, so it
   * fully overwrites regardless.
   */
  async upsertDeal(workspaceId: string, connectionId: string, sourceNamespace: string, deal: NormalizedCrmDeal): Promise<{ dealId: string }> {
    const dealId = deterministicId('crmd', workspaceId, deal.providerNamespace, deal.providerObjectId);
    const now = new Date();
    await this.db
      .insert(crmDeals)
      .values({
        workspaceId, id: dealId, connectionId,
        providerNamespace: deal.providerNamespace, providerObjectId: deal.providerObjectId,
        name: deal.name ?? null, amount: deal.amount !== undefined ? deal.amount.toString() : null,
        currency: deal.currency ?? null, pipeline: deal.pipeline ?? null, stage: deal.stage ?? null,
        status: deal.status ?? null, dealTimestamp: new Date(deal.dealTimestamp), traits: deal.traits, sourceNamespace,
      })
      .onConflictDoUpdate({
        target: [crmDeals.workspaceId, crmDeals.providerNamespace, crmDeals.providerObjectId],
        set: {
          name: deal.name !== undefined ? deal.name : sql`${crmDeals.name}`,
          amount: deal.amount !== undefined ? deal.amount.toString() : sql`${crmDeals.amount}`,
          currency: deal.currency !== undefined ? deal.currency : sql`${crmDeals.currency}`,
          pipeline: deal.pipeline !== undefined ? deal.pipeline : sql`${crmDeals.pipeline}`,
          stage: deal.stage !== undefined ? deal.stage : sql`${crmDeals.stage}`,
          status: deal.status !== undefined ? deal.status : sql`${crmDeals.status}`,
          dealTimestamp: new Date(deal.dealTimestamp),
          traits: sql`${crmDeals.traits} || ${JSON.stringify(deal.traits)}::jsonb`,
          updatedAt: now,
        },
      });

    return { dealId };
  }

  /** Resolves a `NormalizedCrmAssociation`'s two provider-space object ids to LOCAL
   * canonical ids and upserts the edge. Silently skipped (not an error) when either
   * side hasn't been synced yet — associations converge independently of page
   * order: whichever side syncs LAST re-attempts the SAME natural key. */
  async upsertAssociation(workspaceId: string, connectionId: string, association: NormalizedCrmAssociation): Promise<{ written: boolean }> {
    const [fromId, toId] = await Promise.all([
      this.resolveLocalId(workspaceId, association.providerNamespace, association.fromObjectType, association.fromProviderObjectId),
      this.resolveLocalId(workspaceId, association.providerNamespace, association.toObjectType, association.toProviderObjectId),
    ]);
    if (!fromId || !toId) return { written: false };

    const id = deterministicId('crmas', workspaceId, association.fromObjectType, fromId, association.toObjectType, toId, association.associationType);
    const now = new Date();
    await this.db
      .insert(crmAssociations)
      .values({
        workspaceId, id, connectionId,
        providerNamespace: association.providerNamespace,
        fromObjectType: association.fromObjectType, fromObjectId: fromId,
        toObjectType: association.toObjectType, toObjectId: toId,
        associationType: association.associationType, observedAt: now,
      })
      .onConflictDoNothing({
        target: [crmAssociations.workspaceId, crmAssociations.fromObjectType, crmAssociations.fromObjectId, crmAssociations.toObjectType, crmAssociations.toObjectId, crmAssociations.associationType],
      });
    return { written: true };
  }

  /** The first customer resolved from a 'deal'→'contact' association — used as the
   * outcome's owner. Documented scope decision (Order 061 handoff): "primary
   * contact" = first association found, not a HubSpot-native primary-contact flag
   * (HubSpot associations don't universally expose one across all pricing tiers). */
  private async primaryContactForDeal(workspaceId: string, dealLocalId: string): Promise<string | null> {
    const [assoc] = await this.db
      .select({ toObjectId: crmAssociations.toObjectId })
      .from(crmAssociations)
      .where(and(eq(crmAssociations.workspaceId, workspaceId), eq(crmAssociations.fromObjectType, 'deal'), eq(crmAssociations.fromObjectId, dealLocalId), eq(crmAssociations.toObjectType, 'contact')))
      .limit(1);
    return assoc?.toObjectId ?? null;
  }

  private async resolveLocalId(workspaceId: string, providerNamespace: string, type: CrmObjectType, providerObjectId: string): Promise<string | null> {
    if (type === 'contact') {
      const [row] = await this.db
        .select({ customerId: customerIdentifiers.customerId })
        .from(customerIdentifiers)
        .where(
          and(
            eq(customerIdentifiers.workspaceId, workspaceId),
            eq(customerIdentifiers.providerNamespace, providerNamespace),
            eq(customerIdentifiers.identifierType, 'external_id'),
            eq(customerIdentifiers.identifierValue, providerObjectId),
          ),
        )
        .limit(1);
      return row?.customerId ?? null;
    }
    if (type === 'company') {
      const [row] = await this.db
        .select({ id: crmAccounts.id })
        .from(crmAccounts)
        .where(and(eq(crmAccounts.workspaceId, workspaceId), eq(crmAccounts.providerNamespace, providerNamespace), eq(crmAccounts.providerObjectId, providerObjectId)))
        .limit(1);
      return row?.id ?? null;
    }
    const [row] = await this.db
      .select({ id: crmDeals.id })
      .from(crmDeals)
      .where(and(eq(crmDeals.workspaceId, workspaceId), eq(crmDeals.providerNamespace, providerNamespace), eq(crmDeals.providerObjectId, providerObjectId)))
      .limit(1);
    return row?.id ?? null;
  }

  /**
   * Order 061 §5 — explicit, workspace-configured mapping only. No inference from
   * arbitrary stage/property names, no global `closedwon = purchase`. A mapping
   * CHANGE never rewrites prior history: this only ever runs at write time, against
   * the CURRENT config, and only ever creates/advances — it never re-evaluates or
   * deletes an outcome from a PAST deal sync under an OLD mapping.
   *
   * Called by `CanonicalMappingService` AFTER associations are written (not from
   * inside `upsertDeal`) — resolving the deal's primary contact requires the
   * deal→contact `crm_associations` edge to already exist, which itself requires
   * the deal ROW to exist first (`upsertAssociation` looks it up), so the natural
   * order within one record is: upsertDeal → upsertAssociation(s) → this.
   */
  async applyOutcomeMappingIfConfigured(workspaceId: string, deal: NormalizedCrmDeal, sourceNamespace: string, mappings: CrmOutcomeMapping[]): Promise<void> {
    const match = mappings.find((m) => m.objectType === 'deal' && this.dealPropertyValue(deal, m.propertyName) === m.propertyValue);
    if (!match) return;

    const dealLocalId = deterministicId('crmd', workspaceId, deal.providerNamespace, deal.providerObjectId);
    const customerId = await this.primaryContactForDeal(workspaceId, dealLocalId);
    if (!customerId) return; // no resolved contact yet — self-heals once an association syncs.

    const definitionId = deterministicId('ocd', workspaceId, match.outcomeNamespace, match.outcomeKey);
    await this.db
      .insert(outcomeDefinitions)
      .values({
        workspaceId, id: definitionId, outcomeNamespace: match.outcomeNamespace, outcomeKey: match.outcomeKey,
        name: match.name, kind: 'event',
        definition: { event_name: match.outcomeKey, value_property: 'amount', currency_property: 'currency' },
        sourceNamespace,
      })
      .onConflictDoNothing({ target: [outcomeDefinitions.workspaceId, outcomeDefinitions.outcomeNamespace, outcomeDefinitions.outcomeKey] });

    const outcomeId = deterministicId('oco', workspaceId, match.outcomeNamespace, match.outcomeKey, deal.providerObjectId);
    await this.db
      .insert(customerOutcomes)
      .values({
        workspaceId, id: outcomeId, customerId, outcomeDefinitionId: definitionId,
        outcomeNamespace: match.outcomeNamespace, outcomeKey: match.outcomeKey, dedupeKey: deal.providerObjectId,
        eventId: `connector_${deal.providerNamespace}_deal_${deal.providerObjectId}`,
        value: deal.amount !== undefined ? deal.amount.toString() : null, currency: deal.currency ?? null, sourceNamespace,
        provenance: { source_record_id: deal.providerObjectId } as ContextProvenance,
        observedAt: new Date(deal.dealTimestamp),
      })
      // Same advance-on-conflict pattern as CommerceWriteService/EventProjectionService
      // (Order 060/040 closure) — customerId always follows CURRENT identity
      // resolution, converging onto a surviving customer after an Identity Graph
      // merge instead of staying pinned to a since-merged contact.
      .onConflictDoUpdate({
        target: [customerOutcomes.workspaceId, customerOutcomes.outcomeNamespace, customerOutcomes.outcomeKey, customerOutcomes.dedupeKey],
        set: { customerId, updatedAt: new Date() },
      });
  }

  private dealPropertyValue(deal: NormalizedCrmDeal, propertyName: string): string | undefined {
    if (propertyName === 'dealstage' || propertyName === 'stage') return deal.stage;
    if (propertyName === 'status') return deal.status;
    if (propertyName === 'pipeline') return deal.pipeline;
    const value = deal.traits[propertyName];
    return typeof value === 'string' ? value : undefined;
  }
}
