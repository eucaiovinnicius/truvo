import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull, lt, inArray, not } from 'drizzle-orm';
import {
  customers,
  customerIdentifiers,
  customerTraits,
  customerRelationships,
  customerOutcomes,
  outcomeDefinitions,
  identityLinks,
  dataRetentionSettings,
} from '@truvo/db';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { AuditService } from '../audit/audit.service';

const BATCH_SIZE = 500;
const MAX_BATCHES = 10_000;

export interface RetentionSweepResult {
  skipped: boolean;
  purged: Record<string, number>;
}

/**
 * Order 055 §5 — RETENTION ENFORCEMENT. Turns the tombstone-then-purge model
 * (Order 055 §2's phase 1: subject/workspace deletion soft-deletes immediately)
 * into an actual executable phase 2: physically purge anything tombstoned past a
 * workspace's OWN configured grace period.
 *
 * `data_retention_settings.tombstone_purge_after_days IS NULL` (no row, or an
 * explicit null) means "skip this workspace" — no implicit/global default period
 * is invented; the order explicitly requires failing safe when policy is absent.
 */
@Injectable()
export class RetentionEnforcementService {
  private readonly logger = new Logger(RetentionEnforcementService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async sweepWorkspace(workspaceId: string): Promise<RetentionSweepResult> {
    const [settings] = await this.db.select().from(dataRetentionSettings).where(eq(dataRetentionSettings.workspaceId, workspaceId)).limit(1);
    if (!settings || settings.tombstonePurgeAfterDays === null) {
      return { skipped: true, purged: {} };
    }

    const cutoff = new Date(Date.now() - settings.tombstonePurgeAfterDays * 24 * 3600_000);
    // Children BEFORE parent: customer_identifiers/traits/relationships/outcomes all
    // have `ON DELETE CASCADE` back to `customers` — purging `customers` first would
    // cascade-delete them at the DB level before this method's own query counts
    // them, misattributing the deletion to the wrong store. Purging children first
    // means each call only ever reports what IT explicitly deleted.
    const purged: Record<string, number> = {
      customer_identifiers: await this.purgeTable(customerIdentifiers, workspaceId, cutoff),
      customer_traits: await this.purgeTable(customerTraits, workspaceId, cutoff),
      customer_relationships: await this.purgeTable(customerRelationships, workspaceId, cutoff),
      customer_outcomes: await this.purgeTable(customerOutcomes, workspaceId, cutoff),
      outcome_definitions: await this.purgeTable(outcomeDefinitions, workspaceId, cutoff),
      customers: await this.purgeTable(customers, workspaceId, cutoff),
      identity_links: await this.purgeIdentityLinks(workspaceId, cutoff),
    };

    // PII-free by construction: only table names + row counts + the cutoff — never
    // subject ids/identifier values.
    await this.audit.record({
      workspaceId,
      category: 'data_lifecycle',
      action: 'data_lifecycle.retention_purged',
      resourceType: 'workspace',
      resourceId: workspaceId,
      metadata: { cutoff: cutoff.toISOString(), purge_after_days: settings.tombstonePurgeAfterDays, purged },
    });

    return { skipped: false, purged };
  }

  /** Batched, bounded hard-delete of tombstoned rows past `cutoff`. Idempotent by
   * construction (re-running finds nothing left to delete); workspace-scoped WHERE
   * clause on every batch makes cross-tenant purge structurally impossible. */
  private async purgeTable(
    table: typeof customers | typeof customerIdentifiers | typeof customerTraits | typeof customerRelationships | typeof customerOutcomes | typeof outcomeDefinitions,
    workspaceId: string,
    cutoff: Date,
  ): Promise<number> {
    let processed = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const idsSubquery = this.db
        .select({ id: table.id })
        .from(table)
        .where(and(eq(table.workspaceId, workspaceId), not(isNull(table.deletedAt)), lt(table.deletedAt, cutoff)))
        .limit(BATCH_SIZE);
      const deleted = await this.db.delete(table).where(and(eq(table.workspaceId, workspaceId), inArray(table.id, idsSubquery))).returning({ id: table.id });
      processed += deleted.length;
      if (deleted.length < BATCH_SIZE) break;
    }
    return processed;
  }

  private async purgeIdentityLinks(workspaceId: string, cutoff: Date): Promise<number> {
    let processed = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const idsSubquery = this.db
        .select({ id: identityLinks.id })
        .from(identityLinks)
        .where(and(eq(identityLinks.workspaceId, workspaceId), not(isNull(identityLinks.deletedAt)), lt(identityLinks.deletedAt, cutoff)))
        .limit(BATCH_SIZE);
      const deleted = await this.db.delete(identityLinks).where(and(eq(identityLinks.workspaceId, workspaceId), inArray(identityLinks.id, idsSubquery))).returning({ id: identityLinks.id });
      processed += deleted.length;
      if (deleted.length < BATCH_SIZE) break;
    }
    return processed;
  }
}
