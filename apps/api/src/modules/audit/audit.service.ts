import { Inject, Injectable, Logger } from '@nestjs/common';
import { ulid } from 'ulid';
import { auditLog, type AuditActorType, type AuditMetadata } from '@truvo/db';
import { redact } from '@truvo/observability';
import { DRIZZLE, type Database } from '../auth/database.provider';

export interface AuditRecordInput {
  workspaceId: string;
  category: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  actorType?: AuditActorType;
  actorUserId?: string | null;
  actorEmail?: string | null;
  metadata?: AuditMetadata;
}

/**
 * Order 035 §4 — trilha genérica de mudanças de segurança/admin (membership,
 * ciclo de vida de API key, CRUD de conector, operações destrutivas, config
 * privilegiada). Best-effort: mesmo padrão do `profile_access_log` existente
 * (M15) — auditoria nunca derruba a operação primária por um blip do log.
 *
 * `metadata` passa por `redact()` (`@truvo/observability`) antes de persistir —
 * defesa em profundidade contra PII/segredos acidentalmente incluídos pelo
 * chamador (regra 4/7).
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async record(input: AuditRecordInput): Promise<void> {
    try {
      await this.db.insert(auditLog).values({
        id: `aud_${ulid()}`,
        workspaceId: input.workspaceId,
        category: input.category,
        action: input.action,
        actorType: input.actorType ?? 'user',
        actorUserId: input.actorUserId ?? null,
        actorEmail: input.actorEmail ?? null,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? '',
        metadata: (redact(input.metadata ?? {}) as AuditMetadata) ?? {},
      });
    } catch (err) {
      // Auditoria é obrigatória, mas não deve derrubar a operação primária por um
      // blip do log — mesmo trade-off já aceito em profile_access_log (M15).
      // TODO(Order 55): fallback durável (outbox) + alerta se a trilha falhar.
      this.logger.error(
        `falha ao registrar audit_log (ws=${input.workspaceId}, action=${input.action}): ${(err as Error).message}`,
      );
    }
  }
}
