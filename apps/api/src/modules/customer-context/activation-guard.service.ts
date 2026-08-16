import { Injectable } from '@nestjs/common';
import { CustomerContextService } from './customer-context.service';
import { assertNamespace } from './customer-context.contracts';

/** Namespace canônico das traits de consentimento/opt-out (Order 035 §3). */
export const CONSENT_TRAIT_NAMESPACE = 'consent';

export interface ActivationCheck {
  allowed: boolean;
  reason?: string;
  /** Quando conhecido, o instante em que o opt-out foi observado. */
  optOutObservedAt?: Date;
}

export interface RecordConsentInput {
  workspaceId: string;
  customerId: string;
  /** Canal/propósito livre (ex.: 'email', 'sms', 'ads_personalization') — Order 035
   * explicitamente NÃO fixa a lista de canais aqui (isso é Connector Framework). */
  channel: string;
  granted: boolean;
  sourceNamespace: string;
  observedAt: Date;
  provenance?: Record<string, unknown>;
}

/**
 * Order 035 §3 — CONSENT / OPT-OUT BOUNDARY. Contrato/serviço reusável que outros
 * módulos consultam ANTES de executar uma ativação (envio a um canal/plataforma).
 *
 * Consentimento é representado como uma trait canônica (`customerTraits`,
 * namespace `consent`) — reusa a infraestrutura de contexto do Order 30
 * (source/provenance/timestamp já embutidos), em vez de uma tabela nova.
 *
 * Fail-closed: só quando existe um opt-out CONHECIDO (trait booleana com
 * `granted=false` observada) uma ação é bloqueada. Ausência de sinal (nenhuma
 * trait registrada) NÃO é tratada como bloqueio aqui — isso é uma decisão de
 * política de produto (consent-required-by-default por canal) para o Connector
 * Framework decidir; ver `docs/exec/DATA_LIFECYCLE_LINEAGE.md`.
 *
 * NÃO implementa conectores de canal nem execução de ativação (fora de escopo).
 */
@Injectable()
export class ActivationGuardService {
  constructor(private readonly context: CustomerContextService) {}

  async assertChannelAllowed(
    workspaceId: string,
    customerId: string,
    channel: string,
  ): Promise<ActivationCheck> {
    const traitKey = assertNamespace(channel, 'channel');
    const trait = await this.context.getTrait(workspaceId, customerId, CONSENT_TRAIT_NAMESPACE, traitKey);
    if (!trait) return { allowed: true };

    const granted = trait.value === true;
    if (granted) return { allowed: true };
    return {
      allowed: false,
      reason: `known opt-out for channel '${traitKey}'`,
      optOutObservedAt: trait.observedAt,
    };
  }

  /** Registra uma decisão de consentimento/opt-out como trait canônica. */
  async recordConsent(input: RecordConsentInput) {
    const traitKey = assertNamespace(input.channel, 'channel');
    return this.context.upsertTrait({
      type: 'boolean',
      value: input.granted,
      workspaceId: input.workspaceId,
      customerId: input.customerId,
      traitNamespace: CONSENT_TRAIT_NAMESPACE,
      traitKey,
      sourceNamespace: input.sourceNamespace,
      observedAt: input.observedAt,
      provenance: input.provenance,
    });
  }
}
