import type {
  NotificationCategory,
  NotificationChannel,
  NotificationSeverity,
} from '@truvo/db';

/**
 * M12 — Registry de TIPOS de alerta (PRD §7 M12 "tipos registrados por regra").
 *
 * Cada tipo tem defaults (categoria/severidade/canais/janela de dedup) usados
 * quando NÃO há `alert_rules` configurada para o workspace. Uma regra em
 * `alert_rules` sobrescreve enabled/canais/severidade/janela; o registry só
 * garante um comportamento sensato out-of-the-box e a categoria/título.
 *
 * Os módulos de origem chamam `NotificationService.dispatch(workspaceId, type,
 * payload)` com um destes `type` (ou um custom — cai no {@link GENERIC_TYPE}).
 */

/** Payload que os módulos passam ao dispatch. */
export interface DispatchPayload {
  /** Título (senão o registry monta um a partir de `data`). */
  title?: string;
  body?: string;
  /** Dados estruturados do evento (ids, métricas, deltas). */
  data?: Record<string, unknown>;
  /** Deep-link no app ao clicar. */
  link?: string;
  /** Sobrescreve a severidade do tipo/regra. */
  severity?: NotificationSeverity;
  /**
   * Identidade estável do alerta p/ dedup (ex.: funnelId, adId, `${day}`).
   * Combinada com o bucket de tempo da janela. Sem isso, usa 'default'.
   */
  dedupId?: string;
  /** Restringe a entrega a estes usuários; default = todos os membros ativos. */
  userIds?: string[];
  /** Força os canais, ignorando regra/registry (uso raro/testes). */
  channels?: NotificationChannel[];
}

export interface AlertTypeDef {
  type: string;
  category: NotificationCategory;
  severity: NotificationSeverity;
  defaultChannels: NotificationChannel[];
  /** Janela de dedup/agrupamento default (minutos). */
  dedupWindowMinutes: number;
  /** Título default a partir do payload. */
  title: (payload: DispatchPayload) => string;
}

const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

/**
 * Fallback para `type` desconhecido — entrega in-app com severidade info. Mantém
 * o dispatch resiliente a tipos novos que um módulo introduza antes de registrar.
 */
export const GENERIC_TYPE: AlertTypeDef = {
  type: 'system.notification',
  category: 'system',
  severity: 'info',
  defaultChannels: ['in_app'],
  dedupWindowMinutes: 60,
  title: (p) => str(p.data?.['title'], 'Notificação'),
};

/** Catálogo de tipos conhecidos. */
export const ALERT_TYPES: Record<string, AlertTypeDef> = {
  // ── M5 Funil ────────────────────────────────────────────────────────────
  'funnel.conversion_below_threshold': {
    type: 'funnel.conversion_below_threshold',
    category: 'funnel',
    severity: 'warning',
    defaultChannels: ['in_app', 'email'],
    dedupWindowMinutes: 24 * 60,
    title: (p) =>
      `Conversão do funil "${str(p.data?.['funnel_name'], 'sem nome')}" caiu para ${num(
        p.data?.['observed_conversion_rate'],
      )}% (limiar ${num(p.data?.['threshold'])}%)`,
  },

  // ── M10 Criativos & Ads ──────────────────────────────────────────────────
  'creative.fatigue': {
    type: 'creative.fatigue',
    category: 'creative',
    severity: 'warning',
    defaultChannels: ['in_app'],
    dedupWindowMinutes: 24 * 60,
    title: (p) => `Fadiga de criativo detectada: "${str(p.data?.['creative_name'], 'criativo')}"`,
  },
  'creative.discrepancy': {
    type: 'creative.discrepancy',
    category: 'creative',
    severity: 'warning',
    defaultChannels: ['in_app'],
    dedupWindowMinutes: 24 * 60,
    title: (p) =>
      `Discrepância de plataforma no criativo "${str(p.data?.['creative_name'], 'criativo')}"`,
  },
  'creative.top_performer': {
    type: 'creative.top_performer',
    category: 'creative',
    severity: 'info',
    defaultChannels: ['in_app'],
    dedupWindowMinutes: 24 * 60,
    title: (p) => `Top performer: "${str(p.data?.['creative_name'], 'criativo')}"`,
  },
  'creative.spend_no_conversion': {
    type: 'creative.spend_no_conversion',
    category: 'creative',
    severity: 'warning',
    defaultChannels: ['in_app', 'email'],
    dedupWindowMinutes: 24 * 60,
    title: (p) =>
      `Gasto sem conversão: "${str(p.data?.['creative_name'], 'criativo')}" (spend ${num(
        p.data?.['spend'],
      )})`,
  },

  // ── M14 Qualidade de dados ───────────────────────────────────────────────
  'quality.reconciliation_gap': {
    type: 'quality.reconciliation_gap',
    category: 'quality',
    severity: 'critical',
    defaultChannels: ['in_app', 'email'],
    dedupWindowMinutes: 24 * 60,
    title: (p) =>
      `Gap de reconciliação de ${(num(p.data?.['gap']) * 100).toFixed(1)}% em ${str(
        p.data?.['day'],
        'um dia',
      )} (limiar ${(num(p.data?.['threshold']) * 100).toFixed(1)}%)`,
  },
  'quality.consumer_lag': {
    type: 'quality.consumer_lag',
    category: 'quality',
    severity: 'warning',
    defaultChannels: ['in_app'],
    dedupWindowMinutes: 30,
    title: (p) => `Lag do consumer acima do esperado (${num(p.data?.['lag_seconds'])}s)`,
  },
  'quality.integration_error': {
    type: 'quality.integration_error',
    category: 'quality',
    severity: 'critical',
    defaultChannels: ['in_app', 'email'],
    dedupWindowMinutes: 60,
    title: (p) => `Integração com erro: ${str(p.data?.['integration'], 'desconhecida')}`,
  },

  // ── M11 Billing ──────────────────────────────────────────────────────────
  'billing.usage_approaching_limit': {
    type: 'billing.usage_approaching_limit',
    category: 'billing',
    severity: 'warning',
    defaultChannels: ['in_app', 'email'],
    dedupWindowMinutes: 24 * 60,
    title: (p) =>
      `Uso em ${num(p.data?.['usage_pct'])}% do limite de eventos do plano`,
  },
  'billing.payment_failed': {
    type: 'billing.payment_failed',
    category: 'billing',
    severity: 'critical',
    defaultChannels: ['in_app', 'email'],
    dedupWindowMinutes: 6 * 60,
    title: () => 'Falha no pagamento — regularize para evitar suspensão',
  },

  // ── M17 IA (anomalia → alerta) ───────────────────────────────────────────
  'ai.anomaly_detected': {
    type: 'ai.anomaly_detected',
    category: 'system',
    severity: 'info',
    defaultChannels: ['in_app'],
    dedupWindowMinutes: 12 * 60,
    title: (p) => str(p.data?.['summary'], 'Anomalia detectada na jornada'),
  },
};

/** Resolve a definição do tipo (ou o genérico). */
export function resolveAlertType(type: string): AlertTypeDef {
  return ALERT_TYPES[type] ?? { ...GENERIC_TYPE, type };
}
