## ENG-669: before-switch-on follow-ups for the model allowlist and owner notices (2026-10-22)

Settles the "before switch-on" lists of #3607 (tier model allowlist) and #3676 (owner notices) so
`model_tier_allowlist_enabled` and `agentweb_model_router_enabled` can be turned on. Everything here is inert with
the allowlist off, except two additive run-result/notice details noted below.

**Allowlist (#3607).**
- *A session kind's configured default is AgentWeb's only when AgentWeb set it.* `isSystemChosen` consults the
  scheduled / report / image / video / support default only when the binding is not the user's pick: `'system'`
  (AgentWeb's recorded stamp) or `undefined` (a legacy stamp with no record). A picker PATCH (or `/generate` pick) to
  that default, or a stamp recorded `'user'`, is checked like any pick. The interactive configured default stays exempt
  everywhere (a turn with no model runs it anyway). To tell "none recorded" from "the user's", `storedBindingSource`
  now returns `undefined` for a legacy stamp the legacy rules do not call `'system'` (it used to say `'user'`); both are
  checked identically except for the kind default.
- *Branches inherit provenance.* A branch that inherits the source's stored model takes `storedBindingSource` of the
  source (including the legacy plan-pin rule: the branch has no plan to re-infer it from). Before, a legacy admin-plan
  pin became `'user'` on the branch and was refused on its next turn.
- *End-of-plan restore.* The restore of the pre-plan model is AgentWeb's action (`'system'`) unless the launch recorded
  it as the user's own pick (`launchModelSource: 'user'`); a legacy plan (no `launchModelSource`) restores as system.
  A refused restore now leaves a visible chat note (`kind: 'work-plan-model-restore-failed'`, saved and pushed live)
  naming the model that could not come back and the one the chat stays on; before it was a log line only.
- *Retired step pin.* When a step's own model is unavailable and the STANDING pick (the stored stamp, not a model picked
  in this request) is refused `not_in_plan`, the user gets the step model's pause ("no longer available"), not "not in
  your plan". A pick made in the request is still refused as theirs; any other refusal is unchanged.
- *Owner reads.* `getSession` (non-admin), the `/generate` response and the launch-plan responses drop `planAuthor`,
  `launchModelSource`, `planDefaultModelSource` and each step's `modelSource`. Kept: `llmModelSource` (the portal's
  `llmModelIsSystemChoice`), step `model`, `templatePlanId`. Admin reads keep everything.
- *Admin tier editor.* Partner portal refuses a non-blank "Allowed model IDs" that names no model (only commas / line
  breaks / spaces) instead of saving it as "every model". The server already 400s a list that normalises to `[]`
  (`canonicalizeTierAllowedModels`, `admin.subscriptionTypes.test.ts`).
- *Stale portal pin (item 3)*: fixed in the customer portal (#1267, `useAgentModeSettings` follows a step stamp outside
  the plan list). Backend unchanged; a send racing the session refetch can still 422 once.

**Owner notices (#3676).**
- Run results written by a gate BEFORE the model check (deleted owner, entitlements, withheld report, disallowed
  function, usage limit) carry `endedBeforeModelCheck: true`; `isNewScheduleModelBlock` passes over them like the
  pre-model skips, so blocked, limit, blocked is one email. Written with the switch on or off (additive attribute).
- A Test run's model-blocked result carries `testRun: true` and does not count as the block the owner was told about,
  so the next cron run still emails.
- The schedule email is sent only after the blocked run result is saved: a save that keeps failing sends nothing (the
  first run whose block is on record emails once).
- `upgradeRequired` (the refusal's tiers that include the model) is passed to both notices; when it is empty there is
  no upgrade sentence and no "Compare plans" (also dropped from the run result's text).
- Continuation chains (media and work-plan) carry the attendance of the turn that started them (`isUnattendedRun`,
  required argument) through every round, into their pause decision and their turns. Every current starter is
  attended (`/generate`, the interactive share, the getSession backstop), so a chain on a reopened scheduled chat no
  longer emails; a future headless starter passes `true`.
- The step email names a scheduled run's chat without its `Scheduled: ` / `Test: ` title prefix.

**Router seeding.** There was no validated admin path for `agentweb_model_routing_table` (only the generic settings
PUT). `backend/scripts/seed-agentweb-routing-table.ts <table.json>` prints, using the router's own validator
(`agentWebRoutingTableReport.describeRoutingTable`), whether the table is usable and, per tier, each task's model,
rule and any refusal, judged as if the allowlist were on. `--apply` writes only a table valid for every tier, with a
compare-and-set (exit 2 on a concurrent edit); it never touches the router switch.
