import { Module } from '@nestjs/common';
import { PublicInsightsController } from './public-insights.controller';
import { ExplorerController } from './explorer.controller';
import { InsightsController } from './insights.controller';
import { ExplorerService } from './explorer.service';
import { CatalogService } from './catalog.service';
import { InsightsService } from './insights.service';

/**
 * M16 — DATA EXPLORER (motor de query próprio).
 *
 * INTEGRAÇÃO: adicionar `DataExplorerModule` aos imports de AppModule
 * (apps/api/src/app.module.ts) na onda de integração — ver StructuredOutput.
 * nestModules. NÃO editado aqui p/ evitar conflito com módulos paralelos.
 *
 * Depende da infra @Global do M1 (AuthModule): DRIZZLE + SupabaseAuthGuard +
 * WorkspaceGuard. Lê o ClickHouse (compilador injeta workspace_id + is_bot=0 +
 * janela — regra 19). Persiste insights/versões/shares/catálogo no Postgres.
 *
 * PublicInsightsController vem PRIMEIRO p/ garantir que `public/:token` seja
 * registrado antes das rotas dinâmicas `:insightId` (Express casa por ordem).
 */
@Module({
  controllers: [PublicInsightsController, ExplorerController, InsightsController],
  providers: [ExplorerService, CatalogService, InsightsService],
  exports: [ExplorerService, CatalogService, InsightsService],
})
export class DataExplorerModule {}
