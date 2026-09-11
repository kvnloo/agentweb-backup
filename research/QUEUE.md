# Feature queue

Source of truth: `queue.json`. Ranked by protocol score. Updated 2026-09-11 cycle 2.

**Do not implement yet.** `coding_unlocked: false`.

## How Kevin can help (thesis)

Sit at **Hermes × Emma MCP**, **creative model routing**, and **arena-style
image variants**. Do not pick up CRM/Meta/billing tickets the Argusoft team
already owns. Do not rewrite `agentModeService.ts`. Do not port Kerdoios —
usage runway already exists.

## Ranked KEEP / triage

| Rank | ID | Score | Status | Title |
|---|---|---|---|---|
| 1 | Q-001 | 34 | keep | Make Emma-via-Hermes a real operator path |
| 2 | Q-002 | 31 | triage | Eval-informed image model routing (no new table) |
| 3 | Q-003 | 30 | keep | DesignArena adapter for Emma design/image tasks |
| 4 | Q-004 | 30 | triage | MCP tools/list curation for external agents |
| 5 | Q-006 | 27 | keep | Hide deprecated edit_landing_page_file; fix OpenRouter doc drift |
| 6 | Q-007 | 27 | triage | Remotion compositions beyond intro/outro |

## Parked

| ID | Score | Why parked |
|---|---|---|
| Q-005 | 22 | Tool prompt already requires parallel variant calls |
| Q-008 | 22 | Eval workspace just shipped (ENG-1870); wait for Q-002 |
| Q-009 | 21 | ComfyUI backend — unique but ops-heavy; not first |
| Q-010 | 19 | callLLM strangler — right later, wrong first PR |
| Q-011 | 16 | Local Hermes WhatsApp proxy vs open PR #2271 |

## Discarded

| ID | Why |
|---|---|
| Q-012 | Kerdoios duplicates usage runway; steal BYOK-zero lesson only |
| Q-013 | God-object rewrite cannot merge |

## First coding candidate (not unlocked)

When the loop sets `coding_unlocked`, start with **Q-001** (Hermes operator path)
or **Q-006** (hide deprecated full-file edit) — both mergeable without schema.
Q-004 is the same class once cycle 3 lists exposed outbound tools. Q-002/Q-003
need cycle 4 evidence that routing can use existing human-eval items.
