# External Integrations Map

Last derived from code: 2026-06-11

This file is the quick map. Full contracts should be added or expanded when an
integration changes.

## Summary Table

| Integration | Main stored shape | Main implementation | Agent/tool surface | Main risk |
| --- | --- | --- | --- | --- |
| Meta Ads / Facebook Marketing API | `connected_accounts[].platform=meta`, `config.account_type=ad_account`; legacy `user.adAccount` still exists | `backend/src/services/metaService.ts`, `backend/src/routes/metaAuth.ts`, `backend/src/routes/metaV2.ts` | `backend/src/emma/tools.ts`, `AgentModeService.callMetaMarketingApi`, `callMetaAdsInsightsApiWrapper` | Payload hallucination, account fallback breakage, creative update semantics, dollars vs cents. |
| Instagram Business | `connected_accounts[].platform=instagram`, `config.account_type=instagram_business` | `backend/src/routes/metaAuth.ts`, `backend/src/services/instagramService.ts`, adapters under `backend/src/services/adapters/` | Social posting/metrics tools | Facebook Graph and Instagram Graph use different endpoints and token flows. |
| LinkedIn organic / outreach | `connected_accounts[].platform=linkedin` or `unipile` | `backend/src/routes/linkedinAuth.ts`, `backend/src/services/adapters/linkedInAdapter.ts`, `backend/src/services/linkedInOutreachService.ts` | Social post, comment, reaction, drip/outreach flows | Multiple account types and Unipile-managed auth; sender selection can cause customer-facing side effects. |
| LinkedIn Ads | `connected_accounts[].platform=linkedin_ads`, `config.account_type=ad_account` | `backend/src/services/linkedInAdsService.ts`, `backend/src/routes/linkedinAuth.ts`, `backend/src/config/integrations.ts` | `AgentModeService.callLinkedInMarketingApi`, insights wrapper | LinkedIn REST headers, URN encoding, targeting/reach estimation shape. |
| Google Ads | `connected_accounts[].platform=google_ads`, `config.account_type=google_ads` | `backend/src/services/googleAdsService.ts`, `backend/src/routes/googleAdsAuth.ts`, `backend/src/config/integrations.ts` | `AgentModeService.handleCallGoogleAdsApi`, reporting wrapper | Secrets Manager credentials, OAuth refresh, customer/account hierarchy, Micros currency units. |
| HubSpot | `connected_accounts[].platform=hubspot`, `config.account_type=oauth` | `backend/src/services/hubspotService.ts`, `backend/src/services/adapters/hubspotAdapter.ts`, `backend/src/routes/hubspotAuth.ts` | CRM sync/push/pull flows | Contact/deal property mapping, invalid/email-less leads, webhook subscriptions. |
| Stripe billing | `user.stripe_customer_id`, Stripe customer/subscription objects | `backend/src/services/stripeService.ts`, `backend/src/controllers/stripeController.ts`, `backend/src/routes/stripe.ts` | Billing/admin flows | Subscription state reconciliation, customer ID consistency, webhook ordering. |
| Stripe Connect | Connected account service + Stripe Connect account IDs | `backend/src/services/stripeConnectService.ts`, `backend/src/routes/stripeConnect.ts` | Partner/payment flows | Crypto/storage of connected account data and account lifecycle states. |
| Gmail/Calendar | `connected_accounts[].platform=gmail`, `config.account_type=gmail` | `backend/src/services/gmailService.ts`, `backend/src/config/integrations.ts` | Email/calendar tools | Granted scopes may differ from requested scopes; calendar access requires persisted granted scope. |
| Fathom | `connected_accounts[].platform=fathom`, OAuth/API key config | `backend/src/config/integrations.ts`, Fathom integration tests | Meeting/video workflows | OAuth/API key dual shape and webhook/account availability. |

## High-Risk Patterns Across Integrations

- Do not assume a connected account exists just because a legacy user field
  exists, or vice versa.
- Do not assume every platform uses the same unit for money. Meta ad-set
  service methods receive cents after AgentMode converts dollars. Google Ads
  commonly uses micros. Stripe uses cents.
- Do not remove fallback paths without checking PR history and tests. Several
  customers depend on old account fields or agency-managed account setup.
- Do not trust an LLM to invent enums. Pull enums from code constants, schemas,
  tests, or vendor docs.
- Do not flatten nested external payloads. Ad creative swaps, promoted objects,
  and OAuth token records often require exact nesting.
- Do not treat side-effecting integrations as harmless. LinkedIn outreach,
  HubSpot sync, Meta ad publishing, and Stripe billing can affect customers.

## Full Contract Priority

1. Meta Ads: done in [meta-ads-contract.md](./meta-ads-contract.md).
2. LinkedIn Ads: next highest risk because recent fixes involved targeting
   reach estimation and URL/URN encoding.
3. HubSpot: high risk because lead sync has many data-shape exceptions.
4. Google Ads: high risk because ad/account/budget units differ from Meta.
5. Stripe billing: high risk because bugs directly affect payment state.

