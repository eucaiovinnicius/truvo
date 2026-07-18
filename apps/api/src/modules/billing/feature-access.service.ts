import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { subscriptions, type PlanId } from '@truvo/db';
import { DRIZZLE, type Database } from '../auth/database.provider';
import type { WorkspaceRole } from '../auth/roles';
import { canAccessFeature, featuresForPlan, type Feature } from './feature-gates';
import { defaultPlan, isEntitledStatus, isPlanId } from './plans';

/**
 * FeatureAccessService — API programática dos FEATURE GATES do M11.
 *
 * Exportado pelo BillingModule para OUTROS módulos injetarem quando precisam
 * decidir acesso a feature FORA de um guard de rota (ex.: M16 mostrar/ocultar o
 * modo SQL, M17 orçar tokens, M10 liberar creative_analytics). Para gatear ROTAS,
 * prefira o {@link FeatureGuard} + @RequireFeature.
 *
 * Wiring TODO: os módulos consumidores importam este service na onda de
 * integração (não editados aqui — contrato de arquivos).
 */
@Injectable()
export class FeatureAccessService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * O workspace tem acesso à feature? Combina o gate de PLANO com o gate de ROLE
   * (features role-gated exigem owner/admin). Fail-closed em qualquer incerteza.
   */
  async canAccess(
    workspaceId: string,
    feature: Feature,
    role?: WorkspaceRole,
  ): Promise<boolean> {
    const { plan } = await this.resolvePlan(workspaceId);
    return canAccessFeature(plan, feature, role);
  }

  /** Lista de features acessíveis pelo plano vigente do workspace (para UI/settings). */
  async listFeatures(workspaceId: string): Promise<Feature[]> {
    const { plan } = await this.resolvePlan(workspaceId);
    return featuresForPlan(plan);
  }

  /**
   * Plano efetivo do workspace + status Stripe. Sem assinatura entitled → plano
   * default (fail-closed). Também usado pelo BillingService/UsageService.
   */
  async resolvePlan(
    workspaceId: string,
  ): Promise<{ plan: PlanId; status: string; entitled: boolean }> {
    const rows = await this.db
      .select({ plan: subscriptions.plan, status: subscriptions.status })
      .from(subscriptions)
      .where(eq(subscriptions.workspaceId, workspaceId))
      .limit(1);
    const row = rows[0];
    if (!row) return { plan: defaultPlan(), status: 'none', entitled: false };
    const entitled = isEntitledStatus(row.status);
    const plan = entitled && isPlanId(row.plan) ? row.plan : defaultPlan();
    return { plan, status: row.status, entitled };
  }
}
