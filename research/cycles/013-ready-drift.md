# Cycle 013 — READY drift check (no un-ready)

**When:** 2026-09-11T17:42Z  
**Focus:** Re-read cited files vs the six READY briefs. `origin/main` has
no new commits ahead of this branch.

## Drift table

| ID | Still true? | Citation now |
|---|---|---|
| Q-001 | **Docs already match the runbook.** `HERMES_MCP_OAUTH.md` L20–38 is the 315s PTY + paste-callback recipe, dated 2026-09-11. Production token **was not issued**. Remaining work is Kevin's host smoke + optional skill **outside** this repo. Do not plan a large AgentWeb PR. |
| Q-014 | Yes. `generate_image` still `internal: true` (`apiTools.ts` L2076–2077), required `category`, execute → `/api/emma/generate-image`. |
| Q-003 | Yes. Hardcoded default still `gemini-3-pro-image-preview`. Mapping file still the 2026-09-11 snapshot. |
| Q-004 | Yes. `post_on_account` L1493 listed, no `internal`. In-app remains `post_on_connected_account`. |
| Q-006 | Yes. `edit_landing_page_file` L1770 listed; description still names `coding_agent`. |
| Q-015 | Yes. `freeze_user_account` L3408 listed, no `internal`. |

`save_file` L3553 is `internal: true` (cost/storage). Not a queue item.

## Queue effect

- Q-001 first_slice narrowed: **no in-repo doc rewrite required**. Operator
  smoke on a Hermes host + optional skill in `hermes-agent`. Still READY
  because acceptance #1 (successful login) is unproven in production.
- Other READY unchanged. No collision refresh vs cycle 11 (same open PR
  set; `origin/main` quiet).

## Not this cycle

Do not unsubscribe the timer (`stop_after` is 20:15 UTC).
