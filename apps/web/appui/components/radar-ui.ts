export const RADAR_WINDOWS = [7, 14, 30, 60] as const;

export type AudienceAst =
  | { version: 1; op: 'identified' }
  | { version: 1; op: 'trait'; key: string; operator: 'eq' | 'exists'; value?: string | number | boolean }
  | { version: 1; op: 'outcome_occurred'; outcomeDefinitionId: string }
  | { version: 1; op: 'and' | 'or'; children: AudienceAst[] };

export type RadarReadiness = {
  status: 'ready_to_train' | 'insufficient_data';
  definitionVersion?: number;
  eligibleCustomerCount: number;
  positiveOutcomeCount: number;
  negativeCount: number;
  historyDays: number;
  minimumHistoryDays: number;
  identityCoverage?: number | null;
  contextCoverage?: { score?: number };
  blockers: string[];
  warnings: string[];
  activationReadiness?: { status: 'ready' | 'unavailable' | 'not_configured'; reasonCode: string | null };
};

export type RadarListItem = {
  id: string;
  name: string;
  status: string;
  current_definition_version: number;
  current_model_reference: string | null;
  outcome_definition_id: string;
  prediction_window_days: number;
  updated_at: string;
};

export type RadarDetail = {
  radar: RadarListItem;
  definition: {
    version: number;
    outcome_definition_id: string;
    audience_ast: AudienceAst;
    prediction_window_days: number;
    optimization_goal: Record<string, unknown>;
    activation_destination: { connectionId: string; capability: 'activation' } | null;
    readiness: RadarReadiness | null;
  };
  activationReadiness: { status: 'ready' | 'unavailable' | 'not_configured'; reasonCode: string | null };
};

export type RadarOutcome = { id: string; name: string; kind: string };
export type ActivationDestination = { id: string; provider: string; display_name: string; lifecycle_state: string; capabilities: string[] };

export const defaultAudience: AudienceAst = { version: 1, op: 'identified' };

export function audienceSummary(ast: AudienceAst, outcomes: RadarOutcome[] = []): string {
  if (ast.op === 'identified') return 'Todos os clientes identificáveis e elegíveis';
  if (ast.op === 'trait') return ast.operator === 'exists'
    ? `Clientes com o atributo ${ast.key}`
    : `Clientes com ${ast.key} igual a ${String(ast.value)}`;
  if (ast.op === 'outcome_occurred') return `Clientes com ${outcomes.find((outcome) => outcome.id === ast.outcomeDefinitionId)?.name ?? 'o resultado selecionado'}`;
  const label = ast.op === 'and' ? 'e' : 'ou';
  return ast.children.map((child) => audienceSummary(child, outcomes)).join(` ${label} `);
}

export function readinessCopy(code: string): string {
  const copy: Record<string, string> = {
    insufficient_labeled_examples: 'Ainda não há clientes elegíveis suficientes para esta pergunta.',
    insufficient_positive_outcomes: 'Há poucos clientes que já realizaram o resultado escolhido.',
    insufficient_negative_examples: 'Faltam clientes elegíveis sem o resultado escolhido para comparar.',
    insufficient_history: 'Ainda não há histórico suficiente para a janela de previsão escolhida.',
    target_outcome_unavailable: 'O resultado escolhido não está mais disponível. Escolha outro resultado ativo.',
    blocking_quality_issues: 'Há problemas de contexto que precisam ser corrigidos antes do treinamento.',
    activation_destination_unavailable: 'O destino de ativação está indisponível. Isso não impede validar os dados.',
    quality_warnings: 'Há avisos de qualidade. Você pode continuar, mas vale revisá-los.',
  };
  return copy[code] ?? 'Há uma condição de dados que precisa ser revisada.';
}

export function modelState(radar: Pick<RadarListItem, 'status' | 'current_model_reference' | 'current_definition_version'>): string {
  if (radar.status === 'training') return 'Treinamento em andamento';
  if (radar.status === 'failed') return 'Treinamento não foi concluído';
  if (radar.status === 'active' && radar.current_model_reference) return 'Modelo ativo para a definição atual';
  if (radar.status === 'paused') return 'Radar pausado';
  if (radar.status === 'archived') return 'Radar arquivado';
  if (radar.current_definition_version > 1 && !radar.current_model_reference) return 'A definição atual mudou e precisa ser validada novamente';
  return 'Aguardando validação dos dados';
}

export function statusLabel(status: string): string {
  return ({
    draft: 'Rascunho', validating_data: 'Validando dados', ready_to_train: 'Pronto para treinar', training: 'Treinando', active: 'Ativo',
    insufficient_data: 'Dados insuficientes', failed: 'Treinamento falhou', paused: 'Pausado', archived: 'Arquivado',
  } as Record<string, string>)[status] ?? status;
}
