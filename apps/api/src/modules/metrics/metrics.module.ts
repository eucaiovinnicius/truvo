import { Module } from '@nestjs/common';
import { CreativesModule } from '../creatives/creatives.module';
import { MetricsController } from './metrics.controller';
import { KpisController } from './kpis.controller';
import { DashboardsController } from './dashboards.controller';
import { PublicDashboardsController } from './public-dashboards.controller';
import { MetricsService } from './metrics.service';
import { KpisService } from './kpis.service';
import { DashboardsService } from './dashboards.service';
import { WorkspaceScopeGuard } from './guards/workspace-scope.guard';

/**
 * M6 — METRICS / KPI LAYER + DASHBOARD BUILDER.
 *
 * INTEGRAÇÃO: adicionar `MetricsModule` aos imports de AppModule (app.module.ts)
 * na onda de integração — ver StructuredOutput.nestModules. NÃO editado aqui p/
 * evitar conflito com módulos paralelos.
 *
 * Depende de infra @Global do M1 (AuthModule): DRIZZLE + SupabaseAuthGuard.
 * PublicDashboardsController vem primeiro p/ garantir que `public/:token` seja
 * registrado antes das rotas com `:id` (Express casa por ordem de registro).
 */
@Module({
  // CreativesModule (M10) exporta AD_SPEND_PROVIDER (creative_daily) — o MetricsService
  // injeta o token p/ ROAS/CAC/CPL nativos. Sem ciclo: CreativesModule é folha (não
  // importa MetricsModule). Mesmo padrão do AttributionModule (M7).
  imports: [CreativesModule],
  controllers: [
    PublicDashboardsController,
    MetricsController,
    KpisController,
    DashboardsController,
  ],
  providers: [MetricsService, KpisService, DashboardsService, WorkspaceScopeGuard],
  exports: [MetricsService, KpisService, DashboardsService],
})
export class MetricsModule {}
