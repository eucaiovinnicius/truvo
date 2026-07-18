import { Injectable, Logger } from '@nestjs/common';
import type { Funnel, FunnelAlert } from '@truvo/db';

/**
 * Resultado da avaliação de um alerta de funil (conversão < X%).
 * `breached = true` quando o alerta está ligado E a conversão observada caiu
 * abaixo do limiar configurado.
 */
export interface AlertEvaluation {
  funnel_id: string;
  workspace_id: string;
  enabled: boolean;
  breached: boolean;
  threshold: number;
  observed_conversion_rate: number;
  channels: Array<'email' | 'slack' | 'in_app'>;
}

/** Payload de notificação entregue ao M12 (onda futura). */
export interface FunnelAlertNotification {
  type: 'funnel.conversion_below_threshold';
  workspace_id: string;
  funnel_id: string;
  funnel_name: string;
  threshold: number;
  observed_conversion_rate: number;
  channels: Array<'email' | 'slack' | 'in_app'>;
  triggered_at: string;
}

/**
 * M5 — Alertas de funil. Responsável por AVALIAR o gatilho (conversão abaixo do
 * limiar) e MONTAR o payload de notificação. A ENTREGA (e-mail/Slack/in-app) é
 * do M12 — Notificações & Alertas (onda futura): aqui só estruturamos e
 * publicamos o evento; `dispatch` marca o ponto de integração.
 */
@Injectable()
export class FunnelAlertsService {
  private readonly logger = new Logger(FunnelAlertsService.name);

  /** Avalia se a conversão observada rompe o limiar configurado no funil. */
  evaluate(funnel: Pick<Funnel, 'id' | 'workspaceId' | 'alert'>, observedConversionRate: number): AlertEvaluation {
    const alert: FunnelAlert = funnel.alert ?? { enabled: false, min_overall_conversion_rate: 0 };
    const enabled = Boolean(alert.enabled);
    const threshold = alert.min_overall_conversion_rate ?? 0;
    return {
      funnel_id: funnel.id,
      workspace_id: funnel.workspaceId,
      enabled,
      breached: enabled && observedConversionRate < threshold,
      threshold,
      observed_conversion_rate: observedConversionRate,
      channels: alert.channels ?? ['in_app'],
    };
  }

  /**
   * Dispara a notificação de um alerta rompido. Hoje: monta o payload e loga.
   *
   * TODO(live): integrar com o M12 (Notificações & Alertas) — publicar em
   * `truvo.notifications` (Kafka) ou chamar NotificationsService quando existir.
   * O M12 resolve destinatários por `channels` e aplica de-dup/rate-limit.
   */
  async dispatch(evaluation: AlertEvaluation, funnelName: string): Promise<FunnelAlertNotification | null> {
    if (!evaluation.breached) return null;

    const notification: FunnelAlertNotification = {
      type: 'funnel.conversion_below_threshold',
      workspace_id: evaluation.workspace_id,
      funnel_id: evaluation.funnel_id,
      funnel_name: funnelName,
      threshold: evaluation.threshold,
      observed_conversion_rate: evaluation.observed_conversion_rate,
      channels: evaluation.channels,
      triggered_at: new Date().toISOString(),
    };

    // TODO(live): substituir por publish no M12. Por ora, apenas registramos.
    this.logger.warn(
      `ALERTA funil ${notification.funnel_id}: conversão ${notification.observed_conversion_rate}% < ${notification.threshold}% (ws=${notification.workspace_id})`,
    );
    return notification;
  }
}
