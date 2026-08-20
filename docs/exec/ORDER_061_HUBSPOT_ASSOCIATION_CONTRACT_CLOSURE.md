# ORDER 061 — HUBSPOT ASSOCIATION + CONTRACT CLOSURE

**Execution Order:** 61  
**Goal:** close the two remaining Order 61 acceptance gaps only.

## Current state

Order 61 implementation is committed at:

`05cb78d`

Already proven and **not to be reimplemented**:

- real bidirectional HubSpot adapter
- OAuth/token refresh + least-privilege configurable scopes
- CRM API contract/version pinned
- contacts / companies / deals backfill
- independent multi-stream checkpoints
- batch webhooks process every event in the new Connector Framework path
- explicit workspace-scoped outcome mapping
- reconciliation for missed webhooks
- namespaced Truvo writeback
- Identity Graph v2 + suppression integration
- additive CRM migration `0008_normal_mother_askani.sql`
- 164/164 API tests PASS, 0 skip
- migration validation / lint / typecheck / build / API boot PASS

Named `ORDER_*.md` files are authoritative. Ignore stale `ACTIVE_WORK_ITEM.md`.

Do not start Order 62.

## Remaining gap A — run the actual shared Connector Framework contract kit

The Order 61 handoff states that HubSpot used a provider-specific proof pattern instead of actually passing the reusable Order 50 contract kit.

That does **not** satisfy the explicit acceptance item:

`Order 50 connector contract kit PASS for HubSpot`

### Required

Inspect:

- `connector-contract-kit.ts`
- `connector-contract-kit.test.ts`
- HubSpot adapter contract tests
- Shopify adapter contract tests

Minimally refactor/parameterize the shared kit so a real provider adapter can be supplied with capability-aware fixtures without weakening the fake-provider baseline.

The shared kit must execute against the HubSpot adapter for every applicable capability, including at least:

- source capability
- destination capability
- connection lifecycle / connection test semantics
- checkpoint resume / idempotency
- transient retry classification
- permanent auth failure classification
- rate-limit behavior
- webhook verification / duplicate handling where the kit covers it
- destination idempotency/correlation
- tenant isolation where the kit covers it

Rules:

- do not copy/paste the helpers into a HubSpot-only suite;
- do not replace shared assertions with weaker provider-specific assertions;
- capability gating is allowed only where a contract truly does not apply;
- no relevant test may be reported PASS if skipped.

Shopify/fake-provider contract behavior must remain green.

## Remaining gap B — authoritative CRM association convergence

Current `crm_associations` behavior is additive-only.

A reassociation can therefore produce:

`old edge + new edge`

instead of converging to HubSpot's current relationship state.

That is not sufficient for CRM context.

### Required semantics

Implement a **provider-neutral authoritative association reconciliation** mechanism.

For a scoped association set fetched/received from a provider:

- upsert currently present edges;
- deactivate/delete/tombstone previously-active edges that are now absent from the authoritative provider state;
- preserve workspace + provider provenance;
- repeated reconciliation is idempotent;
- another workspace is unaffected;
- out-of-order stale updates must not resurrect a newer-removed edge;
- object deletion/restoration must produce deliberate association behavior.

Prefer additive schema evolution such as `deleted_at` / active-state metadata if history/auditability benefits from it.

Do not create HubSpot-specific columns in the canonical CRM relationship table.

### Webhook vs reconciliation

Inspect the current HubSpot adapter/provider contract and the official supported webhook semantics already used by the implementation.

If the current supported HubSpot webhook contract can represent association add/remove directly, handle it.

If it cannot reliably provide the full authoritative association set, use the existing reconciliation pull as the source of truth for pruning stale edges.

Do not invent provider events.

## Required runtime scenarios

Use disposable Postgres 16 and the existing deterministic HubSpot provider test double/fixtures.

Directly prove:

### Deal reassociation

1. Deal D is associated with Company A.
2. Sync/reconciliation persists exactly the active D→A edge.
3. Provider state changes so D is now associated with Company B and no longer A.
4. Incremental/reconciliation runs through the normal Connector Framework path.
5. Active canonical state contains D→B.
6. D→A is no longer active.
7. Repeating the same sync is idempotent.

### Contact/company reassociation

Repeat the equivalent proof for a contact/company association.

### Out-of-order safety

Apply an older/stale association update after a newer reassociation and prove it cannot silently restore the obsolete active edge.

### Tenant isolation

Use the same provider object/association IDs in another workspace and prove no cross-workspace mutation.

### Outcome safety

Where deal outcome mapping depends on a primary contact association, prove reassociation causes future mapped outcomes to use the **current valid association**, without duplicating an existing natural outcome.

Do not change the rule that a deal is not a purchase unless explicitly mapped.

## Repair boundaries

If closure exposes a framework defect:

- fix only the smallest provider-neutral contract/association defect;
- add shared regression coverage;
- do not redesign Connector Framework;
- do not reopen OAuth, writeback, CRM object schemas or Radar logic unless the failing proof directly requires a minimal compatibility fix.

The legacy M4 single-event webhook normalizer may remain untouched as long as the production Connector Framework HubSpot path continues to process all batch events and existing legacy behavior is not regressed.

## Final gate

Run against required disposable infrastructure:

```bash
pnpm migration:validate
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Also report separately:

- shared Connector Framework contract-kit results for HubSpot;
- HubSpot adapter contract/integration results;
- association reassociation/removal/out-of-order results;
- exact total test counts;
- **0 relevant skip**.

If schema changes, apply the versioned migration from a clean disposable Postgres database and prove the second migration run is safe/no-op.

## Definition of Done

Return `DONE` only if:

- the actual shared Order 50 contract kit runs and passes against HubSpot for all applicable capabilities;
- reassociation converges to the provider's current association set rather than accumulating stale active edges;
- stale/out-of-order updates cannot resurrect obsolete associations;
- tenant isolation and idempotency are runtime-proven;
- mapped deal outcomes use the current association safely;
- the full repository regression gate remains green.

Do not start Order 62.

## Handoff

Use `/docs/exec/HANDOFF_TEMPLATE.md`.

Include:

- shared contract-kit changes and exact HubSpot shared-kit results
- association state model
- deal reassociation proof
- contact/company reassociation proof
- removal/tombstone proof
- out-of-order proof
- tenant isolation
- mapped-outcome association proof
- migrations if any
- exact final validation results
- any residual provider limitation

End with:

`TRUVO_CODEX_HANDOFF_END`
