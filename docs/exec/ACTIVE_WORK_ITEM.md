# ACTIVE WORK ITEM

## Execution Order 130 — QA & Workspace de Demonstração v1

**Priority:** P0
**Phase:** MVP / Reliability
**Code State:** Partial
**Reuse Strategy:** Adapt
**Status:** Ready
**Readiness:** Build Ready
**Canonical Spec:** `docs/exec/ORDER_130_QA_DEMO_WORKSPACE_V1.md` (SPEC-21)
**Baseline SHA:** `581f2b508542b1472e23f185cdd0c5eccd096e97`
**Branch:** `order-130-qa-demo-workspace`

---

## 0. Mission

Entregar uma infraestrutura reproduzível de QA e workspace de demonstração para o loop central da Truvo:
`Customer Context → Radars → Propensity → Revenue Opportunities → Activation → Learning`.

Permitir que qualquer novo agente ou pipeline de CI execute uma jornada determinística de ponta a ponta e detecte regressões reais de produto.

### Escopo obrigatório
1. **Workspace de demonstração determinístico:** Entrypoint canônico para criar/resetar workspace de demo/QA com dados conhecidos e IDs estáveis.
2. **Dataset sintético versionado:** Entidades completas cobrindo as 6 personas de SPEC-21:
   - Persona 1: Provável comprador
   - Persona 2: Não comprador
   - Persona 3: Comprador recorrente
   - Persona 4: Candidato a upgrade de assinatura
   - Persona 5: Histórico semelhante a churn
   - Persona 6: Histórico insuficiente
3. **Fixtures portáveis e sanitizadas de conectores:** Payloads de ingestão/conectores (Shopify, Stripe, HubSpot, Klaviyo) sem segredos, tokens ou dados reais, provando transformações source → canônico.
4. **Isolamento de tenants (Tenant Isolation):** Prova em runtime/API/queries entre Workspace A e Workspace B.
5. **Golden E2E do loop central:** Jornada determinística completa:
   `workspace → seed/input → canonical context → anonymous-known identity merge → Radar → scoring → opportunity → activation/export → result/decision`.
6. **Regression Gate:** Comando root canônico `pnpm test:demo-workspace` integrado a `pnpm test:prebeta` e ao CI.
