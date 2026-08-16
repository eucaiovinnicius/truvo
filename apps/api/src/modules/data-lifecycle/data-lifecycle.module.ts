import { Module } from '@nestjs/common';
import { CustomerContextModule } from '../customer-context/customer-context.module';
import { DataLifecycleService } from './data-lifecycle.service';
import { DataLifecycleController } from './data-lifecycle.controller';

/**
 * Order 035 §5 — DATA LIFECYCLE FOUNDATION. Depende de CustomerContextModule
 * (leitura canônica) e do AuditModule/AuthModule @Global (não reimportados).
 */
@Module({
  imports: [CustomerContextModule],
  controllers: [DataLifecycleController],
  providers: [DataLifecycleService],
  exports: [DataLifecycleService],
})
export class DataLifecycleModule {}
