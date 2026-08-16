# Truvo Codex Context Index

Use this repository context progressively instead of loading the full PRD for every task.

## Always loaded / first read

- `/AGENTS.md` — short operating rules and navigation map.

## Current task

- `/docs/exec/ACTIVE_WORK_ITEM.md` — only the currently authorized work item.
- `/docs/exec/HANDOFF_TEMPLATE.md` — required end-of-task report.

## Deep reference

- `/docs/truvo/TRUVO_PRD_v4.4.md` — full product, migration architecture and roadmap.

## Token-efficient workflow

1. Start a Codex task with a short prompt:  
   `Follow AGENTS.md and execute the current ACTIVE_WORK_ITEM.md. Do not start the next item.`
2. Codex reads only the PRD sections referenced by the active work item.
3. When complete, Codex produces the handoff template.
4. Paste the handoff into ChatGPT.
5. ChatGPT updates Notion and generates/replaces `ACTIVE_WORK_ITEM.md` for the next task.
6. Repeat.

This keeps persistent context small while preserving a deep source of truth in the repository.
