## ENG-2263: log-only detector for `[verified: <CRM tool>]` tags no CRM call can back (2026-10-07)

PR #3185 added a prompt rule ("`[verified]` on a CRM number means a tool call happened in THIS turn"). An A/B replay
(old vs new prompt, one-line difference, ~290 runs across 8 models) showed the rule has no consistent effect:
on cheaper, user-selectable models Emma restated a stale overall CRM total about half the time, tagged
`[verified: get_lead_lists]` with no such call that turn. The production default model (`gemini-3.8-flash`,
verified on a fresh session) and the strong models (`claude-sonnet-5.5`, `gpt-5.5`) did not do it (0 of 79 runs).
`gemini-3.1-flash-lite` is the cost-policy fallback (`optimizedDefaultModel`), not the default.

`utils/crmFreshnessGuard.ts` detects that shape deterministically (no LLM): a `[verified: ...]` tag citing a CRM tool
(`get_lead_lists`, `get_leads`, `search_leads`, `ask_crm`, ...) that did not run and succeed this turn
(`toolCallSucceeded`: not errored, not `success:false`, not a duplicate, not deferred). Skipped: tags that already say
earlier/previous/stale, and a tag being *discussed* ("I can't include the [verified] tag because no tool ran").
A bare `[verified]` that names no tool is deliberately not judged: in the replay it caught nothing the cited rule missed,
and on the preview it misfired on exactly that commentary (gemini-3.8-flash). It is LOG-ONLY: it logs
`[crm-freshness-shadow] ... (message NOT modified)` with `{sessionId, model, kinds, findingCount, tagsSeen,
crmToolsSucceeded, sample}` and never edits the reply. Always on (pure, try/catch-wrapped); kill switch
`AGENT_CRM_FRESHNESS_GUARD=off`.

Offline replay of the saved outputs: flags 49 of 83 bad answers from weak models (59%), 0 of 79 on the default and strong
models. The unflagged remainder is a flat, untagged total, which this version deliberately does not touch.

To measure on production: `grep '\[crm-freshness-shadow\]'` in `web.stdout.log`; break down by `model` and `kinds`.
Decide enforcement (rewrite the tag to "from earlier in this conversation, may be out of date") only after that.
Not done, on purpose: the untagged-total caveat. Real `get_lead_lists` returns `lists[].leadCount` and `totalLists`
(no total-leads field), so the model sums it itself and a "number appears in the tool result" check must accept sums.
