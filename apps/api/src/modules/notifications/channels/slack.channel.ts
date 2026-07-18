import { Injectable, Logger } from '@nestjs/common';
import type { NotificationSeverity } from '@truvo/db';

/**
 * M12 — Canal Slack (incoming webhook por workspace, via fetch nativo).
 *
 * O webhook do Slack é config de WORKSPACE (notification_channels.slackWebhookUrl),
 * não por usuário — o post vai para o canal fixado no webhook. Fail-closed: sem
 * webhook → não envia. Sem libs: `fetch` do Node 20.
 */

const SEVERITY_EMOJI: Record<NotificationSeverity, string> = {
  info: ':information_source:',
  warning: ':warning:',
  critical: ':rotating_light:',
};

export interface SlackMessage {
  title: string;
  body?: string | null;
  severity: NotificationSeverity;
  /** Link "Abrir no Truvo". */
  link?: string | null;
}

@Injectable()
export class SlackChannel {
  private readonly logger = new Logger(SlackChannel.name);

  /**
   * Posta no webhook. Retorna true só em 2xx. Fail-closed: sem webhook ou erro →
   * log + false, sem lançar.
   */
  async send(webhookUrl: string | null | undefined, msg: SlackMessage): Promise<boolean> {
    if (!webhookUrl) {
      this.logger.warn('Slack webhook ausente — pulando envio.');
      return false;
    }
    const emoji = SEVERITY_EMOJI[msg.severity] ?? '';
    const lines = [`${emoji} *${msg.title}*`];
    if (msg.body) lines.push(msg.body);
    if (msg.link) lines.push(`<${msg.link}|Abrir no Truvo>`);
    const text = lines.join('\n');

    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        this.logger.warn(`Slack respondeu ${res.status}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn(`falha ao postar no Slack: ${String((err as Error)?.message ?? err)}`);
      return false;
    }
  }
}
