import { Module } from '@nestjs/common';
import { CustomerContextService } from './customer-context.service';
import { ActivationGuardService } from './activation-guard.service';

@Module({
  providers: [CustomerContextService, ActivationGuardService],
  exports: [CustomerContextService, ActivationGuardService],
})
export class CustomerContextModule {}
