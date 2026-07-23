import 'reflect-metadata';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { subscriptions, type PlanId } from '@truvo/db';
import type { WorkspaceRole } from '../auth/roles';
import { getDb } from './infra';
import { FEATURE_KEY } from './feature.decorator';
import { canAccessFeature, isFeature, type Feature } from './feature-gates';
import { defaultPlan, isEntitledStatus, isPlanId } from './plans';

/**
 * FeatureGuard — enforce dos FEATURE GATES do M11 (PRD §7 M11).
 *
 * SEM DI (mesmo padrão dos guards do M2): lê a metadata `@RequireFeature(...)` via
 * reflect-metadata e resolve o plano do workspace pelo helper de infra `getDb()`.
 * Assim QUALQUER módulo pode `@UseGuards(SupabaseAuthGuard, WorkspaceGuard,
 * FeatureGuard)` + `@RequireFeature('explorer_sql')` sem importar o BillingModule
 * (wiring TODO nos módulos consumidores — M16/M17/M10/M8).
 *
 * Fail-closed:
 *  - workspace sem assinatura ativa → plano default (menor tier);
 *  - feature role-gated sem role owner/admin → nega;
 *  - erro ao resolver o plano → cai para o plano default: features premium
 *    (explorer_sql/ai_journey/...) então negam com 402, base segue liberada.
 */
@Injectable()
export class FeatureGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required =
      (Reflect.getMetadata(FEATURE_KEY, context.getHandler()) as Feature | undefined) ??
      (Reflect.getMetadata(FEATURE_KEY, context.getClass()) as Feature | undefined);

    // Sem @RequireFeature → nada a gatear.
    if (!required) return true;
    if (!isFeature(required)) {
      // Guard mal configurado — falha fechada (não deixa passar por engano).
      throw new ForbiddenException(`Feature desconhecida no gate: ${String(required)}`);
    }

    const req = context.switchToHttp().getRequest<{
      workspace?: { id: string; role: WorkspaceRole };
    }>();
    const ws = req.workspace;
    if (!ws) {
      // WorkspaceGuard deve rodar antes.
      throw new ForbiddenException('Contexto de workspace ausente (WorkspaceGuard antes do FeatureGuard)');
    }

    const plan = await this.resolvePlan(ws.id);
    if (!canAccessFeature(plan, required, ws.role)) {
      throw new HttpException(
        {
          statusCode: HttpStatus.PAYMENT_REQUIRED,
          error: 'Payment Required',
          message: `Feature "${required}" não está disponível no seu plano (${plan}).`,
          feature: required,
          plan,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    return true;
  }

  /** Plano vigente do workspace; fail-closed para o plano default em qualquer falha. */
  private async resolvePlan(workspaceId: string): Promise<PlanId> {
    try {
      const rows = await getDb()
        .select({ plan: subscriptions.plan, status: subscriptions.status })
        .from(subscriptions)
        .where(eq(subscriptions.workspaceId, workspaceId))
        .limit(1);
      const row = rows[0];
      if (!row) return defaultPlan();
      // Só status "entitled" mantêm o plano pago; senão cai para o default.
      if (!isEntitledStatus(row.status)) return defaultPlan();
      return isPlanId(row.plan) ? row.plan : defaultPlan();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[truvo/api] FeatureGuard resolvePlan fail-closed: ${(err as Error).message}`);
      // Erro de DB NUNCA pode conceder premium: usa o MENOR tier fixo (não o
      // BILLING_DEFAULT_PLAN, que a config poderia ter elevado a agency/enterprise).
      return 'starter';
    }
  }
}
