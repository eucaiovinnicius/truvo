import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ulid } from 'ulid';
import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  customers,
  customerIdentifiers,
  customerTraits,
  customerRelationships,
  customerOutcomes,
  outcomeDefinitions,
  dataLifecycleRequests,
  dataLifecycleStoreResults,
  profileAccessLog,
  type DataLifecycleRequest,
  type DataLifecycleStoreResult,
} from '@truvo/db';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { AuditService } from '../audit/audit.service';
import { CustomerContextService } from '../customer-context/customer-context.service';
import { SuppressionService } from '../customer-context/suppression.service';
import { DATA_LIFECYCLE_LINEAGE, type SubjectExportResult, type TombstoneCounts } from './data-lifecycle.contracts';
import { getClickHouse } from './erasure/clickhouse.infra';
import { SUBJECT_ERASURE_STORES, type StoreErasureHandler } from './erasure/subject-erasure.registry';
import { WORKSPACE_ERASURE_EXTRA_STORES, type WorkspaceErasureHandler } from './erasure/workspace-erasure.registry';

export interface RequestActor {
  id: string;
  email?: string;
}

/** Linhas por lote no tombstone workspace-wide — bounded, retry-safe (Order 035 §5). */
const BATCH_SIZE = 500;
/** Trava de segurança contra loop infinito em caso de bug/anomalia de dados. */
const MAX_BATCHES = 10_000;

export type StoreResultView = Record<string, { status: 'completed' | 'failed'; processedCount?: number; error?: string }>;

export interface SubjectDeletionResult {
  requestId: string;
  status: 'completed' | 'failed';
  stores: StoreResultView;
}

