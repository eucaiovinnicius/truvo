import { createHash } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import {
  customers,
  customerIdentifiers,
  identityConflicts,
  identityMergeEvents,
  identityLinks,
  identityMerges,
  type Customer,
  type CustomerIdentifier,
  type CustomerIdentifierType,
  type CustomerStatus,
  type IdentityConflict,
  type IdentityMergeEvent,
  type IdentityMergeEvidence,
  type IdentityActor,
} from '@truvo/db';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { assertNamespace } from '../customer-context/customer-context.contracts';
import { CustomerContextService, LEGACY_IDENTITY_NAMESPACE } from '../customer-context/customer-context.service';
import { SuppressionService } from '../customer-context/suppression.service';
import { enqueueRetroStitch } from './identity.infra';
import { isStrongIdentifier } from './identity-graph.policy';

/** Order 055 §3 — thrown when a caller tries to attach/resolve a SUPPRESSED
 * identifier (belonged to a deleted subject, not reactivated). Distinct from
 * `BadRequestException` so callers (e.g. `CanonicalMappingService`) can catch it
 * specifically and skip just that record instead of failing an entire batch. */
export class SuppressedIdentifierError extends Error {
  constructor(
    public readonly providerNamespace: string,
    public readonly identifierType: string,
    public readonly identifierValue: string,
  ) {
    super(`identifier suppressed: ${providerNamespace}/${identifierType}`);
    this.name = 'SuppressedIdentifierError';
  }
}

