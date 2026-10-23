## ENG-2649: blind A/B harness for the AgentWeb Model router vs today's defaults (2026-10-23)

**What.** `backend/src/scripts/routerAbEval.ts` (logic in `src/loops/eval/routerAb.ts`, tasks in `routerAbTasks.ts`)
runs ENG-669 AC3's quality-per-dollar A/B: per task type, the model the routing table sends it to (resolved with the
router's own `parseRoutingTable`/`routeFor`) against the model that flow runs today (passed in explicitly). Cells
whose two arms are the same model are not run. Inputs for v0: `backend/eval-artifacts/router-ab/`.

**Commands.** `plan` (free, offline: cells, eligible judges, upper-bound spend), `generate` (paid), `judge` (paid),
`report` (free; `--reprice model=in/out` for a price-change sensitivity, `--human ratings.csv`), `export-human` (free:
blinded sheet, sealed key, ratings template). Every command resumes from `--out-dir`.

**How a run works.** In-process `agentModeService.generateMarketingResponse(..., mockMode=true)` on the Dev tables, in a
session shaped like the product's (report_generation / image-generation / video-generation / emma-sidebar), with the
skills carrying the flow's required tool installed as `runVerifiedChat` does. Mock mode means no tool leaves the
sandbox and both arms see identical tool results. Cost is the turn's assistant-message usage priced by
`MODEL_PRICING` (an unpriced model is refused, never $0). A run fails if it errored, if any assistant message ran a
model other than the arm's, if a required tool was not called, or if it returned nothing; a failed arm scores the
floor without a judge call. Each pair is judged twice (router first, incumbent first) with model names redacted; a
judge must be from a provider that wrote neither arm (`gpt-6-sol` judges every cell; Sonnet 5 adds a second opinion on
Gemini-vs-Gemini cells).

**Safety.** `generate`/`judge` refuse anything but `NODE_ENV=development`, refuse a `--user-id` whose email is not on a
reserved test domain, refuse a task set not marked synthetic or naming a non-reserved domain, and stop before the call
that would pass `--max-usd` (spend already in `--out-dir` counts). Judge calls are unmetered (eval spend is no
customer's usage) and capped by OpenRouter's reported cost.

**Not covered.** `scheduled` is refused (an in-process turn is not a faithful unattended run); v0 routes it to the same
model as today, so it needs no A/B. Tool-internal LLM calls (e.g. `create_blog_article`'s rewrite, which uses the
`content_generation` role model) and suggested replies are the same on both arms and are excluded from cost.

**Finding while building it.** The Research Reports flow (`/verified-generate` with `create_blog_article`) runs
`agent_mode_report_generation_default_model` (falling back to `agent_mode_default_model`), not
`agent_mode_reports_model`: `runVerifiedChatInner` overwrites the session model the latter set at creation. The
report cell's incumbent must be whichever of the two the measured flow actually runs.
