import { Module } from '@nestjs/common';
import { CustomerContextModule } from '../customer-context/customer-context.module';
import { DataLifecycleService } from './data-lifecycle.service';
import { DataLifecycleController } from './data-lifecycle.controller';
import { RetentionEnforcementService } from './retention-enforcement.service';

/**
 * Order 035 §5 / Order 055 — DATA LIFECYCLE. Depende de CustomerContextModule
 * (leitura canônica + SuppressionService) e do AuditModule/AuthModule @Global (não
 * reimportados). `RetentionEnforcementService` é exportado para o SchedulerModule.
 */
@Module({
  imports: [CustomerContextModule],
  controllers: [DataLifecycleController],
  providers: [DataLifecycleService, RetentionEnforcementService],
  exports: [DataLifecycleService, RetentionEnforcementService],
})
export class DataLifecycleModule {}
