import { Module } from '@nestjs/common';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { KafkaProducerService } from './kafka-producer.service';
import { RateLimiterService } from './rate-limiter.service';
import { WebhookRetryService } from './retry/webhook-retry.service';
import { WorkspaceAuthGuard } from './guards/workspace-auth.guard';
import { databaseProvider } from './webhooks.providers';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

/**
 * M4 — WEBHOOK RECEIVERS.
 *
 * INTEGRAÇÃO: registrar em apps/api/src/app.module.ts →
 *   imports: [ ..., WebhooksModule ]
 * (app.module.ts não é editado por este módulo — ver nestModules no output).
 *
 * Também recomendado no bootstrap (apps/api/src/main.ts):
 *   NestFactory.create(AppModule, { rawBody: true })  // HMAC byte-exato.
 */
@Module({
  controllers: [WebhooksController, IntegrationsController],
  providers: [
    databaseProvider,
    KafkaProducerService,
    RateLimiterService,
    WebhooksService,
    IntegrationsService,
    WebhookRetryService,
    WorkspaceAuthGuard,
  ],
  exports: [KafkaProducerService],
})
export class WebhooksModule {}
