## ENG-3040: Zoma `ads_get_ad_accounts` read tool; `ads_get_field_context` still a gap (2026-11-15)

- Meta describes its tool as "List the ad accounts the user has access to (name, status, currency, timezone)" (ad-creation-and-management tools page, read 2026-11-15). `zoma_status` returns account id, name, currency and the ads_management scope state, but no status and no timezone, so the row could not be mapped to it. New read tool `ads_get_ad_accounts` in `backend/src/mcp/metaToolkitAdAccounts.ts`.
- It lists only the usable Meta ad accounts connected to the caller's Zoma login (own plus org-shared, the same list the account resolver uses), one `act_<id>` read each for `name,account_status,currency,timezone_name`, capped at 25. It does not ask Meta which other accounts the Meta user can reach. No arguments; `tools:read` on aw_ keys; metered once; classified read-only in `toolkitToolAnnotations.ts`.
- The gateway handles it before account resolution, so it works when several accounts are connected (the case where every other tool answers "pass account_id").
- `ads_get_field_context` is unchanged: still `gap`, owner ENG-3040. Meta describes it as field metadata (type, filterability, enum values, entity levels) for `ads_get_ad_entities`. Whether a public Graph endpoint backs it was not established (Meta's Graph reference pages returned HTTP 400 to this box).
- Customer-visible: new tool name and description. Held for Harsha's wording answer before merge.
- Totals from `summarizeParity`: covered 72 / gap 13 / n/a 3 (of 88). Main was 71 / 14 / 3.
