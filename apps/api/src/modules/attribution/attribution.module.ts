import { Module } from '@nestjs/common';
import { AttributionController } from './attribution.controller';
import { AttributionService } from './attribution.service';
import { AD_SPEND_PROVIDER, UnavailableAdSpendProvider } from './ad-spend.provider';

/**
 * M7 — ATTRIBUTION ENGINE.
 *
 * Depende do M1 (@Global AuthModule): SupabaseAuthGuard, WorkspaceGuard e o
 * provider DRIZZLE já estão disponíveis sem re-importar (o service injeta DRIZZLE).
 * Lê a tabela ClickHouse `touchpoints` (M8) e `events` (M2) — sempre com
 * workspace_id + is_bot = 0 (regras 1 e 11).
 *
 * DI notável:
 *  - AD_SPEND_PROVIDER → hoje o stub `UnavailableAdSpendProvider` (M10 ausente).
 *    Na integração, o M10 fornece o provider real p/ o MESMO token sem tocar neste
 *    módulo (mesmo padrão do M14 / PLATFORM_METRICS_PROVIDER).
 *
 * INTEGRAÇÃO: adicionar `AttributionModule` aos imports do AppModule (app.module.ts)
 * na onda de integração — ver StructuredOutput.nestModules. NÃO editado aqui p/
 * evitar conflito com módulos paralelos.
 */
@Module({
  controllers: [AttributionController],
  providers: [
    AttributionService,
    { provide: AD_SPEND_PROVIDER, useClass: UnavailableAdSpendProvider },
  ],
  exports: [AttributionService],
})
export class AttributionModule {}
