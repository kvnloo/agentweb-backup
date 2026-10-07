## ENG-903: An explicit model selection runs on that model or not at all (2026-10-07)

Rule: a model the user (or a schedule pin, or the session's stored selection) explicitly chose is either the model that runs, or nothing runs and the caller is told. It is never replaced by the default, never "corrected", and never overwritten in storage. No selection at all still uses the configured default; usage-paused is still the 429; registry legacy aliases (`LEGACY_MODEL_ALIASES`) still map forward; a user-configured backup model is unchanged.

**How:** `resolveEffectiveModelForUser` throws `ModelUnavailableError` (`services/agentMode/modelUnavailable.ts`) when an explicit model is not served (`resolveGenerationModel(...).fellBack`, which used to mask the policy's `corrected`) or is not selectable. `allowSilentSwap` is true only when there is NO explicit selection (unpinned schedule, no-selection session creation, unselected shared session).

**Behaviour per entry point**
- `/generate`, session creation, `verifiedGenerate`: HTTP 422 `{ error, code:'model_unavailable', requestedModel, reason }`. Validated before any session write (a deck/work-plan answer is not consumed), no LLM call, no metering, stored `llmModel` untouched, lock and idempotency claim released. A paused account still gets the plain 429.
- Shared / conversable chats (anonymous visitors): 422 with a body that names no model and carries no `reason`.
- Scheduled runs: the run ends `failure` **before** any session, resume claim or lease work, with `actualResponse: 'model_unavailable: pinned model "<id>" is not served — ...'`, no requeue, no session; the existing oncall alert is kept (same dedupe key) and now says the run FAILED and nothing ran. Unpinned schedules keep the old alert-only behaviour.
- Slack / session responder: one channel-safe sentence (no model id) instead of "Sorry".
- `generateSessionResponse` has a strict pre-flight for callers that bypass the controller choke point (explicit stored model, not the code default).

**Deploy prerequisite — run before shipping:** every stored pin that is not a served model or alias starts failing the day this deploys. `scripts/migrateStaleModelReferences.ts` (dry-run is the default) inventories and remaps them (schedules, templates, sessions, work plans, settings). Known example: ENG-903's schedules pinning `claude-sonnet-4-5`.

**Not changed / decided:** no new persisted field, table or key; no owner email for a failed scheduled run (new customer copy needs review); no auto-pause (a failed run still consumes `runCount` like any other failed run); emma-email, work-plan `defaultModel` launch fallback, htmlCreation and the scoring judge are admin/internal configuration and untouched. **Rollback:** revert the PR (no data to repair).
