import { Module } from '@nestjs/common';
import { FunnelsController } from './funnels.controller';
import { FunnelsService } from './funnels.service';
import { FunnelCalcService } from './funnel-calc.service';
import { FunnelAlertsService } from './funnel-alerts.service';

/**
 * M5 — FUNNEL ENGINE.
 *
 * Depende do M1 (@Global AuthModule): SupabaseAuthGuard, WorkspaceGuard e o
 * provider DRIZZLE já estão disponíveis sem re-importar (o service injeta DRIZZLE).
 *
 * INTEGRAÇÃO: adicionar `FunnelsModule` aos imports do AppModule (app.module.ts)
 * na onda de integração — ver StructuredOutput.nestModules. Não editado aqui p/
 * evitar conflito com módulos paralelos.
 */
@Module({
  controllers: [FunnelsController],
  providers: [FunnelsService, FunnelCalcService, FunnelAlertsService],
  exports: [FunnelsService, FunnelCalcService, FunnelAlertsService],
})
export class FunnelsModule {}