function deterministicId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('')).digest('hex').slice(0, 26)}`;
}

@Injectable()
export class DataLifecycleService {
  private readonly logger = new Logger(DataLifecycleService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly context: CustomerContextService,
    private readonly audit: AuditService,
    private readonly suppression: SuppressionService,
  ) {}

  // ─────────────────────────── subject export ───────────────────────────

  /**
   * Execução mínima do export de titular: monta o contexto canônico (Postgres) +
   * as referências de comportamento (ClickHouse, NÃO buscadas aqui — ver lineage).
   * Auditável em dois lugares: `audit_log` (mudança de segurança/admin) e
   * `profile_access_log` (M15, ação 'export' — trilha LGPD já existente e reusada).
   */
  async requestSubjectExport(
    workspaceId: string,
    customerId: string,
    requestedBy: RequestActor,
  ): Promise<SubjectExportResult> {
    const id = `dlr_${ulid()}`;
    const now = new Date();
    await this.db.insert(dataLifecycleRequests).values({
      id,
      workspaceId,
      kind: 'subject_export',
      targetCustomerId: customerId,
      status: 'running',
      requestedBy: requestedBy.id,
      requestedByEmail: requestedBy.email ?? null,
      startedAt: now,
    });

    let context: SubjectExportResult['context'] = null;
    let status: 'completed' | 'failed' = 'completed';
    let lastError: string | undefined;
    try {
      context = await this.context.getContext(workspaceId, customerId);
    } catch (err) {
      status = 'failed';
      lastError = (err as Error).message;
    }

    const completedAt = new Date();
    await this.db.update(dataLifecycleRequests).set({
      status,
      completedAt,
      lastError: lastError ?? null,
      resultRef: context
        ? {
            found: true,
            identifiers: context.identifiers.length,
            traits: context.current_traits.length,
            relationships: context.relationships.length,
            behavior_references: context.behavior_references.length,
          }
        : { found: false },
      updatedAt: completedAt,
    }).where(and(eq(dataLifecycleRequests.workspaceId, workspaceId), eq(dataLifecycleRequests.id, id)));

    // Reusa a trilha LGPD já existente (M15) para o EVENTO de export em si.
    await this.recordProfileAccess(workspaceId, customerId, requestedBy, 'export', { request_id: id, status });

    await this.audit.record({
      workspaceId,
      category: 'data_lifecycle',
      action: 'data_lifecycle.subject_export',
      resourceType: 'customer',
      resourceId: customerId,
      actorUserId: requestedBy.id,
      actorEmail: requestedBy.email,
      metadata: { request_id: id, status },
    });

    return { requestId: id, status, context, lineage: DATA_LIFECYCLE_LINEAGE };
  }

  // ─────────────────────────── subject deletion (Order 055) ───────────────────────────

  /**
   * Order 055 §1/§2 — subject erasure across every store in
   * `SUBJECT_ERASURE_STORES`, tracked per-store in `data_lifecycle_store_results`.
   * Overall `status` is 'completed' ONLY when every required store is 'completed' —
   * never reported completed with a store still failed/pending. On full success,
   * the subject's own identifiers are suppressed (Order 055 §3) so a later replay
   * cannot silently recreate them.
   */
  async requestSubjectDeletion(workspaceId: string, customerId: string, requestedBy: RequestActor): Promise<SubjectDeletionResult> {
    const id = `dlr_${ulid()}`;
    const now = new Date();
    await this.db.insert(dataLifecycleRequests).values({
      id, workspaceId, kind: 'subject_deletion', targetCustomerId: customerId, status: 'running',
      requestedBy: requestedBy.id, requestedByEmail: requestedBy.email ?? null, startedAt: now,
    });

    const outcome = await this.runSubjectErasure(workspaceId, id, customerId, SUBJECT_ERASURE_STORES);
    if (outcome.status === 'completed') {
      await this.suppressSubjectIdentifiers(workspaceId, customerId, id);
    }
    await this.finalizeRequest(workspaceId, id, outcome.status, outcome.stores);

    await this.audit.record({
      workspaceId, category: 'data_lifecycle', action: 'data_lifecycle.subject_deletion',
      resourceType: 'customer', resourceId: customerId,
      actorUserId: requestedBy.id, actorEmail: requestedBy.email,
      metadata: { request_id: id, status: outcome.status, stores: outcome.stores },
    });

    return { requestId: id, status: outcome.status, stores: outcome.stores };
  }

  /**
   * Order 055 §1 — "Retries must resume incomplete stores only." Re-runs ONLY the
   * stores that are not yet 'completed' on an EXISTING request; a store that
   * already succeeded is left untouched (not re-executed, not re-counted).
   */
  async retrySubjectDeletion(workspaceId: string, requestId: string, requestedBy: RequestActor): Promise<SubjectDeletionResult> {
    const request = await this.getRequest(workspaceId, requestId);
    if (!request) throw new NotFoundException('data lifecycle request não encontrado');
    if (request.kind !== 'subject_deletion' || !request.targetCustomerId) {
      throw new BadRequestException('retrySubjectDeletion só se aplica a requests do tipo subject_deletion');
    }
    const customerId = request.targetCustomerId;

    const priorResults = await this.getStoreResults(workspaceId, requestId);
    const incomplete = SUBJECT_ERASURE_STORES.filter((s) => priorResults.find((r) => r.store === s.store)?.status !== 'completed');

    const outcome = incomplete.length > 0
      ? await this.runSubjectErasure(workspaceId, requestId, customerId, incomplete)
      : { status: this.allCompleted(SUBJECT_ERASURE_STORES.map((s) => s.store), priorResults) ? ('completed' as const) : ('failed' as const), stores: this.toStoreView(priorResults) };

    if (outcome.status === 'completed') {
      await this.suppressSubjectIdentifiers(workspaceId, customerId, requestId);
    }
    await this.finalizeRequest(workspaceId, requestId, outcome.status, outcome.stores);

    await this.audit.record({
      workspaceId, category: 'data_lifecycle', action: 'data_lifecycle.subject_deletion_retried',
      resourceType: 'customer', resourceId: customerId,
      actorUserId: requestedBy.id, actorEmail: requestedBy.email,
      metadata: { request_id: requestId, status: outcome.status, stores_retried: incomplete.map((s) => s.store) },
    });

    return { requestId, status: outcome.status, stores: outcome.stores };
  }

  /** Runs the given stores, tracking each in `data_lifecycle_store_results`, then
   * recomputes overall status from the FULL, current set of rows for this request
   * (not just the ones just run) — so a retry that skips already-completed stores
   * still correctly reports 'completed' once every required store is done. */
  private async runSubjectErasure(
    workspaceId: string,
    requestId: string,
    customerId: string,
    stores: ReadonlyArray<{ store: string; handler: StoreErasureHandler }>,
  ): Promise<{ status: 'completed' | 'failed'; stores: StoreResultView }> {
    const ch = getClickHouse();
    for (const { store, handler } of stores) {
      const [existing] = await this.db.select().from(dataLifecycleStoreResults).where(and(
        eq(dataLifecycleStoreResults.workspaceId, workspaceId), eq(dataLifecycleStoreResults.requestId, requestId), eq(dataLifecycleStoreResults.store, store),
      )).limit(1);
      const attempts = (existing?.attempts ?? 0) + 1;
      await this.upsertStoreResult(workspaceId, requestId, store, { status: 'running', attempts, startedAt: existing?.startedAt ?? new Date() });

      try {
        const res = await handler({ db: this.db, ch, workspaceId, customerId });
        if (res.status === 'completed') {
          await this.upsertStoreResult(workspaceId, requestId, store, { status: 'completed', attempts, processedCount: res.processedCount, completedAt: new Date(), lastError: null });
        } else {
          await this.upsertStoreResult(workspaceId, requestId, store, { status: 'failed', attempts, lastError: res.error ?? 'store handler reported failure' });
        }
      } catch (err) {
        this.logger.error(`erasure store '${store}' falhou (ws=${workspaceId}, req=${requestId}): ${(err as Error).message}`);
        await this.upsertStoreResult(workspaceId, requestId, store, { status: 'failed', attempts, lastError: (err as Error).message });
      }
    }

    const allResults = await this.getStoreResults(workspaceId, requestId);
    const requiredStores = [...new Set([...SUBJECT_ERASURE_STORES.map((s) => s.store), ...allResults.map((r) => r.store)])];
    return { status: this.allCompleted(requiredStores, allResults) ? 'completed' : 'failed', stores: this.toStoreView(allResults) };
  }

  private allCompleted(requiredStores: string[], results: DataLifecycleStoreResult[]): boolean {
    return requiredStores.every((store) => results.find((r) => r.store === store)?.status === 'completed');
  }

  private toStoreView(results: DataLifecycleStoreResult[]): StoreResultView {
    const view: StoreResultView = {};
    for (const r of results) {
      view[r.store] = r.status === 'completed'
        ? { status: 'completed', processedCount: r.processedCount }
        : { status: 'failed', error: r.lastError ?? undefined };
    }
    return view;
  }

  private async upsertStoreResult(
    workspaceId: string,
    requestId: string,
    store: string,
    patch: { status: 'running' | 'completed' | 'failed'; attempts: number; startedAt?: Date; completedAt?: Date; processedCount?: number; lastError?: string | null },
  ): Promise<void> {
    const id = deterministicId('dlsr', workspaceId, requestId, store);
    await this.db.insert(dataLifecycleStoreResults).values({
      workspaceId, id, requestId, store,
      status: patch.status, attempts: patch.attempts,
      startedAt: patch.startedAt ?? null, completedAt: patch.completedAt ?? null,
      processedCount: patch.processedCount ?? 0, lastError: patch.lastError ?? null,
    }).onConflictDoUpdate({
      target: [dataLifecycleStoreResults.workspaceId, dataLifecycleStoreResults.requestId, dataLifecycleStoreResults.store],
      set: {
        status: patch.status, attempts: patch.attempts,
        startedAt: patch.startedAt, completedAt: patch.completedAt,
        processedCount: patch.processedCount, lastError: patch.lastError,
        updatedAt: new Date(),
      },
    });
  }

  private async getStoreResults(workspaceId: string, requestId: string): Promise<DataLifecycleStoreResult[]> {
    return this.db.select().from(dataLifecycleStoreResults).where(and(
      eq(dataLifecycleStoreResults.workspaceId, workspaceId), eq(dataLifecycleStoreResults.requestId, requestId),
    ));
  }

  /** Order 055 §3 — suppress every identifier this subject is (or was) known
   * under, INCLUDING already-tombstoned ones, so a replayed historical event
   * cannot silently recreate canonical identity for them. */
  private async suppressSubjectIdentifiers(workspaceId: string, customerId: string, requestId: string): Promise<void> {
    const rows = await this.db.select({
      providerNamespace: customerIdentifiers.providerNamespace,
      identifierType: customerIdentifiers.identifierType,
      identifierValue: customerIdentifiers.identifierValue,
    }).from(customerIdentifiers).where(and(
      eq(customerIdentifiers.workspaceId, workspaceId), eq(customerIdentifiers.customerId, customerId),
    ));
    for (const row of rows) {
      await this.suppression.suppress(workspaceId, row, { reason: 'subject_deletion', sourceRequestId: requestId });
    }
  }

  private async finalizeRequest(workspaceId: string, requestId: string, status: 'completed' | 'failed', stores: StoreResultView): Promise<void> {
    const completedAt = new Date();
    const processedCount = Object.values(stores).reduce((sum, s) => sum + (s.status === 'completed' ? (s.processedCount ?? 0) : 0), 0);
    await this.db.update(dataLifecycleRequests).set({
      status, completedAt, processedCount, resultRef: { stores }, updatedAt: completedAt,
      lastError: status === 'failed' ? Object.entries(stores).find(([, v]) => v.status === 'failed')?.[1]?.error ?? 'one or more stores failed' : null,
    }).where(and(eq(dataLifecycleRequests.workspaceId, workspaceId), eq(dataLifecycleRequests.id, requestId)));
  }

  // ─────────────────────────── workspace deletion ───────────────────────────

  /**
   * Order 055 §4 — completes workspace deletion across every current MVP store.
   * Existing customer-context batch tombstone (Order 035) is preserved as-is;
   * extended with `customer_outcomes` (Order 40) and hard-deletes of the
   * workspace-scoped stores Orders 40/45/50 added afterward (see
   * `workspace-erasure.registry.ts` for why these are hard deletes, not tombstones).
   */
  async requestWorkspaceDeletion(
    workspaceId: string,
    requestedBy: RequestActor,
  ): Promise<{ requestId: string; status: 'completed' | 'failed'; counts: TombstoneCounts; stores: StoreResultView }> {
    const id = `dlr_${ulid()}`;
    const now = new Date();
    await this.db.insert(dataLifecycleRequests).values({
      id, workspaceId, kind: 'workspace_deletion', targetCustomerId: null, status: 'running',
      requestedBy: requestedBy.id, requestedByEmail: requestedBy.email ?? null, startedAt: now,
    });

    let counts: TombstoneCounts = { customers: 0, identifiers: 0, traits: 0, relationships: 0, outcomeDefinitions: 0 };
    let coreFailed = false;
    try {
      counts = await this.tombstoneWorkspace(workspaceId, id);
    } catch (err) {
      coreFailed = true;
      this.logger.error(`workspace_deletion (customer-context) falhou (ws=${workspaceId}): ${(err as Error).message}`);
      await this.upsertStoreResult(workspaceId, id, 'customer_context_ws', { status: 'failed', attempts: 1, lastError: (err as Error).message });
    }
    if (!coreFailed) {
      const total = counts.customers + counts.identifiers + counts.traits + counts.relationships + counts.outcomeDefinitions;
      await this.upsertStoreResult(workspaceId, id, 'customer_context_ws', { status: 'completed', attempts: 1, processedCount: total, completedAt: new Date() });
    }

    const ch = getClickHouse();
    for (const { store, handler } of WORKSPACE_ERASURE_EXTRA_STORES as ReadonlyArray<{ store: string; handler: WorkspaceErasureHandler }>) {
      try {
        const res = await handler({ db: this.db, ch, workspaceId });
        if (res.status === 'completed') {
          await this.upsertStoreResult(workspaceId, id, store, { status: 'completed', attempts: 1, processedCount: res.processedCount, completedAt: new Date() });
        } else {
          await this.upsertStoreResult(workspaceId, id, store, { status: 'failed', attempts: 1, lastError: res.error ?? 'store handler reported failure' });
        }
      } catch (err) {
        this.logger.error(`workspace_deletion store '${store}' falhou (ws=${workspaceId}): ${(err as Error).message}`);
        await this.upsertStoreResult(workspaceId, id, store, { status: 'failed', attempts: 1, lastError: (err as Error).message });
      }
    }

    const allResults = await this.getStoreResults(workspaceId, id);
    const requiredStores = ['customer_context_ws', ...WORKSPACE_ERASURE_EXTRA_STORES.map((s) => s.store)];
    const status: 'completed' | 'failed' = this.allCompleted(requiredStores, allResults) ? 'completed' : 'failed';
    const stores = this.toStoreView(allResults);

    await this.finalizeRequest(workspaceId, id, status, stores);

    await this.audit.record({
      workspaceId, category: 'data_lifecycle', action: 'data_lifecycle.workspace_deletion',
      resourceType: 'workspace', resourceId: workspaceId,
      actorUserId: requestedBy.id, actorEmail: requestedBy.email,
      metadata: { request_id: id, status, counts, stores },
    });

    return { requestId: id, status, counts, stores };
  }

  private async tombstoneWorkspace(workspaceId: string, requestId: string): Promise<TombstoneCounts> {
    const counts: TombstoneCounts = { customers: 0, identifiers: 0, traits: 0, relationships: 0, outcomeDefinitions: 0 };

    counts.identifiers += await this.batchTombstone(customerIdentifiers, workspaceId, requestId, 'identifiers');
    counts.traits += await this.batchTombstone(customerTraits, workspaceId, requestId, 'traits');
    counts.relationships += await this.batchTombstoneRelationships(workspaceId, requestId);
    counts.outcomeDefinitions += await this.batchTombstone(outcomeDefinitions, workspaceId, requestId, 'outcomeDefinitions');
    await this.batchTombstone(customerOutcomes, workspaceId, requestId, 'customerOutcomes');
    counts.customers += await this.batchTombstone(customers, workspaceId, requestId, 'customers');

    return counts;
  }

  /** Varre uma tabela workspace-scoped com `deleted_at`/`id` até esvaziar, em lotes.
   * Genérico o bastante para identifiers/traits/customers/outcome_definitions/customer_outcomes
   * (todas têm `workspace_id`+`id`+`deleted_at`+`updated_at`). */
  private async batchTombstone(
    table: typeof customerIdentifiers | typeof customerTraits | typeof customers | typeof outcomeDefinitions | typeof customerOutcomes,
    workspaceId: string,
    requestId: string,
    label: string,
  ): Promise<number> {
    let processed = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const now = new Date();
      const idsSubquery = this.db
        .select({ id: table.id })
        .from(table)
        .where(and(eq(table.workspaceId, workspaceId), isNull(table.deletedAt)))
        .limit(BATCH_SIZE);
      const updated = await this.db.update(table).set({ deletedAt: now, updatedAt: now }).where(and(
        eq(table.workspaceId, workspaceId),
        inArray(table.id, idsSubquery),
      )).returning({ id: table.id });
      processed += updated.length;
      if (updated.length < BATCH_SIZE) break; // último lote (ou tabela já vazia)
      await this.touchCursor(workspaceId, requestId, `${label}:${processed}`, processed);
    }
    return processed;
  }

  private async batchTombstoneRelationships(workspaceId: string, requestId: string): Promise<number> {
    let processed = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const now = new Date();
      const idsSubquery = this.db
        .select({ id: customerRelationships.id })
        .from(customerRelationships)
        .where(and(eq(customerRelationships.workspaceId, workspaceId), isNull(customerRelationships.deletedAt)))
        .limit(BATCH_SIZE);
      const updated = await this.db.update(customerRelationships).set({ deletedAt: now, updatedAt: now }).where(and(
        eq(customerRelationships.workspaceId, workspaceId),
        inArray(customerRelationships.id, idsSubquery),
      )).returning({ id: customerRelationships.id });
      processed += updated.length;
      if (updated.length < BATCH_SIZE) break;
      await this.touchCursor(workspaceId, requestId, `relationships:${processed}`, processed);
    }
    return processed;
  }

  private async touchCursor(workspaceId: string, requestId: string, cursor: string, processedCount: number): Promise<void> {
    await this.db.update(dataLifecycleRequests).set({ cursor, processedCount, updatedAt: new Date() }).where(and(
      eq(dataLifecycleRequests.workspaceId, workspaceId), eq(dataLifecycleRequests.id, requestId),
    ));
  }

  // ─────────────────────────── leitura (status) ───────────────────────────

  async getRequest(workspaceId: string, requestId: string): Promise<DataLifecycleRequest | null> {
    const [row] = await this.db.select().from(dataLifecycleRequests).where(and(
      eq(dataLifecycleRequests.workspaceId, workspaceId), eq(dataLifecycleRequests.id, requestId),
    )).limit(1);
    return row ?? null;
  }

  private async recordProfileAccess(
    workspaceId: string,
    canonicalId: string,
    actor: RequestActor,
    action: 'export',
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.db.insert(profileAccessLog).values({
        id: `pal_${ulid()}`,
        workspaceId,
        canonicalId,
        accessedBy: actor.id,
        accessedByEmail: actor.email ?? null,
        action,
        metadata,
      });
    } catch (err) {
      this.logger.error(`falha ao registrar profile_access_log (export): ${(err as Error).message}`);
    }
  }
}
