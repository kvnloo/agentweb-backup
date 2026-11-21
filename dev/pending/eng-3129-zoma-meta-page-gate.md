## ENG-3129: Zoma refuses Meta creates without Page access (2026-11-16)

- Zoma's Meta write toolkit now refuses CAMPAIGN / AD_SET / AD CREATE (`metaToolkitWrites.ts`) and
  AD_CREATIVE CREATE / BULK_CREATE (`metaToolkitCreatives.ts`) when the stored Page probe says
  `getMetaPagesAccessState(config) === 'missing'`. The check runs right after the ads_management
  check and before any preview, money normalization, upload or dispatch, so Meta is never called.
  Preview and confirm calls are both refused.
- The refusal (`mcp/metaPageAccessRefusal.ts`) is `getMetaAdsNoPagesMessage` (names the Page when
  the account's existing ads use one), "nothing was sent to Meta", then numbered steps: grant this
  Facebook user "Create ads" (Advertiser) access on Page X in Business Settings, reconnect with the
  one-click link (`buildMetaConnectUrl(userId, 'marketing')`, the link `zoma_status` uses), choose
  Edit access and select Page X. AD_CREATIVE uses the request's `page_id` as Page X. If the link
  can't be built, the text says to run `zoma_status` for it; the refusal still happens.
- Not gated: never-probed (`unknown`) and granted Page access, UPDATE/lifecycle writes, image/video
  uploads, and every read (ENG-2822: Page access gates create only).
- `ads_get_errors` (`explainMetaError`) accepts an optional `message`. Code 283, and codes 10 /
  200–299 whose message names a Page / `page_id` / `pages_*` permission, return the same Page
  message and fix steps (`page_access: "missing"`) instead of the generic code-200 hint. The
  experiment-writes refusal now passes Meta's message through to it.
- `META_BUSINESS_PAGES_SETTINGS_URL` moved to `metaPageAccessRefusal.ts`, re-exported from
  `zomaOnboarding.ts`.
