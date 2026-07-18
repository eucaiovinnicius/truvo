import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { apiKeys } from '@truvo/db';
import { getDb } from '../infra';
import { sha256 } from '../crypto.util';
import type { AuthenticatedRequest } from '../types';

/**
 * ApiKeyGuard — autentica ingestão via header `X-Api-Key`.
 *
 * Fluxo: lê a chave em claro → SHA-256 (regra 7) → busca `api_keys` ativa →
 * injeta `workspace_id` na request (regra 1: workspace vem SEMPRE do servidor,
 * nunca do corpo do evento). Sem DI: usa helpers memoizados, então outros
 * módulos podem `@UseGuards(ApiKeyGuard)` sem herdar providers do EventsModule.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const raw = req.header('x-api-key') ?? req.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (!raw) {
      throw new UnauthorizedException('Missing X-Api-Key header');
    }

    const hash = sha256(raw.trim());
    const db = getDb();

    const rows = await db
      .select({ id: apiKeys.id, workspaceId: apiKeys.workspaceId })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, hash), eq(apiKeys.status, 'active')))
      .limit(1);

    const key = rows[0];
    if (!key) {
      throw new UnauthorizedException('Invalid or revoked API key');
    }

    req.workspaceId = key.workspaceId;
    req.apiKeyId = key.id;

    // fire-and-forget: marca uso sem bloquear a ingestão (rule 9 — resposta rápida).
    void db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, key.id))
      .catch(() => undefined);

    return true;
  }
}
