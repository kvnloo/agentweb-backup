# Cycle 047 — Three catalogs for one tool name

UTC: 2026-09-11T20:05Z. Architecture track. `coding_unlocked` false. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.

## File-level citations

1. **Collision** (20 open AgentWebPro PRs). `apiTools.ts` /
   `imageGeneration.ts` / `loops/core` still empty. Avoid:
   `emma/tools.ts` (#2832 #1076 #689), `sdkConstructionGuard.test.ts`
   (#2563), `agentModeService.ts` pile (same as cycle 46), Slack
   `routes/slack.ts` (#2393). **#1076 now also touches
   `chatbotService.ts`** — do not edit that file. **#2861** is promoting
   `convert_to_pdf` to a foundation tool; do not piggyback
   `generate_image` onto that pattern.

2. **Same `generate_image` name, three availability policies.** Cycle 46
   named three *execute* faces. This cycle names the *catalogs*. Hermes
   has one `tools/list`. AgentWeb does not.

   | Face | Process | How the model sees the tool |
   |---|---|---|
   | MCP `tools/list` (Q-014) | Parent | `apiTools.ts` L2077 `internal: true` → `registry.ts` L82–84 `getToolDefinitions()` filters `!t.internal`. Still callable by name. No page. No skill. |
   | Emma chatbot | Parent | `chatbotService.ts` L5184 starts from `buildSkillContext` (foundation + skills), then L5204–5224 **pageToolMap**. `'images'` injects `generate_image` (L5211). |
   | Agent Mode | Worker | `buildSkillContext` L6937 = `FOUNDATION_TOOLS` + skill `toolNames` + `__other_skills__`. **No pageToolMap.** |

3. **`generate_image` is not a foundation tool; `describe_image` is.**
   `DEFAULT_FOUNDATION_TOOLS` (`agentModeService.ts` L6132–6255) lists
   `describe_image` (L6166–6171, ENG-260: *previously only injected on
   the `images` page* — they promoted analysis, not generation).
   `generate_image` is absent from that array (grep: no match in the
   foundation list). `getUnassociatedTools` L6372–6376 excludes
   foundation + admin + **page-context-only** `get_visual_context`.
   `generate_image` is not in that page-only exclusion, so on Agent Mode
   it lands in a skill or `__other_skills__`, not on every session.

4. **Hermes / OMP / cutting-edge.** One in-process registry, one list.
   Q-014 is the Hermes-facing catalog: drop `internal` so an
   authenticated MCP session *discovers* the tool. Do **not** copy
   chatbot `pageToolMap` onto MCP (Hermes has no AgentWeb URL). Do
   **not** add `generate_image` to `DEFAULT_FOUNDATION_TOOLS` in Q-014
   (#2861 owns that move for a different tool). A-006 as an HTTP image
   process would have to pick one catalog or reimplement all three.

## DISCARD / rank

Park **A-014** (sibling of A-011): do not unify availability policies
inside Q-014. A-006 stays discard. Product READY unchanged
(Q-001 / Q-014 / Q-003). Architecture order still A-002 → A-007 → A-008.

## Mapping evidence

`COMPOSITION.md` three catalogs. `briefs/Q-014-generate-image-mcp.md`
out of scope. `queue.json` A-014. `THESIS.md` one line.

## Next

Cycle 48: collision-only unless a cheaper mapping exists. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006. Unsubscribe
`agentweb-research-cycle` after `stop_after` (2026-09-12T06:00Z).
