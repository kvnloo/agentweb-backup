# Cycle 011 — Q-004 `post_on_account` + collision refresh

**When:** 2026-09-11T17:38Z  
**Focus:** Outbound MCP social publish. Collision refresh of AgentWebPro
open PRs. Do not un-ready Q-001 / Q-014 / Q-003 / Q-006 / Q-015.

## Citations

- MCP `post_on_account` (`apiTools.ts` L1493–1516): listed, **no**
  `internal` / `internalOnly`. ENG-827 `publishWithdrawnMidFlight` then
  `POST /api/emma/post-on-account`. Description has **no** "get explicit
  approval" language.
- In-app Emma posts via `post_on_connected_account`
  (`emma/tools.ts` L4514) with CRITICAL approval copy, plus
  `create_social_media_posts` / `twitter_manage_post`. Those names are
  **not** on `mcpToolRegistry`. Hiding the MCP wrapper does not remove
  in-app posting.
- Blog create/publish already `internalOnly` (L1385–1387, L1418–1420).
  Social post is the inconsistent outbound hole.
- Also listed writes (not this slice): `publish_landing_page_changes`
  (L1885, also ENG-827), `generate_landing_page` (generate+deploy).
- `security.mcpServer.test.ts` `INTERNAL_TOOL_NAMES` does not include
  `post_on_account`.

## Collision refresh (2026-09-11T17:38Z)

Open on `AgentWebPro/agentweb` — none edit `apiTools.ts` `post_on_account`:

| PR | Why still avoid |
|---|---|
| **#2862** | `toolErrorClassifier.ts` — OpenRouter 429. Not `callLLM` body; still don't restack retry. |
| **#2271** | WhatsApp Cloud API |
| **#2861** | `convert_to_pdf` foundation tool |
| **#2563** | dead AgentMode transports |
| **#2871** | autonomous report work plan |
| **#2875** | renewal-health alert |
| **#2832** | X ranking scores — **touches `emma/tools.ts`**. Q-004 must not edit that file. |
| CRM/HubSpot #1814 etc. | contractor lane |

Q-004 collision 3→1 (no in-flight hide of this tool; #2832 is emma-registry).

## Queue effect

- **Q-004** KEEP → **ready**. Brief: `briefs/Q-004-post-on-account-internalOnly.md`.
  Score 24→32. Hygiene: land **with or before Q-014** so Hermes cannot
  discover image gen *and* live social publish in the same listing.
- Implementation order stays Q-001, Q-014, Q-003. Q-004 is hygiene
  alongside Q-006 / Q-015, not Kevin's unique first PR.