function deterministicId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('')).digest('hex').slice(0, 32)}`;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export interface AttachIdentifierInput {
  workspaceId: string;
  customerId: string;
  providerNamespace: string;
  identifierType: CustomerIdentifierType;
  identifierValue: string;
  sourceNamespace: string;
  observedAt: Date;
  provenance?: Record<string, unknown>;
}

export type AttachIdentifierResult =
  | { status: 'attached'; identifierId: string }
  | { status: 'already_attached'; identifierId: string }
  | { status: 'conflict'; conflictId: string; existingCustomerId: string };

export interface ResolveOrCreateInput {
  workspaceId: string;
  providerNamespace: string;
  identifierType: CustomerIdentifierType;
  identifierValue: string;
  sourceNamespace: string;
  observedAt: Date;
}

export interface MergeCustomersInput {
  workspaceId: string;
  sourceCustomerId: string;
  targetCustomerId: string;
  reason: string;
  sourceNamespace: string;
  actor: IdentityActor;
}

export type MergeCustomersResult =
  | { status: 'merged'; eventId: string; movedIdentifiers: number }
  | { status: 'already_merged'; eventId: string | null };

export interface RecordConflictInput {
  workspaceId: string;
  existingCustomerId: string;
  incomingCustomerId: string;
  providerNamespace: string;
  identifierType: CustomerIdentifierType;
  identifierValue: string;
  reason: string;
  sourceNamespace: string;
  evidence?: Record<string, unknown>;
  detectedAt: Date;
}

export interface UnmergeInput {
  workspaceId: string;
  mergeEventId: string;
  reason: string;
  actor: IdentityActor;
}

export type UnmergeResult =
  | { status: 'unmerged'; eventId: string; restoredIdentifiers: number; skippedIdentifiers: number }
  | { status: 'already_unmerged'; eventId: string };

export interface IdentityGraphView {
  customer: Customer;
  identifiers: CustomerIdentifier[];
  openConflicts: IdentityConflict[];
  mergeHistory: IdentityMergeEvent[];
}

export interface BackfillCollision {
  canonicalId: string;
  identifierType: string;
  identifierValue: string;
  conflictingOwnerId: string;
}

export interface BackfillResult {
  workspaceId: string;
  canonicalsProcessed: number;
  canonicalsReconciled: number;
  canonicalsSkippedForCollision: number;
  collisions: BackfillCollision[];
}

/**
 * Order 045 — IDENTITY GRAPH V2.
 *
 * Storage: `customers` / `customer_identifiers` (Order 30) — already collision-safe
 * by `(workspace_id, provider_namespace, identifier_type, identifier_value)`. This
 * service does NOT introduce a new identifier-edge table; it adds what Order 30/M8
 * never modeled: explicit conflicts and auditable/reversible merge events.
 *
 * v1 (`identity_links`/`identity_merges`, M8) is untouched and stays authoritative
 * for the public `identify()` contract — its live bridge into this graph
 * (`CustomerContextService.synchronizeLegacyIdentity`) is unchanged. This service is
 * the NEW, deterministic, provider-neutral entry point intended for connectors —
 * no fuzzy matching, no silent reassignment: a disagreement always becomes an
 * explicit, auditable `identity_conflicts` row, never an automatic merge.
 */
@Injectable()
export class IdentityGraphService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly customerContext: CustomerContextService,
    private readonly suppression: SuppressionService,
  ) {}

  // ────────────────────────── lookup helpers ─────────────────────────

  private async findOwner(
    workspaceId: string,
    providerNamespace: string,
    identifierType: CustomerIdentifierType,
    identifierValue: string,
  ): Promise<string | null> {
    const [row] = await this.db
      .select({ customerId: customerIdentifiers.customerId })
      .from(customerIdentifiers)
      .where(
        and(
          eq(customerIdentifiers.workspaceId, workspaceId),
          eq(customerIdentifiers.providerNamespace, providerNamespace),
          eq(customerIdentifiers.identifierType, identifierType),
          eq(customerIdentifiers.identifierValue, identifierValue),
          isNull(customerIdentifiers.deletedAt),
        ),
      )
      .limit(1);
    return row?.customerId ?? null;
  }

  private async touchCustomer(workspaceId: string, customerId: string, observedAt: Date): Promise<void> {
    await this.db
      .update(customers)
      .set({ lastSeenAt: sql`greatest(${customers.lastSeenAt}, ${observedAt.toISOString()}::timestamptz)`, updatedAt: new Date() })
      .where(and(eq(customers.workspaceId, workspaceId), eq(customers.id, customerId)));
  }

  // ──────────────────────── required v2 methods ──────────────────────

  /** Finds the customer already owning this identifier, or creates a fresh one.
   * Order 055 §3: fails closed (throws `SuppressedIdentifierError`) for a
   * suppressed identifier — never resolves/creates against it. */
  async resolveOrCreateCustomer(input: ResolveOrCreateInput): Promise<{ customerId: string; created: boolean }> {
    const provider = assertNamespace(input.providerNamespace, 'providerNamespace');
    const sourceNamespace = assertNamespace(input.sourceNamespace, 'sourceNamespace');

    if (await this.suppression.isSuppressed(input.workspaceId, { providerNamespace: provider, identifierType: input.identifierType, identifierValue: input.identifierValue })) {
      throw new SuppressedIdentifierError(provider, input.identifierType, input.identifierValue);
    }

    const existing = await this.findOwner(input.workspaceId, provider, input.identifierType, input.identifierValue);
    if (existing) return { customerId: existing, created: false };

    const customerId = deterministicId('cus', input.workspaceId, provider, input.identifierType, input.identifierValue);
    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(customers).values({
          workspaceId: input.workspaceId,
          id: customerId,
          status: isStrongIdentifier(input.identifierType) ? 'identified' : 'anonymous',
          sourceNamespace,
          firstSeenAt: input.observedAt,
          lastSeenAt: input.observedAt,
          provenance: { imported_by: 'identity-graph-v2' },
        });
        await tx.insert(customerIdentifiers).values({
          workspaceId: input.workspaceId,
          id: deterministicId('cid', input.workspaceId, provider, input.identifierType, input.identifierValue),
          customerId,
          identifierType: input.identifierType,
          providerNamespace: provider,
          identifierValue: input.identifierValue,
          sourceNamespace,
          firstSeenAt: input.observedAt,
          lastSeenAt: input.observedAt,
        });
      });
      return { customerId, created: true };
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Race: another writer created this exact customer/identifier concurrently.
        const owner = await this.findOwner(input.workspaceId, provider, input.identifierType, input.identifierValue);
        if (owner) return { customerId: owner, created: false };
      }
      throw err;
    }
  }

  /**
   * Attaches an identifier to a customer. Collision-safe by construction (the
   * unique index on `customer_identifiers` is the source of truth): if the
   * identifier is already owned by a DIFFERENT customer, this never reassigns or
   * merges silently — it records an explicit conflict and returns it.
   */
  async attachIdentifier(input: AttachIdentifierInput): Promise<AttachIdentifierResult> {
    const provider = assertNamespace(input.providerNamespace, 'providerNamespace');
    const sourceNamespace = assertNamespace(input.sourceNamespace, 'sourceNamespace');

    // Order 055 §3: fail closed on a suppressed identifier, before touching anything.
    if (await this.suppression.isSuppressed(input.workspaceId, { providerNamespace: provider, identifierType: input.identifierType, identifierValue: input.identifierValue })) {
      throw new SuppressedIdentifierError(provider, input.identifierType, input.identifierValue);
    }

    const [existingRow] = await this.db
      .select({ id: customerIdentifiers.id, customerId: customerIdentifiers.customerId })
      .from(customerIdentifiers)
      .where(
        and(
          eq(customerIdentifiers.workspaceId, input.workspaceId),
          eq(customerIdentifiers.providerNamespace, provider),
          eq(customerIdentifiers.identifierType, input.identifierType),
          eq(customerIdentifiers.identifierValue, input.identifierValue),
          isNull(customerIdentifiers.deletedAt),
        ),
      )
      .limit(1);

    if (existingRow && existingRow.customerId === input.customerId) {
      await this.touchCustomer(input.workspaceId, input.customerId, input.observedAt);
      return { status: 'already_attached', identifierId: existingRow.id };
    }

    if (existingRow) {
      const conflict = await this.recordConflict({
        workspaceId: input.workspaceId,
        existingCustomerId: existingRow.customerId,
        incomingCustomerId: input.customerId,
        providerNamespace: provider,
        identifierType: input.identifierType,
        identifierValue: input.identifierValue,
        reason: 'attach_identifier_owned_by_other_customer',
        sourceNamespace,
        evidence: { strong: isStrongIdentifier(input.identifierType) },
        detectedAt: input.observedAt,
      });
      return { status: 'conflict', conflictId: conflict.conflictId, existingCustomerId: existingRow.customerId };
    }

    const identifierId = deterministicId('cid', input.workspaceId, provider, input.identifierType, input.identifierValue);
    try {
      await this.db.insert(customerIdentifiers).values({
        workspaceId: input.workspaceId,
        id: identifierId,
        customerId: input.customerId,
        identifierType: input.identifierType,
        providerNamespace: provider,
        identifierValue: input.identifierValue,
        sourceNamespace,
        firstSeenAt: input.observedAt,
        lastSeenAt: input.observedAt,
        provenance: input.provenance ?? {},
      });
      await this.touchCustomer(input.workspaceId, input.customerId, input.observedAt);
      return { status: 'attached', identifierId };
    } catch (err) {
      if (isUniqueViolation(err)) return this.attachIdentifier(input); // race — re-evaluate ownership
      throw err;
    }
  }

  /**
   * Deterministic merge: moves every identifier currently owned by `source` to
   * `target`, marks `source` as merged, and records a full-evidence merge event.
   * Idempotent (replaying the same merge is a no-op); never crosses workspaces
   * (both customers are looked up scoped to the same `workspaceId`).
   */
  async mergeCustomers(input: MergeCustomersInput): Promise<MergeCustomersResult> {
    if (input.sourceCustomerId === input.targetCustomerId) {
      throw new BadRequestException('sourceCustomerId and targetCustomerId must differ');
    }
    const sourceNamespace = assertNamespace(input.sourceNamespace, 'sourceNamespace');

    const [source] = await this.db
      .select()
      .from(customers)
      .where(and(eq(customers.workspaceId, input.workspaceId), eq(customers.id, input.sourceCustomerId)))
      .limit(1);
    const [target] = await this.db
      .select()
      .from(customers)
      .where(and(eq(customers.workspaceId, input.workspaceId), eq(customers.id, input.targetCustomerId)))
      .limit(1);
    if (!source) throw new BadRequestException('sourceCustomerId not found in this workspace');
    if (!target) throw new BadRequestException('targetCustomerId not found in this workspace');
    if (target.status === 'merged') {
      throw new BadRequestException(`targetCustomerId is itself merged into ${target.mergedIntoCustomerId} — merge into the root customer`);
    }

    if (source.status === 'merged') {
      if (source.mergedIntoCustomerId === target.id) {
        const [priorEvent] = await this.db
          .select()
          .from(identityMergeEvents)
          .where(
            and(
              eq(identityMergeEvents.workspaceId, input.workspaceId),
              eq(identityMergeEvents.sourceCustomerId, source.id),
              eq(identityMergeEvents.targetCustomerId, target.id),
              eq(identityMergeEvents.operation, 'merge'),
            ),
          )
          .orderBy(desc(identityMergeEvents.at))
          .limit(1);
        return { status: 'already_merged', eventId: priorEvent?.id ?? null };
      }
      throw new BadRequestException(`sourceCustomerId is already merged into ${source.mergedIntoCustomerId}, not ${target.id}`);
    }

    const eventId = deterministicId('mev', input.workspaceId, 'merge', source.id, target.id);
    const now = new Date();
    const moved: IdentityMergeEvidence['movedIdentifiers'] = [];

    await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(customerIdentifiers)
        .where(
          and(
            eq(customerIdentifiers.workspaceId, input.workspaceId),
            eq(customerIdentifiers.customerId, source.id),
            isNull(customerIdentifiers.deletedAt),
          ),
        );
      for (const row of rows) {
        await tx
          .update(customerIdentifiers)
          .set({ customerId: target.id, updatedAt: now })
          .where(and(eq(customerIdentifiers.workspaceId, input.workspaceId), eq(customerIdentifiers.id, row.id)));
        moved.push({
          id: row.id,
          providerNamespace: row.providerNamespace,
          identifierType: row.identifierType,
          identifierValue: row.identifierValue,
        });
      }

      await tx
        .update(customers)
        .set({ status: 'merged', mergedIntoCustomerId: target.id, updatedAt: now })
        .where(and(eq(customers.workspaceId, input.workspaceId), eq(customers.id, source.id)));
      await tx
        .update(customers)
        .set({ lastSeenAt: sql`greatest(${customers.lastSeenAt}, ${now.toISOString()}::timestamptz)`, updatedAt: now })
        .where(and(eq(customers.workspaceId, input.workspaceId), eq(customers.id, target.id)));

      const evidence: IdentityMergeEvidence = { movedIdentifiers: moved, sourceStatusBeforeMerge: source.status };
      await tx.insert(identityMergeEvents).values({
        workspaceId: input.workspaceId,
        id: eventId,
        operation: 'merge',
        sourceCustomerId: source.id,
        targetCustomerId: target.id,
        reason: input.reason,
        evidence,
        sourceNamespace,
        actor: input.actor,
        at: now,
      });
    });

    await this.enqueueRetroactiveStitch(input.workspaceId, target.id, [source.id], input.reason);

    return { status: 'merged', eventId, movedIdentifiers: moved.length };
  }

  /** Idempotent: the SAME disagreement re-detected while open just refreshes evidence/timestamp. */
  async recordConflict(input: RecordConflictInput): Promise<{ conflictId: string }> {
    const provider = assertNamespace(input.providerNamespace, 'providerNamespace');
    const sourceNamespace = assertNamespace(input.sourceNamespace, 'sourceNamespace');
    const id = deterministicId(
      'con',
      input.workspaceId,
      input.existingCustomerId,
      input.incomingCustomerId,
      provider,
      input.identifierType,
      input.identifierValue,
    );

    await this.db
      .insert(identityConflicts)
      .values({
        workspaceId: input.workspaceId,
        id,
        existingCustomerId: input.existingCustomerId,
        incomingCustomerId: input.incomingCustomerId,
        identifierType: input.identifierType,
        providerNamespace: provider,
        identifierValue: input.identifierValue,
        reason: input.reason,
        evidence: input.evidence ?? {},
        sourceNamespace,
        status: 'open',
        detectedAt: input.detectedAt,
      })
      .onConflictDoUpdate({
        target: [
          identityConflicts.workspaceId,
          identityConflicts.existingCustomerId,
          identityConflicts.incomingCustomerId,
          identityConflicts.providerNamespace,
          identityConflicts.identifierType,
          identityConflicts.identifierValue,
        ],
        set: {
          status: 'open',
          reason: input.reason,
          evidence: input.evidence ?? {},
          sourceNamespace,
          detectedAt: input.detectedAt,
          resolvedAt: null,
          resolvedBy: null,
          resolution: null,
          updatedAt: new Date(),
        },
      });

    return { conflictId: id };
  }

  /** Internal/admin-safe resolution — no public UI (out of scope per the order). */
  async resolveConflict(
    workspaceId: string,
    conflictId: string,
    input: { status: 'resolved' | 'dismissed'; resolvedBy: string; resolution?: Record<string, unknown> },
  ): Promise<IdentityConflict | null> {
    const [row] = await this.db
      .update(identityConflicts)
      .set({
        status: input.status,
        resolvedAt: new Date(),
        resolvedBy: input.resolvedBy,
        resolution: input.resolution ?? {},
        updatedAt: new Date(),
      })
      .where(and(eq(identityConflicts.workspaceId, workspaceId), eq(identityConflicts.id, conflictId)))
      .returning();
    return row ?? null;
  }

  async getIdentityGraph(workspaceId: string, customerId: string): Promise<IdentityGraphView | null> {
    const [customer] = await this.db
      .select()
      .from(customers)
      .where(and(eq(customers.workspaceId, workspaceId), eq(customers.id, customerId)))
      .limit(1);
    if (!customer) return null;

    const [identifiers, openConflicts, mergeHistory] = await Promise.all([
      this.db
        .select()
        .from(customerIdentifiers)
        .where(
          and(
            eq(customerIdentifiers.workspaceId, workspaceId),
            eq(customerIdentifiers.customerId, customerId),
            isNull(customerIdentifiers.deletedAt),
          ),
        ),
      this.db
        .select()
        .from(identityConflicts)
        .where(
          and(
            eq(identityConflicts.workspaceId, workspaceId),
            eq(identityConflicts.status, 'open'),
            or(eq(identityConflicts.existingCustomerId, customerId), eq(identityConflicts.incomingCustomerId, customerId)),
          ),
        ),
      this.db
        .select()
        .from(identityMergeEvents)
        .where(
          and(
            eq(identityMergeEvents.workspaceId, workspaceId),
            or(eq(identityMergeEvents.sourceCustomerId, customerId), eq(identityMergeEvents.targetCustomerId, customerId)),
          ),
        )
        .orderBy(desc(identityMergeEvents.at)),
    ]);

    return { customer, identifiers, openConflicts, mergeHistory };
  }

  /**
   * Reversal, built ONLY from the merge event's own recorded evidence — never by
   * reconstructing membership heuristically. If an identifier was re-attached
   * elsewhere after the original merge, it is left alone and reported as skipped
   * (a transparent partial reversal, never a silent overwrite of later state).
   */
  async unmergeCustomers(input: UnmergeInput): Promise<UnmergeResult> {
    const [event] = await this.db
      .select()
      .from(identityMergeEvents)
      .where(
        and(
          eq(identityMergeEvents.workspaceId, input.workspaceId),
          eq(identityMergeEvents.id, input.mergeEventId),
          eq(identityMergeEvents.operation, 'merge'),
        ),
      )
      .limit(1);
    if (!event) throw new BadRequestException('merge event not found');
    if (event.reversedByEventId) {
      return { status: 'already_unmerged', eventId: event.reversedByEventId };
    }

    const now = new Date();
    const unmergeEventId = deterministicId('mev', input.workspaceId, 'unmerge', event.id);
    const restored: IdentityMergeEvidence['movedIdentifiers'] = [];
    const skipped: string[] = [];

    await this.db.transaction(async (tx) => {
      for (const moved of event.evidence.movedIdentifiers) {
        const [current] = await tx
          .select({ customerId: customerIdentifiers.customerId })
          .from(customerIdentifiers)
          .where(and(eq(customerIdentifiers.workspaceId, input.workspaceId), eq(customerIdentifiers.id, moved.id)))
          .limit(1);
        if (current && current.customerId === event.targetCustomerId) {
          await tx
            .update(customerIdentifiers)
            .set({ customerId: event.sourceCustomerId, updatedAt: now })
            .where(and(eq(customerIdentifiers.workspaceId, input.workspaceId), eq(customerIdentifiers.id, moved.id)));
          restored.push(moved);
        } else {
          skipped.push(moved.id);
        }
      }

      const restoredStatus = (event.evidence.sourceStatusBeforeMerge as CustomerStatus | undefined) ?? 'anonymous';
      await tx
        .update(customers)
        .set({ status: restoredStatus, mergedIntoCustomerId: null, updatedAt: now })
        .where(and(eq(customers.workspaceId, input.workspaceId), eq(customers.id, event.sourceCustomerId)));

      const evidence: IdentityMergeEvidence = {
        movedIdentifiers: restored,
        skippedIdentifierIds: skipped,
        reversesEventId: event.id,
      };
      await tx.insert(identityMergeEvents).values({
        workspaceId: input.workspaceId,
        id: unmergeEventId,
        operation: 'unmerge',
        sourceCustomerId: event.sourceCustomerId,
        targetCustomerId: event.targetCustomerId,
        reason: input.reason,
        evidence,
        sourceNamespace: 'identity-graph-v2',
        actor: input.actor,
        at: now,
      });
      await tx
        .update(identityMergeEvents)
        .set({ reversedByEventId: unmergeEventId })
        .where(and(eq(identityMergeEvents.workspaceId, input.workspaceId), eq(identityMergeEvents.id, event.id)));
    });

    return { status: 'unmerged', eventId: unmergeEventId, restoredIdentifiers: restored.length, skippedIdentifiers: skipped.length };
  }

  /** Reuses the SAME Redis stream v1's `identify()` already writes to — one queue, no parallel pipeline. */
  async enqueueRetroactiveStitch(workspaceId: string, canonicalId: string, mergedFrom: string[], reason: string): Promise<void> {
    if (mergedFrom.length === 0) return;
    await enqueueRetroStitch({
      workspace_id: workspaceId,
      canonical_id: canonicalId,
      merged_from: mergedFrom,
      reason,
      enqueued_at: new Date().toISOString(),
    });
  }

  // ───────────────── v1 → v2 reconciliation (migration) ──────────────

  /**
   * Non-destructive reconciliation sweep: for every canonical currently present in
   * v1 `identity_links` (workspace-scoped), ensures the v2 mirror
   * (`customers`/`customer_identifiers`) is current — reusing the SAME idempotent
   * `synchronizeLegacyIdentity` the live `identify()` bridge already calls (Order
   * 040). Safe to run repeatedly/incrementally (a full sweep, not a one-shot).
   *
   * Collision preflight: before mirroring a canonical, checks whether the v2 table
   * already holds one of its identifiers under a DIFFERENT owner (only possible if
   * a v2-native `attachIdentifier` call raced ahead of this backfill). On collision,
   * that ONE canonical is skipped (fails closed) and an `identity_conflicts` row is
   * recorded instead of overwriting or guessing — every other canonical in the sweep
   * still proceeds.
   */
  async backfillLegacyIdentity(workspaceId: string): Promise<BackfillResult> {
    const [links, merges] = await Promise.all([
      this.db.select().from(identityLinks).where(eq(identityLinks.workspaceId, workspaceId)),
      this.db.select().from(identityMerges).where(eq(identityMerges.workspaceId, workspaceId)),
    ]);

    const byCanonical = new Map<string, typeof links>();
    for (const link of links) {
      const arr = byCanonical.get(link.canonicalId) ?? [];
      arr.push(link);
      byCanonical.set(link.canonicalId, arr);
    }
    const mergedFromByCanonical = new Map<string, string[]>();
    for (const m of merges) {
      const arr = mergedFromByCanonical.get(m.canonicalId) ?? [];
      if (!arr.includes(m.mergedFrom)) arr.push(m.mergedFrom);
      mergedFromByCanonical.set(m.canonicalId, arr);
    }

    let reconciled = 0;
    let skipped = 0;
    const collisions: BackfillCollision[] = [];

    for (const [canonicalId, rows] of byCanonical) {
      let collided = false;
      for (const row of rows) {
        const owner = await this.findOwner(workspaceId, LEGACY_IDENTITY_NAMESPACE, row.identifierType, row.identifier);
        if (owner && owner !== canonicalId) {
          collided = true;
          collisions.push({ canonicalId, identifierType: row.identifierType, identifierValue: row.identifier, conflictingOwnerId: owner });
          await this.recordConflict({
            workspaceId,
            existingCustomerId: owner,
            incomingCustomerId: canonicalId,
            providerNamespace: LEGACY_IDENTITY_NAMESPACE,
            identifierType: row.identifierType,
            identifierValue: row.identifier,
            reason: 'legacy_backfill_collision',
            sourceNamespace: 'identity-graph-v2-backfill',
            evidence: { note: 'v1 identity_links canonical could not be safely mirrored into v2 customer_identifiers' },
            detectedAt: new Date(),
          });
        }
      }

      if (collided) {
        skipped++;
        continue;
      }

      const refs = rows.map((r) => ({ identifier: r.identifier, type: r.identifierType }));
      const mergedFrom = mergedFromByCanonical.get(canonicalId) ?? [];
      const firstSeen = rows.reduce((min, r) => (r.firstSeen < min ? r.firstSeen : min), rows[0]!.firstSeen);
      await this.customerContext.synchronizeLegacyIdentity(workspaceId, canonicalId, refs, mergedFrom, firstSeen);
      reconciled++;
    }

    return {
      workspaceId,
      canonicalsProcessed: byCanonical.size,
      canonicalsReconciled: reconciled,
      canonicalsSkippedForCollision: skipped,
      collisions,
    };
  }
}
