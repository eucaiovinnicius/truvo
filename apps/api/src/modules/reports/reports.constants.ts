/**
 * M13 — RELATÓRIOS. Constantes e leitura de env (fail-closed).
 *
 * O envio de email reusa o EmailChannel do M12 (provedor/credencial vêm de
 * NOTIFICATIONS_EMAIL_PROVIDER + RESEND_API_KEY/POSTMARK_API_TOKEN). Sem provedor
 * configurado, a entrega fica indisponível (delivery = 'skipped', a run ainda congela
 * o snapshot). Aqui só ficam as configs PRÓPRIAS do M13 (link público, scheduler).
 */

/** Períodos relativos aceitos (alinhados a metrics RELATIVE_PERIODS). */
export const REPORT_PERIODS = [
  'today',
  'last_7_days',
  'last_14_days',
  'last_30_days',
  'last_90_days',
  'last_180_days',
  'last_365_days',
] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

export const REPORT_FREQUENCIES = ['manual', 'daily', 'weekly', 'monthly'] as const;
export const REPORT_TEMPLATES = ['client_report', 'ads_performance', 'monthly_funnel', 'custom'] as const;
export const REPORT_FORMATS = ['web', 'email', 'pdf'] as const;

/** Período default sugerido por frequência (usado quando o cliente não fixa `period`). */
export const DEFAULT_PERIOD_BY_FREQUENCY: Record<string, ReportPeriod> = {
  manual: 'last_30_days',
  daily: 'today',
  weekly: 'last_7_days',
  monthly: 'last_30_days',
};

/** Regex de cor hex (#rgb | #rrggbb). */
export const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Prefixos de token público (namespacing p/ debug; sem valor de segurança). */
export const REPORT_TOKEN_PREFIX = 'rpt';
export const REPORT_RUN_TOKEN_PREFIX = 'rrn';

// ─────────────────────────── env (fail-closed) ───────────────────────────

/**
 * Remetente OPCIONAL específico de relatórios (white-label). Vazio = deixa o EmailChannel
 * do M12 usar o remetente default (NOTIFICATIONS_EMAIL_FROM). Só sobrescreve se definido.
 */
export function reportsEmailFromOverride(): string {
  return (process.env.REPORTS_EMAIL_FROM ?? '').trim();
}

/** Base pública p/ montar o link do relatório nos emails (sem barra final). */
export function reportsPublicBaseUrl(): string {
  return (process.env.REPORTS_PUBLIC_BASE_URL ?? 'https://app.truvo.com').trim().replace(/\/+$/, '');
}

/** Liga o scheduler in-process (=1). Default off — em prod prefira worker dedicado. */
export function schedulerEnabled(): boolean {
  return (process.env.REPORTS_SCHEDULER_ENABLED ?? '').trim() === '1';
}

/** Intervalo de varredura do scheduler (ms). */
export function schedulerScanMs(): number {
  const n = Number(process.env.REPORTS_SCHEDULER_SCAN_MS ?? 60_000);
  return Number.isFinite(n) && n >= 5_000 ? n : 60_000;
}
