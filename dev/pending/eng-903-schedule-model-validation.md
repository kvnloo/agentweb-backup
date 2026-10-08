## ENG-903: Validate scheduled-chat model pins at write time (2026-10-08)

`createScheduledChat`, `updateScheduledChat` and `createScheduleFromTemplate` (per-use override) stored `llmModel` / `llmBackupModel` with no served/selectable check, so a bad pin only surfaced as a failed run plus an oncall alert. They now call `validateScheduleModelPin` (agentModeController.ts), which trims, resolves aliases via `agentModeService.resolveGenerationModel`, and requires `isModelSelectableBy(canonical, isAdmin)`; failure is HTTP 422 with the shared `buildModelUnavailableBody` (`code: 'model_unavailable'`, reason `not_served` | `not_selectable`). Non-strings are 422. Empty/absent = no pin.

Compat rule: on update, a model/backup is validated only when it is being SET to a different non-empty value. Absent, unchanged, or `''` (clear) are never rejected, so old schedules whose model was later retired can still have other fields edited. An unchanged stored backup that is no longer valid is kept as stored.

Not changed (run-time behaviour untouched): MCP/Emma schedule tools (they call these HTTP handlers, so they are covered transitively); template create/update (user and admin) and a template's own stored `llmModel`; admin routes; work-plan `defaultModel` (already filtered by `getSupportedModels` at apply); internal `scheduleDb.updateSchedule` callers (llmModelChangeService, scripts, linkedIn health).

Portal: `useAgentModeSchedules.ts` save handler discards the server `error` text and shows a generic "Failed to save schedule" toast, so the 422 is not surfaced specifically yet (portal follow-up).
