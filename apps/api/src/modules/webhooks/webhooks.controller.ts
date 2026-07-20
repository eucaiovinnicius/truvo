import { Controller, HttpCode, Post, RawBodyRequest, Req } from '@nestjs/common';
import type { Request } from 'express';
import { WebhooksService, type WebhookResult } from './webhooks.service';

/**
 * Receptores de webhook (PRD §7 M4). Chamados pelos gateways externos.
 *
 * Cada endpoint verifica HMAC-SHA256 ANTES de processar (regra 6), normaliza
 * para o EventSchema e publica no Kafka (`truvo.events`). Sempre respondem 200
 * rápido quando aceitos/ignorados; 401 em assinatura inválida; 404 se a
 * integração não for resolvida (regra 9: processamento assíncrono via Kafka).
 *
 * A integração é resolvida por `?integration_id=<id>` na URL registrada no
 * provedor ou por identificador externo (ex.: `X-Shopify-Shop-Domain`).
 */
@Controller('v1/webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post('shopify')
  @HttpCode(200)
  shopify(@Req() req: RawBodyRequest<Request>): Promise<WebhookResult> {
    return this.webhooks.handleIncoming('shopify', req);
  }

  @Post('stripe')
  @HttpCode(200)
  stripe(@Req() req: RawBodyRequest<Request>): Promise<WebhookResult> {
    return this.webhooks.handleIncoming('stripe', req);
  }

  @Post('hotmart')
  @HttpCode(200)
  hotmart(@Req() req: RawBodyRequest<Request>): Promise<WebhookResult> {
    return this.webhooks.handleIncoming('hotmart', req);
  }

  @Post('kiwify')
  @HttpCode(200)
  kiwify(@Req() req: RawBodyRequest<Request>): Promise<WebhookResult> {
    return this.webhooks.handleIncoming('kiwify', req);
  }

  @Post('hubspot')
  @HttpCode(200)
  hubspot(@Req() req: RawBodyRequest<Request>): Promise<WebhookResult> {
    return this.webhooks.handleIncoming('hubspot', req);
  }
}
