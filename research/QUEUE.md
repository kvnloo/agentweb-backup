# Feature queue

Source of truth: `queue.json`. Ranked by protocol score. Updated 2026-09-11 cycle 4.

**Do not implement yet.** `coding_unlocked: false`.

## How Kevin can help (thesis)

Sit at **Hermes × Emma MCP** and **creative generation**. After OAuth, Hermes
still cannot *discover* `generate_image` (hidden, ENG-973). DesignArena
routing (Q-003) is the better no-table model picker than parsing Matt's Slack
queue. Do not unlist the CRUD catalogue (ENG-983 is the team's job). Do not
port Kerdoios. Do not rewrite `agentModeService.ts`.

## Ranked KEEP / triage

| Rank | ID | Score | Status | Title |
|---|---|---|---|---|
| 1 | Q-001 | 34 | keep | Make Emma-via-Hermes a real operator path |
| 2 | Q-014 | 34 | keep | Expose generate_image on external MCP tools/list |
| 3 | Q-003 | 31 | keep | DesignArena adapter for Emma design/image tasks |
| 4 | Q-002 | 29 | triage | Eval-informed image model routing (no new table) |
| 5 | Q-006 | 27 | keep | Hide edit_landing_page_file; stop recommending missing coding_agent on MCP |
| 6 | Q-015 | 27 | keep | Hide admin MCP tools from non-admin tools/list |
| 7 | Q-007 | 27 | triage | Remotion compositions beyond intro/outro |
| 8 | Q-004 | 24 | keep | Mark remaining outbound/admin MCP tools internalOnly (not ENG-983) |

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

When coding unlocks: **Q-001** (Hermes login runbook) in parallel with **Q-014**
(list `generate_image` to external MCP, keep metering) or **Q-015** (hide
`freeze_user_account`). Q-003 after those. Q-002 is an offline parser, not a
live router, until verdicts are structured.
