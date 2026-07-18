import { Module } from '@nestjs/common';
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
