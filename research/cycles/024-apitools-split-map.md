# Cycle 024 — A-007 first slice is infrastructure.ts, not content.ts

UTC: 2026-09-11T19:00Z. Architecture track. `coding_unlocked` false. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006.

## File-level citations

1. **Collision filter** `imageGeneration|apiTools|loops/core|agentMode/core|brandLogo`
   on 20 open `AgentWebPro/agentweb` PRs: **empty.** A-002 / A-007 / A-008
   still clear. A-005 still parked on the same `agentModeService.ts` set:
   **#2871 #2861 #2832 #2563 #2060 #1584 #1076** (+ `#689` / `#1076` /
   `#2832` on `emma/tools.ts`).

2. **`MODULE_MAP.md` proposed `tools/content.ts ← generate_image` is wrong.**
   `apiTools.ts` L1381 “Content” is `create_blog_article` / `publish_blog_article`
   and both `await import('../../services/agentModeService')` (L1406, 1442).
   `generate_image` is L2076 under the Internal-only block’s “Infrastructure
   tools” comment (L1996), with `you_search_*`, `google_search_web`,
   `send_email` — mcpFetch only. Q-014 still a one-flag change at L2077
   (`internal: true`, not `internalOnly`). `send_email` L2115 stays
   `internalOnly`.

3. **Header vs Hermes DAG.** File header L3–9 forbids direct service calls.
   Four dynamic loop imports exist (L1406, 1442, 1970, 1991) plus static
   `workPlanSteps` / `prDigestService`. Hermes tools do not import the
   agent loop. A-007’s first file must be the mcpFetch island so Q-014
   does not inherit `agentModeService`. Copy ENG-982 (`workflowTools.ts`,
   5 registers) — not an 85-file Hermes clone.

## DISCARD / rank

No rank change. A-007 **first_slice** narrowed to
`mcp/server/tools/infrastructure.ts`. A-006 stays discard (the Content
leak is an argument to keep the loop in-process). Product READY unchanged.

## Mapping evidence

`research/sdlc/A-007-split-map.md`.

## Next

Cycle 25: collision-only on `apiTools.ts` / `imageGeneration.ts` /
`loops/core`. Unsubscribe `agentweb-research-cycle` after `stop_after`
(2026-09-12T06:00:00Z).
