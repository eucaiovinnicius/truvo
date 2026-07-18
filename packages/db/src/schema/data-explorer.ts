import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * M16 — DATA EXPLORER (motor de query próprio) · schema Postgres (PRD §7 Módulo 16).
 *
 * A LEITURA analítica em si é toda no ClickHouse (compilador `ExplorerQuerySpec` →
 * SQL parametrizado, SEMPRE com workspace_id + is_bot = 0 + janela de data — regras
 * 1, 11 e 19). No Postgres ficam apenas os artefatos operacionais do módulo:
 *
 *   · insights          — biblioteca self-serve (visual = spec JSONB | sql = texto
 *                         guardado), com dono, nome e o tipo de insight.
 *   · insight_versions  — versão IMUTÁVEL de cada alteração (permite restore/diff).
 *   · insight_shares    — token read-only de compartilhamento (senha/expiração
 *                         opcionais). O token carrega só o insight_id; o
 *                         workspace_id é resolvido SERVER-SIDE pelo dono — nunca
 *                         a partir do request (regra 1 / segurança multi-tenant).
 *   · explorer_catalog  — catálogo semântico/allowlist por workspace (dimensões,
 *                         measures salvas, propriedades `properties.*` amostradas +
 *                         flag de PII). É a fonte que o compilador consulta.
 *
 * A auditoria/telemetria de execução (custo, status, SQL) vive no ClickHouse
 * (`explorer_query_log`, ver clickhouse/ddl/08-explorer.sql) — não aqui.
 *
 * NOTA DE INTEGRAÇÃO: este arquivo deve ser re-exportado por
 * `packages/db/src/schema/index.ts` (`export * from './data-explorer'`) na onda de
 * integração para que `@truvo/db` exponha `insights`, `insightVersions`,
 * `insightShares` e `explorerCatalog`. O barrel NÃO é editado por este módulo
 * (contrato de arquivos) — reportado em `schemaExports`.
 *
 * Obs.: `workspace_id`/`owner_id`/`created_by` são `text` (não FK) — mesmo padrão
 * do M2/M5/M6 — para permanecerem compatíveis com o formato de id do M1 (Auth).
 * Toda leitura/escrita filtra por `workspace_id` (regra 1).
 */

// ─────────────────────────── tipos JSONB (fonte de verdade) ───────────────────────────

/** Tipo de insight visual (cada um tem um compilador dedicado no service). */
export const INSIGHT_TYPES = ['trends', 'funnel', 'retention', 'path', 'breakdown'] as const;
export type InsightType = (typeof INSIGHT_TYPES)[number];

/** Origem do insight: construtor visual (spec JSON) ou SQL guardado. */
export const INSIGHT_KINDS = ['visual', 'sql'] as const;
export type InsightKind = (typeof INSIGHT_KINDS)[number];

/**
 * `ExplorerQuerySpec` — a camada semântica própria do Truvo (PRD §7 M16). É um
 * JSON que o front-end (visual) produz e o compilador server-side transforma em
 * SQL ClickHouse PARAMETRIZADO. Persistido como jsonb em `insights.spec`.
 *
 * A validação de forma/allowlist é feita pelo zod do módulo (compiler/spec.ts) na
 * escrita e ANTES de compilar — este type é o contrato de armazenamento. O
 * compilador NUNCA lê `workspace_id`/`is_bot` daqui: são invariantes injetadas
 * server-side a partir da sessão (regra 19).
 */
export interface ExplorerQuerySpec {
  insight_type: InsightType;
  /** Tabela lógica de origem (mapeada p/ física pelo compilador). */
  source: 'events' | 'touchpoints';
  /** Measures (trends/breakdown). Vocabulário fechado — ver compiler/catalog.ts. */
  measures?: ExplorerMeasure[];
  /** Passos do funil (insight_type = 'funnel'). */
  steps?: ExplorerFunnelStep[];
  /** Janela de atribuição do funil em dias (windowFunnel). Default 7. */
  window_days?: number;
  /** Config de retenção (insight_type = 'retention'). */
  retention?: ExplorerRetention;
  /** Config de path/flow (insight_type = 'path'). */
  path?: ExplorerPath;
  /** Dimensões de quebra (breakdown/trends). Só campos do catálogo. */
  dimensions?: string[];
  /** Alias de group_by (mesclado com `dimensions`). */
  group_by?: string[];
  /** Árvore de filtros (and/or aninháveis). Só campos/ops do catálogo. */
  filters?: ExplorerFilterNode;
  /** Janela de data — preset relativo OU {from,to} ISO. */
  date_range?: ExplorerDateRange;
  /** Granularidade do bucket temporal (trends/retention). */
  granularity?: 'minute' | 'hour' | 'day' | 'week' | 'month';
  /** Ordenação por alias de measure/dimensão. */
  order?: Array<{ by: string; dir: 'asc' | 'desc' }>;
  /** Teto de linhas de resultado (o compilador ainda aplica o teto do plano). */
  limit?: number;
  /** IGNORADO pelo compilador — is_bot = 0 é invariante (regra 11). Só documental. */
  include_bots?: boolean;
}

