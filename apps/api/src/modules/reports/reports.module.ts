import { Module } from '@nestjs/common';
import { MetricsModule } from '../metrics/metrics.module';
import { WorkspaceScopeGuard } from '../metrics/guards/workspace-scope.guard';
// REUSO do canal de email do M12 (sem deps injetadas — registrado local p/ o DI instanciar).
import { EmailChannel } from '../notifications/channels/email.channel';
import { PublicReportsController } from './public-reports.controller';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { ReportRenderService } from './report-render.service';
import { ReportDeliveryService } from './report-delivery.service';
import { ReportSchedulerService } from './report-scheduler.service';

/**
 * M13 — RELATÓRIOS (agendados + white-label).
 *
 * Depende do M1 (@Global AuthModule): SupabaseAuthGuard + provider DRIZZLE já disponíveis.
 * Importa o M6 (MetricsModule) p/ REUSAR o DashboardsService — o snapshot congela os dados
 * do dashboard-fonte (ClickHouse, sempre workspace_id + is_bot=0). Reusa também o
 * WorkspaceScopeGuard do M6 (registrado localmente como provider p/ o DI instanciar, já que
 * o MetricsModule não o exporta) — `:id` aqui é o relatório, então o workspace vem do header.
 *
 * PublicReportsController vem PRIMEIRO p/ a rota `public/:token` casar antes de `:id`
 * (Express casa por ordem de registro).
 *
 * INTEGRAÇÃO: adicionar `ReportsModule` aos imports do AppModule (app.module.ts) na onda
 * de integração — ver StructuredOutput.nestModules. Não editado aqui p/ evitar conflito.
 */
@Module({
  imports: [MetricsModule],
  controllers: [PublicReportsController, ReportsController],
  providers: [
    ReportsService,
    ReportRenderService,
    ReportDeliveryService,
    ReportSchedulerService,
    WorkspaceScopeGuard,
    EmailChannel,
  ],
  exports: [ReportsService],
})
export class ReportsModule {}
