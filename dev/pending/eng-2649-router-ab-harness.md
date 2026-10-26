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
skills carrying the flow's required tool installed as `runVerifiedChat` does. The task is re-prompted ("Please try
again. Make sure to <tool> (1 more time needed).") up to 5 turns while the required tool is skipped, as the product's
`/verified-generate` does. Mock mode means no tool leaves the sandbox and both arms see identical tool results. Cost is
what OpenRouter reported (`usage.cost`, via `openRouterCallCostUsd`) for EVERY LLM call of the run, wrapped at
`agentModeService.callLLM` (suggested replies and side calls included). A call with no reported cost stops the run.
A run fails if it errored, if any assistant message ran a model other than the arm's, if a required tool was not
called, or if it returned nothing; a failed arm scores the floor without a judge call. Each pair is judged twice
(router first, incumbent first) with model names redacted and the required tool's arguments (the report body in
`create_blog_article`) shown in full; a judge must be from a provider that wrote neither arm.

**Safety and spend.** `generate`/`judge` refuse anything but `NODE_ENV=development`, an unset or production
`AWS_S3_BUCKET`, an exported `OPENROUTER_API_KEY` (unless `--allow-env-key`), a `--user-id` that is an admin, a shared
QA account or not on an RFC 2606/6761 reserved domain, and a task set not marked synthetic. Create one budget file
with `budget --generation-cap 150 --judge-cap 50`; every run (no-tier, Free, pilot, resume) passes it as
`--budget-file`, so the caps are global. Each call is reserved at an upper bound (max of its estimate and the largest
cost seen for that model) before it is sent and settled after; a crash leaves the reservation charged. Exit codes:
0 done, 1 error/refused, 3 stopped at the cap, 4 a call reported no cost.

**Not covered.** `scheduled` is refused (an in-process turn is not a faithful unattended run); v0 routes it to the same
model as today, so it needs no A/B. Mock mode skips the work-plan reminder and the retry backoff sleep (latency only).

**Finding while building it.** The Research Reports flow (`/verified-generate` with `create_blog_article`) runs
`agent_mode_report_generation_default_model` (falling back to `agent_mode_default_model`), not
`agent_mode_reports_model`: `runVerifiedChatInner` overwrites the session model the latter set at creation. The
report cell's incumbent must be whichever of the two the measured flow actually runs.
