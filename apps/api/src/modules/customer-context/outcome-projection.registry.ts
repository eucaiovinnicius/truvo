/**
 * Order 040 §1/§2 — registro EXPLÍCITO e revisável de projeção evento→outcome
 * canônico. Função pura, sem I/O: espelha o padrão já usado em
 * `apps/consumer/src/identity/event-hook.ts` (IDENTITY_TRIGGER_EVENTS) e
 * `apps/consumer/src/conversion-hook.ts` (CONVERSION_FORWARD_EVENTS) — uma lista
 * fixa de nomes de evento, nunca uma heurística sobre o nome.
 *
 * Escopo mínimo do §2 ("purchase/subscription"): cobre `purchase` e
 * `subscription_started`. `refund`/`subscription_cancelled` deliberadamente NÃO
 * entram aqui — reversão de outcome é uma semântica adicional (o que "desfazer" um
 * purchase observado significa) que o order não pede e que inventar agora arriscaria
 * uma segunda verdade de purchase divergente. Documentado no HANDOFF como follow-up.
 *
 * `valueProperty`/`currencyProperty` apontam para `event.properties.value` /
 * `event.properties.currency` — o MESMO vocabulário que `clickhouse-batch.ts`
 * (`buildRow`) e os normalizers de webhook (ex.: `normalizers/stripe.ts`) já usam.
 * Nenhum campo novo é inventado; a projeção só lê o que o EventSchema já carrega.
 */
export interface OutcomeProjectionRule {
  eventName: string;
  outcomeNamespace: string;
  outcomeKey: string;
  name: string;
  valueProperty: string;
  currencyProperty: string;
  /** de onde vem a chave de dedupe idempotente: order_id (preferencial) ou, na
   * ausência, o próprio event_id (ex.: subscription_started sem order_id). */
  dedupeFrom: 'order_id' | 'event_id';
}

export const OUTCOME_PROJECTION_RULES: readonly OutcomeProjectionRule[] = [
  {
    eventName: 'purchase',
    outcomeNamespace: 'commerce',
    outcomeKey: 'purchase',
    name: 'Purchase',
    valueProperty: 'value',
    currencyProperty: 'currency',
    dedupeFrom: 'order_id',
  },
  {
    eventName: 'subscription_started',
    outcomeNamespace: 'commerce',
    outcomeKey: 'subscription_started',
    name: 'Subscription started',
    valueProperty: 'value',
    currencyProperty: 'currency',
    dedupeFrom: 'order_id',
  },
] as const;

export function findOutcomeProjectionRule(eventName: string): OutcomeProjectionRule | undefined {
  return OUTCOME_PROJECTION_RULES.find((r) => r.eventName === eventName);
}
