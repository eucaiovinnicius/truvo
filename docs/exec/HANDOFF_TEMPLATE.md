# CODEX → TRUVO HANDOFF TEMPLATE

> Fill this at the end of every Truvo work item.
> The user will paste this report back into ChatGPT so the Notion roadmap can be updated from real code evidence.

## Handoff Metadata

- **Execution Order:**
- **Work Item:**
- **Result:** `DONE | PARTIAL | BLOCKED | REVIEW_NEEDED`
- **Date:**
- **Repository branch / commit before:**
- **Repository branch / commit after:**

## 1. Executive Summary

In 3–8 bullets, explain exactly what was accomplished.

- 
- 

## 2. Existing Code Reused

List important existing Truvo components that were preserved/adapted instead of rebuilt.

| Existing component | How it was reused |
|---|---|
| | |

## 3. Files Changed

List meaningful files/directories only.

| Path | Change | Why |
|---|---|---|
| | | |

## 4. Database / Migrations

- **Postgres migrations created/changed:**
- **ClickHouse migrations created/changed:**
- **Backfill required:** `yes/no`
- **Data compatibility notes:**

If none, write `None`.

## 5. Commands and Validation Evidence

Record exact commands and results.

| Command | Result | Notes |
|---|---|---|
| `...` | PASS/FAIL/SKIPPED | |

Include:
- install;
- lint if applicable;
- typecheck;
- tests;
- build;
- migrations;
- startup/health;
- critical flow checks.

Do not call a skipped check “passing”.

## 6. Acceptance Criteria

Copy the active work item's acceptance criteria and mark them accurately.

- [ ] 
- [ ] 

## 7. Compatibility Impact

### Preserved
- 

### Intentionally changed
- 

### Potential regressions
- 

## 8. Bugs / Technical Debt Discovered

Only include issues discovered from real code/runtime evidence.

| Issue | Severity | Blocks current item? | Suggested action |
|---|---|---|---|
| | | | |

## 9. Product / Architecture Decisions Needed

If none:
`None.`

If a decision is needed, provide:

- **Decision:**
- **Why it is needed:**
- **Options:**
- **Recommended option:**
- **Consequence of delaying:**

Do not silently make cross-cutting decisions.

## 10. Risks Remaining

- 

## 11. Work Item Status Recommendation

Choose one:

- `DONE` — all required acceptance criteria are satisfied.
- `PARTIAL` — useful progress, but acceptance criteria remain.
- `BLOCKED` — cannot safely continue without dependency/decision/environment fix.
- `REVIEW_NEEDED` — implementation is complete enough for human review but should not yet be treated as done.

**Recommended Notion status:**
**Recommended Notion readiness:**

## 12. Recommended Next Execution Order

- **Next order:**
- **Next work item:**
- **Why it is now unblocked / why it remains blocked:**

Do **not** start the next item automatically.

## 13. Copy/Paste Summary for ChatGPT / Notion

Keep this section compact and factual.

```text
TRUVO HANDOFF
Execution Order:
Work Item:
Result:
Summary:
Validation:
Migrations:
Compatibility:
Risks:
Decisions needed:
Recommended next item:
```

TRUVO_CODEX_HANDOFF_END
