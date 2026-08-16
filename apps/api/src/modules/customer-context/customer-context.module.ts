import { Module } from '@nestjs/common';
import { CustomerContextService } from './customer-context.service';
import { ActivationGuardService } from './activation-guard.service';
import { EventProjectionService } from './event-projection.service';
import { ContextProjectionInternalController } from './context-projection-internal.controller';

@Module({
  controllers: [ContextProjectionInternalController],
  providers: [CustomerContextService, ActivationGuardService, EventProjectionService],
  exports: [CustomerContextService, ActivationGuardService, EventProjectionService],
})
export class CustomerContextModule {}
