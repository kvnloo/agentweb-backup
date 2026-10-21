## ENG-669: AgentWeb Model router, PR-C (dark) (2026-10-21)

**Rule.** `agentweb-model` is a selectable model id like any other. A user who picks it chose the router, so routing is
not a swap: AgentWeb picks the concrete model per task, logs which one and why, and runs exactly that model. If the
routed model fails, the turn errors visibly; nothing is retried on another model (no backup, no `fallbackModels`). It is
metered against the same pool as any model (by the concrete model that ran). It is NOT the default for anyone yet
(ENG-669 AC3 decides that later). Code: `services/agentMode/agentWebModelRouter.ts` (pure) and
`agentWebModelRouterInstance.ts` (wiring).

**Switch.** AW-Settings `agentweb_model_router_enabled`; only the exact string `true` turns it on. Absent, any other
value or a cold-start read failure = off: the id is not offered and a selection of it is refused exactly like an unknown
id (422 `model_unavailable`/`not_served` on a turn, 400 "Unsupported model" on the picker PATCH, a failed schedule run;
a Compare column is rejected as unavailable). Only the switch is read, and only when a request names the id. Cached
~60s, last-known value on a failed refresh.

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
- Precedence: the tier's route for the task type, the tier's `default`, the table route, the table `default`.
- Validated on every load (~60s): `version` and `default` required; unknown keys / task types refused; every target a
  registry model (legacy aliases resolved, stored canonically), publicly selectable (not admin-only, internal-only or
  live voice), priced (`llmPricing.ts`), tool-capable. With the PR-A tier allowlist on: every route a tier that may
  select the router (`allowedModels` lists `agentweb-model`) can take must be in that tier's `allowedModels`, and every
  `tiers` key must name a configured tier. NOTE: PR-A's example of narrowing Free to `["agentweb-model"]` alone is
  therefore an INVALID table for Free: list the routed models too (e.g. `["agentweb-model", "gemini-3.1-flash-lite"]`).
- Invalid, missing or unreadable table = router UNAVAILABLE: every selection gets the visible 422 `not_served` (the
  picker stops offering it), one on-call alert deduped 1h (`agentweb_model_router:unavailable`). Never a fallback.
  A failed read keeps the last good table. A route outside the owner's LIVE allowlist (an allowlist edited inside the
  cache window) is refused the same way (`agentweb_model_router:route_outside_plan`).

**Seeding.** Write the table row first, then the switch (`agentweb_model_router_enabled` = `true`). Check the logs for
`AgentWebModel: routing table loaded` (or `routing table unavailable` with the reasons). Each routed turn logs
`AgentWebModel: routed { owner, tier, taskType, model, reason, tableVersion }`.

**What is stored (no migration; additive optional attributes).**
- The SELECTION is stored, never the routed model: `session.llmModel` (every write site: create, /generate,
  verified-generate, interactive share, conversable, scheduled runs, branch, step-engine stamps), schedule and Work
  Plan pins (plan default and step `model`). `llmModelSource` follows the selection (`user` for a pick).
- `llmUsagePolicyDecision` of a routed turn: `requestedModel: "agentweb-model"`, `effectiveModel` = the concrete model,
  plus `routedVia`, `routingReason` (e.g. `chat task: tier "Pro" route`), `tableVersion`. The /generate and
  createSession responses echo the same three fields.
- Assistant messages: `llm` = the concrete model (unchanged) plus `llmSelected: "agentweb-model"`, `llmRoutingReason`,
  `llmRoutingTableVersion` (carried to the worker as `modelRouting`).
- Work Plan steps (ENG-2378): the engine's `engineModel` / `pickedModel` markers and an adopted step model record the
  selection too, so the stored stamp still equals the engine's marker next turn (no false "user pick"). A step pinned to
  the router routes per turn; a router session running concrete step pins runs those pins, then routes again on
  model-less steps and on the end-of-plan restore.

**Who / what is checked.** The SELECTION against the owner's tier (PR-A gate: `agentweb-model` listed, or a wildcard
tier); the routed model is AgentWeb's choice (provenance `system`, not tier-checked as a pick) but constrained by the
table rules above. Side channels that run `session.llmModel` without the resolver (Slack/transports, Emma email,
approval resumes, GTM, continuations) are routed inside `generateSessionResponse` before anything is persisted.

**Exclusions (v0).** Compare refuses `agentweb-model` as a column (400 `agentweb_model_not_comparable`) while the switch
is on. Schedule BACKUP models stay concrete (the router is never offered as a backup).

**Pickers.** `/model-options` (`allModels`, `selectableModels`) and `/public/llm-models` (signed-in only) list it right
AFTER the first entry while the switch is on, the table is valid and the owner's tier includes it. Deliberately not
first: the portal pre-selects index 0 (`useAgentModeSettings.ts`), which would make the router everyone's default.

**Portal.** Display ("AgentWeb Model · via X" from `llmSelected` + `llm`, the picker entry's name/description) is a
separate small customer-portal PR. Until it ships, keep the switch off: the stock portal would show the raw id.

**Rollback.** Set `agentweb_model_router_enabled` to anything but `true` (within ~60s, no deploy). Sessions and pins
that already store `agentweb-model` then behave like any retired model: an explicit turn or schedule run gets the
visible 422 / failed run, a step pin pauses its plan, a side channel is refused; a turn without an explicit model
(stored only) is corrected to the configured default with the usual `corrected` decision.
