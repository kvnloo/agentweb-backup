## ENG-55: Compare asks OpenRouter for no-data-collection providers (2026-10-09)

Compare sends the prompt plus up to ~24k chars of history to several vendors via OpenRouter, and the code set no
data policy. Now, behind AW-Settings `model_compare_deny_data_collection` (exact string `true` only: no trim, no case folding;
absent or anything else = OFF = byte-identical request), Compare calls add `provider.data_collection = "deny"`
next to the shared `order` / `allow_fallbacks` / `require_parameters` (and `ignore` for Gemini).

- Where: `services/agentMode/compareProviderPolicy.ts` (pure; 60s cache, last-known on read error, cold-start error = off).
  `CompareDeps.getProviderPolicy` -> `CompareCallOptions.providerPolicy` -> `callLLM` `options.providerPolicy`.
  Only the Compare path passes it; normal chat, loops, coding agent never do. No new persisted field/table/index.
- Verified against the OpenRouter docs (https://openrouter.ai/docs/features/provider-routing): request-level `provider.data_collection`
  is `"allow" | "deny"`, default `"allow"`; when nothing satisfies the provider constraints the request fails with a 404.
  NOT verified from the repo (it has no reference for `data_collection`) or live (no credentials): the exact 404 wording for the
  data-policy case, and that every Compare model has a deny-compliant endpoint. Owner should run one live Compare after enabling.
- Failure mapping (conservative): `errorCode: "provider_policy_unavailable"` (status `error`; other columns still answer) ONLY when
  the policy is ON, the model is a registry id, and the failure is the generic `isProviderNoEndpointsError` 404 whose text does NOT
  mention "parameter" (Compare always sends `require_parameters: true`, whose own 404 "No endpoints found that can handle the
  requested parameters" must stay `upstream_error`) and is not the model-specific "No endpoints found for <slug>" (unknown/retired
  model). Everything else, and everything with the policy OFF, stays `upstream_error`. No data-policy keyword is used as evidence: we
  could not cite an OpenRouter docs sentence for the data-policy 404 wording, so the code does not guess it.
- Portal contract: new `errorCode` `provider_policy_unavailable`. The code is a best guess, not a certainty, so copy should not
  assert a cause. Suggested: "No provider for this model was available with the current privacy setting. Try again later or pick
  another model." Current portal `describeResultError` (CompareResultCard.tsx) has no entry, so it shows the generic
  "This model could not answer this time." until a copy entry is added.
- Rollout: deploy with switch absent (no change); owner sets the AW-Settings row to `true` after a live check. Rollback: set it to
  `false` (or delete the row); effective within ~60s per instance.
