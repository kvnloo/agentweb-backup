# Cycle 002 — collisions, deprecated tools, MCP flags

**When:** 2026-09-11  
**Focus:** Open PRs, `coding_agent` vs `edit_landing_page_file`, MCP `internalOnly` coverage.

## Open PR collisions (`AgentWebPro/agentweb`)

| PR | Title | Queue impact |
|---|---|---|
| #2862 | OpenRouter 429 kills session when provider fallback exhausted | Do not patch `callLLM` retry. Q-006 stays docs/policy only. |
| #2271 | WhatsApp Cloud API as peer channel | Confirms Q-011 PARK. |
| #2861 | Promote `convert_to_pdf` to foundation tool | Unrelated; don't touch foundation-tool set. |
| #2871 | Autonomous report work plan | Unrelated. |
| #2563 | Remove dead AgentMode transports | Adjacent to gateway; don't restack transports. |
| #2850 | Partner-portal Emma brand tokens | UI; this tree's partner-portal only. |

No open PR is doing image-model routing, DesignArena, or Hermes operator UX.

## coding_agent vs full-file edit

`edit_landing_page_file` is still **registered and executable** in
`backend/src/mcp/server/apiTools.ts` (~L1769). Description says DEPRECATED
and points at `coding_agent`, but it is not `internal` / `internalOnly`.
Emma can still choose the broken path under token pressure.

Q-006 first slice is therefore: hide or refuse `edit_landing_page_file` for
new sessions (or wrap it to redirect), plus a test — not a doc-only fix.

## MCP curation is half-done

Mechanism exists (`registry.ts` ENG-973 hide vs ENG-974 refuse). Coverage is
thin: **4** `internalOnly` tools in `apiTools.ts` (`create_blog_article`,
`publish_blog_article`, `install_skills`, `send_email`) vs **85** registered
API tools. `generate_image` lives in `emma/tools.ts` and is **not** marked
internal — by design it is metered (ENG-973), so hiding is optional; publishing
tools are the real gap.

Q-004 remains KEEP: inventory `tools/list` as `externalMcp=true` and mark
remaining outbound tools `internalOnly`. Do not hide `generate_image` unless
product wants Hermes to not spend.

## generate_image variants

Tool description already instructs: emit N `generate_image` calls in one turn
for independent variants (parallel, bounded). Q-005 is therefore **not** a
missing product behavior — it is an `n` convenience. Demoted to park.

## Prompt quality ≠ model routing

`imagePromptQualityService` ranks **onboarding archetype prompts** by like-rate.
It does not score GPT-image vs Gemini vs Runway. Q-002 still needs human-eval
queue items or a new pure function over existing Matt feedback — cycle 4.

## Rank changes

- Q-005 → park (prompt already specifies parallel variants)
- Q-006 mergeability stays high; product up because the deprecated tool is live
- Q-004 confirmed: flags exist, coverage does not
