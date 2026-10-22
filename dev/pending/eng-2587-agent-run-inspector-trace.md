## ENG-2587: AgentRun Inspector, step-by-step run trace (2026-10-20)

**Why.** The inspector is where a labeller checks whether a run did the task (ENG-665 links to it). It showed no work-plan steps, no tool arguments or results, and the final reply as escaped HTML cut at 360 characters, inside about 10 screens of boilerplate decision and flag cards.

**Backend.** `GET /api/admin/agent-runs/trace?sessionId=&startedAt=&completedAt=` (`services/agentRunTrace.ts`) returns one run's trace:
- the ask
- work-plan steps with the agent's notes, and the calls that served each step (a `set_work_plan_status` that closes steps ends a segment; plan-management calls before any work are "setup")
- every call's arguments and result, with failures parsed from the "Tool Error" text and linked to a later successful call to the same tool
- the final reply, plus summed cost and tokens

Messages are read newest-first back to the run's start (cap 1,000), so the latest run of a long session is always in the window. Every text field is capped and redacted:
- explicit passes first: URL user:password, Slack/Discord webhook paths, auth schemes, secret key/value pairs including header style
- then URL paths, UUIDs and word-like names are shielded from the opaque-token pass, which only masks strings with a digit

Reasoning and memory telemetry are never returned. The `x-aw-agent-runs-secret` credential now gets 403 on any sub-route. The list endpoint is unchanged, because an external fetcher reads it.

**Portal.** `AgentRunsInspector.tsx`, plus `components/agentRuns/`:
- **Header:** the status in words ("Completed · 3 failures, all recovered" vs "Completed · 2 failed calls"), steps done, calls, cost and tokens, model, copyable IDs, and grouped flag chips.
- **Body:** the ask shown once, steps collapsed with their notes, and one row per call that expands to show arguments and result.
- **Failures:** unrecovered failures start open; there is a Failed filter and a "First failure" jump.
- **Final reply:** sanitised through one module-level DOMPurify instance. Images become links, and the reply's links are listed up front.
- **Diagnostics:** gateway policy, repairs and raw events, collapsed at the bottom.
- **Behaviour:** `?run=` selects a run without re-running the search, Enter submits, status icons have accessible names, status colours are kept off body text, and the layout works at 390px.

The eval labelling page's link now opens the trace in a new tab.
