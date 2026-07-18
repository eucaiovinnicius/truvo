import type { PlanId } from '@truvo/db';
import type { WorkspaceRole } from '../auth/roles';

/**
 * M11 — FEATURE GATES por plano (PRD §7 M11 + gates novos v3.2).
 *
 * Fonte de verdade das capacidades liberadas por plano. Lógica PURA (sem DI, sem
 * DB) para ser reusada tanto pelo {@link FeatureGuard} (sem DI, cross-módulo)
 * quanto pelo {@link FeatureAccessService} (com DI). Outros módulos (M16 explorer,
 * M17 ai_journey, M10 creative_analytics, M8 identity_resolution) consultam estes
 * gates para bloquear features fora do plano — ver wiring TODO.
 */

/** Todas as capacidades gateáveis conhecidas (união fechada). */
export const ALL_FEATURES = [
  'pixel',
  'url_tracking',
  'funnels_3',
  'funnels_unlimited',
  'dashboard_basic',
  'dashboard_full',
  'server_side',
  'attribution_basic',
  'attribution_advanced',
  'integrations',
  'identity_resolution',
  'creative_analytics',
  'white_label',
  'explorer_visual',
  'retention_path',
  'user_360',
  'explorer_sql',
  'ai_journey',
  'sla',
  'dedicated_infra',
] as const;
export type Feature = (typeof ALL_FEATURES)[number];

/** Sentinela: plano com acesso a TODAS as features (dimensão de plano). */
const ALL = 'all' as const;

/**
 * Gates por plano (PRD §7 M11). `ALL` = todas as features na dimensão de plano
 * (Agency/Enterprise). Features role-gated (ver ROLE_GATED_FEATURES) ainda exigem
 * o papel mesmo com `ALL`.
 *
 *   starter: pixel, url_tracking, funnels_3, dashboard_basic, explorer_visual
 *   growth:  + funnels_unlimited, server_side, attribution_basic, integrations,
 *            dashboard_full, retention_path, user_360
 *   agency:  ALL + white_label, attribution_advanced, identity_resolution,
 *            creative_analytics, explorer_sql, ai_journey
 *   enterprise: superset do agency + sla, dedicated_infra
 */
export const PLAN_FEATURES: Record<PlanId, readonly (Feature | typeof ALL)[]> = {
  starter: ['pixel', 'url_tracking', 'funnels_3', 'dashboard_basic', 'explorer_visual'],
  growth: [
    'pixel',
    'url_tracking',
    'funnels_unlimited',
    'server_side',
    'attribution_basic',
    'integrations',
    'dashboard_full',
    'explorer_visual',
    'retention_path',
    'user_360',
  ],
  agency: [
    ALL,
    'white_label',
    'attribution_advanced',
    'identity_resolution',
    'creative_analytics',
    'explorer_sql',
    'ai_journey',
  ],
  enterprise: [
    ALL,
    'white_label',
    'attribution_advanced',
    'identity_resolution',
    'creative_analytics',
    'explorer_sql',
    'ai_journey',
    'sla',
    'dedicated_infra',
  ],
};

/**
 * Features que, além do plano, exigem role `owner`/`admin` (PRD §7 M11 v3.2 +
 * §M16): `explorer_sql` (SQL guardado) e `ai_journey` (IA generativa, custo por
 * token). `member`/`viewer` ficam no explorador visual mesmo em Agency/Enterprise.
 */
export const ROLE_GATED_FEATURES: ReadonlySet<Feature> = new Set<Feature>([
  'explorer_sql',
  'ai_journey',
]);

const ROLE_GATE_ALLOWED: readonly WorkspaceRole[] = ['owner', 'admin'];

/**
 * O plano libera a feature? (dimensão de PLANO apenas; role é checado à parte.)
 * Expande o sentinela `ALL`.
 */
export function planAllowsFeature(plan: PlanId, feature: Feature): boolean {
  const gates = PLAN_FEATURES[plan];
  if (gates.includes(ALL)) return true;
  return (gates as readonly string[]).includes(feature);
}

/**
 * A feature é acessível para (plano, role)? Combina o gate de plano com o gate de
 * role (fail-closed: feature role-gated sem role conhecido → nega).
 */
export function canAccessFeature(
  plan: PlanId,
  feature: Feature,
  role?: WorkspaceRole,
): boolean {
  if (!planAllowsFeature(plan, feature)) return false;
  if (ROLE_GATED_FEATURES.has(feature)) {
    return role !== undefined && ROLE_GATE_ALLOWED.includes(role);
  }
  return true;
}

/** Lista concreta (sem o sentinela `ALL`) das features do plano — para /plans e /subscription. */
export function featuresForPlan(plan: PlanId): Feature[] {
  return ALL_FEATURES.filter((f) => planAllowsFeature(plan, f));
}

export function isFeature(v: unknown): v is Feature {
  return typeof v === 'string' && (ALL_FEATURES as readonly string[]).includes(v);
}
