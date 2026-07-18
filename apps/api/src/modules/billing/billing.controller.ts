import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { WorkspaceGuard } from '../auth/guards/workspace.guard';
import { CurrentUser, CurrentWorkspace, Roles } from '../auth/decorators';
import { BillingService } from './billing.service';
import { createCheckoutSchema, type CreateCheckoutDto } from './dto/billing.dto';

/**
 * M11 — BILLING (PRD §7 M11).
 *
 * Auth (reuso do M1): SupabaseAuthGuard no controller (autentica). As rotas que
 * tocam o workspace/Stripe adicionam o WorkspaceGuard (resolve o tenant via header
 * `x-workspace-id`, regra 1). Gerenciar billing é ação de OWNER (matriz de
 * permissões do M1) → `@Roles('owner')` no checkout/portal; a leitura de
 * `/subscription` é liberada para qualquer membro (viewData).
 */
@Controller('v1/billing')
@UseGuards(SupabaseAuthGuard)
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /** GET /v1/billing/plans — catálogo de planos (preços/limites/features). */
  @Get('plans')
  getPlans() {
    return this.billing.getCatalog();
  }

  /** GET /v1/billing/subscription — plano + status + consumo do mês. */
  @Get('subscription')
  @UseGuards(WorkspaceGuard)
  getSubscription(@CurrentWorkspace('id') workspaceId: string) {
    return this.billing.getSubscriptionView(workspaceId);
  }

  /** POST /v1/billing/checkout — cria Checkout Session de upgrade (owner). */
  @Post('checkout')
  @UseGuards(WorkspaceGuard)
  @Roles('owner')
  createCheckout(
    @CurrentWorkspace('id') workspaceId: string,
    @CurrentUser('email') email: string | undefined,
    @Body(new ZodValidationPipe(createCheckoutSchema)) dto: CreateCheckoutDto,
  ) {
    return this.billing.createCheckout(workspaceId, email, dto);
  }

  /** GET /v1/billing/portal — abre o Customer Portal do Stripe (owner). */
  @Get('portal')
  @UseGuards(WorkspaceGuard)
  @Roles('owner')
  getPortal(@CurrentWorkspace('id') workspaceId: string) {
    return this.billing.createPortal(workspaceId);
  }
}
