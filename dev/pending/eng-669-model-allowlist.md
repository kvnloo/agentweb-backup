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
- field absent = every model. Admin GET/POST round-trip it as stored (`"*"` is not expanded). Partner portal: the
  "Chat models" field in Subscription Types (comma-separated; blank = absent).

**Who / what is checked.** The canonical id (after alias resolution) against the session OWNER's tier (org members:
the org owner's tier unless they have their own live subscription; `anon_` owners: Free), never the caller. Admin
owners bypass. Requested AND stored models are checked, before the silent-swap branches, so a stored selection outside
the plan is a 422 and is not rewritten (grandfathering). The only exempt "no choice" path is defaulted.

**System models (exempt).** The configured interactive default (everywhere); the session kind's configured default
(scheduled, report generation, image / video generation, customer support / emma-sidebar); an unpinned schedule's
scheduled default; the usage-paused body; the pins (plan default + step models) of an admin-authored Work Plan
(`isBuiltIn` or `visibility: 'system'`) in a session launched from it. User-authored plan/schedule/step pins are checked
at write (unchanged stored values stay editable) and at launch/run. Note: a schedule created from a system schedule
template copies the template's model as a user pin, so it is checked at run time.

**Enforcement points.** `resolveEffectiveModelForUser`; `validateModelPin` / `validateScheduleModelPin` / plan write
and launch helpers (owner/launcher threaded through); session PATCH (with the switch on: checked against the session
OWNER, 422 instead of the caller-based 403) and shared-session PATCH; `llmModelChangeService` and the usage-drivers
recommendation catalog; a final gate in `generateSessionResponse` for side channels that run `session.llmModel`
without the resolver (it checks the STORED model; a model the caller chose itself is AgentWeb's choice); Compare
per column (through the resolver) and up front (D3: owner runs fewer than two models => 403
`compare_not_available_for_tier` + `upgradeRequired`, `/me` hint `modelCompareTierBlocked` while the switch is on);
`/model-options` filters `allModels` / `selectableModels` and adds `modelAccess: { tier, allowedModels, upgradeRequired? }`.

**422 body.** `{ error, code: 'model_unavailable', requestedModel, reason: 'not_in_plan', model, tier, allowedModels,
upgradeRequired }`; the share-viewer (interactive share / conversable) body omits `model`, `tier`, `allowedModels`,
`upgradeRequired`. Slack threads, other transports and approval-inbox resumes post the same sentence instead of the
generic error.

**Unreadable tier.** Never blocks: this owner's last-known access, else allow and one deduped on-call alert
(`model_tier_allowlist:tier_unreadable`, 1h). A pin outside the plan on a scheduled run fails the run visibly but does
not page (it is the plan limit working, not a fault).

**Rollout.** 1) Ship with every tier's `allowedModels` absent or `["*"]` and the switch off. 2) Turn the switch on:
still no change in behaviour (every tier allows everything); watch logs for `ModelAccess:`. 3) Narrow paid tiers if
wanted. 4) Narrow Free (e.g. to `["agentweb-model"]`) only after PR-C's router exists; until then Free could run only
the configured default. Cost while on: one owner/tier read per owner per ~10s, only for a non-default model.

**Rollback.** Set `model_tier_allowlist_enabled` to anything but `true` (takes effect within ~60s, no deploy). Removing
`allowedModels` from a tier (or setting `["*"]`) also restores full choice for that tier.
