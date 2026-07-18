import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { subscriptions, usageRecords, type PlanId } from '@truvo/db';
import { DRIZZLE, type Database } from '../auth/database.provider';
import { getRedis, getStripe, isStripeConfigured } from './infra';
import { eventsIncludedForPlan } from './plans';

/** Resumo de consumo de eventos do mês vigente (para /subscription + alertas). */
export interface UsageSummary {
  periodMonth: string;
  eventsUsed: number;
  eventsIncluded: number | null;
  overage: number;
  usagePct: number | null;
  /** Cruzou o limiar de alerta de aproximação (BILLING_USAGE_ALERT_THRESHOLD)? */
  approachingLimit: boolean;
}

/**
 * M11 — metering de eventos e excedente.
 *
 * Fonte do consumo: o CONTADOR MENSAL do M2 no Redis
 * (`billing:events:{workspace_id}:{YYYYMM}`, incrementado só por eventos não-bot —
 * regra 11). Aqui apenas LEMOS esse contador; nunca reingerimos.
 *
 * Excedente → Stripe Usage Records (metered). É fail-closed: sem item metered
 * configurado na assinatura (STRIPE_PRICE_*_METERED / webhook), gravamos a linha
 * de auditoria em `usage_records` mas NÃO enviamos (TODO(live)).
 */
@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);
  private readonly alertThreshold = clampFraction(
    Number(process.env.BILLING_USAGE_ALERT_THRESHOLD ?? 0.8),
    0.8,
  );

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Mês de competência atual no formato YYYYMM (UTC) — casa com a chave do M2. */
  currentPeriodMonth(now: Date = new Date()): string {
    return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  /**
   * Eventos não-bot contabilizados no mês (contador Redis do M2). Fail-soft: se o
   * Redis estiver indisponível, retorna 0 e loga (não derruba /subscription).
   */
  async getMonthlyEvents(workspaceId: string, periodMonth?: string): Promise<number> {
    const yyyymm = periodMonth ?? this.currentPeriodMonth();
    const key = `billing:events:${workspaceId}:${yyyymm}`;
    try {
      const raw = await getRedis().get(key);
      const n = raw ? Number.parseInt(raw, 10) : 0;
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch (err) {
      this.logger.warn(`Redis indisponível ao ler ${key}: ${(err as Error).message}`);
      return 0;
    }
  }

  /** Monta o resumo de consumo do mês para um plano/limite. */
  async buildSummary(
    workspaceId: string,
    plan: PlanId,
    eventsIncludedOverride?: number | null,
  ): Promise<UsageSummary> {
    const periodMonth = this.currentPeriodMonth();
    const eventsUsed = await this.getMonthlyEvents(workspaceId, periodMonth);
    const eventsIncluded =
      eventsIncludedOverride !== undefined
        ? eventsIncludedOverride
        : eventsIncludedForPlan(plan);

    const overage =
      eventsIncluded == null ? 0 : Math.max(0, eventsUsed - eventsIncluded);
    const usagePct =
      eventsIncluded == null || eventsIncluded === 0
        ? null
        : round4(eventsUsed / eventsIncluded);
    const approachingLimit =
      usagePct != null && usagePct >= this.alertThreshold && overage === 0;

    return { periodMonth, eventsUsed, eventsIncluded, overage, usagePct, approachingLimit };
  }

  /**
   * Calcula o excedente do mês e (a) faz upsert do registro de auditoria em
   * `usage_records` e (b) — se houver item metered na assinatura e Stripe
   * configurado — envia o Usage Record (action='set': define o total do período).
   *
   * Idempotente por (workspace, mês). Chamado por um job periódico e/ou no fim do
   * ciclo (TODO(live): agendar via cron do M12/infra de jobs).
   */
  async reportOverage(workspaceId: string): Promise<{
    periodMonth: string;
    eventsUsed: number;
    eventsIncluded: number | null;
    overage: number;
    reportedToStripe: boolean;
    stripeUsageRecordId: string | null;
  }> {
    const subRows = await this.db
      .select({
        plan: subscriptions.plan,
        eventsLimit: subscriptions.eventsLimit,
        usageItemId: subscriptions.stripeUsageItemId,
      })
      .from(subscriptions)
      .where(eq(subscriptions.workspaceId, workspaceId))
      .limit(1);
    const sub = subRows[0];

    const eventsIncluded =
      sub?.eventsLimit != null ? sub.eventsLimit : eventsIncludedForPlan(sub?.plan ?? 'starter');

    const periodMonth = this.currentPeriodMonth();
    const eventsUsed = await this.getMonthlyEvents(workspaceId, periodMonth);
    const overage = eventsIncluded == null ? 0 : Math.max(0, eventsUsed - eventsIncluded);

    let reportedToStripe = false;
    let stripeUsageRecordId: string | null = null;

    if (overage > 0 && sub?.usageItemId && isStripeConfigured()) {
      try {
        // TODO(live): exige um Price metered configurado no Stripe + o item na
        // assinatura (stripe_usage_item_id, preenchido pelo webhook). Sem isso,
        // apenas auditamos (fail-closed).
        const rec = await getStripe().subscriptionItems.createUsageRecord(sub.usageItemId, {
          quantity: overage,
          timestamp: Math.floor(Date.now() / 1000),
          action: 'set',
        });
        reportedToStripe = true;
        stripeUsageRecordId = rec.id;
      } catch (err) {
        this.logger.error(
          `Falha ao reportar Usage Record (ws=${workspaceId}, item=${sub.usageItemId}): ${(err as Error).message}`,
        );
      }
    }

    await this.db
      .insert(usageRecords)
      .values({
        id: `ur_${ulid()}`,
        workspaceId,
        periodMonth,
        eventsUsed,
        eventsIncluded: eventsIncluded ?? null,
        overage,
        reportedToStripe,
        stripeUsageRecordId,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [usageRecords.workspaceId, usageRecords.periodMonth],
        set: {
          eventsUsed,
          eventsIncluded: eventsIncluded ?? null,
          overage,
          reportedToStripe,
          stripeUsageRecordId,
          updatedAt: new Date(),
        },
      });

    return {
      periodMonth,
      eventsUsed,
      eventsIncluded: eventsIncluded ?? null,
      overage,
      reportedToStripe,
      stripeUsageRecordId,
    };
  }
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function clampFraction(n: number, fallback: number): number {
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback;
}
