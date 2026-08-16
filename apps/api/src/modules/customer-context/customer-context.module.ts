import { Module } from '@nestjs/common';
import { CustomerContextService } from './customer-context.service';

@Module({
  providers: [CustomerContextService],
  exports: [CustomerContextService],
})
export class CustomerContextModule {}
