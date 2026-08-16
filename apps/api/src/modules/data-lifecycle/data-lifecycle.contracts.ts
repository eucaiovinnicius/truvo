import type { CustomerContext } from '../customer-context/customer-context.contracts';

/**
 * Order 035 §5 — DATA LIFECYCLE FOUNDATION. Contratos + classificação de linhagem.
 *
 * `DATA_LIFECYCLE_LINEAGE` é a fonte única (como código, testável) da classificação
 * delete/anonymize/reconstruct exigida pelo Acceptance Criteria. A versão em prosa
 * para o handoff/Notion vive em `docs/exec/DATA_LIFECYCLE_LINEAGE.md` — mantida em
 * sincronia manual; este array é a fonte de verdade.
 *
 * `executedByOrder35=true` marca o que a EXECUÇÃO MÍNIMA deste order de fato cobre
 * (tombstone workspace-scoped em Postgres/customer-context). Tudo com `false` é
 * lineage DOCUMENTADO mas cuja purga/anonimização real fica para o Order 55 (motor
 * de erasure cross-store completo) — não implementado aqui por escopo explícito.
 */
export type LineageAction = 'delete' | 'anonymize' | 'reconstruct';

export interface StoreLineageEntry {
  store: string;
  description: string;
  action: LineageAction;
  executedByOrder35: boolean;
  notes: string;
}

export const DATA_LIFECYCLE_LINEAGE: readonly StoreLineageEntry[] = [
  {
    store: 'postgres.customers/customer_identifiers/customer_traits/customer_relationships',
    description: 'Canonical customer context (Order 30) — a fonte primária de identidade/traits/relacionamentos Truvo 4.x.',
    action: 'delete',
    executedByOrder35: true,
    notes: 'Tombstoned via deleted_at (DataLifecycleService); purga física definitiva fica para uma varredura de retenção do Order 55.',
  },
  {
    store: 'postgres.outcome_definitions',
    description: 'Definições de outcome do workspace (não são dados de UMA pessoa).',
    action: 'delete',
    executedByOrder35: true,
    notes: 'Tombstoned apenas em workspace_deletion (não em subject_deletion, que é por pessoa).',
  },
  {
    store: 'postgres.identity_links / identity_merges',
    description: 'Grafo de identidade legado (M8, v3.2) — customer-context referencia via legacy_canonical_id.',
    action: 'anonymize',
    executedByOrder35: false,
    notes: 'Order 55 precisa resolver o canonical_id legado e aplicar a mesma decisão de retenção/anonimização.',
  },
  {
    store: 'postgres.user_profiles',
    description: 'Projeção de perfil (M15), derivada de ClickHouse + Postgres.',
    action: 'reconstruct',
    executedByOrder35: false,
    notes: 'É um cache derivado — reconstrói automaticamente a partir das fontes; não precisa de ação direta de purga.',
  },
  {
    store: 'postgres.profile_access_log',
    description: 'Trilha de auditoria LGPD (M15) — quem acessou qual pessoa.',
    action: 'anonymize',
    executedByOrder35: false,
    notes: 'É em si um registro de auditoria (retenção separada); Order 55 decide política de retenção do PRÓPRIO log, não deleta junto com o titular.',
  },
  {
    store: 'clickhouse.events',
    description: 'Stream de eventos brutos (M2) — carrega identificadores hasheados/pseudônimos por linha.',
    action: 'anonymize',
    executedByOrder35: false,
    notes: 'Referenciado (não buscado/apagado) via customer.behavior_references. Purga/anonimização linha-a-linha é o motor do Order 55.',
  },
  {
    store: 'clickhouse.touchpoints',
    description: 'Toques de atribuição (M7/M8), derivados de events.',
    action: 'anonymize',
    executedByOrder35: false,
    notes: 'Mesma fronteira de events — Order 55.',
  },
  {
    store: 'clickhouse.*_daily / materialized views',
    description: 'Agregações/projeções materializadas (funis, atribuição, reconciliação, criativos).',
    action: 'reconstruct',
    executedByOrder35: false,
    notes: 'Derivadas de events — se regeneram automaticamente após a purga upstream; nenhuma ação direta por titular.',
  },
  {
    store: 'postgres.integration_out_logs / webhook_logs',
    description: 'Logs de entrega de integrações de saída/entrada (M4/M9).',
    action: 'anonymize',
    executedByOrder35: false,
    notes: 'Retidos por auditoria operacional; campos com PII (se houver) precisam de revisão no Order 55.',
  },
] as const;

export type DataLifecycleKind = 'subject_export' | 'subject_deletion' | 'workspace_deletion';

export interface SubjectExportResult {
  requestId: string;
  status: 'completed' | 'failed';
  context: CustomerContext | null;
  lineage: readonly StoreLineageEntry[];
}

export interface TombstoneCounts {
  customers: number;
  identifiers: number;
  traits: number;
  relationships: number;
  outcomeDefinitions: number;
}
