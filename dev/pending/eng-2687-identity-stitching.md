## ENG-2687: Identity stitching visitorId -> account_id (2026-10-26)

- **Data-plane gate: not hit.** No table, GSI, key, or new attribute. Stitching reuses fields the hireemma.ai
  session list already stores: `customFields.accountId` (on `acct-<userId>` rows, ENG-2684) and
  `customFields.visitorId` (on every browser SDK row). The link writes the browser's visitorId onto the
  account row through the existing `ingestTrackerEvent → upsertSessionLead` path.
- **Write:** `linkVisitorToAccount` (services/serverSignalEmitter.ts) emits `registration_completed`
  (`controllers/auth.ts` register) and `lead_identified` (password login = authenticated identify) as custom
  events on the account row, with `visitorId` from `req.body.visitorId` when it matches the ingest's
  `VISITOR_ID_RE`. Fire-and-forget; never fails the request. Idempotent: fixed row key + per-key SET merge.
- **Read:** `utils/identityStitching.resolvePersons` (pure) maps visitorId → accountId from rows carrying both
  and groups every row of that visitor (pre- and post-signup) under `acct:<accountId>`. A browser linked to two
  accounts resolves to the latest link (`forwardedAt`).
- **Limits / follow-ups:**
  - The account row holds ONE visitorId (latest link). Keeping every device's link would need a persisted
    mapping (table/attribute) — that is the data-plane gate, deliberately not done here.
  - Nothing sends `visitorId` yet: the signup/login clients (customer portal / hireemma.ai) must pass the SDK's
    `aw_vid` (cross-domain: via URL param or the landing page's own signup form) in the register/login body.
  - Google OAuth signup is a redirect flow with no body; it is not linked by this slice.
  - `lead_identified` from an anonymous form email is not linked: an unauthenticated email claim could attach
    a stranger's account to an attacker's browser.
