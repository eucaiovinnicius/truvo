import { boolean, index, integer, jsonb, pgTable, real, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * M17 — AI JOURNEY INTELLIGENCE (schema Postgres, PRD §7 Módulo 17).
 *
 * ARQUITETURA DETERMINISTIC-FIRST (regras 12/13/17):
 *   · Fase 1 (determinística): tudo é calculado no ClickHouse — path analysis por
 *     canal, CVR com Wilson lower-bound, receita RECONCILIADA (via M14), CAC/ROAS/
 *     LTV. O resultado é o "evidence pack" (AiEvidencePack), persistido em
 *     `ai_journey_runs.evidence`. NENHUM número vem do LLM.
 *   · Fase 2 (LLM): o Claude recebe SÓ os agregados + rótulos de canal (nunca PII,
 *     nunca linha crua) e produz ranking/narrativa/insights/recomendações citando o
 *     evidence (evidence_ref). Se o `reconciliation_gap` for alto → modo incerteza.
 *
 * Os RUNS são ASSÍNCRONOS: /journeys/analyze cria uma linha `queued`, o processamento
 * roda em background e o cliente faz polling em /journeys/runs/:id.
 *
 * O Postgres guarda apenas os artefatos operacionais do módulo (objetivos, runs,
 * insights, recomendações, conversas de Q&A). Toda a LEITURA analítica é no ClickHouse
 * (`journey_paths_daily` — 10-ai.sql — + `touchpoints`/`reconciliation_daily`), SEMPRE
 * com workspace_id (regra 1) e is_bot = 0 (regra 11 — aplicada na MV do 10-ai.sql).
 *
 * NOTA DE INTEGRAÇÃO: este arquivo precisa ser re-exportado por
 * `packages/db/src/schema/index.ts` (`export * from './ai'`) na onda de integração
 * para que `@truvo/db` exponha as tabelas + tipos — MESMO padrão do M7/M16/M15. O
 * barrel NÃO é editado por este módulo (contrato de arquivos) — ver schemaExports.
 *
 * Obs.: `workspace_id`/`created_by`/`requested_by`/`user_id` são `text` (não FK) —
 * mesmo padrão do M2..M16 — compatível com o formato de id do M1 (Auth). Toda
 * leitura/escrita filtra por `workspace_id` (regra 1).
 */

// ─────────────────────────── vocabulário fechado (fonte de verdade) ───────────────────────────

/** Objetivos de otimização suportados (PRD §7 M17). */
export const AI_GOALS = [
  'maximize_roas',
  'minimize_cac',
  'maximize_ltv',
  'maximize_cvr',
  'maximize_revenue',
] as const;
export type AiGoal = (typeof AI_GOALS)[number];

/** Estados de um run assíncrono. */
export const AI_RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;
export type AiRunStatus = (typeof AI_RUN_STATUSES)[number];

/** Severidade de um insight/anomalia. */
export const AI_INSIGHT_SEVERITIES = ['info', 'opportunity', 'warning', 'critical'] as const;
export type AiInsightSeverity = (typeof AI_INSIGHT_SEVERITIES)[number];

/** Estado de uma recomendação (workflow leve do cliente). */
export const AI_RECOMMENDATION_STATUSES = ['proposed', 'accepted', 'dismissed'] as const;
export type AiRecommendationStatus = (typeof AI_RECOMMENDATION_STATUSES)[number];

// ─────────────────────────── tipos JSONB (evidence pack + segmento) ───────────────────────────

/**
 * Segmento do objetivo. GENÉRICO e SEM PII de propósito (regra 4/5): só rótulos de
 * canal / dimensões agregadas. O serviço valida e nunca coloca isto no prompt como
 * dado do usuário — só como filtro de canal.
 */
export interface AiSegment {
  /** Restringe a análise a um canal (channel_resolved). */
  channel?: string;
  /** Restringe a um utm_source/medium/campaign (rótulos, não PII). */
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
}

/** Evidence por canal — TODOS os números são agregados determinísticos do ClickHouse. */
export interface AiChannelEvidence {
  channel: string;
  touches: number;
  persons: number;
  converters: number;
  conversions: number;
  /** converters / persons. */
  cvr: number | null;
  /** limite inferior de Wilson (95%) da CVR — evita superestimar canais de baixa amostra. */
  cvr_wilson_lower: number | null;
  /** crédito multi-touch do M7 (modelo default do workspace). */
  attributed_conversions: number | null;
  attributed_revenue: number | null;
  /** participação na receita reconciliada (M14) — null quando sem ground truth. */
  reconciled_revenue_share: number | null;
  /** spend do M10 (via AD_SPEND_PROVIDER); null enquanto indisponível (regra 12). */
  spend: number | null;
  roas: number | null;
  cac: number | null;
  /** LTV aproximado na janela = receita / converters únicos (proxy — ver notes). */
  ltv_proxy: number | null;
}

/** Uma sequência de canais (jornada) agregada. */
export interface AiJourneyEvidence {
  path: string[];
  conversions: number;
  revenue: number | null;
  avg_path_length: number | null;
}

/** Estado de reconciliação (M14) da janela — fonte da "marca de incerteza" (regra 12). */
export interface AiReconciliationEvidence {
  truvo_revenue: number;
  gateway_revenue: number | null;
  reconciliation_gap: number | null;
  uncertain_days: number;
  status: string; // reconciled | uncertain | no_ground_truth
}

/** Anomalia detectada DETERMINISTICAMENTE (janela atual vs. janela anterior). */
export interface AiAnomalyEvidence {
  channel: string;
  metric: string; // cvr | revenue | reconciliation
  current: number | null;
  previous: number | null;
  change_pct: number | null;
  severity: AiInsightSeverity;
  note: string;
}

/**
 * O "evidence pack" — a única coisa que o LLM enxerga (Fase 2). Só agregados +
 * rótulos de canal. Persistido em `ai_journey_runs.evidence` e é a base do
 * evidence_ref de insights/recomendações (rastreabilidade — nunca número inventado).
 */
export interface AiEvidencePack {
  generated_at: string;
  goal: AiGoal;
  window: { start: string; end: string; days: number };
  segment?: AiSegment | null;
  spend_available: boolean;
  attribution_model: string;
  totals: {
    conversions: number;
    attributed_revenue: number | null;
    reconciled_revenue: number | null;
    unique_converters: number;
  };
  reconciliation: AiReconciliationEvidence;
  /** true quando o gap de reconciliação passa do limiar → LLM entra em modo incerteza. */
  uncertain: boolean;
  channels: AiChannelEvidence[];
  top_journeys: AiJourneyEvidence[];
  anomalies: AiAnomalyEvidence[];
}

/** Uma referência estruturada ao evidence (o que ancora um insight/recomendação). */
export interface AiEvidenceRef {
  /** Chave textual dentro do pack (ex.: 'channels.paid_social', 'reconciliation'). */
  key: string;
  channel?: string;
  metric?: string;
}

/** Uma mensagem de uma conversa de Q&A (text-to-query via M16). */
export interface AiConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  /** ExplorerQuerySpec (M16) que respondeu à pergunta (assistant). Nunca SQL cru. */
  spec?: unknown;
  /** Amostra compacta das linhas de resultado que fundamentam a resposta. */
  evidence?: unknown;
  /** Marca de incerteza (regra 12) herdada do executor do M16. */
  uncertain?: boolean;
  at: string; // ISO
}

