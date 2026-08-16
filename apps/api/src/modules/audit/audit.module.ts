import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/**
 * Order 035 §4 — AuditModule. @Global: `AuditService` fica injetável em QUALQUER
 * módulo sem reimportar (mesmo espírito de AuthModule/NotificationsModule) — é o
 * que M1 (workspaces/API keys), M4/M9 (conectores) e o novo módulo de data
 * lifecycle chamam via `record(...)`.
 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
