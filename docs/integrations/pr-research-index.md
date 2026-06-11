# Integration PR Research Index

Last researched: 2026-06-11

This file records which merged PRs were used to derive the integration
contracts. Future agents should use it as a starting point before changing
external API code.

The goal is not to summarize every historical PR. The goal is to preserve the
bug patterns that should become contract rules.

## Research Method

Useful commands:

```bash
gh pr list --state merged --limit 300 --json number,title,mergedAt,url,headRefName
git log --oneline --all --grep='meta\|facebook\|ads\|hubspot\|stripe\|linkedin' --regexp-ignore-case
gh pr view <number> --json number,title,mergedAt,url,headRefName,files
```

When researching a vendor:

1. Start with PR titles and branches.
2. Inspect changed files to see which service/routes/tests encoded the fix.
3. Translate the fix into a contract rule.
4. Add the rule to the vendor contract and keep the PR link here.

## Meta Ads / Facebook Marketing API

Meta is the most researched contract so far. The pattern is clear: many bugs
were not "random Meta weirdness"; they were boundary mistakes between AgentWeb's
internal model and Meta's exact API model.

| PR | Merged | Changed areas | What it proves | Contract rule |
| --- | --- | --- | --- | --- |
| [#959](https://github.com/AgentWebPro/agentweb/pull/959) fix: Meta campaigns not discovered via Emma | 2026-03-31 | `emma.metaAdsCampaignTools.test.ts`, `backend/src/emma/tools.ts` | Emma campaign listing must use the modern connected-account path. | Use `listMetaAdsCampaignsNew`; do not rely only on legacy `user.adAccount`. |
| [#999](https://github.com/AgentWebPro/agentweb/pull/999) feat: use connected Meta ad account for Paid Social when legacy account not set | 2026-04-03 | `backend/src/routes/meta.ts`, route tests | Paid Social had to fall back from legacy setup to connected accounts. | Account resolution must understand both connected accounts and legacy ad account fields. |
| [#1053](https://github.com/AgentWebPro/agentweb/pull/1053) feat: Meta Ads destination URL support via AD_CREATIVE LIST | 2026-04-07 | `backend/src/emma/tools.ts`, `metaService.ts` | Agents need creative details to recover destination URLs. | AD/creative list output must expose enough nested creative data for follow-up tool calls. |
| [#1147](https://github.com/AgentWebPro/agentweb/pull/1147) fix: Meta ad accounts not showing after successful connection | 2026-04-14 | `metaService.ts`, service tests | OAuth account discovery can fail if response shape handling is wrong. | Preserve `getAdAccounts` response mapping and test it. |
| [#1207](https://github.com/AgentWebPro/agentweb/pull/1207) fix: Meta ad account connection fails across load-balanced instances | 2026-04-17 | `metaAuth.ts`, `db.ts`, create-tables, auth tests | In-memory OAuth handoff fails behind multiple backend instances. | OAuth token sessions must be durable, not process-local memory. |
| [#1305](https://github.com/AgentWebPro/agentweb/pull/1305) fix(agent-mode): fall back to adAccount when Meta connected account is absent | 2026-04-24 | `agentModeService.ts`, credentials fallback tests | Legacy agency-managed accounts still matter. | Do not remove `user.adAccount` fallback without a migration. |
| [#1306](https://github.com/AgentWebPro/agentweb/pull/1306) fix: complete Meta ad account selection step in agent mode connect flow | 2026-04-24 | release docs | The connect flow can appear done before account selection is actually complete. | OAuth success and usable connected account are different states. |
| [#1309](https://github.com/AgentWebPro/agentweb/pull/1309) fix(agent-mode): guide Emma to fall back to list_meta_ads_campaigns when Meta connected account is unavailable | 2026-04-24 | system prompt, Emma tools | Tool guidance affected whether Emma could recover from missing account context. | Agent-facing descriptions are part of integration reliability. |
| [#1326](https://github.com/AgentWebPro/agentweb/pull/1326) fix(meta-ads): Emma no longer hallucinates data when Meta account not connected | 2026-04-25 | `agentModeService.ts`, campaign/page/fallback tests | Missing accounts previously led to fake/confident outputs. | Return explicit auth/setup errors; never fabricate metrics or campaign data. |
| [#1433](https://github.com/AgentWebPro/agentweb/pull/1433) fix(meta): include all ads in LIST (CAMPAIGN_PAUSED/ADSET_PAUSED) | 2026-05-04 | `metaService.ts`, Emma tool docs, tests | Filtering only active ads misses spend-control entities. | AD LIST must include non-deleted effective statuses, including parent-paused states. |
| [#1537](https://github.com/AgentWebPro/agentweb/pull/1537) chore(meta): upgrade Meta Marketing API default version to v25.0 | 2026-05-15 | config, auth, Meta service, metrics tests | API version is centralized but comments/docs can drift. | Contract must record current runtime version and call out version-sensitive matrices. |
| [#1608](https://github.com/AgentWebPro/agentweb/pull/1608) fix: Meta Ads budget update passes dollars instead of cents to Meta API | 2026-05-21 | `agentModeService.ts`, Meta CRUD tests | User/tool budgets are dollars; Meta SDK fields are cents. | AgentMode converts money to cents before `MetaService` calls. |
| [#1724](https://github.com/AgentWebPro/agentweb/pull/1724) fix(agent-mode): return Meta Ads insights inline instead of unreadable S3 URL | 2026-05-31 | `agentModeService.ts`, insights tests, Emma tool docs | A custom S3 upload path made tool output unreadable. | Insights wrapper returns inline and lets the general tool-response offload handle size. |
| [#1744](https://github.com/AgentWebPro/agentweb/pull/1744) fix(meta): unwrap adimages response so distinct creatives get unique hashes | 2026-06-03 | `metaService.ts`, advanced Meta tests | Meta image upload returns filename-keyed maps. | Service unwraps to flat `{ hash }`; callers should not parse filename maps. |
| [#1754](https://github.com/AgentWebPro/agentweb/pull/1754) fix(meta): auto-resize oversized ad images and surface real upload errors | 2026-06-03 | `metaService.ts`, image resize tests | Oversized assets fail with poor Meta errors. | Resize/re-encode before upload; preserve structured error surfacing. |
| [#1756](https://github.com/AgentWebPro/agentweb/pull/1756) fix(meta): creative swap on AD UPDATE actually changes the ad | 2026-06-03 | `agentModeService.ts`, Emma tool docs, CRUD tests | Top-level `creative_id` can be ignored by Meta. | Ad creative swaps must be nested as `creative: { creative_id }`. |
| [#1766](https://github.com/AgentWebPro/agentweb/pull/1766) feat(meta): per-placement image asset customization (asset_feed_spec) | 2026-06-05 | `metaService.ts`, `agentModeService.ts`, validators, Emma tool docs | Placement customization has an exact nested shape. | Use `asset_feed_spec`, image hashes, one fallback rule with `customization_spec: {}`. |
| [#1784](https://github.com/AgentWebPro/agentweb/pull/1784) Fix Meta IG actor lookup fallback | 2026-06-07 | `metaService.ts`, service tests | Instagram placements can fail unless an IG actor is resolved from the page. | Placement assets targeting IG require `instagram_user_id` or auto-resolution. |

## Other Integrations: PR Patterns To Turn Into Full Contracts

These PRs were not researched as deeply as Meta, but they show the same pattern:
external integrations need explicit contracts because fixes often encode vendor
rules that future agents could accidentally erase.

| Integration | PR | Merged | What it proves | Contract work still needed |
| --- | --- | --- | --- | --- |
| Google Ads | [#1735](https://github.com/AgentWebPro/agentweb/pull/1735) feat: Google Ads integration | 2026-06-04 | Google Ads touched auth, secrets, account listing, tool schemas, services, and admin config together. | Full Google Ads contract should document OAuth, customer IDs, manager/client hierarchy, money micros, and tool action matrix. |
| LinkedIn Ads | [#1813](https://github.com/AgentWebPro/agentweb/pull/1813) fix(linkedin-ads): make ESTIMATE_REACH accept campaign targeting shapes | 2026-06-10 | Reach estimation depends on exact targeting shape and encoding. | Full LinkedIn Ads contract should document REST headers, URN encoding, targeting resolution, and reach estimate inputs. |
| HubSpot | [#1773](https://github.com/AgentWebPro/agentweb/pull/1773) fix(crm): skip leads with invalid email during HubSpot sync | 2026-06-05 | HubSpot cannot accept every CRM lead shape. | HubSpot contract should document email validation, update-by-ID fallback, and property mapping. |
| HubSpot | [#1776](https://github.com/AgentWebPro/agentweb/pull/1776) fix(crm): sync email-less leads to HubSpot | 2026-06-06 | Some email-less leads still need syncing through alternate identity/update paths. | Contract must distinguish "invalid email" from "missing email but syncable." |
| HubSpot / Attio | [#1791](https://github.com/AgentWebPro/agentweb/pull/1791) fix(crm-sync): run HubSpot/Attio push as background job | 2026-06-08 | Synchronous push behavior produced false failure UX. | CRM sync contract should document job/enqueue semantics and user-facing status. |
| Stripe | [#1810](https://github.com/AgentWebPro/agentweb/pull/1810) fix(stripe): make admin per-user Sync Stripe authoritative | 2026-06-10 | Local subscription state can become stale and needs Stripe-ground-truth reconciliation. | Stripe contract should document authoritative fields, webhook ordering, and reconciliation rules. |
| Gmail/Calendar | [#1075](https://github.com/AgentWebPro/agentweb/pull/1075) fix: classify Google Calendar 403s + persist gmail granted_scopes | 2026-04-09 | Requested scopes are not enough; granted scopes must be persisted and checked. | Gmail contract should document `granted_scopes`, calendar 403 classification, and reconnect guidance. |
| Gmail | [#1373](https://github.com/AgentWebPro/agentweb/pull/1373) fix: Gmail connected account no longer shows inactive after reconnect | 2026-04-28 | Token validity/status logic can drift from user-visible account state. | Gmail contract should define token expiry/refresh/status semantics. |
| Fathom | [#1469](https://github.com/AgentWebPro/agentweb/pull/1469) fix(fathom): add 401 error handling with reconnect guidance | 2026-05-08 | Auth errors need user-actionable reconnect guidance. | Fathom contract should document OAuth/API-key states and 401 handling. |
| Fathom | [#1581](https://github.com/AgentWebPro/agentweb/pull/1581) fix: sync Fathom connection status between summary card and account list | 2026-05-19 | Multiple UI surfaces can disagree about integration state. | Fathom contract should define one status source of truth. |
| LinkedIn Outreach | [#1752](https://github.com/AgentWebPro/agentweb/pull/1752) fix(crm): LinkedIn acceptance notifications restore/gating/backfill suppression | 2026-06-03 | Backfills and side effects can notify customers incorrectly. | LinkedIn Outreach contract should document sender gates, backfill suppression, and notification side effects. |

## Meta Research Conclusion

The Meta contract should be treated as a living bug-prevention artifact. The
main issue is not that Meta is impossible; it is that small exact-shape details
matter:

- account source and token source,
- ID prefix normalization,
- nested creative payloads,
- dollars versus cents,
- image upload response unwrapping,
- async insights output handling,
- placement-specific creative rules,
- and explicit no-hallucination behavior when account context is missing.

Future Meta PRs should update [meta-ads-contract.md](./meta-ads-contract.md)
and this index in the same PR.

