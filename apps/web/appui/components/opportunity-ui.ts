export function reconciliationCopy(state: string): { title: string; description: string; tone: 'neutral' | 'warning' | 'danger' } {
  return ({
    no_active_model: { title: 'Nenhum modelo ativo', description: 'Ative um modelo válido neste Radar para gerar oportunidades.', tone: 'neutral' },
    waiting_for_scores: { title: 'Atualizando previsões', description: 'O modelo atual ainda não tem um score batch concluído. Resultados antigos não serão apresentados como novos.', tone: 'warning' },
    needs_materialization: { title: 'Atualizando oportunidades', description: 'Uma versão mais recente está sendo materializada. A versão atual permanece consistente até a troca atômica.', tone: 'warning' },
    eligibility_refresh_due: { title: 'Revisão de elegibilidade pendente', description: 'A lista continua disponível enquanto a elegibilidade é atualizada.', tone: 'warning' },
    stale_identity: { title: 'Identidades em atualização', description: 'Clientes mesclados ou suprimidos são excluídos enquanto a lista é reconciliada.', tone: 'warning' },
    stale_model: { title: 'Modelo desatualizado', description: 'A versão referenciada não está ativa. Revise o ciclo de vida do modelo.', tone: 'danger' },
    materialization_failed: { title: 'Falha ao atualizar oportunidades', description: 'A versão anterior permaneceu intacta. Tente novamente ou verifique a operação.', tone: 'danger' },
  } as Record<string, { title: string; description: string; tone: 'neutral' | 'warning' | 'danger' }>)[state]
    ?? { title: 'Oportunidades atuais', description: 'Ranking versionado pelo score batch e modelo exibidos abaixo.', tone: 'neutral' };
}

export function formatMoney(value: string | number | null, currency: string | null): string {
  if (value === null || !currency) return 'Indisponível';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(value));
}

export function signalLabel(code: string): string {
  const known: Record<string, string> = {
    recent_purchase: 'Compra recente',
    high_engagement: 'Engajamento alto',
    returning_customer: 'Cliente recorrente',
    scale_tie: 'Sinal de propensão',
  };
  return known[code] ?? code.replace(/[_-]+/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
}

export function economicDisclosure(expectedRevenue: string | null, currencyState?: string): string {
  if (currencyState === 'mixed') return 'Múltiplas moedas — escolha uma moeda para comparar Receita Esperada.';
  if (expectedRevenue === null) return 'Receita esperada indisponível — histórico monetário consistente insuficiente.';
  return 'Probabilidade × valor estimado do resultado. Não é receita incremental.';
}