/** Uma measure: métrica agregável do vocabulário fechado. */
export interface ExplorerMeasure {
  id: string;
  metric: 'count' | 'unique' | 'sum' | 'avg' | 'min' | 'max' | 'p50' | 'p90' | 'p95' | 'rate';
  /** Filtra event_name da measure (omitido/`*` = todos). */
  event?: string;
  /** Campo numérico do catálogo (obrigatório p/ sum/avg/min/max/percentis). */
  property?: string;
  /** Coluna de distinção p/ `unique` (user_id/session_id/anonymous_id/canonical_id). */
  on?: string;
}

/** Passo do funil (event + filtros opcionais reusando a árvore de filtros). */
export interface ExplorerFunnelStep {
  event: string;
  filters?: ExplorerFilterNode;
}

/** Config de retenção: coorte por evento inicial × evento de retorno. */
export interface ExplorerRetention {
  initial_event: string;
  return_event: string;
  /** Nº de períodos (buckets) da matriz; o compilador aplica um teto. */
  periods?: number;
}

/** Config de path/flow: top-N sequências de eventos por pessoa. */
export interface ExplorerPath {
  /** Máx. de passos por sequência (o compilador aplica um teto). */
  max_steps?: number;
  /** Restringe a eventos iniciais (opcional). */
  start_event?: string;
}

/** Nó da árvore de filtros: grupo (and/or) ou condição folha. */
export type ExplorerFilterNode = ExplorerFilterGroup | ExplorerFilterCondition;

export interface ExplorerFilterGroup {
  op: 'and' | 'or';
  conditions: ExplorerFilterNode[];
}

export interface ExplorerFilterCondition {
  field: string;
  op:
    | 'eq'
    | 'neq'
    | 'in'
    | 'not_in'
    | 'gte'
    | 'lte'
    | 'gt'
    | 'lt'
    | 'contains'
    | 'not_contains'
    | 'is_set'
    | 'is_not_set';
  value?: string | number | boolean | Array<string | number>;
}

/** Janela de data — preset relativo (resolvido no TZ do workspace) ou explícita. */
export type ExplorerDateRange =
  | { preset: string }
  | { from: string; to: string };

/** Definição de uma entrada custom do catálogo (measure/dimensão salva). */
export interface ExplorerCatalogDefinition {
  /** Para measure salva: o spec da measure. */
  measure?: ExplorerMeasure;
  /** Para propriedade amostrada: valores frequentes p/ autocomplete. */
  sample_values?: string[];
  /** Descrição/alias amigável. */
  note?: string;
}

// ─────────────────────────────────── enums ───────────────────────────────────

export const insightKindEnum = pgEnum('insight_kind', INSIGHT_KINDS);
export const explorerCatalogEntryEnum = pgEnum('explorer_catalog_entry', [
  'dimension',
  'measure',
  'property',
]);

// ─────────────────────────────────── tabelas ───────────────────────────────────

export const insights = pgTable(
  'insights',
  {
    /** Gerado no serviço: `ins_<ulid>`. */
    id: text('id').primaryKey(),
    /** Tenant dono do insight (regra 1). */
    workspaceId: text('workspace_id').notNull(),
    /** visual (spec) | sql (texto guardado). */
    kind: insightKindEnum('kind').notNull().default('visual'),
    /**
     * Tipo de insight visual (trends|funnel|retention|path|breakdown). Para
     * `kind = 'sql'` fica 'sql'. Texto (não enum) p/ tolerar evolução do vocabulário.
     */
    insightType: text('insight_type').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** ExplorerQuerySpec (kind = visual). NULL p/ insights SQL. */
    spec: jsonb('spec').$type<ExplorerQuerySpec>(),
    /** SQL guardado (kind = sql). NULL p/ insights visuais. Validado antes de rodar. */
    sqlText: text('sql_text'),
    /** Dono/criador (M1 user id). */
    ownerId: text('owner_id'),
    /** Nº da versão corrente (espelha o topo de insight_versions). */
    currentVersion: integer('current_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('insights_workspace_idx').on(t.workspaceId, t.createdAt),
  }),
);