// ─────────────────────────────────── tabelas ───────────────────────────────────

/** ai_objectives — objetivos salvos (goal + janela + segmento) por workspace. */
export const aiObjectives = pgTable(
  'ai_objectives',
  {
    /** Gerado no serviço: `obj_<ulid>`. */
    id: text('id').primaryKey(),
    /** Tenant dono (regra 1). */
    workspaceId: text('workspace_id').notNull(),
    name: text('name').notNull(),
    goal: text('goal').$type<AiGoal>().notNull(),
    windowDays: integer('window_days').notNull().default(30),
    segment: jsonb('segment').$type<AiSegment>(),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('ai_objectives_workspace_idx').on(t.workspaceId, t.createdAt),
  }),
);

/**
 * ai_journey_runs — 1 linha por análise assíncrona. Guarda a config, o status e o
 * EVIDENCE PACK determinístico (regra 12/13). O narrative é gerado pelo LLM.
 */
export const aiJourneyRuns = pgTable(
  'ai_journey_runs',
  {
    /** Gerado no serviço: `run_<ulid>`. */
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    /** Objetivo salvo que originou o run (null p/ run ad-hoc). */
    objectiveId: text('objective_id'),
    goal: text('goal').$type<AiGoal>().notNull(),
    windowDays: integer('window_days').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
    segment: jsonb('segment').$type<AiSegment>(),
    status: text('status').$type<AiRunStatus>().notNull().default('queued'),
    /** Modelo Claude usado na Fase 2 (null se LLM indisponível — fail-closed). */
    llmModel: text('llm_model'),
    llmAvailable: boolean('llm_available').notNull().default(false),
    /** gap de reconciliação da janela (regra 12). */
    reconciliationGap: real('reconciliation_gap'),
    uncertain: boolean('uncertain').notNull().default(false),
    /** Evidence pack determinístico (Fase 1). */
    evidence: jsonb('evidence').$type<AiEvidencePack>(),
    /** Narrativa NL do LLM (Fase 2). */
    narrative: text('narrative'),
    error: text('error'),
    requestedBy: text('requested_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    workspaceIdx: index('ai_journey_runs_workspace_idx').on(t.workspaceId, t.createdAt),
  }),
);

