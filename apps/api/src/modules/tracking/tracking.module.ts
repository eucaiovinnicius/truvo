import { Module } from '@nestjs/common';
import { TrackingService } from './tracking.service';
import { TrackingLinksController } from './tracking-links.controller';
import { RedirectController } from './redirect.controller';
import { WorkspaceAuthGuard } from './guards/workspace-auth.guard';

/**
 * M3 — Tracking Layer.
 * INTEGRAÇÃO: adicionar `TrackingModule` aos imports de AppModule (app.module.ts)
 * durante a integração — ver StructuredOutput.nestModules.
 */
@Module({
  controllers: [TrackingLinksController, RedirectController],
  providers: [TrackingService, WorkspaceAuthGuard],
  exports: [TrackingService],
})
export class TrackingModule {}
