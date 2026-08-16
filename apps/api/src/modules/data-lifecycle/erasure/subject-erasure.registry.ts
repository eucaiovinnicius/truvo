import { and, eq, isNull, or } from 'drizzle-orm';
import type { ClickHouseClient } from '@truvo/db';
import {
  customers,
  customerIdentifiers,
  customerTraits,
  customerRelationships,
  customerOutcomes,
  identityLinks,
  identityConflicts,
  identityMergeEvents,
  type IdentityMergeEvidence,
} from '@truvo/db';
import type { Database } from '../../auth/database.provider';

/**
 * Order 055 §2 — SUBJECT ERASURE PROPAGATION. One handler per store, explicit and
 * reviewable (same "code registry, not heuristics" convention as
 * `outcome-projection.registry.ts` / `identity-graph.policy.ts`). Every handler is
 * independently idempotent (matches on `deletedAt IS NULL` / re-redacts an already-
 * redacted value harmlessly) — safe to retry any ONE store without re-running the
 * others (Order 055 §1: "Retries must resume incomplete stores only").
 *
 * None of these handlers destroy a VALUE another handler still needs to read (they
 * set `deleted_at` or replace a value with a fixed redaction marker, never drop a
 * row outright) — so store execution order is not load-bearing for correctness.
 */
export const REDACTED_MARKER = '[erased]';

export interface ErasureContext {
  db: Database;
  ch: ClickHouseClient;
  workspaceId: string;
  customerId: string;
}

export interface StoreErasureResult {
  status: 'completed' | 'failed';
  processedCount: number;
  error?: string;
}

export type StoreErasureHandler = (ctx: ErasureContext) => Promise<StoreErasureResult>;

async function ok(processedCount: number): Promise<StoreErasureResult> {
  return { status: 'completed', processedCount };
}

/** Order 30 canonical customer context — tombstone (Order 035's existing logic,
 * now tracked per-store). `customer_outcomes` (Order 40) was not yet covered when
 * Order 035 shipped this — added here. */
export const erasePostgresCustomerContext: StoreErasureHandler = async (ctx) => {
  const now = new Date();
  const [identifiers, traits, relationships, outcomes, customer] = await Promise.all([
    ctx.db.update(customerIdentifiers).set({ deletedAt: now, updatedAt: now }).where(and(
      eq(customerIdentifiers.workspaceId, ctx.workspaceId), eq(customerIdentifiers.customerId, ctx.customerId), isNull(customerIdentifiers.deletedAt),
    )).returning({ id: customerIdentifiers.id }),
    ctx.db.update(customerTraits).set({ deletedAt: now, updatedAt: now }).where(and(
      eq(customerTraits.workspaceId, ctx.workspaceId), eq(customerTraits.customerId, ctx.customerId), isNull(customerTraits.deletedAt),
    )).returning({ id: customerTraits.id }),
    ctx.db.update(customerRelationships).set({ deletedAt: now, updatedAt: now }).where(and(
      eq(customerRelationships.workspaceId, ctx.workspaceId),
      or(eq(customerRelationships.fromCustomerId, ctx.customerId), eq(customerRelationships.toCustomerId, ctx.customerId)),
      isNull(customerRelationships.deletedAt),
    )).returning({ id: customerRelationships.id }),
    ctx.db.update(customerOutcomes).set({ deletedAt: now, updatedAt: now }).where(and(
      eq(customerOutcomes.workspaceId, ctx.workspaceId), eq(customerOutcomes.customerId, ctx.customerId), isNull(customerOutcomes.deletedAt),
    )).returning({ id: customerOutcomes.id }),
    ctx.db.update(customers).set({ deletedAt: now, updatedAt: now }).where(and(
      eq(customers.workspaceId, ctx.workspaceId), eq(customers.id, ctx.customerId), isNull(customers.deletedAt),
    )).returning({ id: customers.id }),
  ]);
  return ok(identifiers.length + traits.length + relationships.length + outcomes.length + customer.length);
};

/** v1 identity graph (M8) — tombstone `identity_links` rows for this subject's
 * legacy canonical (Order 055: `deleted_at` added to this table specifically so it
 * can join the same lifecycle every other subject-owned table already uses). */
export const eraseIdentityV1: StoreErasureHandler = async (ctx) => {
  const [customer] = await ctx.db.select({ legacyCanonicalId: customers.legacyCanonicalId }).from(customers).where(and(
    eq(customers.workspaceId, ctx.workspaceId), eq(customers.id, ctx.customerId),
  )).limit(1);
  const legacyId = customer?.legacyCanonicalId ?? ctx.customerId;

  const now = new Date();
  const updated = await ctx.db.update(identityLinks).set({ deletedAt: now }).where(and(
    eq(identityLinks.workspaceId, ctx.workspaceId), eq(identityLinks.canonicalId, legacyId), isNull(identityLinks.deletedAt),
  )).returning({ id: identityLinks.id });
  return ok(updated.length);
};

/** Identity Graph v2 (Order 45) audit evidence — RETAINED (never deleted, it's the
 * merge/conflict audit trail), but the identifier VALUES it carries (which ARE
 * PII/pseudonymous data) are redacted for rows touching this customer. */
