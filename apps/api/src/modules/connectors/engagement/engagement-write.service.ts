import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { engagementEvents } from '@truvo/db';
import { DRIZZLE, type Database } from '../../auth/database.provider';
import { CustomerContextService } from '../../customer-context/customer-context.service';
import type { NormalizedEngagementEvent } from '../contracts';

function deterministicId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('')).digest('hex').slice(0, 26)}`;
}

/** Order 063 — engagement events are immutable append-only facts: insert-once by
 * `providerEventId` (`onConflictDoNothing`), never updated in place — unlike
 * billing (Order 062) there is no out-of-order guard to apply, because a later
 * delivery of the SAME event can only ever be a harmless duplicate, never a
 * revised state. Returns the resolved row owner (or the pre-existing owner on a
 * duplicate) so a later identity merge can converge derived traits correctly. */
@Injectable()
export class EngagementWriteService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly customerContext: CustomerContextService,
  ) {}

  async upsertEvent(workspaceId: string, connectionId: string, customerId: string | null, input: NormalizedEngagementEvent): Promise<string | null> {
    const id = deterministicId('eng', workspaceId, input.providerNamespace, input.providerEventId);
    await this.db
      .insert(engagementEvents)
      .values({
        workspaceId, id, connectionId, customerId,
        providerNamespace: input.providerNamespace, providerEventId: input.providerEventId,
        metricName: input.metricName, engagementKind: input.engagementKind,
        campaignId: input.campaignId ?? null, flowId: input.flowId ?? null,
        correlationId: input.correlationId ?? null, occurredAt: new Date(input.occurredAt),
      })
      // Immutable fact: a replayed/duplicate delivery of the SAME provider event id
      // is a harmless no-op, never a state change (Order 063 §7 "duplicate
      // engagement event", §3 "replay is harmless").
      .onConflictDoNothing({ target: [engagementEvents.workspaceId, engagementEvents.providerNamespace, engagementEvents.providerEventId] });
    const [row] = await this.db
      .select({ customerId: engagementEvents.customerId })
      .from(engagementEvents)
      .where(and(eq(engagementEvents.workspaceId, workspaceId), eq(engagementEvents.providerNamespace, input.providerNamespace), eq(engagementEvents.providerEventId, input.providerEventId)))
      .limit(1);
    return row?.customerId ?? null;
  }

  async recomputeDerivedTraits(workspaceId: string, customerId: string): Promise<void> {
    const rows = await this.db.select().from(engagementEvents).where(and(eq(engagementEvents.workspaceId, workspaceId), eq(engagementEvents.customerId, customerId)));
    const countsByKind: Record<string, number> = {};
    let lastEngagementAt: Date | null = null;
    for (const row of rows) {
      countsByKind[row.engagementKind] = (countsByKind[row.engagementKind] ?? 0) + 1;
      if (!lastEngagementAt || row.occurredAt > lastEngagementAt) lastEngagementAt = row.occurredAt;
    }
    const now = new Date();
    await Promise.all([
      this.customerContext.upsertTrait({ type: 'json', value: countsByKind, workspaceId, customerId, traitNamespace: 'engagement', traitKey: 'event_counts_by_kind', sourceNamespace: 'connector.engagement', observedAt: now }),
      ...(lastEngagementAt ? [this.customerContext.upsertTrait({ type: 'datetime' as const, value: lastEngagementAt.toISOString(), workspaceId, customerId, traitNamespace: 'engagement', traitKey: 'last_engagement_at', sourceNamespace: 'connector.engagement', observedAt: now })] : []),
    ]);
  }
}
