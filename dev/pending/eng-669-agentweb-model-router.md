## ENG-669: AgentWeb Model router, PR-C (dark) (2026-10-21)

**Rule.** `agentweb-model` is a selectable model id like any other. A user who picks it chose the router, so routing is
not a swap: AgentWeb picks the concrete model per task, logs which one and why, and runs exactly that model. If the
routed model fails, the turn errors visibly; nothing is retried on another model (no backup, no `fallbackModels`). It is
metered against the same pool as any model (by the concrete model that ran). It is NOT the default for anyone yet
(ENG-669 AC3 decides that later). Code: `services/agentMode/agentWebModelRouter.ts` (pure) and
`agentWebModelRouterInstance.ts` (wiring).

**Switch.** AW-Settings `agentweb_model_router_enabled`; only the exact string `true` turns it on. Absent, any other
value or a cold-start read failure = off: the id is not offered and an explicit selection of it is refused like an
unknown id (422 `model_unavailable`/`not_served` on a turn, worded "AgentWeb Model isn't available right now. Choose
another model to continue."; 400 "Unsupported model" on the picker PATCH; a failed schedule run). Cached ~60s,
last-known value on a failed refresh. The pickers (`/model-options`, `/public/llm-models`) read this cached switch on
every request, with it on or off (one settings read per ~60s per process); a turn reads it only when it names the id.

**Table.** AW-Settings `agentweb_model_routing_table`, JSON:

```json
{
  "version": "2026-10-21.1",
  "default": "gemini-3.8-flash",
  "routes": { "report": "gpt-5.5", "scheduled": "gpt-5.5" },
  "tiers": {
    "Free": { "default": "gemini-3.1-flash-lite" },
    "Pro": { "routes": { "chat": "gpt-5.5" } }
  }
}
```

- Task types (v0, no classifier): the session kind PR-A's system-default exemption already uses: `chat` (default),
  `scheduled` (sessionType `scheduled`, and any schedule run), `report` (`report_generation`), `image`
  (`image-generation`), `video` (`video-generation`), `support` (portalType `emma-sidebar`). `taskTypeForSession`.
- Precedence: the tier's route for the task type, the tier's `default`, the table route, the table `default`. A route
  that cannot be served is refused; it never falls through to the next rule.
- The routing reason names the task type and the KIND of rule only (`chat task: plan route`, `report task: table
  default`), never a tier name: replies carry it. Logs carry the tier.
- Validated on every load (~60s), each problem contained as narrowly as it can be. A refusal is always the visible 422
  `model_unavailable`/`not_served`, never a fallback, with one on-call alert deduped 1h (re-sent each load; the log line
  only when what is broken changes):
  - **Table unusable** (not JSON, not an object, unknown top-level keys, a `routes` with unknown task types, a `tiers`
    that is not an object, no `version` / `default`, a non-string target in the table's own routes), **missing**, or
    (cold-start) **unreadable**: unavailable for EVERYONE (`agentweb_model_router:unavailable`).
  - **One tier override malformed** (not an object, unknown keys or task types, an empty or non-string target):
    unavailable for THAT tier only (`agentweb_model_router:tier:<tier>`); a typo for one plan never breaks the others.
  - **Unusable target** (not a registry model, admin-only, internal-only, live voice, unpriced, cannot call tools): only
    the routes that resolve to it are unavailable (`agentweb_model_router:target:<model>`).
  - **Tier allowlist** (PR-A on): a tier that may select the router (`allowedModels` lists `agentweb-model`) but does
    not allow every model its routes resolve to is unavailable for THAT tier only (`agentweb_model_router:tier:<tier>`,
    naming each task and model). NOTE: PR-A's example of narrowing Free to `["agentweb-model"]` alone therefore makes
    the router unavailable for Free: list the routed models too (e.g. `["agentweb-model", "gemini-3.1-flash-lite"]`).
  - A `tiers` key naming no configured tier never applies; reported (`agentweb_model_router:table_issues`), nothing is
    taken down.
  - A failed read keeps the last good table. A route outside the owner's LIVE allowlist (an allowlist edited inside the
    cache window) is refused too (`agentweb_model_router:route_outside_plan`).
- Accepted (same as PR-A): a tier read that fails while routing with the allowlist ON fails open (the owner's
  last-known access, else no tier: the table's own routes) with the deduped `model_tier_allowlist:tier_unreadable`
  alert. With the allowlist off the same alert is worded for the router ("AgentWeb Model router could not read a
  subscription tier").

**Seeding.** Write the table row first, then the switch (`agentweb_model_router_enabled` = `true`). Check the logs for
`AgentWebModel: routing table loaded` (or `routing table unavailable` / `router unavailable for a tier` / `routes to an
unusable model` with the reasons). Each routed TURN logs `AgentWebModel: routed { owner, tier, taskType, model, reason,
tableVersion }` (checks of a pick being saved do not).

**What is stored (no migration; additive optional attributes).**
- The SELECTION is stored, never the routed model: `session.llmModel` (every write site: create, /generate,
  verified-generate, interactive share, conversable, scheduled runs, branch, step-engine stamps), schedule and Work
  Plan pins (plan default and step `model`). `llmModelSource` follows the selection (`user` for a pick).
- `llmUsagePolicyDecision` of a routed turn: `requestedModel: "agentweb-model"`, `effectiveModel` = the concrete model,
  plus `routedVia`, `routingReason`, `tableVersion`. The /generate and createSession responses echo the same three.
- Assistant messages: `llm` = the concrete model (unchanged) plus `llmSelected: "agentweb-model"`, `llmRoutingReason`,
  `llmRoutingTableVersion`, only when THIS turn's caller routed it (the caller's own decision is passed to the run;
  the session's stored decision is never read back). Share and conversable reads strip all three; admin reads keep them.
- Work Plan steps (ENG-2378): the engine's `engineModel` / `pickedModel` markers and an adopted step model record the
  selection too, so the stored stamp still equals the engine's marker next turn (no false "user pick"). A step pinned to
  the router routes per turn; a router session running concrete step pins runs those pins, then routes again on
  model-less steps and on the end-of-plan restore.

**Who / what is checked.** The SELECTION against the owner's tier (PR-A gate: `agentweb-model` listed, or a wildcard
tier); the routed model is AgentWeb's choice (provenance `system`, not tier-checked as a pick) but constrained by the
table rules above. An admin-authored plan's router pin is not the launcher's pick, but at launch it must route for the
LAUNCHER's tier (a visible 422 now, not at a step). Callers that hand over the stored selection without resolving it
are routed inside `generateSessionResponse` before anything is persisted: transports (sessionResponder) and Slack
thread replies, approval-inbox resumes, the plan-launch first turn, runVerifiedChat callers that pass no model, and every
auto continuation (media and work plan; from /generate, the interactive-share timeout and the getSession backstop).
Emma email, GTM and result-endpoint turns run the configured default, never a selection. A continuation carries the
SELECTION, not the routed model: it is a turn of its own, routed again (the same table routes it to the same model),
so its replies are stamped and the switch / availability are re-checked each time; a refused continuation ends its
chain with the refusal saved to the chat (and pushed live). An approval-inbox resume refused on the router saves the
same visible refusal (as for `not_in_plan`); other models' refusals there keep the passive note only.

**Where it can never run (refused visibly).** Compare columns (400 `agentweb_model_not_comparable` while the switch is
on; off, the column is rejected as an unknown model, as before), and, switch on or off:
schedule BACKUP models (422 `not_selectable`), benchmarks (400 `agentweb_model_not_benchmarkable`), any AW-Settings
value (e.g. `agent_mode_default_model`: 400 `agentweb_model_not_configurable`), `/api/emma/create-html-from-template`
and `/api/emma/describe-media` (422 `not_selectable`, never the default model), the sidebar chatbot's `model` (422).
The partner portal's benchmark and default-model pickers drop it (`utils/agentWebModel.ts`); its plan step-model
picker keeps it (a pin routes). `migrateStaleModelReferences.ts` treats it as valid.

**Customer copy.** Never the raw id: "AgentWeb Model" in 422 bodies, chat refusals, step pause messages and owner
emails; an unavailable router is "unavailable right now", not "no longer available". A schedule or step on an
unavailable router does not page once per schedule / session (the router's own alert covers a broken table; a
switch-off is a deliberate rollback); the run text says "AgentWeb Model is unavailable right now".

**Pickers.** `/model-options` (`allModels`, `selectableModels`) and `/public/llm-models` (signed-in only) list it right
AFTER the first entry while the switch is on, the owner's tier includes it, and the router is currently valid for that
tier (usable table, tier not unavailable, every route the tier can take usable). Deliberately not first: the portal
pre-selects index 0 (`useAgentModeSettings.ts`), which would make the router everyone's default.

**Portal.** Display ("AgentWeb Model · via X" from `llmSelected` + `llm`, the picker entry's name/description) is a
separate small customer-portal PR. Until it ships, keep the switch off: the stock portal would show the raw id.

**Rollback.** Set `agentweb_model_router_enabled` to anything but `true` (within ~60s, no deploy). Every session, pin
and schedule that stores `agentweb-model` keeps it (nothing is rewritten) and every turn on it is refused VISIBLY with
the 422 "AgentWeb Model isn't available right now. Choose another model to continue." on every path: /generate (with
or without a model in the body), verified-generate, interactive share, conversable, branch, transports and Slack
replies; an auto continuation or an approval-inbox resume saves the same refusal to the chat; a scheduled run fails
with "AgentWeb Model is unavailable right now" (no page); a step pinned to it pauses its plan; an unattended plan launch
pinned to it is refused (no page). Nothing is
"corrected" to the default. Turning the switch back on resumes them unchanged; a user can pick another model any time.
