import type { CustomerContext } from '../customer-context/customer-context.contracts';

/**
 * Order 035 §5 / Order 055 — DATA LIFECYCLE. Contratos + classificação de linhagem.
 *
 * `DATA_LIFECYCLE_LINEAGE` é a fonte única (como código, testável) da classificação
 * delete/anonymize/reconstruct exigida pelo Acceptance Criteria. A versão em prosa
 * para o handoff/Notion vive em `docs/exec/DATA_LIFECYCLE_LINEAGE.md` — mantida em
 * sincronia manual; este array é a fonte de verdade.
 *
 * `executedByOrder35=true` marca o que a EXECUÇÃO MÍNIMA original cobria (tombstone
 * workspace-scoped em Postgres/customer-context apenas). `executedByOrder55=true`
 * marca o que o motor de erasure cross-store completo (`erasure/*.registry.ts`) de
 * fato executa hoje — subject deletion e/ou workspace deletion, conforme a store.
 * Entradas com `executedByOrder55=false` continuam documentadas mas
 * deliberadamente não-executadas (reconstruct — não precisam de ação direta; ou
 * fora do escopo explícito desta ordem — ver seus `notes`).
 */
export type LineageAction = 'delete' | 'anonymize' | 'reconstruct';

export interface StoreLineageEntry {
  store: string;
  description: string;
  action: LineageAction;
  executedByOrder35: boolean;
  executedByOrder55: boolean;
  notes: string;
}

export const DATA_LIFECYCLE_LINEAGE: readonly StoreLineageEntry[] = [
  {
    store: 'postgres.customers/customer_identifiers/customer_traits/customer_relationships',
    description: 'Canonical customer context (Order 30) — a fonte primária de identidade/traits/relacionamentos Truvo 4.x.',
    action: 'delete',
    executedByOrder35: true,
    executedByOrder55: true,
    notes: 'Tombstoned via deleted_at (fase 1, imediata); purga física definitiva é a varredura de retenção (Order 55 §5, RetentionEnforcementService) após a janela configurada por workspace.',
  },
  {
    store: 'postgres.customer_outcomes',
    description: 'Outcomes canônicos observados (Order 40) — não existia quando o Order 035 foi escrito.',
    action: 'delete',
    executedByOrder35: false,
    executedByOrder55: true,
    notes: 'Tombstoned em subject_deletion e workspace_deletion, mesma janela de retenção das demais tabelas de customer-context.',
  },
  {
    store: 'postgres.outcome_definitions',
    description: 'Definições de outcome do workspace (não são dados de UMA pessoa).',
    action: 'delete',
    executedByOrder35: true,
    executedByOrder55: true,
    notes: 'Tombstoned apenas em workspace_deletion (não em subject_deletion, que é por pessoa) — inalterado.',
  },
  {
    store: 'postgres.identity_links / identity_merges',
    description: 'Grafo de identidade legado (M8, v3.2) — customer-context referencia via legacy_canonical_id.',
    action: 'delete',
    executedByOrder35: false,
    executedByOrder55: true,
    notes: 'Order 055 adicionou deleted_at a identity_links (migração aditiva) e passou a filtrar isNull(deleted_at) nas leituras de IdentityService. subject_deletion tombstona os links do canonical legado; workspace_deletion faz hard-delete de ambas as tabelas.',
  },
  {
    store: 'postgres.identity_conflicts / identity_merge_events',
    description: 'Evidência de conflito/merge auditável do Identity Graph v2 (Order 45) — não existia quando o Order 035 foi escrito.',
    action: 'anonymize',
    executedByOrder35: false,
    executedByOrder55: true,
    notes: 'RETIDO (é a trilha de auditoria de merge/conflito) — mas os valores de identificador que carregam (identifierValue / evidence.movedIdentifiers[].identifierValue) são redigidos para linhas que tocam o titular removido. workspace_deletion faz hard-delete de ambas as tabelas (não há "auditoria" a preservar para um workspace que deixou de existir).',
  },
  {
    store: 'postgres.connector_connections / connector_sync_checkpoints / connector_sync_runs / connector_destination_writes',
    description: 'Connector Framework (Order 50) — connection/sync/destination-write ledgers, escopados a workspace+provider, não a um titular.',
    action: 'delete',
    executedByOrder35: false,
    executedByOrder55: true,
    notes: 'Nenhuma destas tabelas tem coluna subject-owned (confirmado por inspeção) — nada a fazer em subject_deletion. workspace_deletion faz hard-delete de connector_connections, que cascateia (FK ON DELETE CASCADE) para as outras três — inclui a destruição das credenciais cifradas.',
  },
  {
    store: 'postgres.integrations / integration_out_configs',
    description: 'Configuração de integração de entrada (M4) / saída (M9) por workspace — carrega credenciais cifradas.',
    action: 'delete',
    executedByOrder35: false,
    executedByOrder55: true,
    notes: 'Não são subject-owned — nada em subject_deletion. workspace_deletion faz hard-delete (destrói as credenciais cifradas junto com a linha).',
  },
  {
    store: 'postgres.user_profiles',
    description: 'Projeção de perfil (M15), derivada de ClickHouse + Postgres.',
    action: 'reconstruct',
    executedByOrder35: false,
    executedByOrder55: false,
    notes: 'É um cache derivado — reconstrói automaticamente a partir das fontes; não precisa de ação direta de purga.',
  },
  {
    store: 'postgres.profile_access_log',
    description: 'Trilha de auditoria LGPD (M15) — quem acessou qual pessoa.',
    action: 'anonymize',
    executedByOrder35: false,
    executedByOrder55: false,
    notes: 'É em si um registro de auditoria com política de retenção própria, separada do titular que descreve — deliberadamente não tocado por subject_deletion. Nenhuma decisão de produto definiu essa política ainda (ver HANDOFF, "policy ambiguity").',
  },
  {
    store: 'clickhouse.events',
    description: 'Stream de eventos brutos (M2) — carrega identificadores hasheados/pseudônimos por linha.',
    action: 'delete',
    executedByOrder35: false,
    executedByOrder55: true,
    notes: 'Order 055 executa ALTER TABLE events DELETE (mutation síncrona) casando por todo identificador conhecido do titular (canonical id, legacy canonical id, e os valores brutos de customer_identifiers/identity_links — events não tem coluna canonical_id).',
  },
  {
    store: 'clickhouse.touchpoints',
    description: 'Toques de atribuição (M7/M8), derivados de events.',
    action: 'delete',
    executedByOrder35: false,
    executedByOrder55: true,
    notes: 'Order 055 executa ALTER TABLE touchpoints DELETE (mutation síncrona) por canonical_id — a tabela já carrega essa coluna diretamente.',
  },
  {
    store: 'clickhouse.*_daily / materialized views',
    description: 'Agregações/projeções materializadas (funis, atribuição, reconciliação, criativos).',
    action: 'reconstruct',
    executedByOrder35: false,
    executedByOrder55: false,
    notes: 'Derivadas de events — se regeneram automaticamente após a purga upstream; nenhuma ação direta por titular.',
  },
  {
    store: 'postgres.integration_out_logs / webhook_logs',
    description: 'Logs de entrega de integrações de saída/entrada (M4/M9).',
    action: 'anonymize',
    executedByOrder35: false,
    executedByOrder55: false,
    notes: 'Fora do escopo explícito do Order 055 (não listado no "at minimum" do order); retidos por auditoria operacional. Risco residual documentado no HANDOFF.',
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
