import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IdentityModule } from '../identity/identity.module';
import { CustomerContextModule } from '../customer-context/customer-context.module';
import { RadarsModule } from '../radars/radars.module';
import { OpportunitiesModule } from '../opportunities/opportunities.module';
import { DecisionsModule } from '../decisions/decisions.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { QaDemoWorkspaceService } from './qa-demo-workspace.service';

@Module({
  imports: [
    AuthModule,
    IdentityModule,
    CustomerContextModule,
    RadarsModule,
    OpportunitiesModule,
    DecisionsModule,
    ConnectorsModule,
  ],
  providers: [QaDemoWorkspaceService],
  exports: [QaDemoWorkspaceService],
})
export class QaDemoModule {}
