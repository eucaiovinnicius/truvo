import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull, lt, inArray, not, sql } from 'drizzle-orm';
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

export const OPERATIONAL_LOG_RETENTION_DAYS = {
  profile_access_log: 730,
  integration_out_logs: 180,
  webhook_logs: 30,
} as const;

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
      ...(await this.purgeOperationalLogs(workspaceId)),
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

  /** Operational logs have explicit repository-owned policy windows rather than
   * inheriting the subject-data tombstone window. Every statement is tenant scoped,
   * capped at BATCH_SIZE and naturally resumable/idempotent. Terminal webhook retry
   * bodies are removed eagerly because IDs/statuses are sufficient provenance. */
  private async purgeOperationalLogs(workspaceId: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    await this.db.execute(sql`
      update webhook_logs set retry_payload=null
      where workspace_id=${workspaceId} and retry_payload is not null
        and status in ('processed','failed','rejected','received','verified')
    `);
    for (const [table, days] of Object.entries(OPERATIONAL_LOG_RETENTION_DAYS)) {
      const timestampColumn = table === 'profile_access_log' ? 'at' : table === 'webhook_logs' ? 'received_at' : 'created_at';
      let processed = 0;
      for (let batch = 0; batch < MAX_BATCHES; batch++) {
        const result = await this.db.execute(sql.raw(
          `delete from ${table} where id in (` +
          `select id from ${table} where workspace_id = ${sqlString(workspaceId)} ` +
          `and ${timestampColumn} < now() - interval '${days} days' limit ${BATCH_SIZE}) returning id`,
        )) as unknown as unknown[];
        processed += result.length;
        if (result.length < BATCH_SIZE) break;
      }
      counts[table] = processed;
    }
    return counts;
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

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
