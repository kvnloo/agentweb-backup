# Cycle 015 — collision refresh (no queue rewrite)

**When:** 2026-09-11T17:50Z  
**Focus:** Open PRs on `AgentWebPro/agentweb` vs READY files
(`apiTools.ts`, `imageGeneration.ts`, MCP registry). Do not un-ready
Q-001 / Q-014 / Q-003.

## Method

`gh api repos/AgentWebPro/agentweb/pulls?state=open` then file lists for
#2875, #2871, #2862, #2861, #2832, #2563, #2393, #2271, #2850. Filter:
`apiTools|imageGeneration|mcp/server|registry.ts|emma/tools|HERMES_MCP|humanEval|remotionService|llmPricing`.

## Result

**No open PR touches `apiTools.ts` or `imageGeneration.ts`.** Same set as
cycle 11; no new numbers.

| PR | Hit | Implication |
|---|---|---|
| **#2832** | `backend/src/emma/tools.ts` | Still: Q-004 must not edit that file |
| **#2862** | `toolErrorClassifier.ts` only | Not `callLLM` body; don't restack retry |
| **#2861** | `agentModeService.ts` + `pdfRenderService.ts` | convert_to_pdf foundation; not MCP listing. Don't pick up |
| **#2563** | no MCP/image match | dead transports; don't revive |
| **#2271** | no match in filter | WhatsApp Cloud API; Q-011 still park |
| #2875 #2871 #2850 #2393 | no match | contractor / partner-portal |

## Queue effect

None. STATE said skip a rewrite when those two files are clear. READY
set unchanged.

## Next

Cycle 16: same collision check. If still clear, do not reshuffle.
Unsubscribe after `stop_after` 20:15Z.
