import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * M5 — FUNNEL ENGINE (PRD §7 Módulo 5, §8).
 *
 * Uma linha por funil configurado por workspace. Os `steps` vivem em JSONB
 * (schema abaixo) e o cálculo de conversão roda no ClickHouse sobre a tabela
 * `events` (windowFunnel/sequenceMatch) — SEMPRE com `workspace_id` no WHERE e
 * `is_bot = 0` (regras 1 e 11 do PRD). Nenhuma métrica é persistida aqui além
 * da `sparkline` (mini-série pré-computada p/ a lista, atualizada por worker).
 *
 * NOTA DE INTEGRAÇÃO: este arquivo é re-exportado no barrel `schema/index.ts`
 * (`export * from './funnels'`) na onda de integração do M5 — ver schemaExports/
 * openTODOs. O barrel NÃO é editado por este módulo (contrato de arquivos).
 */

/** Condições opcionais de um step (PRD §7 M5). Todas combinam via AND. */
export interface FunnelStepConditions {
  /** page_url contém (case-insensitive) este texto. */
  url_contains?: string;
  /** properties.element_id == este id (ex.: botão clicado). */
  element_id?: string;
  /** properties[key] == value (string/number/boolean). */
  property_eq?: { key: string; value: string | number | boolean };
  /** properties[key] >= value (numérico). */
  property_gte?: { key: string; value: number };
}

/** Um passo do funil: nome do evento + condições. */
export interface FunnelStep {
  step_id: string;
  name: string;
  /** event_name (STANDARD_EVENTS ou custom). */
  event: string;
  conditions: FunnelStepConditions;
}

/**
 * Config de alerta do funil (PRD §7 M5 — "notificar se conversão cair abaixo de X%").
 * A ENTREGA da notificação depende do M12 (onda futura) — aqui só a ESTRUTURA e o
 * gatilho. Ver FunnelAlertsService (api) e o alert-evaluator (consumer).
 */
export interface FunnelAlert {
  enabled: boolean;
  /** Dispara quando a conversão geral (%) fica ABAIXO deste limiar. */
  min_overall_conversion_rate: number;
  /** Canais de entrega — resolvidos pelo M12 (onda futura). */
  channels?: Array<'email' | 'slack' | 'in_app'>;
  /** ISO do último disparo (evita spam; escrito pelo worker). */
  last_triggered_at?: string | null;
}

/** Ciclo de vida de um funil. */
export const funnelStatusEnum = pgEnum('funnel_status', ['active', 'archived', 'draft']);

export const funnels = pgTable(
  'funnels',
  {
    /** Gerado no serviço: `fnl_<ulid>`. */
    id: text('id').primaryKey(),
    /** Tenant dono do funil (regra 1 — isolamento multi-tenant). */
    workspaceId: text('workspace_id').notNull(),
    name: text('name').notNull(),
    status: funnelStatusEnum('status').notNull().default('active'),
    /** Janela de atribuição p/ windowFunnel (dias → segundos no cálculo). */
    attributionWindowDays: integer('attribution_window_days').notNull().default(7),
    /** Steps ordenados (índice = ordem). Ver FunnelStep. */
    steps: jsonb('steps').$type<FunnelStep[]>().notNull().default(sql`'[]'::jsonb`),
    /** Config de alerta (M12 entrega a notificação). */
    alert: jsonb('alert')
      .$type<FunnelAlert>()
      .notNull()
      .default(sql`'{"enabled":false,"min_overall_conversion_rate":0}'::jsonb`),
    /** Mini-série de conversão p/ a lista (pré-computada por worker). */
    sparkline: jsonb('sparkline').$type<number[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // regra 1: toda listagem/leitura é escopada por workspace.
    workspaceIdx: index('funnels_workspace_idx').on(t.workspaceId, t.createdAt),
    // varredura do worker de alertas: funis ativos por workspace.
    statusIdx: index('funnels_status_idx').on(t.status),
  }),
);

export type Funnel = typeof funnels.$inferSelect;
export type NewFunnel = typeof funnels.$inferInsert;
