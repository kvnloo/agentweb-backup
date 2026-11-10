## ENG-2880: Zoma activation events + progress report (2026-11-09)

- **Dark / DATA-PLANE GATE — Harsha approval required before merge.** New optional `zomaActivationEvents` map on existing AW-Users rows; no table/index/key/IAM change or backfill. Enable only with `ZOMA_ACTIVATION_EVENTS_ENABLED=true` after approval. Disabled is the default and does not perform event lookups/writes.
- Typed stages and first-observation emitter live in `backend/src/services/zomaActivationEvents.ts`. Each value contains userId + ISO timestamp, plus a bounded error_category for launch failure. A conditional owner-bound DynamoDB update preserves the first accepted observation across retries/workers. A missing/deleted/replaced user cannot be recreated by analytics. No raw provider errors/tokens enter events.
- Existing sinks inspected: `serverSignalEmitter`/tracker session rows are last-write-wins and cannot preserve first occurrence; MCP usage events are per-call append-only records without a first-stage read model. Reusing the existing user row avoids a new table or new event-stream key design. This is still a persisted-model change and requires approval.

### Instrumentation sites / semantics

| Stage | Real site |
| --- | --- |
| signed_up | Successful conditional `userDb.createUser` put, shared by password, Google OAuth and admin account creation. Uses the just-created identity rather than an eventually consistent GSI lookup. |
| approved_from_waitlist | Admin create-user completion, manual invitation/resend, and both admin/public-admin status endpoints after successful invited/completed updates. If approval precedes account creation, signup resolves the durable waitlist status and invitedAt (when present). Invitations without a userId are not assigned a fictitious identity. |
| logged_in | Password login, Google callback, and authenticated external toolkit calls (including device/API-key credentials). Invalid authentication emits nothing. |
| onboarding_started | Successful Zoma readiness observation (status/device setup), including setup that is not ready. |
| ad_account_connected | Successful Meta ad-account persistence, plus usable Meta/Google account observation during Zoma readiness. |
| onboarding_completed | Live payment method + usable Meta or enabled Google account; not signup or a stale has_payment_method flag. |
| ad_creation_started | Authenticated/resolved Meta AD CREATE attempt, including preview. |
| ad_creation_completed | Meta AD CREATE only with success + CONFIRMED read-back. PAUSED is creation, not publication. |
| ad_submitted | Meta AD UPDATE status=ACTIVE that returns a provider read-back verdict; previews, token mismatch and no-op do not count. |
| ad_published | Same activation write only with success + CONFIRMED + provider effective_status=ACTIVE. Configured ACTIVE/PENDING_REVIEW never counts. |
| ad_launch_failed | Meta AD activation rejection, thrown failure, mismatch or unavailable read-back; categorical error only. |
| returned_later_day | Successful password/Google/toolkit authentication on a later UTC calendar day than recorded signup or authoritative account createdAt. |

**Unwired stages: none on the Meta toolkit path. Coverage limitations:** Google guarded-write creation/submission/publication is not wired (different resource/status model; do not translate ENABLED into proven delivery). Onboarding/connection and authentication cover Google. No asynchronous Meta review/delivery polling/webhook observer is added: an ad that is PENDING_REVIEW at activation and becomes ACTIVE later is conservatively not counted as published until a later confirmed ACTIVE write is observed. Internal Emma/other ad-creation paths are not treated as Zoma. These are observation events, not an exactly-once delivery system: fail-open sink outages/process termination can leave gaps; there is no outbox or historical inference/backfill.

### Admin report

`GET /api/admin/zoma/activation-progress[?format=json|csv][&stuckAfterHours=24][&cursor=<opaque>][&userId=<id>]`

- Existing authenticateToken + isAdmin middleware, including delegated-session denial. No-store; never exposes user password/token fields.
- Bounded 250-evaluated-user page with explicit `scope: page`, `hasMore`, `nextCursor`. `stuckByStage` is page-scoped, never mislabeled a fleet total. Follow all JSON cursors for a complete account report. CSV is also page-scoped (`X-Report-Scope: page`, `X-Next-Cursor`); concatenate data rows while retaining the header once. Specific userId uses a direct lookup instead of a scan; it cannot be combined with cursor.
- Account lifecycle is global because signup/login are shared; Zoma engagement starts at onboarding_started. Existing accounts without events report unknown, not fake signup/activation. List scans omit deleted/sandbox principals.
- Furthest stage uses semantic ordering, not callback arrival order. Failure and return are side branches. Stuck means no forward-progress observation for the threshold (default 24h), with publication terminal. Activation means provider-confirmed ad_published **only**; signup/setup alone never count.
- JSON includes all observed stage timestamps/error category. CSV includes all stage timestamp columns, quotes values and guards spreadsheet formulas.

### Verification / operations

- Mock-only scoped Jest covers emitter, conditional persistence, signup/password/Google/toolkit/readiness/Meta-connect/waitlist wiring, report authorization, cursor validation, CSV and activation/stuck logic. Scoped tsc checks the standalone emitter/report model and its tests; no full-repo typecheck, dev server, browser, real AWS writes or DB provisioning.
- Verified: **125/125 tests, 11/11 selected suites** (84 ENG-2880 tests plus four existing regression suites); scoped strict tsc passed for `zomaActivationEvents.ts` and `eng2880.activationEvents.test.ts`. Local CodeRabbit review completed with three minor findings, all addressed and retested. Existing imported timer handles produce Jest's forced-worker-exit warning; no product servers were started. Full-build pre-push hook is bypassed for this draft because the task explicitly forbids full-repo checks on this low-RAM host; exact-head CI remains the build proof.
- Not tested: production deployment, live provider OAuth/ad delivery, real DynamoDB concurrency, full production build/full-repo typecheck. Await exact-head CI build before considering merge; this PR remains draft.
- After approval/deployment: authenticate as a real admin, read one JSON page and CSV page (read-only), confirm non-admin/delegated denial; use a separately approved staging account to exercise signup → setup → paused create → activation and verify timestamps stay unchanged on replay. Do not create paid/live ads as an unapproved smoke.
- Rollback: unset/false `ZOMA_ACTIVATION_EVENTS_ENABLED` to stop writes, or revert the PR. Existing optional attributes are inert and remain preserved; no destructive cleanup/backfill is part of rollback. Report reads remain admin-only and do not require writes.
