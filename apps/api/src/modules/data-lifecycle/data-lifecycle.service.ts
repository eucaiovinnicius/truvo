import { Inject, Injectable, Logger } from '@nestjs/common';
import { ulid } from 'ulid';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  customers,
  customerIdentifiers,
  customerTraits,
  customerRelationships,
  outcomeDefinitions,
  dataLifecycleRequests,
  profileAccessLog,
  type DataLifecycleRequest,
} from '@truvo/db';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { AuditService } from '../audit/audit.service';
import { CustomerContextService } from '../customer-context/customer-context.service';
import { DATA_LIFECYCLE_LINEAGE, type SubjectExportResult, type TombstoneCounts } from './data-lifecycle.contracts';

export interface RequestActor {
  id: string;
  email?: string;
}

/** Linhas por lote no tombstone workspace-wide — bounded, retry-safe (Order 035 §5). */
const BATCH_SIZE = 500;
/** Trava de segurança contra loop infinito em caso de bug/anomalia de dados. */
const MAX_BATCHES = 10_000;

@Injectable()
export class DataLifecycleService {
  private readonly logger = new Logger(DataLifecycleService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly context: CustomerContextService,
    private readonly audit: AuditService,
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

  // ─────────────────────────── subject deletion ───────────────────────────

  /**
   * Tombstone (deleted_at) de UMA pessoa: customer + identifiers + traits +
   * relationships. NÃO toca em outcome_definitions (é config de workspace, não de
   * pessoa) nem em ClickHouse (fora de escopo — ver lineage/Order 55). Idempotente:
   * reexecutar sobre uma pessoa já tombstoned é no-op (WHERE deleted_at IS NULL).
   */
  async requestSubjectDeletion(
    workspaceId: string,
    customerId: string,
    requestedBy: RequestActor,
  ): Promise<{ requestId: string; status: 'completed' | 'failed'; counts: TombstoneCounts }> {
    const id = `dlr_${ulid()}`;
    const now = new Date();
    await this.db.insert(dataLifecycleRequests).values({
      id,
      workspaceId,
      kind: 'subject_deletion',
      targetCustomerId: customerId,
      status: 'running',
      requestedBy: requestedBy.id,
      requestedByEmail: requestedBy.email ?? null,
      startedAt: now,
    });

    let status: 'completed' | 'failed' = 'completed';
    let lastError: string | undefined;
    let counts: TombstoneCounts = { customers: 0, identifiers: 0, traits: 0, relationships: 0, outcomeDefinitions: 0 };
    try {
      counts = await this.tombstoneSubject(workspaceId, customerId);
    } catch (err) {
      status = 'failed';
      lastError = (err as Error).message;
      this.logger.error(`subject_deletion falhou (ws=${workspaceId}, customer=${customerId}): ${lastError}`);
    }

    const completedAt = new Date();
    await this.db.update(dataLifecycleRequests).set({
      status,
      completedAt,
      lastError: lastError ?? null,
      processedCount: counts.customers,
      resultRef: { ...counts },
      updatedAt: completedAt,
    }).where(and(eq(dataLifecycleRequests.workspaceId, workspaceId), eq(dataLifecycleRequests.id, id)));

    await this.audit.record({
      workspaceId,
      category: 'data_lifecycle',
      action: 'data_lifecycle.subject_deletion',
      resourceType: 'customer',
      resourceId: customerId,
      actorUserId: requestedBy.id,
      actorEmail: requestedBy.email,
      metadata: { request_id: id, status, counts },
    });

    return { requestId: id, status, counts };
  }

  private async tombstoneSubject(workspaceId: string, customerId: string): Promise<TombstoneCounts> {
    const now = new Date();
    const [identifiers, traits, relationships, customer] = await Promise.all([
      this.db.update(customerIdentifiers).set({ deletedAt: now, updatedAt: now }).where(and(
        eq(customerIdentifiers.workspaceId, workspaceId), eq(customerIdentifiers.customerId, customerId),
        isNull(customerIdentifiers.deletedAt),
      )).returning({ id: customerIdentifiers.id }),
      this.db.update(customerTraits).set({ deletedAt: now, updatedAt: now }).where(and(
        eq(customerTraits.workspaceId, workspaceId), eq(customerTraits.customerId, customerId),
        isNull(customerTraits.deletedAt),
      )).returning({ id: customerTraits.id }),
      this.db.update(customerRelationships).set({ deletedAt: now, updatedAt: now }).where(and(
        eq(customerRelationships.workspaceId, workspaceId),
        or(eq(customerRelationships.fromCustomerId, customerId), eq(customerRelationships.toCustomerId, customerId)),
        isNull(customerRelationships.deletedAt),
      )).returning({ id: customerRelationships.id }),
      this.db.update(customers).set({ deletedAt: now, updatedAt: now }).where(and(
        eq(customers.workspaceId, workspaceId), eq(customers.id, customerId), isNull(customers.deletedAt),
      )).returning({ id: customers.id }),
    ]);
    return {
      customers: customer.length,
      identifiers: identifiers.length,
      traits: traits.length,
      relationships: relationships.length,
      outcomeDefinitions: 0,
    };
  }

  // ─────────────────────────── workspace deletion ───────────────────────────

  /**
   * Orquestra o tombstone de TODA a customer-context de um workspace, em lotes
   * retry-safe: cada tabela é varrida independentemente até não sobrar linha
   * `deleted_at IS NULL` — se interrompido a qualquer momento, reexecutar retoma
   * exatamente de onde parou (nenhuma tabela depende do estado tombstone de outra).
   * `outcome_definitions` é workspace-level e É tombstoned aqui (só aqui, não em
   * subject_deletion).
   */
  async requestWorkspaceDeletion(
    workspaceId: string,
    requestedBy: RequestActor,
  ): Promise<{ requestId: string; status: 'completed' | 'failed'; counts: TombstoneCounts }> {
    const id = `dlr_${ulid()}`;
    const now = new Date();
    await this.db.insert(dataLifecycleRequests).values({
      id,
      workspaceId,
      kind: 'workspace_deletion',
      targetCustomerId: null,
      status: 'running',
      requestedBy: requestedBy.id,
      requestedByEmail: requestedBy.email ?? null,
      startedAt: now,
    });

    let status: 'completed' | 'failed' = 'completed';
    let lastError: string | undefined;
    let counts: TombstoneCounts = { customers: 0, identifiers: 0, traits: 0, relationships: 0, outcomeDefinitions: 0 };
    try {
      counts = await this.tombstoneWorkspace(workspaceId, id);
    } catch (err) {
      status = 'failed';
      lastError = (err as Error).message;
      this.logger.error(`workspace_deletion falhou (ws=${workspaceId}): ${lastError}`);
    }

    const completedAt = new Date();
    const total = counts.customers + counts.identifiers + counts.traits + counts.relationships + counts.outcomeDefinitions;
    await this.db.update(dataLifecycleRequests).set({
      status,
      completedAt,
      lastError: lastError ?? null,
      processedCount: total,
      resultRef: { ...counts },
      updatedAt: completedAt,
    }).where(and(eq(dataLifecycleRequests.workspaceId, workspaceId), eq(dataLifecycleRequests.id, id)));

    await this.audit.record({
      workspaceId,
      category: 'data_lifecycle',
      action: 'data_lifecycle.workspace_deletion',
      resourceType: 'workspace',
      resourceId: workspaceId,
      actorUserId: requestedBy.id,
      actorEmail: requestedBy.email,
      metadata: { request_id: id, status, counts },
    });

    return { requestId: id, status, counts };
  }

  private async tombstoneWorkspace(workspaceId: string, requestId: string): Promise<TombstoneCounts> {
    const counts: TombstoneCounts = { customers: 0, identifiers: 0, traits: 0, relationships: 0, outcomeDefinitions: 0 };

    counts.identifiers += await this.batchTombstone(customerIdentifiers, workspaceId, requestId, 'identifiers');
    counts.traits += await this.batchTombstone(customerTraits, workspaceId, requestId, 'traits');
    counts.relationships += await this.batchTombstoneRelationships(workspaceId, requestId);
    counts.outcomeDefinitions += await this.batchTombstone(outcomeDefinitions, workspaceId, requestId, 'outcomeDefinitions');
    counts.customers += await this.batchTombstone(customers, workspaceId, requestId, 'customers');

    return counts;
  }

  /** Varre uma tabela workspace-scoped com `deleted_at`/`id` até esvaziar, em lotes.
   * Genérico o bastante para identifiers/traits/customers/outcome_definitions
   * (todas têm `workspace_id`+`id`+`deleted_at`+`updated_at`). */
  private async batchTombstone(
    table: typeof customerIdentifiers | typeof customerTraits | typeof customers | typeof outcomeDefinitions,
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
