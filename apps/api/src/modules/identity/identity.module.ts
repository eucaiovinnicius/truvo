import { Module } from '@nestjs/common';
import { IdentityController } from './identity.controller';
import { IdentityInternalController } from './identity-internal.controller';
import { IdentityService } from './identity.service';
import { InternalAuthGuard } from './guards/internal-auth.guard';
import { CustomerContextModule } from '../customer-context/customer-context.module';

/**
 * M8 — IDENTITY RESOLUTION + DEDUP avançado (lado da API).
 *
 * Depende do AuthModule (@Global) para o provider DRIZZLE e para os guards
 * SupabaseAuthGuard/WorkspaceGuard — nada a re-importar aqui. ClickHouse
 * (touchpoints) e Redis (fila de stitching retroativo) vêm de helpers memoizados
 * (`identity.infra.ts`), sem DI.
 *
 * Integração: adicionar `IdentityModule` aos imports do AppModule na onda de
 * integração (app.module.ts não é editado aqui — contrato de arquivos).
 */
@Module({
  imports: [CustomerContextModule],
  controllers: [IdentityController, IdentityInternalController],
  providers: [IdentityService, InternalAuthGuard],
  exports: [IdentityService],
})
export class IdentityModule {}
