# AGENTS.md — Truvo

## Purpose

This repository is the existing Truvo v3.2 codebase being evolved into Truvo 4.x — AI Revenue Intelligence.

**Do not rebuild Truvo from zero. Preserve, adapt and extend the existing codebase.**

## Context strategy

Do not read every Truvo document for every task.

Use this order:

1. Read this `AGENTS.md`.
2. Read `docs/exec/ACTIVE_WORK_ITEM.md`.
3. Read only the PRD sections explicitly referenced by the active work item.
4. Inspect the relevant existing code before proposing changes.
5. Read other docs only when necessary to resolve the current task.

Full product source of truth:
- `docs/truvo/TRUVO_PRD_v4.4.md`

Current executable task:
- `docs/exec/ACTIVE_WORK_ITEM.md`

Required completion report:
- `docs/exec/HANDOFF_TEMPLATE.md`

## Product direction

Truvo is **AI Revenue Intelligence**.

Primary communication:
> Know who will buy next.

Core progression:
`Measure → Predict → Experiment → Decide → Act → Measure Incrementality → Learn`

The new product center is:
`Customer Context → Radars → Propensity → Revenue Opportunities → Activation → Learning`

## Migration rules

- Existing v3.2 code is an asset, not disposable legacy.
- Prefer additive migrations.
- Preserve EventSchema compatibility unless explicitly authorized.
- Preserve identity history and attribution behavior still exposed to users.
- Inspect existing subsystems before creating new ones.
- Do not create parallel auth/workspace/queue/identity/audit/integration systems without evidence.
- Never silently change event, identity, outcome or attribution semantics.
- Never silently show mock/synthetic business data in live mode.
- Demo mode may explicitly use synthetic data.

## Execution

Work **one Execution Order item at a time**.

Do not automatically continue to the next work item after completing the current one unless the user explicitly asks you to continue.

The currently authorized task is defined in:
`docs/exec/ACTIVE_WORK_ITEM.md`

## Validation

Run all checks relevant to the task.

Common checks:
- lint
- typecheck
- unit tests
- integration tests
- build
- migrations
- startup/health checks
- critical flow verification

Do not delete or weaken tests simply to make a task pass.

## Decision escalation

If implementation requires a product or cross-cutting architecture decision not covered by the active work item or PRD:

1. do not silently decide;
2. document the decision needed in the final handoff;
3. explain options and impact;
4. stop the affected scope if proceeding would create irreversible divergence.

## Required handoff

At the end of **every** task, produce a structured report following:
`docs/exec/HANDOFF_TEMPLATE.md`

The report is intentionally designed so the user can paste it back into ChatGPT to update the Truvo Notion roadmap.

Important:
- distinguish completed work from partial work;
- include exact commands and outcomes;
- include migrations;
- include files changed;
- include compatibility impact;
- include unresolved risks;
- recommend the next Execution Order, but do not start it automatically.

## Handoff marker

End every completion report with this exact marker:

`TRUVO_CODEX_HANDOFF_END`

This lets downstream tooling/humans quickly identify a complete handoff.
