import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingWebhookController } from './webhook.controller';
import { BillingService } from './billing.service';
import { UsageService } from './usage.service';
import { FeatureAccessService } from './feature-access.service';
import { FeatureGuard } from './feature.guard';

/**
 * M11 — BILLING (lado da API). Onda 4 (FINAL).
 *
 * Depende do M1 (@Global AuthModule): SupabaseAuthGuard/WorkspaceGuard e o provider
 * DRIZZLE já estão disponíveis sem re-importar. Consome o CONTADOR MENSAL do M2 no
 * Redis (`billing:events:{workspace_id}:{YYYYMM}`) para metering de excedente.
 *
 * EXPORTA para os demais módulos (FEATURE GATES):
 *  - FeatureGuard (sem DI) + @RequireFeature → gatear ROTAS por plano em QUALQUER
 *    módulo, sem importar o BillingModule (mesmo padrão dos guards do M2). Ex.:
 *    M16 `explorer_sql`, M17 `ai_journey`, M10 `creative_analytics`,
 *    M8 `identity_resolution`.
 *  - FeatureAccessService.canAccess(workspaceId, feature, role?) → checagem
 *    programática fora de rota. Para injetá-lo, o módulo consumidor adiciona
 *    `BillingModule` aos seus imports (wiring TODO — ver openTODOs).
 *
 * INTEGRAÇÃO (onda de wiring — NÃO editados aqui, contrato de arquivos):
 *  - adicionar `BillingModule` aos imports do AppModule (app.module.ts);
 *  - barrel `packages/db/src/schema/index.ts` re-exportar `./billing`
 *    (subscriptions, usageRecords) — ver schemaExports;
 *  - main.ts já tem `rawBody: true` (necessário para o webhook Stripe) — OK.
 */
@Module({
  controllers: [BillingController, BillingWebhookController],
  providers: [BillingService, UsageService, FeatureAccessService, FeatureGuard],
  exports: [FeatureAccessService, FeatureGuard, UsageService],
})
export class BillingModule {}
