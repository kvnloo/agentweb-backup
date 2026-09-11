# Feature queue

Source of truth: `queue.json`. Protocol score is research leverage.
**Implementation order** (first PRs when unlocked): Q-001, Q-014, Q-003.
Cycle 8 promoted Q-003 to ready after a live DesignArena snapshot; it did
not un-ready Q-001 / Q-014.

**Do not implement yet.** `coding_unlocked: false`. `briefing_ready: true`.
Teach-in: `ARCHITECTURE.md`. Working agreement: `HOW_TO_HELP.md`.
Mapping: `mappings/designarena-image-models.md`.

## How Kevin can help (thesis)

Hermes operator + MCP creative discovery first. Then a fail-open
DesignArena → `SUPPORTED_MODELS` mapper (not mcp-bench-router's OpenRouter
chat map). Local logged-in browser is ENG-381 (relay is dead; ownership
unconfirmed). Do not port Kerdoios. Do not rewrite Agent Mode. Do not
compete with WhatsApp Cloud API #2271.

## Ranked (by score)

| Rank | ID | Score | Status | Title |
|---|---|---|---|---|
| 1 | Q-003 | 38 | **ready** | DesignArena adapter — `briefs/Q-003-designarena-adapter.md` |
| 2 | Q-001 | 34 | **ready** | Emma-via-Hermes operator path — `briefs/Q-001-hermes-oauth.md` |
| 3 | Q-014 | 34 | **ready** | Expose generate_image on MCP tools/list — `briefs/Q-014-generate-image-mcp.md` |
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

1. **Q-001** — Hermes OAuth runbook / skill (no customer blast radius).
2. **Q-014** — list `generate_image` on MCP (metering unchanged).
3. **Q-003** — fail-open DesignArena mapper; Matt before flipping the
   production default to `gpt-image-2`.

None of these needs a database change.
