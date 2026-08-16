import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { CreativesModule } from '../creatives/creatives.module';
import { DataQualityModule } from '../data-quality/data-quality.module';
import { DataLifecycleModule } from '../data-lifecycle/data-lifecycle.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { SchedulerService } from './scheduler.service';

/**
 * SCHEDULER — jobs periódicos (billing/alertas/reconciliação/ads-sync/retenção/
 * connector incremental sync) atrás de leader-lock Redis. Importa os módulos donos
 * da lógica (que exportam os services) — folha na DI (ninguém importa este
 * módulo). OFF por padrão (SCHEDULER_ENABLED). Adicionar aos imports do AppModule.
 */
@Module({
  imports: [BillingModule, CreativesModule, DataQualityModule, DataLifecycleModule, ConnectorsModule],
  providers: [SchedulerService],
})
export class SchedulerModule {}
