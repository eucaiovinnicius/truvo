import { Module } from '@nestjs/common';
import { IntegrationsOutController } from './integrations-out.controller';
import { IntegrationOutConfigService } from './config.service';
import { ConversionForwarderService } from './conversion-forwarder.service';
import { databaseProvider } from './integrations-out.providers';
import {
  conversionClientsProvider,
  GoogleEnhancedClient,
  HubspotClient,
  MetaCapiClient,
  TikTokEventsClient,
} from './clients';

/**
 * M9 — EXTERNAL INTEGRATIONS (SAÍDA DE DADOS).
 *
 * Envio server-side de conversões para Meta CAPI, Google Enhanced Conversions e
 * TikTok Events API (PRD §7 M9). Sem DDL ClickHouse nova — usa Postgres para config
 * e logs (schema/integrations-out.ts).
 *
 * Auth: guards SupabaseAuthGuard/WorkspaceGuard vêm do AuthModule (@Global) — não
 * reprovidos aqui.
 *
 * INTEGRAÇÃO:
 *  1. Adicionar `IntegrationsOutModule` aos imports do AppModule (apps/api/src/
 *     app.module.ts) — NÃO editado por este módulo (contrato de arquivos; ver
 *     `nestModules` no StructuredOutput).
 *  2. Barrel do schema: adicionar `export * from './integrations-out'` em
 *     packages/db/src/schema/index.ts (ver `schemaExports`/`openTODOs`).
 *  3. WIRING do envio: o `ConversionForwarderService` é exportado para o passo de
 *     conversão do consumer/M8 chamar em purchase/lead. Como o consumer é standalone
 *     (não Nest), a onda de integração conecta via Kafka `truvo.conversions.out` +
 *     worker da API, ou extrai o forwarder para um pacote compartilhado
 *     (// TODO(live) — ver openTODOs).
 */
@Module({
  controllers: [IntegrationsOutController],
  providers: [
    databaseProvider,
    IntegrationOutConfigService,
    ConversionForwarderService,
    MetaCapiClient,
    GoogleEnhancedClient,
    TikTokEventsClient,
    HubspotClient,
    conversionClientsProvider,
  ],
  exports: [ConversionForwarderService, IntegrationOutConfigService],
})
export class IntegrationsOutModule {}
