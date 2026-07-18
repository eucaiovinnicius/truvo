import { Injectable, Logger } from '@nestjs/common';

/**
 * M12 — Canal de e-mail transacional (Resend/Postmark via fetch nativo).
 *
 * Provedor escolhido por env (NOTIFICATIONS_EMAIL_PROVIDER). Fail-closed: sem
 * provedor/chave configurada, NÃO tenta enviar — loga e retorna false (o in-app
 * continua funcionando). Sem libs pesadas: usa `fetch` do Node 20.
 *
 * ENV:
 *   NOTIFICATIONS_EMAIL_PROVIDER = "resend" | "postmark" | ""   (vazio = off)
 *   NOTIFICATIONS_EMAIL_FROM     = "Truvo Alertas <alerts@truvo.app>"
 *   RESEND_API_KEY               = "re_..."        (se provider=resend)
 *   POSTMARK_API_TOKEN           = "..."           (se provider=postmark)
 *   POSTMARK_MESSAGE_STREAM      = "outbound"      (opcional; default "outbound")
 */

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  /** Sobrescreve o remetente default (white-label por workspace). */
  from?: string;
}

@Injectable()
export class EmailChannel {
  private readonly logger = new Logger(EmailChannel.name);

  private provider(): 'resend' | 'postmark' | '' {
    const p = (process.env.NOTIFICATIONS_EMAIL_PROVIDER ?? '').trim().toLowerCase();
    return p === 'resend' || p === 'postmark' ? p : '';
  }

  private defaultFrom(): string {
    return (process.env.NOTIFICATIONS_EMAIL_FROM ?? '').trim() || 'Truvo <alerts@truvo.app>';
  }

  /** O canal de e-mail está utilizável (provedor + chave presentes)? */
  isConfigured(): boolean {
    const p = this.provider();
    if (p === 'resend') return Boolean(process.env.RESEND_API_KEY);
    if (p === 'postmark') return Boolean(process.env.POSTMARK_API_TOKEN);
    return false;
  }

  /**
   * Envia um e-mail. Retorna true só em sucesso confirmado (2xx). Fail-closed:
   * qualquer indisponibilidade → log + false, sem lançar (não derruba o dispatch).
   */
  async send(input: SendEmailInput): Promise<boolean> {
    const provider = this.provider();
    if (!provider) {
      // TODO(live): configurar NOTIFICATIONS_EMAIL_PROVIDER + chave (ver .env.example).
      this.logger.warn(
        `e-mail não configurado (NOTIFICATIONS_EMAIL_PROVIDER vazio) — pulando envio para ${input.to}`,
      );
      return false;
    }
    const from = input.from?.trim() || this.defaultFrom();
    try {
      if (provider === 'resend') return await this.sendResend(from, input);
      return await this.sendPostmark(from, input);
    } catch (err) {
      this.logger.warn(
        `falha ao enviar e-mail via ${provider} para ${input.to}: ${String(
          (err as Error)?.message ?? err,
        )}`,
      );
      return false;
    }
  }

  private async sendResend(from: string, input: SendEmailInput): Promise<boolean> {
    const key = process.env.RESEND_API_KEY;
    if (!key) {
      this.logger.warn('RESEND_API_KEY ausente — pulando envio.');
      return false;
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      this.logger.warn(`Resend respondeu ${res.status}: ${await safeText(res)}`);
      return false;
    }
    return true;
  }

  private async sendPostmark(from: string, input: SendEmailInput): Promise<boolean> {
    const token = process.env.POSTMARK_API_TOKEN;
    if (!token) {
      this.logger.warn('POSTMARK_API_TOKEN ausente — pulando envio.');
      return false;
    }
    const res = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': token,
      },
      body: JSON.stringify({
        From: from,
        To: input.to,
        Subject: input.subject,
        HtmlBody: input.html,
        MessageStream: (process.env.POSTMARK_MESSAGE_STREAM ?? '').trim() || 'outbound',
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      this.logger.warn(`Postmark respondeu ${res.status}: ${await safeText(res)}`);
      return false;
    }
    return true;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '<sem corpo>';
  }
}
