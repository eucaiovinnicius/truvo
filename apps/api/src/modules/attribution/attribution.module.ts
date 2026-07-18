import { Module } from '@nestjs/common';
import { CreativesModule } from '../creatives/creatives.module';
import { AttributionController } from './attribution.controller';
import { AttributionService } from './attribution.service';

/**
 * M7 — ATTRIBUTION ENGINE.
 *
 * Depende do M1 (@Global AuthModule): SupabaseAuthGuard, WorkspaceGuard e DRIZZLE.
 * Lê ClickHouse `touchpoints` (M8) e `events` (M2) — sempre workspace_id + is_bot=0.
 *
 * DI: AD_SPEND_PROVIDER é fornecido pelo M10 (CreativesModule exporta o token via
 * useExisting → CreativeAdSpendProvider). Importamos CreativesModule para que o
 * AttributionService receba o provider REAL (spend/ROAS/CAC). Sem ciclo: CreativesModule
 * só importa o arquivo-símbolo ../attribution/ad-spend.provider, não este módulo.
 */
@Module({
  imports: [CreativesModule],
  controllers: [AttributionController],
  providers: [AttributionService],
  exports: [AttributionService],
})
export class AttributionModule {}
