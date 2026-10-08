## ENG-2263: log-only detector for stale CRM numbers presented as fresh (2026-10-08)

PR #3185 added a prompt rule ("`[verified]` on a CRM number means a tool call happened in THIS turn"). A scripted A/B replay (old vs new
prompt, one-line difference, ~400 runs, 8 models) showed the rule has no consistent effect: on cheaper, user-selectable models Emma
restates a stale account-wide CRM total about half the time, often tagged `[verified: get_lead_lists]` with no such call that turn. The
production default model (`gemini-3.8-flash`, verified on a fresh session) and the strong models (`claude-sonnet-5.5`, `gpt-5.5`) did not
(0 of ~80 runs). `gemini-3.1-flash-lite` is the cost-policy fallback (`optimizedDefaultModel`), not the default.

`utils/crmFreshnessGuard.ts` detects it deterministically (no LLM), log-only, two kinds:
- `cited_tool_not_run`: a `[verified: <CRM tool>]` tag whose cited tool did not run and succeed this turn (`toolCallSucceeded`: not errored,
  not `success:false`, not a duplicate, not deferred). Skipped: tags that say earlier/previous/stale, and a tag the model is only
  *discussing* ("I can't include the [verified] tag because no tool ran"). A bare `[verified]` naming no tool is not judged.
- `inventory_total_not_in_tool_results`: an account-wide total ("N lead lists", "N leads in total", "Total leads across all lists: N",
  "N leads across K lists") whose number is in none of this turn's CRM tool results. `get_lead_lists` returns per-list `leadCount` and
  `totalLists` but no total-leads field, so the model sums it; the check therefore accepts any number in the results, array lengths, the
  sum of `leadCount`, and the sum of per-call match counts. Skipped: honest wording ("earlier", "as of", "previous") within 140 chars.
  "N leads across all lists" is deliberately NOT an inventory claim - that is how a filtered search total reads.

It never edits the reply. Always on, try/catch-wrapped, kill switch `AGENT_CRM_FRESHNESS_GUARD=off`. Every scan is bounded (tag regex
{0,300}, input capped at 200KB, <=200 tags, <=20 claims, linear tag stripper): unbounded `[^\]]*`/`[^>]*` were quadratic (100KB of
unclosed `[verified ` blocked the event loop 1.5s, 500KB 37s).

Replay of saved outputs (simulated CRM tool results, real prompt): tag check alone catches ~51% of stale unlabelled totals from weak
models; with the total check, 39/39 on the set the patterns were tuned on and 36/36 on a fresh held-out batch (untuned). Default model:
0 false alarms on stale-free replies except one stale-derived count. Every flagged reply I inspected involved a stale or stale-derived
number; one reply that deliberately compared "was 18 / 47" against fresh counts was a genuine false alarm.

Reading it: one JSON line per flagged reply, `[crm-freshness-shadow] ... {"sessionId","model","kinds","findingCount","tagsSeen",
"crmToolsSucceeded","claimed":[numbers],"cited":[tool names]}`. It carries NO reply text - only numbers and tool names (an earlier
revision logged a 60-120 char slice of the reply, which can contain names and emails; the PR #3351 review caught it and a test now
asserts the exact key set and that PII in the reply never reaches the line). Summarise with
`node backend/scripts/summarize-crm-freshness-shadow.mjs web.stdout.log` (counts per model/kind, most-claimed numbers, cited tools).
Counts are flagged replies, not rates - the denominator comes from request logs. "Not backed this turn" is not the same as "stale": a
legitimate follow-up that restates an earlier number is flagged too. Decide enforcement only after reading production output.

Known limits: numbers are matched only in the patterns above ("N lead lists", "N leads in total", "Total leads: N", "Lead lists: N",
"N leads across K lists"); "1.2k", "twelve" and a bare "47 leads" are not claims. After a CRM write the check abstains. A turn that spans
several generateMarketingResponse invocations (auto-continue) only sees evidence from the current one. Only count-like fields
(count, total, totalLists, leadCount, ...) and array lengths back a number - not arbitrary numbers inside lead rows.
