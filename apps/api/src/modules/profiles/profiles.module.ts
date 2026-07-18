import { Module } from '@nestjs/common';
import { ProfilesController } from './profiles.controller';
import { ProfilesService } from './profiles.service';
import { ProfileProjectionService } from './profile-projection.service';

/**
 * M15 — CUSTOMER PROFILE / USER 360 (lado da API).
 *
 * Depende do AuthModule (@Global) para o provider DRIZZLE (Postgres: identity_links
 * do M8, projeção user_profiles + profile_access_log do M15) e para os guards
 * SupabaseAuthGuard/WorkspaceGuard — nada a re-importar aqui. ClickHouse (events,
 * touchpoints, reconciliation_daily) vem de um helper memoizado (`profiles.infra.ts`),
 * sem DI — mesmo padrão do M6/M8.
 *
 * INTEGRAÇÃO: adicionar `ProfilesModule` aos imports do AppModule (app.module.ts) na
 * onda de integração — ver StructuredOutput.nestModules. Não editado aqui (contrato
 * de arquivos) para evitar conflito com módulos paralelos.
 */
@Module({
  controllers: [ProfilesController],
  providers: [ProfilesService, ProfileProjectionService],
  exports: [ProfilesService, ProfileProjectionService],
})
export class ProfilesModule {}