export const insightVersions = pgTable(
  'insight_versions',
  {
    /** Gerado no serviço: `inv_<ulid>`. */
    id: text('id').primaryKey(),
    /** Insight dono desta versão. */
    insightId: text('insight_id').notNull(),
    /** Tenant (regra 1 — escopo de toda leitura/restore). */
    workspaceId: text('workspace_id').notNull(),
    /** Nº sequencial da versão (1..N). */
    version: integer('version').notNull(),
    kind: insightKindEnum('kind').notNull(),
    insightType: text('insight_type').notNull(),
    /** Snapshot imutável do spec (visual). */
    spec: jsonb('spec').$type<ExplorerQuerySpec>(),
    /** Snapshot imutável do SQL (sql). */
    sqlText: text('sql_text'),
    /** Autor da alteração (M1 user id). */
    authorId: text('author_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Ordena o histórico de um insight; unicidade por (insight, versão).
    insightVersionUq: uniqueIndex('insight_versions_insight_version_uq').on(
      t.insightId,
      t.version,
    ),
    workspaceIdx: index('insight_versions_workspace_idx').on(t.workspaceId),
  }),
);

export const insightShares = pgTable(
  'insight_shares',
  {
    /** Gerado no serviço: `shr_<ulid>`. */
    id: text('id').primaryKey(),
    insightId: text('insight_id').notNull(),
    /** Tenant dono — a ÚNICA fonte de workspace na rota pública (regra 1). */
    workspaceId: text('workspace_id').notNull(),
    /** Token público (opaco). Resolve o insight sem auth, read-only. */
    token: text('token').notNull(),
    /** Hash de senha opcional (bcrypt/argon — nunca a senha em claro). */
    passwordHash: text('password_hash'),
    /** Expiração opcional; depois disso o token não resolve. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** Revogação (soft): quando presente, o token deixa de resolver. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenUq: uniqueIndex('insight_shares_token_uq').on(t.token),
    insightIdx: index('insight_shares_insight_idx').on(t.insightId),
    workspaceIdx: index('insight_shares_workspace_idx').on(t.workspaceId),
  }),
);

export const explorerCatalog = pgTable(
  'explorer_catalog',
  {
    /** Gerado no serviço: `cat_<ulid>`. */
    id: text('id').primaryKey(),
    /** Tenant dono da entrada (regra 1). */
    workspaceId: text('workspace_id').notNull(),
    /** dimension | measure | property. */
    entryType: explorerCatalogEntryEnum('entry_type').notNull(),
    /** Chave/caminho do campo (ex.: `context.utm_source`, `properties.plan`). */
    key: text('key').notNull(),
    /** Rótulo amigável / alias exibido no explorador. */
    label: text('label'),
    /** Tipo inferido/declarado (string|number|datetime|boolean). */
    dataType: text('data_type').notNull().default('string'),
    /** Tabela lógica de origem (events|touchpoints). */
    source: text('source').notNull().default('events'),
    /**
     * PII detectada na amostragem (regra 4/5): entradas com is_pii = true NÃO
     * são expostas em claro nem aceitas pelo compilador. Ver blocklist no service.
     */
    isPii: boolean('is_pii').notNull().default(false),
    /** Definição (measure salva / valores amostrados / nota). */
    definition: jsonb('definition').$type<ExplorerCatalogDefinition>(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Unicidade da chave por (workspace, tipo). Base do allowlist consultado no compile.
    keyUq: uniqueIndex('explorer_catalog_key_uq').on(t.workspaceId, t.entryType, t.key),
    workspaceIdx: index('explorer_catalog_workspace_idx').on(t.workspaceId),
  }),
);

export type Insight = typeof insights.$inferSelect;
export type NewInsight = typeof insights.$inferInsert;
export type InsightVersion = typeof insightVersions.$inferSelect;
export type NewInsightVersion = typeof insightVersions.$inferInsert;
export type InsightShare = typeof insightShares.$inferSelect;
export type NewInsightShare = typeof insightShares.$inferInsert;
export type ExplorerCatalogEntry = typeof explorerCatalog.$inferSelect;
export type NewExplorerCatalogEntry = typeof explorerCatalog.$inferInsert;
