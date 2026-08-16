import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { customers, customerOutcomes, outcomeDefinitions, type ContextProvenance } from '@truvo/db';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { findOutcomeProjectionRule } from './outcome-projection.registry';

/** sourceNamespace usado pelas linhas que este projetor escreve (catálogo + observação). */
export const PROJECTION_SOURCE_NAMESPACE = 'truvo.projection';

/** Subconjunto do TruvoEvent que a projeção precisa — não o evento inteiro (a
 * validação completa do EventSchema já aconteceu na ingestão/M2). */
export interface ProjectableEvent {
  event_id: string;
  event_name: string;
  order_id?: string;
  timestamp?: string;
  properties: Record<string, unknown>;
}

export interface ProjectionResult {
  projected: boolean;
  reason?: string;
  outcomeId?: string;
  /** true quando a linha JÁ existia (replay/retry do mesmo evento) — não é erro. */
  deduped?: boolean;
}

function deterministicId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('')).digest('hex').slice(0, 32)}`;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Order 040 §1/§2 — camada de projeção determinística evento→contexto canônico.
 *
 * Pré-condição do chamador (ver `apps/consumer/src/consumer.ts`): `canonicalId` já
 * foi resolvido por um `identify()` (M8) bem-sucedido, que sempre grava a linha
 * espelho em `customers` via `synchronizeLegacyIdentity` ANTES de responder — logo,
 * a FK de `customer_outcomes` para `customers` já está satisfeita quando este
 * método roda. Esta camada NUNCA resolve identidade sozinha (Identity Graph v2 fora
 * de escopo) e NUNCA toca o evento original no ClickHouse.
 */
@Injectable()
export class EventProjectionService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async project(workspaceId: string, canonicalId: string, event: ProjectableEvent): Promise<ProjectionResult> {
    const rule = findOutcomeProjectionRule(event.event_name);
    if (!rule) return { projected: false, reason: 'no_matching_rule' };

    const dedupeKey = (rule.dedupeFrom === 'order_id' ? event.order_id : undefined) ?? event.event_id;
    const observedAt = event.timestamp ? new Date(event.timestamp) : new Date();
    if (Number.isNaN(observedAt.getTime())) return { projected: false, reason: 'invalid_timestamp' };

    // Order 055 §3: fail closed — never write NEW outcome/trait data under a
    // canonical id whose customer row has been tombstoned (deleted subject). A
    // replayed historical event for a deleted person must not silently reappear
    // as fresh canonical data.
    const [customer] = await this.db
      .select({ deletedAt: customers.deletedAt })
      .from(customers)
      .where(and(eq(customers.workspaceId, workspaceId), eq(customers.id, canonicalId)))
      .limit(1);
    if (!customer || customer.deletedAt !== null) {
      return { projected: false, reason: 'customer_suppressed' };
    }

    // 1. garante a entrada de catálogo (idempotente — onConflictDoNothing na chave natural).
    const definitionId = deterministicId('ocd', workspaceId, rule.outcomeNamespace, rule.outcomeKey);
    await this.db
      .insert(outcomeDefinitions)
      .values({
        workspaceId,
        id: definitionId,
        outcomeNamespace: rule.outcomeNamespace,
        outcomeKey: rule.outcomeKey,
        name: rule.name,
        kind: 'event',
        definition: {
          event_name: rule.eventName,
          value_property: rule.valueProperty,
          currency_property: rule.currencyProperty,
        },
        sourceNamespace: PROJECTION_SOURCE_NAMESPACE,
      })
      .onConflictDoNothing({
        target: [outcomeDefinitions.workspaceId, outcomeDefinitions.outcomeNamespace, outcomeDefinitions.outcomeKey],
      });

    // 2. registra a observação — id determinístico a partir da dedupeKey: reprocessar
    // o MESMO evento (ou o mesmo order_id vindo de outra fonte já perdida no dedup do
    // M2) sempre resolve para a MESMA linha; a unique index torna o replay um no-op.
    const outcomeId = deterministicId('oco', workspaceId, rule.outcomeNamespace, rule.outcomeKey, dedupeKey);
    const value = asNumber(event.properties[rule.valueProperty]);
    const currency = asString(event.properties[rule.currencyProperty]);

    const inserted = await this.db
      .insert(customerOutcomes)
      .values({
        workspaceId,
        id: outcomeId,
        customerId: canonicalId,
        outcomeDefinitionId: definitionId,
        outcomeNamespace: rule.outcomeNamespace,
        outcomeKey: rule.outcomeKey,
        dedupeKey,
        eventId: event.event_id,
        value: value !== undefined ? value.toString() : null,
        currency: currency ?? null,
        sourceNamespace: PROJECTION_SOURCE_NAMESPACE,
        provenance: { source_record_id: event.event_id } as ContextProvenance,
        observedAt,
      })
      .onConflictDoNothing({
        target: [
          customerOutcomes.workspaceId,
          customerOutcomes.outcomeNamespace,
          customerOutcomes.outcomeKey,
          customerOutcomes.dedupeKey,
        ],
      })
      .returning({ id: customerOutcomes.id });

    return { projected: true, outcomeId, deduped: inserted.length === 0 };
  }
}