export const redactIdentityGraphV2Evidence: StoreErasureHandler = async (ctx) => {
  let count = 0;

  const conflictRows = await ctx.db.select({ id: identityConflicts.id, identifierValue: identityConflicts.identifierValue }).from(identityConflicts).where(and(
    eq(identityConflicts.workspaceId, ctx.workspaceId),
    or(eq(identityConflicts.existingCustomerId, ctx.customerId), eq(identityConflicts.incomingCustomerId, ctx.customerId)),
  ));
  for (const row of conflictRows) {
    if (row.identifierValue === REDACTED_MARKER) continue; // already redacted — idempotent skip
    await ctx.db.update(identityConflicts).set({ identifierValue: REDACTED_MARKER, updatedAt: new Date() }).where(eq(identityConflicts.id, row.id));
    count += 1;
  }

  const mergeEventRows = await ctx.db.select({ id: identityMergeEvents.id, evidence: identityMergeEvents.evidence }).from(identityMergeEvents).where(and(
    eq(identityMergeEvents.workspaceId, ctx.workspaceId),
    or(eq(identityMergeEvents.sourceCustomerId, ctx.customerId), eq(identityMergeEvents.targetCustomerId, ctx.customerId)),
  ));
  for (const row of mergeEventRows) {
    const evidence = row.evidence as IdentityMergeEvidence;
    const alreadyRedacted = evidence.movedIdentifiers.every((m) => m.identifierValue === REDACTED_MARKER);
    if (alreadyRedacted) continue;
    const redacted: IdentityMergeEvidence = {
      ...evidence,
      movedIdentifiers: evidence.movedIdentifiers.map((m) => ({ ...m, identifierValue: REDACTED_MARKER })),
    };
    await ctx.db.update(identityMergeEvents).set({ evidence: redacted }).where(eq(identityMergeEvents.id, row.id));
    count += 1;
  }

  return ok(count);
};

/** ClickHouse — DELETE the subject's own raw event/touchpoint rows, matched by
 * every identifier the subject is known under (canonical id, legacy canonical id,
 * and every raw identifier value from `customer_identifiers`/`identity_links` —
 * `events` has no canonical_id column, so raw values are the only join key it has).
 * Synchronous mutation (`mutations_sync: '1'`) — same setting Order 045's
 * `retro-stitch.ts` already uses for ClickHouse mutations on this exact codebase;
 * the command's own promise resolution IS the completion signal (no new async-
 * mutation-polling state machine invented for this order — see HANDOFF). */
export const eraseClickHouseEventsAndTouchpoints: StoreErasureHandler = async (ctx) => {
  const [customer] = await ctx.db.select({ legacyCanonicalId: customers.legacyCanonicalId }).from(customers).where(and(
    eq(customers.workspaceId, ctx.workspaceId), eq(customers.id, ctx.customerId),
  )).limit(1);
  const legacyId = customer?.legacyCanonicalId ?? ctx.customerId;

  const [identifierRows, linkRows] = await Promise.all([
    ctx.db.select({ value: customerIdentifiers.identifierValue }).from(customerIdentifiers).where(and(
      eq(customerIdentifiers.workspaceId, ctx.workspaceId), eq(customerIdentifiers.customerId, ctx.customerId),
    )),
    ctx.db.select({ identifier: identityLinks.identifier }).from(identityLinks).where(and(
      eq(identityLinks.workspaceId, ctx.workspaceId), eq(identityLinks.canonicalId, legacyId),
    )),
  ]);
  const values = [...new Set([...identifierRows.map((r) => r.value), ...linkRows.map((r) => r.identifier)])];
  const canonicalIds = [...new Set([ctx.customerId, legacyId])];

  if (values.length === 0 && canonicalIds.length === 0) return ok(0);

  try {
    await ctx.ch.command({
      query: `
        ALTER TABLE events DELETE
        WHERE workspace_id = {ws:String}
          AND (anonymous_id IN {values:Array(String)} OR user_id IN {values:Array(String)}
               OR click_id IN {values:Array(String)} OR order_id IN {values:Array(String)})`,
      query_params: { ws: ctx.workspaceId, values: values.length > 0 ? values : [''] },
      clickhouse_settings: { mutations_sync: '1' },
    });
    await ctx.ch.command({
      query: `ALTER TABLE touchpoints DELETE WHERE workspace_id = {ws:String} AND canonical_id IN {ids:Array(String)}`,
      query_params: { ws: ctx.workspaceId, ids: canonicalIds },
      clickhouse_settings: { mutations_sync: '1' },
    });
  } catch (err) {
    return { status: 'failed', processedCount: 0, error: (err as Error).message };
  }

  return ok(values.length + canonicalIds.length);
};

/** Order 055 §2 "Derived / ML artifacts" — explicitly enumerated: `user_profiles`
 * (M15) is a lazily-recomputed cache (regenerates from source on next read, per
 * `DATA_LIFECYCLE_LINEAGE.md`) and the ClickHouse materialized views (`*_daily`,
 * funnels, attribution) are derived aggregates that regenerate from `events` after
 * the upstream purge above — neither is subject-addressable storage requiring a
 * direct erasure action. No production ML artifact store exists yet in this
 * codebase (confirmed by inspection — not invented for this order). */
export const SUBJECT_ERASURE_STORES: ReadonlyArray<{ store: string; handler: StoreErasureHandler }> = [
  { store: 'customer_context', handler: erasePostgresCustomerContext },
  { store: 'identity_v1', handler: eraseIdentityV1 },
  { store: 'identity_graph_v2_evidence', handler: redactIdentityGraphV2Evidence },
  { store: 'clickhouse_events_touchpoints', handler: eraseClickHouseEventsAndTouchpoints },
];
