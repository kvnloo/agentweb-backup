## ENG-669: tier model allowlist, PR-A (dark) (2026-10-19)

**Rule.** The user (or admin) chooses the model and only that model runs. A model outside the owner's subscription
tier is refused visibly (422 `model_unavailable`, `reason: 'not_in_plan'`); it is never swapped for another model.

**Switch.** AW-Settings `model_tier_allowlist_enabled`; only the exact string `true` turns it on. Absent, any other
value, or a cold-start read failure = off, i.e. exactly the old behaviour (no tier is read). Cached ~60s, last-known
value on a failed refresh (same pattern as `work_plan_step_models_enabled`). Code: `services/agentMode/modelAccess.ts`
(pure) and `modelAccessInstance.ts` (wiring, system-model exemption, Compare D3).

**Data.** `SubscriptionType.allowedModels?: string[]` inside the `subscription_types` JSON:
- canonical registry ids (the admin POST resolves legacy aliases, de-duplicates and rejects unknown ids with 400);
- `"*"` = every non-admin catalog model; a list containing `"*"` is stored as `["*"]`;
- `"agentweb-model"` is reserved for the AgentWeb router (PR-C). It is not a registry key, so until PR-C ships it
  matches nothing runnable: a tier listing only it can run only system models (the configured default);
- field absent = every model. Admin GET/POST round-trip it as stored (`"*"` is not expanded). POST rejects (400) an
  unknown id, an id customers can never select (admin-only / internal / live-voice) and an empty list. Partner
  portal: the "Chat models" field in Subscription Types (comma-separated; blank = absent; a stored empty list is sent
  back as-is so the server refuses it instead of the editor silently widening it).
- a tier with no `subscription_types` row (or no tiers at all) is NOT narrowed: every model, cached, logged once per
  tier, no alert.

**Who chose a stored model (additive optional attributes, no migration).** `ChatSession.llmModelSource`
(`'user' | 'system'`) is written by every `updateSessionLlmModel` call (a write without one removes it, like the
policy decision): createSession (requested = user, else system), the /generate, verified-generate and shared
persists (an echo of the stored stamp keeps its source), PATCH (user), branch (inherits), Compare select (user),
schedule runs, plan launches, step stamps, task-type models, Slack/transports/email/GTM/result-endpoint defaults
(system). An echo is recognised on canonical ids (an alias of the stored model is the same model). A system-stamped
model stays AgentWeb's choice after an admin rotates the default (no false 422). Legacy sessions without the field:
system when the stored decision shows `defaulted`/`corrected`, or when there is no decision at all on a side-channel
session (`slackThread`, `gtmWorkItem`, sessionType `emma-email` / `result-endpoint`: those wrote the then-default
without one); otherwise a user pick (a visible 422 at worst). Owner session reads now include `llmModelSource` and
the plan's `planAuthor` / `launchModelSource` (stripped for share viewers). `ScheduledChat.llmModelSource: 'system'` marks a pin inherited from an admin-authored
(`visibility: 'system'`) schedule template; a user-authored template's pin is checked at creation (422). Only an
administrator may change a system template's model (403 for its non-admin creator). A confirmed recommendation
switch records `modelSourceBefore` on its audit row, so an undo restores the 'system' origin with the model. The
session `workPlan` records `planAuthor`, `launchModelSource`, `planDefaultModelSource` and each step pin's
`modelSource` at launch, so a later edit or deletion of the template does not change whose pins they are.

**Who / what is checked.** The canonical id (after alias resolution) against the session OWNER's tier (org members:
the org owner's tier unless they have their own live subscription; `anon_` owners: Free), never the caller. Admin
owners bypass. Requested AND stored models are checked, before the silent-swap branches, so a stored selection outside
the plan is a 422 and is not rewritten (grandfathering). The only exempt "no choice" path is defaulted.

