## ENG-669: before-switch-on follow-ups for the model allowlist and owner notices (2026-10-22)

Settles the "before switch-on" lists of #3607 (tier model allowlist) and #3676 (owner notices) so
`model_tier_allowlist_enabled` and `agentweb_model_router_enabled` can be turned on. Everything here is inert with
the allowlist off, except two additive run-result/notice details noted below.

**Allowlist (#3607).**
- *A session kind's configured default is AgentWeb's unless the user picks it now.* `isSystemChosen` drops the
  scheduled / report / image / video / support default only for a NEW pick of it: source `'user'` for a model the
  session does not already hold (a picker PATCH, or a `/generate` pick, to that default). The session's STORED model
  stays exempt as that default whatever its record says, and so does the pre-plan model at the end-of-plan restore and
  on a model-less step's fallback to it. Why not "recorded `'user'` is checked": the portal echoes the picker value
  every turn, and since 2026-10-19 that echo records `'user'` on every legacy stamp (storedModelSource's legacy rule),
  written by `/generate` BEFORE the final gate. A legacy scheduled / report / image / video / emma-sidebar session on its
  kind's default was therefore refused on the owner's first turn after switch-on. The interactive configured default
  stays exempt everywhere. `storedBindingSource` returns `undefined` for a legacy stamp the legacy rules do not call
  `'system'` (it used to say `'user'`).
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
- *Owner reads.* Every non-admin read of a session drops `planAuthor`, `launchModelSource`, `planDefaultModelSource`
  and each step's `modelSource` (`utils/workPlanProvenance.ts`): `getSession`, the session list and the createSession
  idempotent replay, the `/generate` response, the launch-plan and accept-recommendation responses, the signed-in
  `POST /public/plan/:title/session` response, the legacy `/api/chatbot/sessions*` reads and
  `GET /api/auth/:userId/chat-sessions`. Kept: `llmModelSource` (the portal's `llmModelIsSystemChoice`), step `model`,
  `templatePlanId`. Admin and delegated-admin reads keep everything. Not covered: `/api/emma/work-plans` (an MCP tool
  surface whose result goes to the model); it also lacks a session-ownership check (pre-existing, reported for a separate fix).
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
PUT). `NODE_ENV=production npx ts-node scripts/seed-agentweb-routing-table.ts <table.json>` prints the target table,
then, using the router's own validator (`agentWebRoutingTableReport.describeRoutingTable`), whether the table is usable
and, per tier, each task's model, rule and any refusal, judged as if the allowlist were on. `--apply` writes only a
table valid for every tier, with a compare-and-set on the value read (create-if-absent when there is no row; exit 2 on
a concurrent edit); it never touches the router switch. NODE_ENV must be `production` (AW-Settings) or `development`
(Dev-AW-Settings): the settings service maps anything else, including unset and `staging`, to the production table, so
the script refuses it. AWS credentials and region come from the settings service's client (env keys, else the SDK
chain; `AWS_REGION`, default us-west-2). The logic is `services/agentMode/agentWebRoutingTableSeed.ts` (tested).
