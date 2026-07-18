import { Injectable, Logger } from '@nestjs/common';
import type { ReportDelivery } from '@truvo/db';
// REUSO DO M12: o canal de e-mail transacional (Resend/Postmark via fetch nativo,
// fail-closed) é do M12. Não está exportado pelo NotificationsModule, mas EmailChannel
// não tem dependências injetadas (só lê env), então o registramos como provider local
// no ReportsModule e delegamos o envio bruto — sem duplicar a lógica de provedor.
import { EmailChannel } from '../notifications/channels/email.channel';
import { reportsEmailFromOverride } from './reports.constants';

/**
 * M13 — Entrega de relatórios por email.
 *
 * A ENTREGA BRUTA reusa o EmailChannel do M12. Este serviço adiciona o que é específico
 * de relatório: dedupe da lista, status POR destinatário (para report_runs.deliveries),
 * banner com o permalink do snapshot e assunto white-label.
 *
 * Diferença de escopo vs. NotificationService.dispatch do M12: `dispatch` entrega a
 * MEMBROS do workspace (lookup em `users`) com template de ALERTA. Um relatório vai para
 * uma lista EXTERNA (clientes da agência, que não são usuários do workspace) com HTML
 * white-label próprio — por isso a entrega passa pelo canal (EmailChannel), não pelo
 * dispatch. // TODO(live): se o M12 expuser um envio "broadcast/externo", delegar a ele.
 */

export interface SendReportEmailInput {
  workspaceId: string;
  recipients: string[];
  subject: string;
  html: string;
  /** Link público (permalink do snapshot) incluído no corpo, se houver. */
  publicUrl?: string;
}

@Injectable()
export class ReportDeliveryService {
  private readonly logger = new Logger(ReportDeliveryService.name);

  constructor(private readonly email: EmailChannel) {}

  /**
   * Envia o relatório a cada destinatário e devolve o status por destinatário (para
   * persistir em report_runs.deliveries). NUNCA lança: falha de entrega não invalida o
   * snapshot já congelado — cada destinatário vira 'sent'|'failed'|'skipped'.
   */
  async sendReport(input: SendReportEmailInput): Promise<ReportDelivery[]> {
    const now = () => new Date().toISOString();
    const recipients = dedupe(input.recipients);
    if (recipients.length === 0) return [];

    // fail-closed: sem provedor/credencial de email (M12), marca todos 'skipped'.
    if (!this.email.isConfigured()) {
      this.logger.warn(
        `canal de email não configurado (M12) — envio de relatório pulado (ws=${input.workspaceId}, ${recipients.length} destinatário(s)). Ver NOTIFICATIONS_EMAIL_PROVIDER no .env.`,
      );
      return recipients.map((r) => ({
        channel: 'email' as const,
        recipient: r,
        status: 'skipped' as const,
        error: 'canal de email não configurado (NOTIFICATIONS_EMAIL_PROVIDER)',
        at: now(),
      }));
    }

    const html = input.publicUrl ? withPermalink(input.html, input.publicUrl) : input.html;
    const from = reportsEmailFromOverride(); // '' → EmailChannel usa o remetente default.

    const results = await Promise.all(
      recipients.map(async (to): Promise<ReportDelivery> => {
        const sent = await this.email.send({
          to,
          subject: input.subject,
          html,
          from: from || undefined,
        });
        return {
          channel: 'email',
          recipient: to,
          status: sent ? 'sent' : 'failed',
          error: sent ? undefined : 'envio não confirmado pelo provedor (ver logs do EmailChannel)',
          at: now(),
        };
      }),
    );
    return results;
  }
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const v = raw.trim().toLowerCase();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(raw.trim());
    }
  }
  return out;
}

function withPermalink(html: string, url: string): string {
  const banner = `<div style="text-align:center;padding:12px;font-size:13px;">Ver no navegador: <a href="${escAttr(url)}">${escAttr(url)}</a></div>`;
  // injeta logo após <body> (fallback: prepend).
  return html.includes('<body>') ? html.replace('<body>', `<body>${banner}`) : banner + html;
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
