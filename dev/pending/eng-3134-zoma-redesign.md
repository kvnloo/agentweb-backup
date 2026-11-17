## ENG-3134: Zoma redesign — agent-first onboarding without Emma, pal classification, zoma_ads_report (2026-11-16)

- MCP `initialize` carries `instructions` opening with "Hey, welcome to Zoma."; the first `zoma_status` is that greeting plus the one ads-experience question (no checklist).
- MCP users' Meta connect link signs `zoma: "mcp"` into the OAuth state; `/api/oauth/meta/callback` forwards it to `/api/zoma/meta/callback`, which finalizes for the state's user on Zoma pages (picker link carries `uid`). The card return is `/api/zoma/done?mcp=1`. Nothing in the Zoma flow points at app.agentweb.pro except the OAuth consent page.
- Every MCP tool result gets a `Next step:` block (REST: `next_step`), except `zoma_status` and the friend path; shared Meta refusals have "Settings -> Connected accounts" rewritten for Zoma at the transport only (Emma text unchanged).
- Friend answer = exactly "Thanks for signing up and trying out Zoma."; scoreboard exclusion value is now `pal` (was `not_interested`), `summary.palUsers` added.
- `zoma_ads_report`: one paged Graph insights read (max 10 pages; larger reports are refused, never partial). ROAS is always purchase value / spend.
- Production cleanup candidates (4 test rows) and backup were prepared; the delete itself was not run (permission denied) — see the PR.
