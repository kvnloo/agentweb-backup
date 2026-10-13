## ENG-2378: Work Plans can pin a model per step (work_plan_step_models_enabled) (2026-10-13)

Before: a Work Plan could pin one `defaultModel` for the whole plan; every step ran on that (or the account default),
so a plan could not use e.g. a strong reasoning model for one step and a cheap one for the rest.

Principle (owner): every user and admin picks the model; the selected model is the only one ever used. No swaps.

Now, with AW-Settings `work_plan_step_models_enabled` = exactly `true` (absent / any other value / cold-start read
failure = off = old behaviour; 60s cache, last-known value on a failed refresh,
`services/agentMode/workPlanStepModels.ts`, same pattern as `compare_save_alternatives`):

- Storage: an OPTIONAL `model?: string` (canonical registry id) on `WorkPlanStep`, an additive optional key INSIDE the
  existing JSON `steps` array of AW-WorkPlans. No migration, table, index or attribute. Absent = the plan `defaultModel`
  pin, then the account default (today). Owner accepted additive optional keys.
- Whitelists (the ENG-889/ENG-1331 silent-drop class): `WORK_PLAN_STEP_FIELDS` and `STEP_CONTENT_FIELDS`
  (workPlanSteps.ts), the admin merge-supplied builder, `createSessionWithPlan`, `applyPredefinedWorkPlan`, the session
  work-plan step types (chatbotService.ts), and the MCP `manage_predefined_work_plan` step schema. A source-scan test
  fails if a `WorkPlanStep` field is ever missing from `WORK_PLAN_STEP_FIELDS`.
- Write (admin + user routes, create/update): each step model is validated with `checkPlanDefaultModelWrite` semantics: an
  UNCHANGED stored value is tolerated (a since-retired model never blocks an unrelated edit; matched by title, else
  stepCount), a new/changed value must be served and selectable by the plan's launchers, else 422 `model_unavailable`
  with `stepCount`. A replace that omits a stored step model is refused as content loss; a blank `model` in
  `steps_mode="merge"` clears it. Switch off: a submitted `model` is dropped with a `warnings` entry and never validated.
- Launch (`launchWorkPlan` / accept / `applyPredefinedWorkPlan` incl. unattended schedule launches, and
  `createSessionWithPlan`): ALL step models are resolved up front for the launching user with the plan-pin rules
  (`resolvePlanLaunchModel`, no silent swap); any failure is a 422 (+ `stepCount`) before any state is written; the
  unattended launch also pages oncall. Canonical ids are copied onto the session plan only while the switch is on.
- Engine (`generateSessionResponse`, `scheduleAutoWorkPlanContinuation`): at each turn/continuation the first
  not-completed/skipped step's model wins over the request's `llmModel` and the session's, via
  `resolveEffectiveModelForUser(allowSilentSwap:false)`, and the session `llmModel` is updated to it. A step model that
  became unavailable mid-plan PAUSES the plan: a visible assistant message ("Step N uses <model>, which is no longer
  available. Pick another model for this step to continue."), an oncall alert, no LLM call; idempotent per step+model so
  the continuation chain does not repeat it. An unexpected resolver failure fails the turn; it never falls back.
- Hint: `GET /api/agent-mode/model-options` returns `workPlanStepModelsEnabled` (boolean) next to `chatBranchingEnabled`
  / `compareSaveAlternatives`. Partner-portal admin work-plan editor shows a per-step model select behind it.
- Not changed: Emma's `create_work_plan` / `modify_work_plan` tools (a model choice belongs to a user/admin, not the LLM;
  `modify_work_plan` keeps a stored step model), model-compare/branching, concurrency cap, retries, autocomplete rounds,
  and the legacy AW-Settings predefined-plans blob (`routes/settings.ts`), which never carried per-step fields.
- Rollback: set `work_plan_step_models_enabled` to anything but `true` (writes drop the field again, launches stop
  copying it, the engine ignores stored values; nothing to migrate back).
