import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  InternalServerErrorException,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import Stripe from 'stripe';
import { BillingService } from './billing.service';
import { getStripe, isStripeConfigured, stripeWebhookSecret } from './infra';

/**
 * M11 — Webhook do Stripe (billing). `POST /v1/webhooks/stripe-billing`.
 *
 * SEM guards de auth: a autenticidade vem da ASSINATURA do Stripe
 * (`stripe-signature`), verificada com STRIPE_WEBHOOK_SECRET sobre o RAW body
 * (habilitado por `rawBody: true` no main.ts — Nest expõe `req.rawBody`). Fail-
 * closed: sem chave/segredo → 503; assinatura inválida → 400.
 *
 * Erros de PROCESSAMENTO retornam 5xx de propósito para o Stripe re-tentar
 * (o handler é idempotente — upsert por workspace).
 */
@Controller('v1/webhooks')
export class BillingWebhookController {
  private readonly logger = new Logger(BillingWebhookController.name);

  constructor(private readonly billing: BillingService) {}

  @Post('stripe-billing')
  @HttpCode(200)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature?: string,
  ): Promise<{ received: true }> {
    if (!isStripeConfigured()) {
      throw new ServiceUnavailableException('Billing indisponível: STRIPE_SECRET_KEY ausente.');
    }
    const secret = stripeWebhookSecret();
    if (!secret) {
      // TODO(live): configurar STRIPE_WEBHOOK_SECRET (endpoint stripe-billing).
      throw new ServiceUnavailableException('STRIPE_WEBHOOK_SECRET não configurado.');
    }
    const raw = req.rawBody;
    if (!raw) {
      throw new BadRequestException('raw body ausente — `rawBody: true` no main.ts é obrigatório.');
    }
    if (!signature) {
      throw new BadRequestException('header stripe-signature ausente.');
    }

    let event: Stripe.Event;
    try {
      event = getStripe().webhooks.constructEvent(raw, signature, secret);
    } catch (err) {
      // Assinatura inválida/adulterada → 400 (Stripe não re-tenta 4xx).
      throw new BadRequestException(`assinatura Stripe inválida: ${(err as Error).message}`);
    }

    try {
      await this.billing.handleStripeEvent(event);
    } catch (err) {
      this.logger.error(`falha ao processar ${event.type} (${event.id}): ${(err as Error).message}`);
      // 5xx → Stripe re-tenta com backoff.
      throw new InternalServerErrorException('falha ao processar evento de billing');
    }

    return { received: true };
  }
}
