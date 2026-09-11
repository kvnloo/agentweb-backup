# Feature queue

Source of truth: `queue.json`. Ranked by protocol score. Updated 2026-09-11 cycle 5.

**Do not implement yet.** `coding_unlocked: false`. Two items are **READY** with briefs.

## How Kevin can help (thesis)

Hermes operator + MCP creative discovery first. Local logged-in browser is
ENG-381 (relay is dead). DesignArena for model routing. Do not port Kerdoios.
Do not rewrite Agent Mode. Do not compete with WhatsApp Cloud API #2271.

## Ranked

| Rank | ID | Score | Status | Title |
|---|---|---|---|---|
| 1 | Q-001 | 34 | **ready** | Emma-via-Hermes operator path — `briefs/Q-001-hermes-oauth.md` |
| 2 | Q-014 | 34 | **ready** | Expose generate_image on MCP tools/list — `briefs/Q-014-generate-image-mcp.md` |
| 3 | Q-003 | 31 | keep | DesignArena adapter for Emma design/image tasks |
| 4 | Q-002 | 29 | triage | Eval-informed image routing (parse outputSummary; not a live router) |
| 5 | Q-006 | 27 | keep | Hide edit_landing_page_file; stop recommending missing coding_agent on MCP |
| 6 | Q-015 | 27 | keep | Hide admin MCP tools from non-admin tools/list |
| 7 | Q-007 | 27 | triage | Remotion compositions beyond intro/outro |
| 8 | Q-004 | 24 | keep | internalOnly on post_on_account / freeze_user_account (not ENG-983) |

## Parked

| ID | Score | Why parked |
|---|---|---|
| Q-011 | 26 | Hermes as ENG-381 local-agent successor; confirm ownership; not #2271 |
| Q-005 | 22 | Tool prompt already requires parallel variant calls |
| Q-008 | 22 | Eval workspace just shipped (ENG-1870) |
| Q-009 | 21 | ComfyUI backend — ops-heavy |
| Q-010 | 19 | callLLM strangler — Harsha gravity; target loop is Hermes-shaped |

## Discarded

| ID | Why |
|---|---|
| Q-012 | Kerdoios duplicates usage runway |
| Q-013 | God-object rewrite cannot merge |

## First coding (when unlocked)

Q-001 (docs/Hermes skill) and Q-014 (list generate_image, keep metering) in
parallel. Neither needs a database change.
