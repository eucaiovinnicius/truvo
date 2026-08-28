import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { customerOutcomes } from '@truvo/db';
import { DRIZZLE, type Database } from '../auth/database.provider';

const BATCH_SIZE = 500;

interface Candidate {
  outcome_id: string;
  source_customer_id: string;
  target_customer_id: string;
}

/** Repairs only the mutable canonical owner pointer after a merge. Economic and
 * source provenance columns are never selected for update. Re-running is a no-op
 * because candidates must still belong to the merge source. */
@Injectable()
export class OutcomeOwnershipReconcilerService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async reconcileWorkspace(workspaceId: string, limit = BATCH_SIZE): Promise<{ processed: number; remaining: boolean }> {
    const bounded = Math.max(1, Math.min(BATCH_SIZE, Math.trunc(limit)));
    const candidates = await this.db.execute(sql`
      select o.id as outcome_id, m.source_customer_id, m.target_customer_id
      from identity_merge_events m
      join customer_outcomes o
        on o.workspace_id=m.workspace_id and o.customer_id=m.source_customer_id
      where m.workspace_id=${workspaceId} and m.operation='merge'
        and m.reversed_by_event_id is null and o.deleted_at is null
      order by m.at asc, o.observed_at asc, o.id asc
      limit ${bounded + 1}
    `) as unknown as Candidate[];
    const batch = candidates.slice(0, bounded);
    let processed = 0;
    for (const candidate of batch) {
      const updated = await this.db.update(customerOutcomes).set({
        customerId: candidate.target_customer_id,
        updatedAt: new Date(),
      }).where(and(
        eq(customerOutcomes.workspaceId, workspaceId),
        eq(customerOutcomes.id, candidate.outcome_id),
        eq(customerOutcomes.customerId, candidate.source_customer_id),
      )).returning({ id: customerOutcomes.id });
      processed += updated.length;
    }
    return { processed, remaining: candidates.length > bounded };
  }
}