/** ai_insights — insights NL gerados por um run (ancorados em evidence_ref). */
export const aiInsights = pgTable(
  'ai_insights',
  {
    /** Gerado no serviço: `aii_<ulid>`. */
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    runId: text('run_id').notNull(),
    severity: text('severity').$type<AiInsightSeverity>().notNull().default('info'),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** Métrica-alvo (roas|cac|cvr|ltv|revenue|reconciliation). */
    metric: text('metric'),
    channel: text('channel'),
    /** Referência ao evidence que fundamenta o insight (rastreabilidade). */
    evidenceRef: jsonb('evidence_ref').$type<AiEvidenceRef>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('ai_insights_workspace_idx').on(t.workspaceId, t.runId),
  }),
);

/** ai_recommendations — recomendações acionáveis de um run (com evidence_ref). */
export const aiRecommendations = pgTable(
  'ai_recommendations',
  {
    /** Gerado no serviço: `rec_<ulid>`. */
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    runId: text('run_id').notNull(),
    goal: text('goal').$type<AiGoal>(),
    title: text('title').notNull(),
    rationale: text('rationale').notNull(),
    action: text('action'),
    expectedImpact: text('expected_impact'),
    priority: integer('priority').notNull().default(0),
    channel: text('channel'),
    evidenceRef: jsonb('evidence_ref').$type<AiEvidenceRef>(),
    status: text('status').$type<AiRecommendationStatus>().notNull().default('proposed'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('ai_recommendations_workspace_idx').on(t.workspaceId, t.runId),
  }),
);

/**
 * ai_conversations — threads de Q&A. Cada resposta é fundamentada num ExplorerQuerySpec
 * (M16) executado no ClickHouse — NUNCA SQL cru (regra 19). As mensagens ficam em jsonb.
 */
export const aiConversations = pgTable(
  'ai_conversations',
  {
    /** Gerado no serviço: `cnv_<ulid>`. */
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    userId: text('user_id'),
    title: text('title'),
    messages: jsonb('messages').$type<AiConversationMessage[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('ai_conversations_workspace_idx').on(t.workspaceId, t.updatedAt),
  }),
);

export type AiObjective = typeof aiObjectives.$inferSelect;
export type NewAiObjective = typeof aiObjectives.$inferInsert;
export type AiJourneyRun = typeof aiJourneyRuns.$inferSelect;
export type NewAiJourneyRun = typeof aiJourneyRuns.$inferInsert;
export type AiInsight = typeof aiInsights.$inferSelect;
export type NewAiInsight = typeof aiInsights.$inferInsert;
export type AiRecommendation = typeof aiRecommendations.$inferSelect;
export type NewAiRecommendation = typeof aiRecommendations.$inferInsert;
export type AiConversation = typeof aiConversations.$inferSelect;
export type NewAiConversation = typeof aiConversations.$inferInsert;