**System models (exempt).** One rule (`isSystemChosen` in `modelAccessInstance.ts`): a model is exempt only when the
provenance recorded WITH it when it was written says AgentWeb chose it, or it is the configured default for the
session's kind (interactive default everywhere; scheduled, report generation, image / video generation, customer
support / emma-sidebar in those sessions), or the owner is an admin. Nothing is inferred at check time from a
session's plan or template. Provenance records: `ChatSession.llmModelSource`; on a session work plan each step pin's
`modelSource` and `planDefaultModelSource`, stamped at launch from the plan's author (admin-authored = 'system'), and
moved together with the model by every modify / reorder / insert (a slot never keeps another step's source); a user's
adoption of a model for a step writes `modelSource: 'user'`. Templates carry no provenance (the author is stamped at
launch), so saving a session plan as a template copies the model only. Re-sending or re-selecting the session's stored
model carries its stamp's source; any other model in a request or a picker PATCH is a user's pick. Legacy records
(written before this change, no source at all): a session stamp follows the decision / side-channel rule above; a
plan with no `planAuthor` treats its OWN pins (plan default and step pins as copied at launch, and the engine's stamp
of one of them) as system while its template is still admin-authored (a deleted template: user; an unreadable one
never blocks). An unpinned schedule's default is system; a schedule created from a system schedule template copies the
template's model as a user pin, so it is checked at run time. A refusal on an approval-inbox resume is saved once and
pushed live once (with its messageIndex and error flag), only for a tier refusal.

**Enforcement points.** `resolveEffectiveModelForUser`; `validateModelPin` / `validateScheduleModelPin` / plan write
and launch helpers (owner/launcher threaded through); session PATCH (with the switch on: checked against the session
OWNER, 422 instead of the caller-based 403) and shared-session PATCH; `llmModelChangeService` and the usage-drivers
recommendation catalog; a final gate in `generateSessionResponse` for side channels that run `session.llmModel`
without the resolver (it checks the STORED model; a model the caller chose itself is AgentWeb's choice); `/api/emma/create-html-from-template` and `/api/emma/describe-media`
(they take a model from the request body; the MCP server's `llmModel` argument reaches no LLM call); Compare
per column (through the resolver) and up front (D3: owner runs fewer than two models => 403
`compare_not_available_for_tier` + `upgradeRequired`, `/me` hint `modelCompareTierBlocked` while the switch is on);
`/model-options` filters `allModels` / `selectableModels` and adds `modelAccess: { tier, allowedModels, upgradeRequired? }`.

A refusal by the final gate during /generate, verified-generate or a shared/conversable turn is the same 422 as the
pre-flight (never a 500).

**422 body.** `{ error, code: 'model_unavailable', requestedModel, reason: 'not_in_plan', model, tier, allowedModels,
upgradeRequired }`; the share-viewer (interactive share / conversable) body omits `model`, `tier`, `allowedModels`,
`upgradeRequired`. Slack threads, other transports and approval-inbox resumes post the same sentence instead of the
generic error.

**Unreadable tier.** Only a failed user / org / settings read. Never blocks: this owner's last-known access, else
allow and one deduped on-call alert (`model_tier_allowlist:tier_unreadable`, 1h); either answer is reused ~10s so a
failing read cannot become a read storm. A pin outside the plan on a scheduled run fails the run visibly but does
not page (it is the plan limit working, not a fault).

**Rollout.** 1) Ship with every tier's `allowedModels` absent or `["*"]` and the switch off. 2) Turn the switch on:
still no change in behaviour (every tier allows everything); watch logs for `ModelAccess:`. 3) Narrow paid tiers if
wanted. 4) Narrow Free (e.g. to `["agentweb-model"]`) only after PR-C's router exists; until then Free could run only
the configured default. Cost while on: one owner/tier read per owner per ~10s, only for a non-default model.

**Rollback.** Set `model_tier_allowlist_enabled` to anything but `true` (takes effect within ~60s, no deploy). Removing
`allowedModels` from a tier (or setting `["*"]`) also restores full choice for that tier.
