import type { CustomerIdentifierType } from '@truvo/db';

/**
 * Order 045 §"Merge policy" — classificação DETERMINÍSTICA de força de evidência.
 * Lista fixa e revisável (mesmo espírito de `outcome-projection.registry.ts` do
 * Order 040) — nenhuma heurística sobre o valor, só o TIPO do identificador.
 *
 * STRONG: identificadores autenticados/de cliente ou contato aprovado-hasheado —
 * podem suportar merge determinístico quando concordam, e DEVEM gerar um conflito
 * explícito (nunca merge automático) quando divergem.
 *
 * WEAK: identificadores anônimos/de sessão — evidência insuficiente para decidir
 * sozinha; uma divergência também vira conflito (nunca reatribuição silenciosa),
 * só que a régua para tratar como "evidência de merge" em outras rotas é mais alta.
 */
export const STRONG_IDENTIFIER_TYPES: readonly CustomerIdentifierType[] = [
  'user_id',
  'email_hash',
  'phone_hash',
  'external_id',
  'order_id',
];

export const WEAK_IDENTIFIER_TYPES: readonly CustomerIdentifierType[] = ['click_id', 'anonymous_id'];

export function isStrongIdentifier(type: CustomerIdentifierType): boolean {
  return (STRONG_IDENTIFIER_TYPES as CustomerIdentifierType[]).includes(type);
}
