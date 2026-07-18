import { Injectable, Logger } from '@nestjs/common';

/**
 * INTERFACE do roteamento de alertas/notificações. Fonte real: M12 — Serviço de
 * Notificação (onda futura). O M17 encaminha ANOMALIAS detectadas
 * deterministicamente (queda de CVR/receita, incerteza de reconciliação) por aqui —
 * mesmo canal que M5/M10/M14 devem usar.
 *
 * Enquanto o M12 não existe, injetamos {@link UnavailableNotificationProvider}
 * (no-op, sinaliza indisponibilidade). Na integração, o M12 fornece o provider real
 * para o MESMO token de DI sem tocar neste módulo — MESMO padrão do M7
 * (AD_SPEND_PROVIDER) e do M14 (PLATFORM_METRICS_PROVIDER). Ver openTODOs.
 */
export interface NotificationMessage {
  /** Tenant destino (regra 1). */
  workspaceId: string;
  /** Categoria do evento (ex.: 'ai_anomaly'). */
  kind: string;
  severity: 'info' | 'opportunity' | 'warning' | 'critical';
  title: string;
  body: string;
  /** Payload estruturado (só agregados/rótulos — nunca PII). */
  data?: Record<string, unknown>;
}

export interface NotificationProvider {
  /** Roteia uma notificação. No-op silencioso enquanto o M12 não existe. */
  notify(msg: NotificationMessage): Promise<void>;
  /** O serviço de notificação está disponível? (false enquanto M12 não existe.) */
  isAvailable(): boolean;
}

/** Token de DI para o serviço de notificação (M12). */
export const NOTIFICATION_PROVIDER = Symbol('NOTIFICATION_PROVIDER');

/**
 * Stub usado até o M12 existir. Não falha o run (fail-open p/ alertas): loga em
 * debug e descarta. Na integração, o M12 fornece o provider real p/ o MESMO token.
 */
@Injectable()
export class UnavailableNotificationProvider implements NotificationProvider {
  private readonly logger = new Logger(UnavailableNotificationProvider.name);

  // TODO(live): substituir pelo provider real do M12 (Notificação) no wiring de
  // integração — mesmo token NOTIFICATION_PROVIDER, sem tocar neste módulo.
  async notify(msg: NotificationMessage): Promise<void> {
    this.logger.debug(
      `[M12 ausente] alerta descartado ws=${msg.workspaceId} kind=${msg.kind} sev=${msg.severity} title="${msg.title}"`,
    );
  }

  isAvailable(): boolean {
    return false;
  }
}
