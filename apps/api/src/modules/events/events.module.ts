import { Module } from '@nestjs/common';
import { EventsController } from './events.controller';
import { EventsQueryController } from './events-query.controller';
import { ApiKeysController } from './api-keys.controller';
import { EventsService } from './events.service';
import { ApiKeysService } from './api-keys.service';
import { KafkaProducerService } from './kafka.producer';
import { ApiKeyGuard } from './guards/api-key.guard';
import { RateLimitGuard } from './guards/rate-limit.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

/**
 * M2 — EVENT PIPELINE (lado da API).
 *
 * Integração: adicionar `EventsModule` aos imports do AppModule na onda de
 * integração (não editado aqui p/ evitar conflito com módulos paralelos).
 *
 * Guards são providers p/ o Nest resolvê-los ao usar as classes em @UseGuards.
 * Eles não têm dependências injetadas (usam helpers memoizados em infra.ts), então
 * outros módulos podem importar `ApiKeyGuard` deste caminho e usá-lo diretamente.
 */
@Module({
  controllers: [EventsController, EventsQueryController, ApiKeysController],
  providers: [
    EventsService,
    ApiKeysService,
    KafkaProducerService,
    ApiKeyGuard,
    RateLimitGuard,
    JwtAuthGuard,
  ],
  exports: [KafkaProducerService, ApiKeyGuard],
})
export class EventsModule {}
