## ENG-665: agent golden set needs work-plan sessions before `agent-task-success` can be validated (2026-10-16)

`agent-task-success` grades only sessions that carry a work plan; every other session is `excluded` (abstain). Run read-only against the 50 seeded agent cases, it graded 4 (45 had no work plan, 1 had no tool calls), 3 of them in the test split. The registry bar needs at least 30 graded test cases with 5 of each class, so human labels on the existing set could never validate it. Production has about 3,270 sessions with a work plan (most `predefined-work-plan` and `scheduled`, which the eval-v2 sampler also grades); on a sample of 80 the grader graded 58 (47 success, 11 failure) and excluded 22 for zero tool calls.

Change: `seedGoldenCases.ts --work-plan-sessions N` is a separate mode that adds agent cases (`seedSource`/`taskType` `work_plan_session`) for sessions with at least one work-plan step, created in the last 90 days, excluding evaluation users, in hash order (never by grader verdict), until the store holds N of them. It builds nothing else, so the other sources' stored sample is untouched; sessions already stored under any agent source are skipped, and a re-run with the same N creates nothing. It needs `EVAL_GOLDEN_CASES_TABLE` also for a dry run (to read the stored agent cases).

Next: run with `--work-plan-sessions 80 --write` (ops role), have a person label `task_success` on the new cases, then `npm run eval:validate -- agent-task-success --evidence <link>` without `--include-ai-labels`. Limits: zero-tool-call sessions are not filtered out at seed time (that needs message reads), so expect roughly a quarter of the new cases to be excluded by the grader; 80 should leave about 55 graded, about 33 in test.

## ENG-2123: phone-only lead dedupe, shipped dark behind a settings row (2026-10-15)

**Problem.** An email-less form capture takes an ordinary timestamp `leadId` and is never deduped: the same person submitting twice makes two leads. A deterministic `lead_ph_<sha>` id was tried and withdrawn because `getLeadsByListId` pages `leadId` descending and assumes it is time-prefixed (`'p'` sorts above every digit and pins those rows to the top of the list forever).

**What this PR adds. With no settings row it changes nothing the customer can see.**
- `LEAD_PHONE_DEDUPE_MODE` (AW-Settings row, read through `settingsService`, cached 30 s, **any missing row, unknown value or read failure means `off`**): `off` (today) | `create` | `shadow` | `on`. It is a settings row, not an env var, because an env-var change is an environment update on an Immutable environment (about 10-25 minutes to roll back).
- `create`: the phone twin of ENG-2321. An email-less form capture with a specific number gets `lead_<5s-bucket>_<12 hex HMAC(listId:"phone:"+digits)>` written in a transaction that also condition-checks the neighbouring buckets, so concurrent same-number submissions collapse to one row and the id stays time-prefixed (list ordering preserved). A loser gets a typed `duplicatePhone` carrying the winner. Same person: it adopts the winner through the existing merge. A **different** first or last name: it creates its own row on an ordinary id (a shared household or office line must not overwrite the first person).
- `shadow`: `create` plus a lookup on `PhoneKeyIndex` and one log line per capture, `[phone-dedupe] mode=… list=… decision=… candidates=… valid=…`. No phone number, name or lead id is logged. The lookup never merges, but `shadow` includes `create`, so a repeat inside the same ~5-10 s bucket still collapses into one row exactly as in `create`.
- `on`: `shadow` plus actually merging a repeat visitor into the OLDEST compatible row (by `createdAt`).
- `phoneKey`: a sparse string attribute, digits only, never `""`, written on every email-less **form capture** whose number passes `phoneDedupeKey` (regardless of mode, so the key exists before the index does). Not written for other origins, rows with an email, a linkedin url or sync metadata, or the synthetic smoke-test numbers. It is an internal attribute and will appear in lead objects the APIs return, like `nameCompanyKey` and `syncMetadata` already do.
- In `off` mode the capture route does one extra AW-Settings read per instance per 30 s (concurrent callers at expiry share one read, bounded to 1.5 s, then it stays `off`). That is the only thing besides the `phoneKey` attribute that differs from before.

**Safety rules baked in** (`utils/phoneLeadDedupe.ts`): at least 10 digits, at most 15; not all one digit; not an ascending or descending run; a 10-digit number must look like NANP (area code and exchange cannot start with 0 or 1). This is stricter than `isDedupablePhone` (7 digits, length only), which the portal mirrors and which is untouched. More than 5 rows on one key is treated as a shared line and never merged. Candidates from the index are never trusted: each is re-read consistently and must still have no email and the same normalised number, so a stale entry costs a missed dedupe, never a wrong merge. `updateLead` is deliberately not modified. Smoke-test numbers, session lists and any capture that carries an email are excluded.

**Failure handling.** A missing or still-building index (`ValidationException … specified index` / `… backfilling`) or `AccessDenied` is a miss, logged once and not retried for 10 minutes; any other `ValidationException` propagates (a bad expression must not silently disable dedupe). A lookup that throws never fails the capture.

**Operator steps (a human with write access; the autofix role is read-only).**
1. Deploy this to every environment.
2. `NODE_ENV=production npx ts-node src/scripts/backfill-lead-phone-key.ts` (dry run, read-only). Read the counts; the number of eligible rows is not known today because `Scan` on `AW-Leads` is denied to the assistant's role.
3. Same command with `--apply --confirm-table=AW-Leads --rate=25`. It sets `phoneKey` only, conditionally, never touches `updatedAt`, and REMOVEs a legacy `email:""` in the same write.
4. `src/scripts/repair-leads-add-phone-key-index.sh` creates `PhoneKeyIndex` (HASH listId, RANGE phoneKey, KEYS_ONLY) and waits for ACTIVE. It also runs on `Dev-AW-Leads` (`TABLE=Dev-AW-Leads`).
5. Set the AW-Settings row `LEAD_PHONE_DEDUPE_MODE` to `create`, then `shadow`; read the `[phone-dedupe]` lines (name-conflict and shared-line rates) for a week or so; only then `on`.
To roll back at any step, set the row to `off`. `phoneKey` attributes and the index are inert when off.

**Not verified / limits.**
- Not run against a real index: the dev index could not be created from the assistant's role. All lookup behaviour is tested against a fake; the first real query happens in shadow mode.
- The production phone-only population is unknown (the card's 17.5k figure is from 2026-09).
- Rows created by `batchCreateLeads` (CSV, HubSpot and Attio imports) get no `phoneKey` from the write path; the backfill covers existing ones but later imports stay invisible to the lookup.
- A phone edit or an added email after capture leaves a stale key; the validate step makes it harmless, but that lead no longer dedupes.
- Two names that differ only by nickname ("Bob" / "Robert") count as different people: it errs toward keeping two rows.
- A person who submits again WITH an email still gets their own row (unchanged).
- In `create` mode a repeat inside roughly 5-10 seconds (the same or the adjacent 5-second bucket) also collapses, not only a literally simultaneous one. A conflicting-name submission in a bucket that already holds someone else's row becomes an ordinary row, so a third person on that same line in the same window also gets their own row (today's behaviour).
- `phoneUniqueCreate` is governed by the settings row only; it does not read `LEAD_EMAIL_UNIQUE_CREATE` (that switch is the email feature's). It shares the email feature's `AccessDenied` circuit breaker, so if the role cannot run `TransactWriteItems` both degrade to a conditional put together.
- The 10-minute "index unavailable" memory is per process; while the index is building the lookup is skipped, not retried per capture.
- The backfill had a bug found in review (it required `nameCompanyKey` to be absent, which would have silently skipped every lead with a first name, last name and company); it now only guards what matters and its test fake evaluates real DynamoDB condition expressions.

**Must be settled BEFORE `on` (found by the all-angles review of PR #3569; `create` and `shadow` are unaffected).**
- The backfill keys every email-less row without a linkedin URL or sync metadata, including hand-entered and imported phone-only leads (leads store no origin, so they cannot be told apart from form captures). In `on`, a form capture on that number merges into the oldest compatible row and `mergeIntoExistingLead` overwrites its firstName, lastName, company, title and notes with any non-empty incoming value. A salesperson's notes can be replaced.
- A blank name on either side is deliberately not a conflict (multi-step landers), so anyone who knows a number can submit it with blank names and merge into that lead, or seed a row a later real visitor merges into. The email path has the same exposure class.
- Needed for `on`: either a non-destructive phone merge (fill blanks, never overwrite non-empty fields) or an eligibility guard (a stated name on both sides, plus excluding rows a person has edited), decided after reading the `shadow` counts.

**Fixed in review:** the phone id used the email hash over `phone:<digits>`, so an "email" of literally `phone:2124567890` produced the same id inside one bucket; phone ids now use their own HMAC namespace (email ids are unchanged). The backfill scan now pauses 250 ms between pages.

**Known limit, accepted: a simultaneous burst of two different names on one number leaves more than one row for the losing name (Opslane P1 on PR #3569).** When N people name person A and M name person B within the same ~5 s bucket, the first to reach the bucket wins its deterministic id. Everyone naming the same person merges into it. Everyone naming the *other* person hits the name-conflict rule and creates an ordinary-id row, one per request, because that separate row is deliberately not protected by the exactly-once create. Reproduced twice on a preview (4 Ana + 4 Bob gave 1 Bob + 4 Ana, and the mirror image); every row held only its own person's name, company and custom fields, so nothing was merged across people. The same burst with the feature off gives 8 rows (4 + 4), so this is strictly fewer duplicates than today, but not the ideal 2. It is accepted because the rule prefers a duplicate to merging two people, the window needs two different people on one number inside seconds, and a later repeat is picked up by the `PhoneKeyIndex` lookup in `on`. A name-keyed id namespace would close it but adds a third id family and a second transaction-protected create inside the error handler; revisit only if the `shadow` name-conflict counts show it matters.

## ENG-2509: Coerce finite decimals/booleans to string for exactly-string tool schemas (2026-10-16)

`validateAndRepairToolArgs` now repairs finite non-integer decimals and booleans passed where the property schema is exactly `string` (`String(value)`, `scalar_coerce` repair). Bare integers remain limited to id-named fields, so `file_url: 123` / `action: 7` still fail as `type_mismatch`. NaN/Infinity/unsafe ints, containers, null, multi-type schemas, and values outside a declared enum are never coerced.

## ENG-2508: Pure scheduled-post due selector + lifecycle transitions (2026-10-16)

- Added `backend/src/services/scheduledPosts/scheduledPostLifecycle.ts`: `selectDuePosts(records, now)` and `transition(record, action)` (edit/cancel/idempotent markFired) with typed results. In-memory only; storage/firing gated on ENG-2501.

## ENG-2507: Pure scheduled-post request validator (2026-10-16)

- Added `backend/src/services/scheduledPosts/validateScheduledPostRequest.ts`: pure ok/error validator (platform x/instagram/linkedin, tz-qualified future publishAt within 90 days via injected clock, per-platform content caps, http(s) media URLs, Instagram requires media). No persistence, no tool registration; storage/firing remain gated on ENG-2501.

## ENG-2504: Pure drip completion -> newsletter-segment routing decision (2026-10-15)

Added `backend/src/services/dripSequenceRouting.ts` `completionRouting()`: delivered no-response completions with a configured segment route to `add_to_segment`; untouched leads, all stop reasons (unsubscribed/bounced compliance, replied/booked sales-owned), missing segment and unknown outcomes return `none`. Pure; not yet wired into the worker.

## ENG-2502: Blind human labelling pages (2026-10-15)

- `/eval-labelling` and `/eval-labelling/calibration` now show a case whose notes start with `[AI-LABEL]` as unlabelled: no stored labels, notes or draft suggestions, not counted as labelled, not skipped by "next unlabelled". A human save replaces the AI label as before.
- Front-end only (`partner-portal/src/utils/blindLabelling.ts`); no backend or data change.

## GROW: Split paid Google/YouTube traffic channels (2026-10-14)

- Traffic classifier 2.1.0: paid `google_search` -> `Google Ads` (`google_ads`), paid `youtube` -> `YouTube Ads` (`youtube_ads`). Organic unchanged.
- Routing rules keyed on `google_search`/`youtube` still match the paid variants.
- `backend/scripts/backfill-paid-channel-split.ts`: dry-run by default, reversible (`--revert`), conditional writes. Needs Harsha approval before `--apply` in prod.

## ENG-2496: Zoma device-flow onboarding (2026-10-14)

- **Shape:** RFC 8628 device flow at `/api/zoma/*` (`routes/zoma.ts` → `mcp/zomaDeviceFlow.ts`). The verification page does NOT build its own login: it redirects into the existing `/oauth/authorize` → portal consent page as a first-party public client `zoma-device-setup`, created lazily by `mcpOAuthService.ensureFirstPartyClient` with redirect URI `<BACKEND_URL>/api/zoma/activate/callback`. The PKCE verifier lives on the device record, so only the backend can redeem the code. `state` = sha256(device_code).
- **Readiness is not duplicated:** the poll calls `getZomaReadiness(userId, …, { mintLinks: false })` each time. It mints links (Stripe setup Checkout / Meta connect) only once per step and caches them on the device record, because minting on every 5s poll would create a Stripe Checkout session per request.
- **Step order in poll:** `connect_meta` before `add_payment` (ticket order); `zoma_status` still lists payment first. Both are derived from the same readiness.
- **Single issuance:** `issueToken` is one DynamoDB transaction: device `status approved→issued` (conditional on the same userId) plus a token-row put with `attribute_not_exists`. A reused device_code returns `invalid_grant`. `slow_down` is an atomic conditional update on `lastPollAt`/`intervalSec`, and the interval grows by 5s per violation.
- **Storage (data-plane, needs approval):** new table `AW-ZomaDeviceAuth` (`Dev-` prefix in development). PK `pk` (S), no SK/GSI, TTL attr `ttl`. Items `device#…`, `usercode#…`, `token#…`. The table must be created before deploy; the code does not create it.
- **Known limit:** revoke requires presenting the token. There is no per-user "list/revoke all" (that needs a userId GSI, which was deliberately left out).

## ENG-2493: Scheduled chat email opt-out also suppresses alert emails (2026-10-14)

PR #3527 let `manage_scheduled_chat` honour `email_notifications: []` as an opt-out, but only as
a request-time flag: the stored schedule just had `emailNotifications: []`. Every alert sender
(run-failed, sourcing-block transition, disallowed-tool error, usage-limit) treats an empty list as
"fall back to the owner's account email", so the owner kept getting alert emails after opting out.

Fix: one persisted optional field, `emailOptOut` (absent = false; Harsha approved 2026-10-14, no
backfill/migration). Create sets it when the tool sends `[]`; update sets it when recipients are
cleared on purpose, sets it false when recipients are set, and omits it otherwise (partial SET keeps
the stored value). The four senders share `resolveScheduleAlertRecipients` in
`agentModeController.ts`: configured recipients, else nobody if opted out, else the owner.
Oncall alerts, run history, and the schedule-card badge are unchanged. The paused-for-input and
variable-request emails still fall back to the owner: they ask for an action the run needs, so
suppressing them would strand the schedule.

## ENG-2488: Partner-portal custom subscription link form (2026-10-14)

Admin-only "Create custom subscription link" button + validated form on the Users org cell, calling the existing `POST /api/admin/custom-subscription-links` (ENG-2428). Hidden unless `VITE_CUSTOM_SUBSCRIPTION_LINKS=true` (default off). No schema/webhook changes.

## ENG-2465: the HubSpot app's webhook subscriptions can only be changed in its HubSpot project (2026-10-14)

**Found in production after #3537.** The boot registration of `contact.merge` failed: HubSpot answered `403 BANNED / AppProjectAssociationErrors.PROJECT_BASED_APP_WEBHOOK_EDIT_ERROR`: the AgentWeb app was created by the project `agentweb_hubspot`, so its webhook configuration "can't be edited through the API or UI"; it has to be changed in the project's webhook config file and the project redeployed. The assumption that the backend could register this app's subscriptions through the API does not hold for this app. The same 403 applies to the config-save path (`routes/crmSync.ts`) and to any mapped-custom-property subscription it tried to add.

**Effect.** Nothing was broken (the contact.merge handlers are inert until the event arrives), but every deploy burned 5 queue attempts on a request that can never succeed and logged 5 errors.

**Fix.** `ensureWebhookSubscriptions` recognises that specific 403, logs ONE warning naming the subscriptions that still have to be added to the project's webhook configuration, skips the remaining POSTs, and reports "nothing this code can do" so the build completes instead of retrying. Any other failure (other 403s, 429, 5xx, timeouts) still fails the build's claim and is retried as before.

**Still to do by hand.** Add the `contact.merge` subscription to the `agentweb_hubspot` project's webhook configuration and redeploy the project; until then merges in HubSpot are not delivered to us, and the stored-id push fails closed on a merged-away id as before.

**Consequence for custom mapped properties.** The config-save path (`routes/crmSync.ts`) registers a `contact.propertyChange` subscription for each user-mapped custom property. Against this app that is refused the same way, so inbound realtime updates for any mapped property that is not already in the project's webhook configuration do not arrive; the warning (one per save) names them. Fixing that means adding the property to the project's webhook configuration; no code in this repo can.

## ENG-2465 / ENG-2464: re-point stored HubSpot contact ids on `contact.merge`, and a live-check script (2026-10-14)

**Why.** Since ENG-2171 the batched HubSpot push updates a lead by its stored `syncMetadata.hubspot_contact_id`. If the customer merges two contacts in HubSpot, that id points at the merged-away contact, so the lead would fail every push (`sync_failed`, id kept, nothing created). HubSpot documents a `contact.merge` webhook (`primaryObjectId`, `mergedObjectIds[]`, `newObjectId`, `numberOfPropertiesMoved`) and no API to find the survivor from a merged-away id, so the webhook is the only documented way to learn it.

**ENG-2465.** Both HubSpot webhook handlers (`routes/webhooks.ts` shared endpoint, `routes/crmWebhook.ts` per-list endpoint) now handle `contact.merge`: the lead holding a merged-away id gets `hubspot_contact_id` rewritten to the survivor (`newObjectId`, else `primaryObjectId`), other `syncMetadata` kept. In the shared endpoint the merge rides in the durable job payload (optional `merges` field, so already-queued jobs still process) and applies only to lists connected to that portal. Every lead holding the merged-away id is rewritten (duplicate leads for one contact), bounded at 25 per id. Merges are applied before deletions in the same delivery; on the per-list endpoint with `deleteOnPull` that stops a `contact.deletion` for the merged-away id deleting the re-pointed lead (the shared endpoint only flags `crmRemovedAt`, and finds the lead by email first, so the ordering matters little there). Idempotent: after the rewrite the old id matches no lead. A lookup or write failure never throws out of the helper; on the shared endpoint it fails the job AFTER the rest of the delivery is applied, so the durable queue retries it (capped at 5 attempts); on the per-list endpoint it is only logged.

**Not done / limits.**
- A merge that fails the same way every time (e.g. a list over the lookup's 20-page cap) fails the shared-webhook job after the delivery's other changes are applied, so each queue retry re-applies those changes; an older delivery replayed late could overwrite a newer value. Same retry semantics as any failure of this job, now reachable by a permanent merge failure.
- `AW-AsyncJobQueue` must exist in the target environment (created by a manual script); if it does not, the boot registration is skipped for that build.
- The `contact.merge` subscription is registered by the backend itself with the developer API key: `ensureWebhookSubscriptions` (`utils/hubspotWebhookSubscriptions.ts`) includes it and recognises it as already present, so it is not re-registered. It runs (a) on a user's HubSpot OAuth sync-config save, as before, and (b) **once per deployed build at server start** (`utils/hubspotWebhookSubscriptionsBoot.ts`, called from `server.ts`). Several instances boot together on a deploy and HubSpot's behaviour on a duplicate subscription is undocumented, so the boot run is claimed with the job queue's atomic insert-if-absent keyed on the build's commit: exactly one instance registers, the rest stand down, and a restart of the same build does nothing. If the queue is unreachable it does NOT run unguarded; with no build identity (local, preview, tests) it does not run at all. A claim whose owner crashes is retried by the queue's poller (idempotent). If any registration FAILS (HubSpot 4xx/5xx/429, transient Secrets Manager error) the claim is marked failed and retried by the poller (capped attempts) instead of being marked complete; missing credentials (nothing this environment can do) complete without retry. HubSpot calls carry a 15s timeout so a hung socket cannot hold the claim. A job whose retries are exhausted stays `failed` for that build and blocks further boot attempts for it (a config save still retries). Runs within one process are serialised, so a boot run and a config save cannot interleave. Kill switch: `HUBSPOT_BOOT_SUBSCRIPTIONS=off` (EB env var, restart). One row per build per source stays in `AW-AsyncJobQueue`. A rejected registration is logged (`[HubSpotWebhook] Failed to register ...`) and does not affect boot. Not covered: two config saves on DIFFERENT instances at the same moment can still both register a missing subscription (this existed before). Not verified against HubSpot; check the app's subscriptions list after the first deploy. Only API-key customers (per-list endpoint) configure their own endpoint.
- If another lead in the list already holds the survivor's id, both now share it; the push handles that (same email collapses, different emails upsert by their own email).
- `getLeadByHubSpotContactId` is a bounded partition query (no index): a very large list can exhaust the page cap, in which case that merge is skipped with a warning.
- A push already in flight holds the old `syncMetadata` map and can write the dead id back after the webhook rewrote it (the rewrite replaces the whole map, as `persistSyncMetadata` does). The window is one push batch and nothing repairs it later; it fails closed, as before the rewrite.
- Leads whose id lives only in `customFields.hubspot_contact_id` are not found (the lookup filters on `syncMetadata`).
- Not live-verified (no connected HubSpot); covered by unit tests only.

**ENG-2464.** `backend/scripts/hubspot-live-check.mjs` records the raw status and body of the contact edge cases HubSpot's docs do not describe (missing id, archived id, mixed batch, duplicate id, email collision, merged-away id, unknown property, upsert right after an email write) and whether `isContactGoneError` would classify each as "gone". It needs a HubSpot developer test account private-app token (`HUBSPOT_TOKEN`) and `HUBSPOT_SANDBOX_CONFIRMED=yes`, reads `/account-info/v3/details` first and refuses any account HubSpot does not label developer, sandbox or test, uses only `@eng2171.example.invalid` probes, and archives them in a `finally`. Its own offline test (`node --test backend/scripts/hubspot-live-check.test.mjs`) runs against a local fake and proves the script, not HubSpot. The card stays open until someone runs it against a real portal and pastes the output.

**Connect error (not in this PR).** The HubSpot connect failing for portals without Marketing Hub is a HubSpot app-config mismatch (marketing scopes registered as `conditionallyRequiredScopes` while we send them as `optional_scope`). `social` is documented as deprecated but `SOCIAL` broadcasts in the Emma HubSpot tool use it, so it is left in `marketingOnlyScopes`.

## ENG-2299: No catalog churn found; tool-gate and install refusals now log why (2026-10-14)

**Finding.** The ticket's premise (the shared published-skill catalog changes under a live session) was not borne out by prod evidence on 2026-10-14. Nothing was changed in code to "fix" it.

- **2026-10-05 `call_google_ads_api`:** eight published skills claim it, so it can never be in the `__other_skills__` pool. No skill was created or updated that day. The one session where it failed (`72f4afd2`) failed with Google `USER_PERMISSION_DENIED` and connected-account errors, not gating. Prod web logs for the day had zero entitlement-unresolved, tier-fallback (`UNCONFIRMED-TIER`, org-owner lookup errors, `STALE-CONFIG`) or skill-resolution failures.
- **ENG-152 session (`00ffae8d`):** a plain missing install; one `install_skills` fixed it. `read_file_content` is now a foundation tool.
- **ENG-1867 session (`4b9f7b7d`):** `__other_skills__` was refused for an entitled Free user. `convert_to_pdf` is now a foundation tool, so the symptom is gone. The cause of the refusal is NOT established: the ENG-1237 unpublished-skill filter predates the session (2026-08-24), the 09-10 logs are past retention, and `AW-Skills` has no history table.
- **Catalog churn:** no published skill changed between 2026-09-25 and 2026-10-13.

**Real but separate inconsistency (not changed).** The install/display path (`getSkillsForDisplay` -> `loadAuthorizedSkillCatalog`) computes the `__other_skills__` pool from the tier-filtered catalog; execution (`buildSkillContext`, `resolveSkillsToToolNames`) computes it from the full published catalog. A tool claimed only by a skill the tier cannot install can therefore look installable and still never be callable. Scoping execution to the tier catalog was tried and rejected in review (it lets a higher-tier skill's tool leak to every tier), so which side is right is a product decision.

**Added.** The skill-install gate in `toolDispatch.ts` now logs one `[tool-gate-refused]` JSON line per refusal: session, user, tool, the session's live installed skill ids (refreshed after a mid-turn install), `entitlementResolved`, whether `__other_skills__` is installed and tier-allowed, published-catalog size, whether the tool is in the live pool, and which published skills claim it (installed / tier-allowed). The refusal text is unchanged. Search CloudWatch `web.stdout.log` for `tool-gate-refused` when the next report arrives. It separates a missing install (`claimedBy`/`otherSkillsInstalled` false), a tier gap (`tierAllows` false with `entitlementResolved` true) and an unresolved entitlement. A pool change over time is only visible by comparing `catalogSize` and `inOtherSkillsPool` across lines.

**Install refusals too.** An `install_skills` rejection (full refusal, the ENG-1867 "unavailable to install" path, or a partial install with `partial: true`) logs one `[install-refused]` line: session, user, requested ids, the four rejection buckets, published-catalog size and the `__other_skills__` pool size. The pool size is computed from the unfiltered published list, so an empty pool is conclusive for every user, but a non-empty one does not prove a given user's tier-filtered pool was non-empty. An empty pool with `__other_skills__` in `unavailable` is the ENG-1237/ENG-1867 signature.

**The two other 2026-10-05 "not available" reports.** `call_hubspot_api` (session `d7e413d3`) and `search_ads_knowledge_base` (`f7e326bb`) are registered tools, are not foundation tools, and appear in no published skill, so both sit in the `__other_skills__` pool. The likeliest reading is the same as ENG-152: the session had not installed `__other_skills__`, so the gate refused as designed. Not confirmed: their `associatedSkills` were not read (the autofix role cannot query sessions by time). The `[tool-gate-refused]` line will settle this for the next occurrence.

## ENG-2135: how reliable are AI-written golden labels? What the cross-checks showed (2026-10-14)

150 label sets (50 agent sessions, 30 accounts, 50 creative images, plus pairwise checks) were produced by independent AI annotators reading raw records, never judge or classifier output, and tagged `[AI-LABEL]`. They are NOT human agreement and cannot qualify a grader: `runValidation` leaves them out by default and a registry validation must now declare `labelSource: 'human'`.

Cross-checks (all counts from the saved annotation passes): account health, two independent passes agree on the state for 28 of 30 (kappa 0.86); creative images, 324 of 350 criterion labels agree between two passes (per-criterion kappa 0.46 for policy_risk up to 0.89 for brand_fidelity); agent sessions, after a decision table was applied, 288 of 350 criterion labels were unanimous across passes and 61 were settled by majority or a third vote, 1 stayed split (left unlabelled for a human). Before the decision table, two passes agreed on instruction_compliance at kappa 0.27: the old help text was ambiguous, now fixed in the labelling UI. Pairwise creative preferences are weak: an independent pass matched the seven human labels on only 3 of 7 pairs and the other AI-written pairs on 27 of 50, so those need people.

Known limits: the annotators are the same model family as the Sonnet shadow judge, so their errors correlate with the judge's; classes are skewed (failed_to_escalate has 2 positives of 50, hook 47 of 50 pass), and `reliable: false` in the report now says so instead of printing a kappa; a claim that might come from hidden injected memory counts as unsupported for groundedness, because a judge sees only the transcript.

## ENG-2135: AI-written golden-set labels never count as human agreement (2026-10-14)

On 2026-10-14, with the owner's permission, a Claude model wrote golden-set labels (72 at the time of writing: creative pairwise
choices and agent `task_success` labels; see ENG-2135). Each carries a note starting `[AI-LABEL]`; the store records the saving admin as the labeller, so that note is
the only marker. The validation harness and the creative calibration report treated every label as human, so a later run could have
produced a registry-shaped "validation" from AI labels, which is the evidence a reviewer pastes into `evalRegistry.ts` to let a judge
gate or alert.

- `isAiLabelled` / `AI_LABEL_NOTE_PREFIX` (`goldenSet.ts`): a case whose note starts with the marker.
- `runValidation` leaves those cases out by default. `includeAiLabels` (CLI `--include-ai-labels`) adds them for an advisory run: the
  result reports `labelSource: 'human+ai'` and `validation: null`, so it can never be recorded as registry evidence.
- `creativeCalibrationReport` leaves AI-written choices out by default, prints how many were left out, and with `--include-ai-labels`
  marks the report "ADVISORY, not human agreement".
- `eval:label-coverage` counts such a case as unlabelled and reports how many cases hold AI-written labels, so it cannot say the human
  work is done when it is not. The offline suite's `golden-agreement` baseline (`--golden`) leaves those cases out too.
- Not changed: stored labels, the label API, flags, `mayGate` for any grader. A label written without the marker is still treated as
  human, so anyone writing labels for the owner must keep the marker.

## ENG-2135: Agent golden set gets an unbiased sampled_session source (2026-10-14)

### Problem
`seedAgent` built cases from replay fixtures, `admin_override` sessions (10) and the false-positive
catalogue (38). All 10 admin_override sessions are already in `AW-EvalGoldenCases`, so no
`--target-agent` value could add cases: the agent surface sat at 50 (29 test / 21 dev). Validation
needs n >= MIN_VALIDATION_N (30) human-labelled cases on the test split, and the split is a hash of the
case id fixed at creation, so agent could never validate as seeded. All three sources are also
failure-biased, a poor base for judge agreement on ordinary traffic.

### What changed
A fourth source, `taskType` / `seedSource` = `sampled_session`. A session qualifies when it was created
within 90 days of `now`, has `messageCount >= 4`, has `sessionType` regular (or absent on legacy rows),
and its `userId` is not an evaluation user (`isEvaluationUser`, `eval_` prefix). Sessions already in
another agent source keep that source. Candidates are ordered by a salted hash of the case id, never by
recency or score, so re-runs pick the same sessions and a larger target only appends. Sampled cases are
not pinned: they fill after pinned and `fp_catalogue` cases, so the default target (50) adds nothing while
the existing store already holds 50 pinned + catalogue cases. The loader now also projects `userId`,
`createdAt`, `sessionType`, `messageCount` (no message bodies). `bySource` and the dry-run line count it.

### Use
Dry run first (reads only, writes nothing): `--target-agent 70` adds up to 20 sampled sessions on top of
the existing 50. `store.createCase` is conditional on `attribute_not_exists(caseId)`, so `--write` never
overwrites and is idempotent. The write is additive but still data-plane work: needs Harsha's approval.
Human labelling workload grows by the number of new cases (about 60% land in test, so 20 new cases is
roughly 12 test labels; reaching 30 test labels from 29 needs only a few, 70 gives margin).

### Limits
Sessions with no `messageCount` (written before the counter) are never sampled. Evaluation sessions are
identified only by the `eval_` userId prefix; other internal/QA accounts cannot be told apart from cheap
attributes and are not excluded.

**Gated creative candidates (ENG-2226).** `--gated-creatives` (opt-in, off by default) adds `gated_candidate` creative cases: image candidates in `AW-HumanEvalQueue` that carry an evaluated creative-gate result (`creativeGates` present and not `notChecked`). Every reviewer-feedback creative case predates the gates (earliest gated candidate 2026-09-25), so the gates adapter abstains on all of them; labelling `format_readiness` on those is wasted effort. Reviewed candidates keep priority and a larger `--target-creative` only appends.

**Target semantics, a foot-gun worth stating.** `--target-<surface>` is the size of the *selection*, not the number of additions, and `createCase` never overwrites. For agent the pinned and catalogue cases (10 admin-override + 2 replay + 38 catalogue = 50) come first, so with `--fp-catalogue` the sampled additions are `target - 50`; without the catalogue file only the 10 admin-override cases are pinned, so the same 20 additions need `--target-agent 30`. Read `bySource` in the dry run and aim for about 20 new `sampled_session` cases (about 12 land in the test split), then diff against the store before any `--write`.

## ENG-2135: account-health golden cases need ad-connected accounts, not a subscription-status split (2026-10-14)

An annotated read of all 30 seeded account-health cases (state judged from raw connection, payment, spend and engagement records, never from the classifier) came out 22 `activation_incomplete`, 3 `healthy`, 2 `at_risk`, 3 not applicable. Subscription status (`canceled` / `active`) says almost nothing about health: only about 27 of roughly 490 users have an ad platform (Meta, Google Ads, LinkedIn Ads) connected, and they are the only possible source of `healthy` and `at_risk` examples. A larger subscription-status sample would only add more `activation_incomplete`, leaving the other two classes with a handful of positives and no usable per-class kappa.

Changes: (1) tombstoned (`deleted_`) and evaluation (`eval_`) accounts are never selected, in either mode (the pool included them; a tombstoned user has no health state, and the other health code already excludes them); (2) opt-in `--ad-connected-accounts` takes every ad-connected account first (hash order), then fills with the existing balanced subscription sample. Default behaviour is otherwise unchanged. With `--target-account-health 50` the expected selection is every ad-connected account (about 27, some already seeded) plus about 23 from the subscription sample.

Limits: the loader projects `connected_accounts` to learn which platforms are connected; the connection config (tokens) is never kept or printed. `at_risk` will stay rare until more accounts have connected ad platforms; the grader cannot be validated on that class before then and must stay ungated. A tombstoned account that already has a golden case keeps it (labelled not applicable).

## DRAMABREAK: observed channel beats link tag; Nova paid channel (2026-10-14)

Classifier 2.2.0. Decided by Harsha 2026-10-14 (DramaBreak attribution decision queue, all recommendations):
- Channel = in-app browser UA, then referrer, then utm_source, then click id, then fallback. Agency and paid links keep the link's platform.
- New row fields `linkChannel` (what the link claims) and `detectedChannel` (what we observed), reported side by side.
- New channels: `nova` (NewsBreak Ads, Paid by construction) and `newsbreak` (newsbreak.com referral).
- Not backfilled: only new sessions use 2.2.0 (rows carry classifierVersion). A backfill is a data-plane change and needs separate approval.

## ENG-2378: Work Plans can pin a model per step (work_plan_step_models_enabled) (2026-10-13)

Before: a Work Plan could pin one `defaultModel` for the whole plan; every step ran on that (or the account default),
so a plan could not use e.g. a strong reasoning model for one step and a cheap one for the rest.

Principle (owner): every user and admin picks the model; the selected model is the only one ever used. No swaps.

Now, with AW-Settings `work_plan_step_models_enabled` = exactly `true` the feature is on (60s cache, last-known value on
a failed refresh, `services/agentMode/workPlanStepModels.ts`, same pattern as `compare_save_alternatives`). The switch has
THREE states, and they differ for writes and for stored models:
- ON (`true`): new/changed step models are accepted and validated; stored models are honoured at launch and by the engine.
- OFF (a row that is absent or any other value, i.e. a successful read): behaves exactly as before the feature. A submitted
  `model` is ignored (with a `warnings` entry), stored models are carried over untouched by writes, not copied at launch
  and ignored by the engine.
- UNKNOWN (settings read failing with no last-known value, e.g. cold start): stored step models are still HONOURED
  (launch validation + copy, engine, `save_work_plan`), because only a definite off may ignore a user's explicit choice;
  writes treat it like off (submitted models ignored, stored ones carried over), and `GET /model-options` reports `false`.

- Storage: an OPTIONAL `model?: string` (canonical registry id) on `WorkPlanStep`, an additive optional key INSIDE the
  existing JSON `steps` array of AW-WorkPlans. No migration, table, index or attribute. Absent = the plan `defaultModel`
  pin, then the account default (today). Owner accepted additive optional keys.
- Whitelists (the ENG-889/ENG-1331 silent-drop class): `WORK_PLAN_STEP_FIELDS` and `STEP_CONTENT_FIELDS`
  (workPlanSteps.ts), the admin merge-supplied builder, `createSessionWithPlan`, `applyPredefinedWorkPlan`, the session
  work-plan step types (chatbotService.ts), and the MCP `manage_predefined_work_plan` step schema. A source-scan test
  fails if a `WorkPlanStep` field is ever missing from `WORK_PLAN_STEP_FIELDS`.
- Write (admin + user routes, create/update): each step model is validated with `checkPlanDefaultModelWrite` semantics: an
  UNCHANGED stored value is tolerated (a since-retired model never blocks an unrelated edit; matched by title, else
  stepCount), a new/changed value must be served and selectable by the plan's launchers, else 422 `model_unavailable`
  with `stepCount`. A replace that omits a stored step model is refused as content loss; a blank `model` in
  `steps_mode="merge"` clears it. Switch off: a submitted `model` is dropped with a `warnings` entry and never validated.
- Launch (`launchWorkPlan` / accept / `applyPredefinedWorkPlan` incl. unattended schedule launches, and
  `createSessionWithPlan`): ALL step models are resolved up front for the launching user with the plan-pin rules
  (`resolvePlanLaunchModel`, no silent swap); any failure is a 422 (+ `stepCount`) before any state is written; the
  unattended launch also pages oncall. Canonical ids are copied onto the session plan only while the switch is on.
- Engine (`generateSessionResponse`, `scheduleAutoWorkPlanContinuation`): at each turn/continuation the first
  not-completed/skipped step's model wins over the request's `llmModel` and the session's, via
  `resolveEffectiveModelForUser(allowSilentSwap:false)`, and the session `llmModel` is updated to it. A step model that
  became unavailable mid-plan PAUSES the plan: a visible assistant message ("Step N uses <model>, which is no longer
  available. Pick another model for this step to continue."), an oncall alert, no LLM call; idempotent per step+model so
  the continuation chain does not repeat it. An unexpected resolver failure fails the turn; it never falls back.
- Hint: `GET /api/agent-mode/model-options` returns `workPlanStepModelsEnabled` (boolean) next to `chatBranchingEnabled`
  / `compareSaveAlternatives`. Partner-portal admin work-plan editor shows a per-step model select behind it.
- Review hardening: a write NEVER erases a stored step model. With the switch off or its state unknown a submitted
  `model` is ignored and the stored one of the matching step (title, then stepCount for a renamed step) is carried over
  (admin, user, MCP replace/merge); `modify_work_plan` follows the step by title, not the stepCount slot;
  `save_work_plan` carries it; `/public/plans` strips step models. A settings-read failure with no last-known value is
  UNKNOWN, not off: stored step models are still honoured (launch + engine); only a definite off ignores them.
- Paused step: an explicit pick (the `/generate` `llmModel` differing from the stored session stamp) overrides an
  UNAVAILABLE pending step model, runs the turn and updates that step; an available step model still wins over the
  picker. Without a pick the plan stays paused ("Choose another model in the model picker and send again").
- A step with no model runs on `workPlan.planDefaultModel`, then `workPlan.launchModel` (the model the session had
  before the plan), recorded at launch only for plans whose steps carry a model; the stamp is exactly what runs. When
  the plan completes the pre-plan model returns unless the user picked one (`workPlan.engineModel` marker).
- Carry-over matching is conservative ("a wrong model is worse than none"): by unique title; duplicated titles match
  only the same-numbered stored step; a rename binds only when exactly one step on each side is left unmatched at the
  same number with unchanged content. A pick on a model-less step stands (the marker `engineModel` keeps naming the
  engine's own choice); a failed end-of-plan restore clears the marker once. Share / conversable views and anonymous
  launches never carry step models or `launchModel` / `planDefaultModel` / `engineModel`.
- The picker PATCHes the session model before `/generate`, so the request model equals the stamp: a stamp that differs
  from the engine's last stamp (`engineModel`; before the first stamp the plan default / launch model) IS the user's
  pick. It resumes a plan paused on a retired step model (the step adopts it), stands on model-less steps, and never
  overrides an available step model. Duplicate-titled steps inherit a model only from the same-numbered stored step
  with the same content (identical twins cannot be told apart and match by number).
- An interactive-share viewer's pick may run for the turn on a model-less step but never rewrites the owner's stored
  step model or the engine marker; on a retired step model the viewer gets the pause and the owner resumes.
- `workPlan.pickedModel` records a model the user explicitly picked during the plan (a model-less step running on it, or a
  retired step adopting it); the end-of-plan restore never replaces it. Submit-for-review and approve revalidate the
  stored step models as a NON-admin launcher (422 + `stepCount`, state unchanged), like the admin scope-widening check.
- Known consequences: a stale picker echo (a `/generate` carrying a model different from the stamp, without a PATCH) is
  indistinguishable from a pick (relies on the portal syncing the picker to the stamp); a plan with later steps pending
  but no marker (hand-edited / legacy only; the engine never creates it) has no baseline; in the unique-title carry
  path the TITLE is the identity (a step retitled into a deleted step's title keeps that model) and duplicates with
  identical title+content cannot be told apart. Also: with the switch off an admin cannot clear a stored step model; a client that always sends
  `llmModel` never sees the pause and rewrites a retired step model to its pick; authenticated
  `GET /api/user-work-plans` shows step models of public plans to signed-in users (as `defaultModel` today); a scheduled
  run paused mid-plan retries up to 20 verified-chat attempts, then the run fails and the next scheduled run re-validates
  every step model at launch.
- Not changed: Emma's `create_work_plan` / `modify_work_plan` tools (a model choice belongs to a user/admin, not the LLM;
  `modify_work_plan` keeps a stored step model), model-compare/branching, concurrency cap, retries, autocomplete rounds,
  and the legacy AW-Settings predefined-plans blob (`routes/settings.ts`), which never carried per-step fields.
- Rollback: set `work_plan_step_models_enabled` to anything but `true` (writes drop the field again, launches stop
  copying it, the engine ignores stored values; nothing to migrate back).

## ENG-112: Legacy branches heal themselves when their owner opens them (2026-10-13)

### Problem
Branches created before agentweb#3463 (2026-10-09..10-13; `chat_branching_enabled` was only turned on 2026-10-09) carry the row-0 `metadata.branchOrigin` marker but no session-level `branchedFrom`. They are not grouped in the sidebar, not listed by `GET /session/:id/branches`, and a branch of one starts a NEW family root.

### Fix (self-healing, bounded, no backfill)
- `GET /api/agent-mode/session/:id`, genuine OWNER view only (not admins, not delegated, not share/MCP views), only when `chat_branching_enabled` is exactly "true", only when the loaded session has no `branchedFrom` and its already-loaded row 0 carries a well-formed `branchOrigin`.
- Derives `branchedFrom {sessionId: sourceSessionId, rootSessionId, messageIndex: sourceMessageIndex, branchedAt}` (the exact values #3463 writes) and persists it with ONE conditional update: `attribute_exists(sessionId) AND userId = :owner AND attribute_not_exists(branchedFrom)`. Concurrent opens are idempotent, an existing value is never overwritten, `updatedAt` is not touched (sidebar order unchanged). The healed value is returned in the same response.
- rootSessionId = the source's `branchedFrom.rootSessionId`, else the source itself (a legacy source without `branchedFrom` is not walked further: that would need its message rows). Inline-message records (very old sessions) are followed up to 10 record reads, cycle-safe. Only `getChatSessionRecord` reads; never message rows.
- Source must exist and belong to the SAME owner (archived is fine); otherwise skipped silently.
- Best effort: any failure is logged and swallowed; GET never fails. Sessions that already have `branchedFrom` or are not branches cost nothing (no flag read, no store call). A legacy session costs the bounded record reads once, ever.

### Known limitation
A chain of two or more legacy hops (C branched from legacy B branched from A) heals C with root B until B itself is opened and healed; C is then in B's family, not A's. Walking further would need message rows, which this change deliberately never reads.

- Accepted two-hop split (pre-#3463 data only): healing B first and then C puts both in A's family; opening C first (root B) and B later splits them (C in B's family, B in A's). Nothing is rewritten after the fact.
- A session whose source is missing/foreign/cyclic is remembered in a per-process set (max 500, cleared on restart, nothing written), so repeated opens do not repeat the flag read and source read.

### Approval / rollout / rollback
- `branchedFrom` is the additive optional attribute already owner-approved with #3463; no new attribute, index, table or backfill.
- Rollback = revert this PR. Values already written are harmless (owner-only, optional, read by the same code as #3463 branches).
- Tests: `chatBranching.legacyHeal.test.ts` (real controller + real ChatbotDB over the in-memory store with enforced ConditionExpressions). Mutation-checked: dropping the owner condition, the attribute_not_exists condition, the owner-view gate, the flag check or the same-owner source check each fails tests.

## ENG-110: Cross-instance active-run guard for interactive /generate (2026-10-13)

Problem: production runs one backend instance but deploys are Immutable (two instances overlap) and the old one
drains for up to 10 min (`DRAIN_CEILING_MS`). The per-session generation lock, its owner map and `/generating` are
process memory, so during an overlap the OLD instance can still run a chat while the NEW instance reports nothing:
after a reload the portal shows the "response wasn't received / Resend" banner and a Resend click starts a SECOND
generation (duplicate user message, two assistant replies, double cost).

Fix (additive, switch-gated, fail-open): an optional attribute on the existing `AW-ChatSessions` item,
`activeRun: { runId, instanceId, startedAt, heartbeatAt }` (epoch ms). No GSI, no backfill, no new table or index.
The run-store guard (`AGENT_RUN_STORE`, `AW-AgentRuns`) is NOT used.

- Switch: AW-Settings `session_active_run_guard_enabled`, exactly `'true'` enables. Absent / anything else / cold-start
  read failure = off = today's behaviour with ZERO session-table calls. ~60s cache, last-known on a failed refresh
  (same pattern as `compareProviderPolicy.ts`). Not an env var. Turn it ON only after the deploy that ships this is live.
- Claim (interactive `/generate` only, right after the in-memory claim): one conditional `UpdateItem`
  (`attribute_exists(sessionId) AND (attribute_not_exists(activeRun) OR activeRun.heartbeatAt < :staleBefore OR
  activeRun.runId = :me OR activeRun.instanceId = :instanceId)`). Condition lost => release lock/owner and answer
  409 `SESSION_BUSY` (same body as the in-memory busy path). Any other error => log and proceed (fail-open).
  The `instanceId` clause (not in the original design) lets the same process re-claim: its in-memory lock already
  proved the earlier run there ended (Stop then an immediate resend before the old run's clear landed).
- Beat: every 30s `SET activeRun.heartbeatAt` conditional on our `runId`; a failed or lost beat is only logged.
  Timer is `unref`'d and cleared synchronously in the existing `finally` (success, throw, timeout, stop, 429, crash path).
- Clear: `REMOVE activeRun` conditional on our `runId` in the same `finally`, best-effort (never clears a newer run).
- Staleness 90s (3 beats). Writes never touch `updatedAt` / `adminListPartition`.
- Reads: `GET /session/:id` `isGenerating` = in-memory OR (fresh activeRun of ANOTHER instance AND genuine owner view),
  no extra read. `GET /generating?sessionId=<id>` (optional; owner only, not delegates) adds that one session via one
  record-only `getChatSessionRecord`; without the param it is unchanged.
- `activeRun` is never serialised: every ChatbotDB session read makes it non-enumerable (invisible to spread / JSON /
  lists / exports / share / admin views), and the owner view and MCP tools also omit it explicitly.
- Whole-item overwrites (`put`) of a session: only `createChatSession` (a new item) and the dev/test scripts
  `copy-session-to-dev.ts` / `seed-imageresume-testenv.ts`. A dropped attribute only means a missed guard.
- Out of scope (phase 1): conversable-share generate and system paths (scheduled / Slack / email / verified-generate).
- Rollback: set the switch to anything but `'true'`; leftover attributes go stale harmlessly.

Switch read is bounded: the (at most once per ~60s) AW-Settings read that /generate awaits is raced against a 2s
timeout (`SETTING_READ_TIMEOUT_MS`); a hung read behaves like a failed refresh (last-known value, off if none, one log
line, retry in 5s) and never stalls the core path.

Accepted tradeoffs (phase 1):
- A >90s event-loop / GC stall of the running instance makes a live run look dead, so a Resend elsewhere is allowed; the
  stalled run's later beat then only logs `lostClaim` and the two runs can overlap.
- After a crash / SIGKILL, Resend on the new instance gets 409 and `isGenerating` stays true for up to 90s (until the
  heartbeat goes stale).
- Out of scope: the conversable / ishare generate path and the GET /session media-continuation durability backstop.
- A malformed existing `activeRun` (e.g. a non-numeric `heartbeatAt`) would stay busy; nothing in the codebase writes one,
  and handling it would need `NOT attribute_type(...)` in the claim condition, which is not worth the complexity.

## ENG-0000: Opslane agent findings fixes (2026-10-13)

Five bugs from Opslane's simulated-user run against `8eac4e0a5`, each reproduced with a failing test on current main before the fix.

- **Schedule timezone.** `manage_scheduled_chat` now takes `timezone` (IANA). An offset-less `next_run_time` is read as wall-clock time in that zone (create) or the schedule's stored zone (update); with no zone it is rejected instead of being silently read as UTC (9am New York had been stored as 09:00Z). Logic in `backend/src/utils/scheduleRunTime.ts`. Create/update responses echo `nextRunTimeLocal` + `timezone` so Emma repeats what was stored.
- **Email opt-out.** The tool maps an explicit `email_notifications: []` to `emailNotificationsOptOut: true`; the controller then stores no recipients on create and allows clearing on update. A bare REST `[]` without the flag keeps the requester-email fallback, because the customer portal sends `[]` for "not set". Responses echo the stored `emailNotifications`.
- **Lead notification types.** `update_lead_notification_settings.leadTypes` is optional; omitted keeps the stored selection, so "off" then "on" no longer wipes it. An empty argument set is still rejected.
- **In-turn nudges.** Consecutive-repeat anti-loop, sliding-window loop, step-budget and time-budget nudges are pushed as `role: 'system'` (ENG-763 precedent). The repeat nudge fires once per turn. `isPersistedResponseMessage` (incrementalPersist.ts) now excludes system messages from checkpoint/final persistence and error-path usage. Before this, the workplan-recovery system nudge was being persisted too. `CONTINUE_PROMPT` / `SYNTHESIS_NUDGE` deliberately stay user-role: they are continuation prompts, and Gemini needs a trailing user turn.
- **Persisted reply.** After every content rewrite, the loop reconciles once: an empty final answer becomes `EMPTY_FINAL_RESPONSE_FALLBACK`, and the last unflushed assistant text message is set to the returned content. When the last persisted message is a tool or tool-call turn (step cap), a fresh assistant message is appended instead.

## ENG-527: Product-feedback filing is never token-limited (2026-10-13)

- New `services/productFeedbackFiling.ts` is the one shared filing policy (title normalization, replay guard, durable fingerprint) used by `POST /api/support/report-ui-bug` and Emma.
- `agentModeController.generateResponse`: when over quota and the request carries `feedbackIntent: 'bug' | 'feature_request'`, the message is filed deterministically (zero LLM calls) and the tracked link returned; failures answer 502/503 `feedback_filing_failed` and never claim tracking. Ordinary over-quota generation keeps its 429.
- Follow-up: the customer portal must send `feedbackIntent` from a Report bug / Request feature affordance.

## ENG-273: WhatsApp STOP moves the customer to no platform (2026-10-13)

- **ENG-273: STOP now moves the customer to "no platform", automatically.** Until now a customer who texted STOP stayed marked as being on WhatsApp: Slack stayed suppressed, every approval failed against the opt-out (502) and the agent engine held their task output until an admin disconnected them by hand. The webhook now, after recording the opt-out, resolves the account that holds the number and disconnects it (`disconnectWhatsAppForNumber`): number unbound, verification rows cleared, opt-out row left in place so the number stays blocked until START. It runs before the confirmation message and a storage error answers 500 so Meta redelivers (everything is idempotent). **Consequence to be aware of:** with no platform, an approval-required task has no channel to ask on, so the engine treats it as `no_channel` and releases that task's output to its subscribers unreviewed (the same as a customer who never connected anything). START clears the opt-out only; the customer reconnects from Settings (new consent). The STOP and START confirmation texts changed to say so, and need Harsha's wording review. Not covered: a number verified before the phone→user index existed cannot be resolved from the number alone (none exist in production: 0 of 489 users have a messaging channel).
- **STOP follow-ups (same PR).** (1) The owner is emailed: WhatsApp was removed, approvals are off, how to undo it. (2) Approvals still waiting on WhatsApp when STOP arrives are cancelled as a system rejection (`reviewedBy: system:whatsapp-stop`), because nobody can answer them any more and the held results would otherwise wait for ever with no record; the results they hold are NOT sent, and the owner is told. Older Slack-era approvals are left alone. A tap from a number that is no longer connected now gets a reply instead of silence. (3) An approval that cannot be delivered (502) or a failed delivery receipt for an approval message emails the owner, at most once a day. (4) The account record carries `whatsappDisconnect {reason: stop|customer|admin, at, last4}` (additive, display only, cleared on a successful verification) and the admin Users list shows it ("Not connected (WhatsApp: customer texted STOP, 12/10/2026)"), plus a red "texted STOP, disconnect it" note for an account still bound to an opted-out number. (5) A code typed while the number was opted out is remembered (`whatsapp:verify-optedout:<phone>`); START finishes the connection and replies "You're connected", so the customer does not type the code twice. (6) A STOP from a number no account can be found for is logged as a warning. Items already covered and not changed: lead alerts email first and ship notifications are additive to email, so an account with no platform still hears by email.
- **Decision recorded:** cancelling pending approvals marks them rejected rather than approving or releasing the held results. Releasing would email possibly-unreviewed work to subscribers because of one message; the safe failure is to withhold and say so. New tasks for an account with no platform still follow the existing no-channel rule (released), which is the earlier product decision.
- **Review corrections (2026-10-13):** approvals are cancelled BEFORE the number is unbound and a failure throws, so a redelivered STOP can still find the account (once unbound it cannot); only `pending` approvals are cancelled (a `needs_changes` one may have a revision in flight), and every page of the index is read, not just the newest 200; a replacement number's waiting code is no longer wiped by the old number's STOP; START keeps its "waiting code" pointer until the connection has been attempted (a storage error no longer abandons it) and also resumes a first attempt that failed part-way (`claimed`); when START answers the customer itself (connected, or told why not) the generic opt-in text is not sent as well; the "we couldn't reach you" email is sent only while that approval is still pending, and gives back the day's slot if the email fails. Known and accepted: a crash between the disconnect and the owner email loses the email (the account marker still records why); a redelivered STOP after a successful disconnect cannot find the account, so it logs a warning and repeats the confirmation text.

## ENG-2468: Resolve live user-owned LinkedIn account after reconnect (2026-10-13)

`resolveUserOwnedAccountId` returned the first Unipile row; a reconnect appends a new account_id, so CRM message sync/invites stayed pinned to the dead session (401 Disconnected account). Now probes and prefers a live account, then unknown, then first.

## ENG-2459: finalize guard shadow window - why 52 flags were false alarms, and what we changed (2026-10-13)

The finalize guard (`backend/src/services/agentMode/core/finalizeGuard.ts`) ran in shadow mode in prod from 2026-09-28 11:46Z to 2026-10-12 (`AGENT_FINALIZE_GUARD_SHADOW`, ENG-2150). The flag is now unset and `AGENT_FINALIZE_GUARD` was never set.

**Numbers (re-derived from raw tables, three independent passes).** 1,625 `agent_run_verdict` events, 288 `finalize_guard_shadow_judge` calls (the judge only runs when the keyword prefilter hits, about 17.7% of runs), 52 `claim_mismatch` flags in 42 sessions. The claim class behind 51 of the 52 is in the web.stdout CloudWatch log (`finalize guard SHADOW detected_mismatch ... claimClasses`): asset_generated 20, email_sent 11, schedule_created 9, task_created_or_updated 8, settings_saved 7, crm_saved 4. The event itself stores no claim or judge output.

**Result.** By the guard's own definition (a completed action in one of the 7 classes with no successful backing tool in that run), 0 of the 52 were true mismatches. Causes of the false alarms:
1. The tool-name matchers did not know real tools (`notify_session`, `add_gtm_work_items`, `update_gtm_work_item`, `create_html_*`, `create_social_media_posts`, knowledge-base writers). Replayed on real runs, the matcher change alone clears 21 of the 58 confidently-unbacked class flags; the new unbacked set is a strict subset of the old one in the 52 flagged and in 96 control runs.
2. The judge prompt never told the judge to skip negated, withheld, zero-count, drafted, quoted or historical statements, and the guard accepted any known class with no quoted statement. About 37 class flags in 29 runs remain after the matcher change and look like judge reads of negations or retold history. The new prompt is NOT measured against a live judge yet.
3. The ledger covers one invocation, so a retry nudge ("Please try again...") or a "continue" run loses the earlier run's tool calls (6 of 52). Not changed here.

**Not a guard problem but real (found by the skeptic review, verified in raw data):** a scheduled Meta Ads report labelled as an analysis of a client after every client lookup failed (numbers came from the caller's own account), and a reply that invented account history absent from its only tool result. These are groundedness failures, not completed-action claims. Tracked with ENG-2137. The offline `gradeGroundedness` grader uses the same keyword prefilter with no judge, so its "ungrounded" rate is inflated by the same noise.

**What changed.** Strict backing added only for tools whose success reliably means the action happened (`notify_session`, `add_gtm_work_items`, `update_gtm_work_item`, `post_on_connected_account`). Tools that can succeed without doing the thing are loose (ambiguous, never corrected): `send_gtm_status_report` (silent no-send), `create_html_*` / `update_html_file` / `create_social_media_posts` (an HTML document, not an image), `perform_data_analysis`, knowledge-base writers. The ledger keeps only a minimised result (`{}` for almost every tool, `extractMinimalToolResult`), so result fields like `draft` or `duplicate_suppressed` are invisible to the guard; that is why those tools are loose and not result-checked. The judge prompt now excludes negated/withheld/drafted/quoted/historical statements, requires a quoted statement, and ignores classes the lexicon did not surface. Dropped claims are counted (`discardedClaims`) and logged with a `console.warn` (session id and count only; not yet on the verdict event, so there is no metric or alert) so a judge whose output shape changes is at least visible in the logs. Class-name case and whitespace drift from the judge is tolerated. Judge `max_completion_tokens` 500 to 800 for the longer output.

**Known limits.** (A saved LinkedIn draft no longer backs a "published" claim; see the ENG-2459 draft-post note.) `create_social_media_posts` still strictly backs a "published" claim (pre-existing); Spanish and other non-English replies skip the English-only lexicon unless they contain English nouns (under-detection, not false alarms).

**Rollout.** Flags stay unset. Before any enforce use: run the live judge-accuracy script on the 52 reply texts and the labelled fixtures with the old and new prompt, then a second shadow window to re-measure precision. Enforce mode appends a visible "Correction" to customer replies, so false positives are customer-visible.

## ENG-2459: a saved LinkedIn draft no longer backs a "published" claim (2026-10-13)

`post_on_connected_account` strictly backs `post_published`, but with `save_as_draft` it also succeeds, so a reply claiming the post was
published passed the guard (the "known limit" in the ENG-2459 precision change). The ledger result for this tool is minimized to `{}`,
so a result check cannot see it; the ledger entry now also carries the call's arguments (`FinalizeLedgerEntry.args`), and both the
strict and the loose matcher skip a call with `save_as_draft: true` (or a result flagged `draft`) for `post_published`. The same applies to
`publish_blog_article`, which saves a CMS draft unless `status` is exactly `published` (the `publish_` prefix strictly backs `post_published`). A loop-level
test pins the hand-off, because unit tests that build ledger entries by hand cannot catch a missing one.

Not changed: `create_social_media_posts` still strictly backs a "published" claim although it only builds an HTML file of drafted posts
(pre-existing, listed in the precision change's known limits). Shadow/enforce behaviour and the flags are untouched; the guard is off in
prod while both flags are unset.

## ENG-2442: Meta connection alerts dedupe onto per-account canonical (2026-10-13)

raiseMetaConnectionHandoff now uses the tracking monitor token alert identity (Alert Class meta-token-invalid + Alert Scope meta-ad-account:<id>), so re-fires comment on the open per-account canonical instead of filing a new issue each tick.

## ENG-2430: Ads Auto Publisher dry-run demo (2026-10-13)

Added `backend/src/adsPublisherDemo/` (pure planner, CLI, mock `POST /v1/publish`, samples). Dry-run only; not mounted in app.ts; test asserts zero network calls.

## ENG-2379: /verified-generate keeps the user-selected model (2026-10-13)

`runVerifiedChat` swapped `session.llmModel` for the report/image/video task-type model whenever it was called without a model, which the interactive `POST /api/agent-mode/verified-generate` always was. The handler now resolves the user's model (request `llmModel`, else the stored one) and passes it, so task defaults apply only when the session has no model. An unavailable explicit pick returns the same 422 `model_unavailable` as `/generate` before any work starts; a retired stored model still falls back to the current default (stored is not explicit). Scheduled, Slack, email, revision, human-eval and result-endpoint callers are unchanged. `GET /api/agent-mode/session/:id` now sends `Cache-Control: no-store`. `/verified-generate` now also applies /generate's allowance gate (same 429 `usage_paused` body, checked before the model so an exhausted account gets 429 before 422); previously an exhausted or paused account ran through it unchecked. The chosen model is persisted only after the session lock and concurrent-cap checks pass, so a 409/429 leaves the stored model unchanged.

## ENG-2379: Compare identity check is catalog-aware; model-options serves the legacy alias map (2026-10-13)

### Identity gap closed
- `isSameServedModel` accepts a dated canonical slug for a bare id (`deepseek/deepseek-v4-flash` -> `...-20260731`) unless a REGISTERED MMDD sibling owns that date. An unregistered sibling (`deepseek-v4-flash-0731`, a different model and price) was therefore accepted if OpenRouter repointed the bare id. The daily catalog monitor only registers a new sibling after a human merge, so the window was real.
- Compare now re-checks any DATED served slug against the live OpenRouter catalog ids (`services/agentMode/openRouterCatalogIds.ts`: public `GET /api/v1/models`, 10 min cache, single-flight, 3 s timeout, stale list kept on failure, 60 s back-off). A listed sibling with the same MMDD => `model_mismatch`.
- Undated exact ids never touch the network. Catalog unreachable and no prior list => falls back to the registered-ids check (the old behaviour, never looser).
- Aliased models are unaffected: a legacy id is normalised to its current id first (`qwen3.8-max` -> `qwen3.8-max-0902`), and an MMDD-suffixed id is its own identity.
- Known conservative edge: if a bare id's own legitimate snapshot date equals a listed sibling's MMDD, Compare refuses it (fail closed).

### Alias map
- `GET /api/agent-mode/model-options` gains `legacyModelAliases: Record<string,string>`, a copy of `LEGACY_MODEL_ALIASES` (the map `normalizeModelId`/`resolveGenerationModel` use). Additive; old portals ignore it. Portal feature-detects it and can drop its hand-copied `LEGACY_MODEL_ALIAS_IDS`.

### Tests
- modelCompare.routes (real matcher, mocked catalog), openRouterCatalogIds, agentModeController.scheduledModelStamp (model-options).

### Review follow-ups
- Catalog/registry sibling ids are normalised before comparison (`:free`/`:nitro` suffix, trailing `/`, `openrouter/` prefix, case).
- Catalog list is stale-while-revalidate: an expired list is served at once and refreshed once in the background; only a cold start waits (<= 3 s). Timeout uses AbortController so it is testable.
- Tests pin: last-good list kept on empty/non-OK/failed refresh, abort at timeout, non-OK body ignored.

## ENG-2171: HubSpot batched push now updates by stored contact id instead of orphaning it (2026-10-13)

**Bug.** `pushLeadsBatched` split leads on email alone, upserted by email and overwrote `syncMetadata.hubspot_contact_id` at Stage 3. A lead first pushed without an email (contact A) and later given one produced contact B and orphaned A. #3026 fixed this only in `pushLeadsPerLead`, but `batchEnabled()` defaults true (the env var is set nowhere), so email leads never reach that path. `autoSyncLead` (the real-time `/forward-lead` sync) also takes the batched path.

**Fix** (`hubspotAdapter.ts`, Stage 1.5): an email lead with a stored id (`syncMetadata.hubspot_contact_id`, or `customFields.hubspot_contact_id` as the per-lead path reads) is updated by id through `batchUpdateContacts`, with the email in the properties, so A gains the address in place. This changes the NORMAL re-push path for every previously synced email lead, not only phone-only ones. A side effect is that an email edited in Emma now updates the contact instead of creating a second one.

**Failure rules** (HubSpot documents none of these for contact batch update, so unknowns fail closed):
- "Gone" = 404/410, or a 207 whose every error category matches `NOT_FOUND`. Only then does the lead fall back to upsert-by-email (new id replaces the stale one), as the per-lead path does.
- Anything else (409 collision, 400, other 207, merged id) is a lead error: `sync_failed`, stored id kept, nothing created.
- 429 / 423 / 502 / 503 / 504 / no response fail the chunk once; they are not bisected. A bare 500 is bisected, so one poison record fails alone.
- Duplicate stored ids with the SAME email collapse to one input. A lead that shares a stored id with a DIFFERENT email upserts by its own email (the pre-fix behaviour) rather than being reported synced on another lead's data. A lead with no stored id that shares an email with an updated stored-id lead adopts that contact (no read-after-write on an email just written).

**Known stuck state: the lead's new email already belongs to a DIFFERENT HubSpot contact.** A phone-only lead (contact A) gains `bob@x.com`, and the customer already has a separate contact B with that address. Before this change the push upserted B and orphaned A; now it tries to put the email on A, HubSpot is expected to refuse (undocumented; probably a 409), and the lead is `sync_failed` on every push with its stored id kept, until someone merges A and B in HubSpot or clears the stored id. This is deliberate (adopting B would silently reintroduce the orphan) but it is a per-lead stuck state, and the kill switch is global, not per lead. The raw status and error categories of every unclassified failure are logged (`not classified as gone`) so the real HubSpot values can be learned.

**Kill switch.** `HUBSPOT_PUSH_BY_STORED_ID=off` (case- and whitespace-insensitive) restores upsert-by-email for every email lead. It is an Elastic Beanstalk env var, so changing it needs a restart.

**Not live-verified.** The only connected HubSpot credential was dead (401, last pull 2026-06-16) and no `[HubspotAdapter]` line appeared in the production log for 7 days, so there was no HubSpot to test against. HubSpot's docs are silent on: the missing-id and archived-id response, batch-update atomicity, duplicate ids in one batch, the email-collision status, merged-away ids, and read-after-write for upsert-by-email. The `OBJECT_NOT_FOUND` category does not appear in the docs at all (the existing deal handler matches it too). If the "gone" classifier is wrong, a deleted-contact lead shows `sync_failed` and stays stuck; it does not duplicate. A merged-away id has the same effect. HubSpot's `contact.merge` webhook (`primaryObjectId`, `mergedObjectIds`) is documented but not handled by `crmWebhook.ts` or `webhooks.ts`.

`HUBSPOT_BATCH_PUSH_ENABLED` is left in place; deleting it is a later change.

## ENG-2143: Feed live Google Ads campaign delivery into the zero-delivery health check (2026-10-13)

- `googleAdsService.getCampaignDelivery` (read-only GAQL: status, budget, start/end, 7-day impressions/clicks, recent `change_event`s) now feeds `accountHealthClassifierCron` `signals.campaigns`, which was hard-coded `null`.
- Go-live is the later of `campaign.start_date_time` and the latest campaign `change_event` in the 7-day window (the API has no "enabled since" field), so a re-enabled campaign gets a fresh 24h grace. A passed `campaign.end_date_time` reports `ENDED`, which the classifier excludes. Account-timezone date-times are read as UTC and skewed toward abstaining.
- A failed/truncated read (including 429, no retry) stays unread (`null`), never zero delivery; one failing Google account leaves that user unread. No schema/data-plane change; Meta campaigns remain unread; no flag changes.
- `--dry-run` of the cron still makes live (read-only) Google Ads calls and consumes API quota.

## ENG-2138: Shadow-judge reliability (2026-10-13)

- The daily sampler (`shadowJudgeSamplerCron.ts`) now retries each session whose scoring threw once, after the main loop. Result and log line gain `retried` and `recovered`; a session that fails twice counts once in `errors`. Session-load failures are not retried.
- `extractJsonObject` returns the first balanced top-level `{...}` (string-aware), so trailing prose or a second object no longer breaks the parse. A never-balanced reply keeps the old first-`{`-to-last-`}` slice and fails as before.
- Shadow scores now store `promptVersion` (first 12 hex of sha256 of the judge system prompt). Scores written before this change have no `promptVersion`; non-shadow judges never get it.
- `evalOutcomeJudge` summary prints both "share of raw scores >= 4.95" and "share of scores that round to 5"; `shareAt5` is unchanged and `shareRoundingTo5` is new.
- Known limits: timeouts are still the only guard against slow judge calls (constants untouched); a failed attempt that reached the model has already spent its cost; rows scored before 2026-10-13 cannot be attributed to a prompt.

## ENG-2138: the shadow outcome judge keeps its one-decimal score (2026-10-13)

`scoreSessionWithJudge` rounded every judge score to a whole number. The original ENG-1710 rubric B asks for a one-decimal
score and was measured on those decimals (a 5 counted at >= 4.95). On the ENG-1710 corpus, with the labels rebuilt in ENG-2410
(comments on ENG-2138, 2026-10-12), the cached scores read AUC 0.76 / 3.4% at 5 raw and AUC 0.72 / 46% at 5 once rounded, so
no integer-scale replay (ENG-2356, ENG-2380, the prod shadow scores) could meet the "< 15% at 5" bar. The committed
reconstructed-3 rubric asks for whole numbers, so this change does nothing to it; it matters once a decimal rubric is the
shadow judge's prompt.

- A shadow judge now stores `Math.round(score * 10) / 10`, clamped to 1-5. Customer-facing judges still store whole numbers.
- `scripts/evalOutcomeJudge.ts` counts a 5 as a score of at least 4.95, matching ENG-1710.
- The fabrication and awaiting-reply guards only use `min`/`max`, so they work on decimals.
- Readers of `judgeScores[outcome-judge-b-shadow]` (`evalAgentGraders`, `runValidation`, the MCP session tool) use the
  `dimensions` or pass the object through; none assumes an integer `score`.
- Existing stored shadow scores are whole numbers and stay as they are; no data is rewritten.

## ENG-2135: golden-set label coverage report and safer draft-tool invocation (2026-10-13)

Golden-set labels must come from a human; nothing here generates, suggests or writes a label.

- `npm run eval:label-coverage` (backend) prints, per surface and split, total cases, cases with at least one binary human label, per-criterion pass/fail/na/unlabelled and the n available for validation (pass + fail on the test split, as `runValidation` drops `na`) against `MIN_VALIDATION_N`. It prints "cannot reach n>=30 on the test split: has N" when the split is smaller than the minimum. Pairwise creative cases are reported separately. Aggregates only; read-only through `listCases`; no grader or LLM; refuses when `EVAL_GOLDEN_CASES_TABLE` is unset. A human runs it with the table env var set.
- `npm run eval:draft-labels -- [flags]` runs `generateGoldenDraftLabels.ts`, unchanged in model, prompt and write semantics. It now prints a preflight (table, surface, cases it would draft, model); a non-dry run needs `--yes` or it exits 1 before any LLM call or write. `--dry-run` still calls the LLM but prints only criterion=label, never rationale text. A human runs it; never against the prod table from an agent session.
- Data fact: as seeded, agent has 29 test-split cases and account_health has 22, so neither can reach n>=30 however fully labelled. creative_image has 32. Whether to reseed or change the split fraction or threshold is the owner's decision; this change alters none of it.

## ENG-2116: Owner-directed agent merges for Argusoft PRs (2026-10-13)

merge-evidence.sh lifts FOREIGN_OWNER when MERGE_EVIDENCE_DIRECTING_LOGIN equals the PR author; CI evidence still decides. Approved by Harsha.

## ENG-1656: manage_scheduled_chat field-named preflight validation (2026-10-13)

- `manage_scheduled_chat` now validates before any API call: create's three required fields, `schedule_id` for update/toggle/delete (previously hit `/scheduled-chats/undefined` and returned a misleading "not found"), toggle `status`, non-empty `email_notifications`, ISO `next_run_time`. Errors name the field.
- `timezone` added to the tool schema and forwarded on create/update (the route already accepted it).
- Agent Mode error guidance covers the preflight message plus nextRunTime/timezone/status rejections.
- Tests: `mcp.manageScheduledChatPreflight.test.ts` (mocked; no live schedules).

## ENG-1607: twitter_manage_post typed auth vs handler errors (2026-10-13)

twitter_manage_post failures now carry `error_type` (auth_required/rate_limited/validation/credits_exhausted/api) + `retryable`; 401/403/no-account are non-retryable auth_required with a reconnect step. Input validation errors are typed; JSON-string/single-string `tweets`/`tweet_ids` are coerced instead of failing. Tests: backend/src/__tests__/emma/twitterManagePostErrors.test.ts.

## ENG-1539: create_google_doc typed error classification (2026-10-13)

createGoogleDoc now returns `error_type` (auth_expired/permission/not_found/validation/api/internal). 401/invalid_grant/missing connection map to a reconnect hint instead of misleading folder_id advice on root-Drive calls. Regression test: backend/src/__tests__/emma/createGoogleDocErrors.test.ts.

## ENG-110: One source for the "generating" signals: /generating and isGenerating (2026-10-13)

### Problem
`GET /api/agent-mode/generating` was built from the per-user concurrent-generation cap map intersected with the session lock, while `isGenerating` on `GET /session/:id` is the lock alone. Auto-continuation runs (media / work-plan) hold the session lock WITHOUT a cap slot, so for them `isGenerating` was true but `/generating` omitted the session. The portal's reload reconcile polls `/generating` and treats absence as "not running", which could show the "response wasn't received / Resend" banner while a continuation run was live.

### Fix
- The lock claim records its owner: `tryClaimSessionGeneration(sessionId, ownerUserId?)` writes `sessionGenerationOwners` (in-memory Map) in the same synchronous step; `releaseSessionGeneration` deletes it. Every claim site already releases in a `finally`, so nothing can outlive the lock. No storage.
- `/generating` = the caller's sessions among the claimed locks (`getClaimedSessionIdsForUser`); `isGenerating` = lock held and owner === caller (`isSessionGeneratingForUser`).
- Owner is passed at every claim site: /generate, public/conversable generate, runVerifiedChat (scheduled, Slack, email, /verified-generate, result endpoint, revision, human eval) via `claimSessionGenerationWithRetry`, media + work-plan auto-continuation, preempt re-claim, approval-inbox resume, chat branching, model compare select.
- Safe fallback: a lock claimed with no owner is not invisible. `/generating` falls back to the caller's cap slot for it, and `isGenerating` stays lock-based (true for the session's own viewer).
- Owner record is the session OWNER (not an admin acting on the session), so the customer's portal sees admin-driven runs. Other users, admins, delegates and share views are never shown the flag or others' ids.

### ACCEPTED risk: deploy overlap
During an Immutable deploy the old instance can still run a chat while the new instance reports nothing (locks are per instance; AW-AgentRuns / AGENT_RUN_STORE is not provisioned and is owned by ENG-784). A Resend in that window could start a second generation. Narrow window, bounded by the 10-minute drain ceiling. Accepted; not fixed here.

### Tests
agentModeController.generatingConsistency, agentModeRoutes.generatingConsistency, and a real media-continuation case in agentModeController.autoMediaContinuation. Mutations that must fail: drop owner record on claim, never delete on release, expose other users' ids.

### Rollback
Revert the PR. No data, no schema, no config.

## ENG-2425: SSRF-guard load-from-url endpoints (2026-10-12)

/api/crm/sequences/load-from-url and /api/admin/announcements/load-from-url now fetch via ssrfGuard.fetchPublicHtml (DNS-pinned, per-hop redirect re-validation, 5MB cap, 15s total timeout); private/loopback/link-local targets return 400.

## ENG-2413: Scope /api/slack/send-approval to caller-entitled channels (2026-10-12)

POST /api/slack/send-approval now 400s a non-string channel and 403s non-admin callers targeting a channel outside getEffectiveAllowedChannels, before any Slack post or approvalDb write (ENG-2407 pattern).

## ENG-2408: Scope character reference image keys to caller's S3 prefix (2026-10-12)

POST /api/characters rejects referenceImageKey outside `users/{userId}/files/`; DELETE only removes S3 objects under the caller's prefix (row still deleted). No schema change.

## ENG-2407: batch-review create restricted to caller-entitled Slack channels (2026-10-12)

POST /api/batch-review/create now 403s unless the channel is in the caller user/org configured Slack channels (getEffectiveAllowedChannels) or the caller is a real admin; check runs before any DB write or Slack post.

## ENG-2402: Workflow run/rerun ownership checks (2026-10-12)

`POST /api/workflows/:id/run` now 403s non-owners and referenced tasks not owned by the caller (400 if missing); task rerun 403s non-owners and 404s when the execution belongs to another workflow. Removed the dead, unrouted `runWorkflow` controller so one run path remains.

## ENG-2338: Luma sign-in cannot be automated from our infrastructure; use the Luma API instead (2026-10-12)

- Prod session bf7f3c5f: first-ever Luma login (the user's cookie jar held only anonymous Luma cookies, no `luma.auth-session-key`) was stopped by the "Verifying Your Browser" gate, which never cleared.
- Reproduced from the autofix box with the production launch args + stealth script, then headless/headed (Xvfb) x spoofed/native user agent: all four variants show the gate after "Continue with Email" and none reach the code step in 90s. It is not the headless flag, the user-agent spoof or the stealth script; the likely cause is datacenter-IP reputation (untested — no alternate egress available).
- Fix: Luma calendar API key as a connected account (`platform: 'luma'`, `POST /api/oauth/luma/connect`). Tools `luma_list_events` / `luma_get_guests` call `public-api.luma.com` (header `x-luma-api-key`; 200 req/min per calendar; Luma Plus required; keys are per-calendar). The key is encrypted at rest with `encryptPassword(key, userId)` inside `config.access_token`.
- The guest list is read newest-registration-first with `sort_column=registered_at&sort_direction=desc nulls last`; entries with no `registered_at` are invited-never-registered and are dropped. A page is never split, so `next_cursor` resumes exactly; de-duplicate on `guest_id`.
- Without a key the tools say so and the agent keeps the existing browser/session-cookie fallback.

## ENG-2303: Zoma Meta Toolkit — OAuth discovery, onboarding, guarded writes (2026-10-12)

- `/api/meta-toolkit/mcp` now answers unauthenticated `initialize` with 401 + RFC 9728
  `resource_metadata` pointing at `/.well-known/oauth-protected-resource/api/meta-toolkit/mcp`.
  MCP clients reject protected-resource metadata whose `resource` differs from the URL they
  connected to, which is why the old `/mcp`-only document never started OAuth.
- A setup-mode Stripe Checkout completion used to be handled as a subscription purchase
  (`handleCheckoutSessionCompleted` defaults `subscription_status: 'active'`). It is now
  acknowledged with no side effects; `zoma_status` uses setup mode for "add a payment method".
- The ENG-400 objective gate needs an Emma transcript or approval deck; the toolkit has
  neither, and a sessionless call used to auto-provision a chat session. The toolkit preview
  (`previewToolkitMetaWrite`) swaps in an explicit-objective gate and never creates sessions.
- Guarded-write replay protection is per-process (no durable claim store — that would be new
  persistence). Worst case cross-instance within 15 min: a duplicate PAUSED create.
- `evaluateMetaSpendCeiling` had no caller; the toolkit write path now calls it with an
  optional env policy (`META_TOOLKIT_SPEND_CEILING`). Per-account ceilings need a policy store.

## ENG-2263: a "continue" after a REAL time-limit partial no longer logs a false total (2026-10-12)

A preview run with AGENT_MODE_GENERATION_TIMEOUT_MS=25000 showed that a real time-limit partial (`kind: generation-timeout-continuation`) persists neither
`toolCalls` nor `crmEvidence`, although CRM tools ran in that turn. The next "continue" restated the totals the timed-out turn had fetched and the log-only
detector flagged them (`continuation:false`, `echoesEarlier:0`). The earlier note's claim that these partials are credited was only true for messages that carry
evidence. `crmEvidenceFromEarlierInvocations` now treats an earlier timeout message WITHOUT persisted evidence as incomplete, so the total check abstains for that
"continue" (the tag check still runs). A timeout message that does carry evidence is still credited, and a plain follow-up after a timeout is still fully checked.
Log-only; the reply is never edited. No controller change.

## ENG-2157: lead PUT route reports/drops server-owned keys, audits suppression changes, and accepts PATCH (2026-10-12)

`PUT /api/crm/lists/:listId/leads/:leadId` handed its whole body to `crmDb.updateLead` (~50 keys). Verified live on the preview that an editor could set or clear `lastAutoSendAt`,
forge `syncMetadata.hubspot_contact_id`, `system`, `firstTouch`/`utmSource`/`clickIds`, pass the internal write flags (`customFieldsKeyMerge`, `skipFieldNamesUpdate`), and
forge who/when changed a suppression (`contactStatusUpdatedBy/At`, honoured whenever `contactStatus` is in the body). No customer-portal code sends any of those, and Emma's own `update_lead` filters to
11 fields. The MCP `lead.update` action forwards its body verbatim, so real usage there is unknown.

- `CRM_LEAD_PUT_GUARD=log|enforce|off`, default **log**: reports which server-owned keys arrive (key names, channel, user id; never values) as `[crm-lead-put-guard] {json}` and changes nothing.
  `enforce` drops them and stamps `contactStatusUpdatedBy` with the authenticated user. Read the log for a week before flipping it; MCP usage is the unknown.
  `aws logs filter-log-events --log-group-name <web.stdout.log group> --filter-pattern '"crm-lead-put-guard"'`
- Do-not-contact / unsubscribe keys are NOT dropped (the portal's Mark DNC, Remove and Resubscribe buttons write them here). A real change to `contactStatus` or `unsubscribedFromGroupEmail` now appends a
  `contact_status.changed` engagement with the authenticated actor (and the delegating admin), a server timestamp and fixed vocabulary only (an unvalidated client string never reaches the event: the
  engagement layer raises `isEngaged` on the words clicked/replied/received). It never blocks or fails the write. `CRM_CONTACT_STATUS_AUDIT=off` disables it.
  The event data is FLAT strings/booleans (`fromStatus`, `toStatus`, `fromGroupEmailUnsubscribed`, `toGroupEmailUnsubscribed`, `reason`, `actorUserId`, `delegatedByUserId`, `channel`, `via`, `note`): the portal's
  Engagements dialog (CRM.tsx) renders `eventData.from` / `eventData.to` as React children for every event type, so an object there would crash it. That dialog is currently unreachable (no caller since engagements moved into the lead drawer), so this is defensive, not a live crash; a test pins the flat shape.
  The trail is best-effort and PARTIAL: it records changes made through this route only (not bulk-contact-status, Emma's update_lead, the public unsubscribe, webhooks or the bounce cron), and the before-state is read
  before the write with no compare-and-swap, so two concurrent changes can both record the same `from`.
- `PATCH` on the same path now runs the same handler. The portal's deal editor (`DealSection`) has always sent PATCH here; the route did not exist, the fetch swallowed the 404, and deal edits vanished on reload.
  Note: DealSection sends the WHOLE `customFields` map built from its local state, so a deal edit rewrites the map (no key-merge) and can overwrite keys written since the page loaded (enrichment, Emma). The drawer's
  `patchCustomField` already does the same through PUT, so this is not a new class of risk, but PATCH newly exposes it to the deal editor. An object-valued `deal` also registers a `deal` name in the list's field names.
  In `enforce` mode `contactStatusUpdatedBy` is stamped with the authenticated user whenever `contactStatus` is present and not null (updateLead then writes the actor/time pair for any value).

Not changed: clearing a suppression is still allowed (product behaviour). Enforcing a compliance-field allowlist needs a dedicated single-lead endpoint and a customer-portal change (separate repo).

## ENG-113: Compare models keeps the unchosen answers (multiverse view) behind compare_save_alternatives (2026-10-12)

Before: "Continue with this answer" appends ONE user+assistant pair and the other columns are lost, so a user could
never revisit the possible outcomes or branch from a different one.

Now, with AW-Settings `compare_save_alternatives` = exactly `true` (absent / any other value / cold-start read failure
= off = old behaviour; 60s cache, last-known value on a failed refresh, `services/agentMode/compareSaveAlternatives.ts`):

- `POST /compare` also returns `alternativesToken`, an HMAC (same key derivation as the select token, with a `kind`
  tag so the two are not interchangeable) over `{userId, sessionId, compareId, prompt, issuedAt}` and the sorted SET of
  `{model, sha256(content)}` of EVERY ok column. The switch is not part of it; it is issued whenever >= 2 columns are ok.
- `POST /compare/select` accepts optional `alternatives:[{model,content,latencyMs?}]` + `alternativesToken`. When the
  switch is on and the token verifies (constant time) over the alternatives PLUS the chosen answer (so the set is exactly
  the ok columns the server produced: nothing added, edited, dropped or re-attributed; models distinct; max 3; each
  content <= 200k chars), the assistant row the select already appends gets `metadata.compareId` and
  `metadata.compareAlternatives:[{model,name,provider,content,latencyMs}]`. name/provider come from the server registry
  (`getModelCompareInfo`), never the client; latencyMs is clamped display data. Any failure => alternatives ignored,
  logged (reason only), select still succeeds for the chosen answer. Replay returns the existing pair and never rewrites;
  409 `compare_already_selected` unchanged; select makes no model call, so usage/cost are unchanged.
- Size (fail closed): the serialized alternatives array must be <= 120,000 UTF-8 bytes AND the whole assistant row must
  be <= 341,808 bytes (`MAX_MESSAGE_CONTENT_SIZE` 350,000 minus 8,192 headroom, `COMPARE_ROW_CAP_BYTES`). The headroom exists
  because a later like/dislike/edit re-runs `shrinkMessageForPersistence`, which truncates the chosen ANSWER before it
  drops metadata; a row accepted right at 350,000 lost answer characters after a feedback write. A row accepted this way
  is returned untouched by the guard, now and after a feedback write (both tested). Otherwise NONE are stored (never a partial set)
  and the row gets `metadata.compareAlternativesOmitted:'size'`; if even the marker would not fit under the cap the
  message is stored exactly as today (the chosen answer is never put at risk for a marker). Bytes are measured as
  JSON-escaped UTF-8 (CJK/emoji/control chars), not characters.
- Exposure: `filterMessagesForClient({omitBranchOrigin:true})` (share/ishare `getSharedConversation`, `getConversableSession`)
  now also drops `compareAlternatives` by the same mechanism as `branchOrigin`. The MCP admin transcript and the
  summarizer/judge/replay inputs build `{role, content}` from an explicit field list, so they cannot carry it; a tripwire
  test fails if any file outside a 5-file allowlist mentions the key.
- LLM context: `isReplayableTurn`/`buildCompareMessages` and `buildMarketingContext` read only role/content/flags; tests
  prove the built context is identical with and without alternatives (hostile alternative text included).
- Branching: copied rows lose `compareAlternatives`/`compareId`/`compareAlternativesOmitted`. New optional request field
  `alternativeModel` ("Branch with this answer"): the target must be an assistant message whose
  `compareAlternatives` contains that model (400 `no_saved_alternatives` / `alternative_not_found` otherwise); the
  branch copies rows 0..N-1 (generic strip) and row N with `content` and `llm` replaced by the alternative's,
  `metadata.branchedFromAlternative:{model}`, alternatives removed; the new session's model is the alternative's
  (resolved as an explicit choice through the usual entitlement/usage policy). `llmModel` must equal
  `alternativeModel` when both are sent. The idempotency scope appends `alternativeModel` only when present, so existing
  scopes are byte-identical.
- Capability hint: `compareSaveAlternatives` (boolean) on `GET /api/agent-mode/model-options`, next to `chatBranchingEnabled`.

Storage: owner-approved additive free-form `metadata` keys; no schema/index/table change. Rollback: set the switch to
anything but `true`; already-saved alternatives stay on their rows (owner-only, stripped from non-owner views).

## ENG-112: Branch family link and GET /session/:id/branches (2026-10-12)

A branch used to be tied back to its source only by `metadata.branchOrigin` on its first message row, so a chat could not list its branches and the sidebar could not group them.

- New optional session attribute `branchedFrom: { sessionId, rootSessionId, messageIndex, branchedAt }`, written once when a branch is created (born archived, revealed after verification, like the rest of the branch). `sessionId` is the immediate source, `rootSessionId` is the source's root (or the source itself), so a branch of a branch stays in one family. Never copied from the source.
- `GET /api/agent-mode/sessions` and `GET /api/agent-mode/session/:id` return it for the owner. Share, conversable, ishare and MCP views do not (MCP strips it explicitly; the share serializers pick fields by name).
- New `GET /api/agent-mode/session/:sessionId/branches` (auth, owner only, same `chat_branching_enabled` flag, 404 `chat_branching_disabled` when off): the root plus every non-archived session of the same owner with that root, createdAt ascending, max 50. One paginated, projected query over the existing `UserIdIndex` (no scan, no new GSI); the walk is newest-first (`ScanIndexForward=false`, like `getUserSessions`), so a capped walk drops the OLDEST sessions, and stops after 20 pages or once a 50th match proves there are more; `truncated: true` is exact (a further match exists, or the page cap hit with index left). Cost is one indexed pass over the owner's sessions (typical user has <1000).
- Per-user lookup throttle (in memory, per instance, sliding 1 minute): AW-Settings `branch_family_max_per_minute`, default 20, `0` = unlimited, garbage = default, cached ~60s with last-known fallback. Over the limit: 429 `TOO_MANY_BRANCH_LOOKUPS`.
- Legacy branches made before this change have no `branchedFrom` (only the row-0 `branchOrigin`). They are NOT grouped: finding them would mean reading message rows for every session. No backfill. Consequence: a branch made from a LEGACY branch starts a NEW family root (its source has no `branchedFrom`).
- Reads are eventually consistent (GSI): a just-created branch may be missing from the endpoint; the portal adds it client-side.
- `UserIdIndex` projects ALL attributes, so each page reads up to 1 MB of full session rows even though the response is projected; worst case 20 pages (20 MB) per request, which is why the throttle exists.

Data plane: owner-approved additive optional attribute; no GSI, no backfill, rollback = stop writing/reading (the attribute is ignored by every other reader; existing items with it are harmless).

## ENG-110: Chats already survive a tab close / reload; add visibility so the UI can re-attach (2026-10-12)

### FACTS (paste into ENG-110 / ENG-2424)
- The premise "closing or reloading the tab cancels an in-flight /generate" is FALSE on the current stack. `POST /api/agent-mode/generate` registers `req.on('close', ...)` (agentModeController.ts, "Cancel generation immediately when the client disconnects") AFTER `express.json()` has consumed the body. On Node >= 16 the request stream is already closed then, so that listener never fires on a client abort; only `res.on('close')` and the socket do. Reproduced with a plain Express server + a client that destroys its socket mid-request on Node 20.19.2 and 22.23.3 (req 'close' never; res 'close' + socket 'close' fire; Node 14.6.0 does fire req 'close').
- Production Node is not pinned in the repo (no .nvmrc, no `engines`; CI uses 22.x; EB platform decides) but every supported EB Node (>= 18) is >= 16, so the listener is dead in production.
- Nothing else cancels: no `res.on('close')`/'aborted'/AbortSignal in the /generate path; nginx (`.platform/nginx/conf.d/agent-mode-timeout.conf`, 600s proxy timeouts) and the ALB (IdleTimeout 600, `.ebextensions/timeout.config`) only close sockets, which the handler ignores; the portal has no beforeunload/pagehide/unmount stop and aborts the fetch only in `handleStop`, which also calls `POST /session/:id/stop` (the real canceller).
- Therefore a running chat keeps running to completion and persists its reply when the tab is closed/reloaded TODAY. What was missing is visibility: after a reload the UI could not tell the chat was still running.
- The dead listener also exists in the conversable-share generate (cancel, never fires) and `/verified-generate` (sets `clientDisconnected`, never true; harmless: `res.json` on a closed socket is a no-op). The SSE GET listener (`/progress`) is a bodyless GET and does fire (verified).
- Do not "repair" these to `res.on('close')` without a product decision: it would make every reload kill the run.

### What this PR adds
- `GET /api/agent-mode/generating` (auth) returns `{ sessionIds }` for the CALLER's sessions only (cap module's per-user map intersected with the session lock Set; added on claim, removed in `finally`).
- `GET /session/:id` gains an additive owner-only `isGenerating`; admins/delegates and share views never get it.
- State is in-memory per instance: during an Immutable deploy overlap another instance's runs are invisible, and a run on the old instance dies with it (accepted). No table/attribute/index.
- No behaviour switch: nothing is changed about cancellation. A comment at the dead listener records the fact. A real-socket test (`agentModeController.generateDisconnect.socket.test.ts`) pins it: client aborts, worker is not cancelled, reply persisted once, lock + slot released, `/generating` lists the run while in flight; explicit Stop cancels.
- Cost note: an abandoned run holds its cap slot until it finishes (<= cap x 600s per user) — this is already today's behaviour.

## ENG-55: Compare no longer fails with model_mismatch for a model OpenRouter renamed (2026-10-09)

- Cause: OpenRouter dropped the bare `qwen/qwen3.8-max` id from its public catalog (only `qwen/qwen3.8-max-0902`, canonical `qwen/qwen3.8-max-20260902`, remains) but still routes the old id as an alias. Our registry kept the stale id, so Compare's strict served-model check (a base id must not accept a sibling's MMDD snapshot) refused the response: `model_mismatch`.
- Fix: registry/pricing key renamed to `openrouter/qwen/qwen3.8-max-0902`; the old id is a `LEGACY_MODEL_ALIASES` entry so existing sessions/schedules/settings keep working on the same model. The identity check is unchanged and still strict.
- Why the registry guard missed it: its snapshot comes from `/models/{id}/endpoints`, which follows aliases; it only checked parameters. It now also fails when a registry id resolves to a different id in the snapshot.
- Portal follow-up: add `'openrouter/qwen/qwen3.8-max'` to `LEGACY_MODEL_ALIAS_IDS` in `src/lib/modelUnavailable.ts`.

## ENG-273: WhatsApp approvals are interactive, and a customer is on one platform (2026-10-09)

Slack and WhatsApp are separate features and a customer connects one of them. Things learned making that true:

- **A WhatsApp-only customer could never be asked to approve anything — for approvals the agent engine creates.** Three independent Slack assumptions: `task_monitor.py` requested approval only when the task had a `slackChannel` (otherwise it logged a warning and emailed results to subscribers unapproved), `POST /api/slack/send-approval` 400'd without `channel`, and `sendApprovalRequestWithTracking` posted to Slack first and threw on failure. Approvals now go through `approvalRequestService.requestApproval` / `POST /api/approval-requests`; the engine keeps the Slack endpoint for tasks that have a channel and uses the neutral one only for tasks without. **Not covered: approvals a person starts from the customer portal.** Images, Videos and Research Reports ask the user to pick a Slack channel and call `/api/slack/send-approval`, so a WhatsApp-only customer cannot start one there; those three callers need a channel-neutral path (skip the picker and call `/api/approval-requests` when the account is on WhatsApp). **The agent engine is deployed by hand** (GCP VM, `agent-engine/deploy/RUNBOOK.md`) and has no CI. Deploy order is safe either way: an engine that runs ahead of the backend gets a 404 from the new endpoint and treats it as "no channel" (release, as before) rather than a failed send, which would hold output.
- **Meta sets a template quick-reply's `button.payload` to the button's LABEL.** An id cannot ride on a template button. A tap is attributable only through `context.id` (the wamid of the message the button sat on), so the outbound id is stored at send time (`whatsapp:approval-msg:<wamid>`, 30-day TTL). Non-template `interactive` buttons do return the `id` we set, and need no template inside the 24h window.
- **WhatsApp buttons can never be removed or disabled.** The client greys out only the tapped one, so every tap, however late, arrives as a fresh message and may come from a customer who already answered elsewhere. Idempotency has to be server-side, in the verdict write itself: `approvalDb.answerIfOpen` is one conditional update (`attribute_exists AND status IN (pending, needs_changes)`), so exactly one tap wins and only the winner emails subscribers. `approvalDb.updateApprovalStatus` is still unconditional and approving fans out subscriber email — on Slack that is masked only because `chat.update` strips the buttons.
- **`resolveDestination(user, 'slack')` falls back to the org and then the org owner.** A WhatsApp member of a Slack org would be delivered to twice. Decided in the resolver (personal verified WhatsApp suppresses the inherited org channel) instead of guarding the three routes by which the two can come to coexist.
- **There was no phone → user lookup.** Verification is code → user. The inverse row (`whatsapp:phone-user:<phone>`) is written at bind time and is a cache only: `resolveUserIdByPhone` re-checks the user record and clears a stale row. Numbers verified before this change have no row until they re-verify (none exist in production).
- **Staging cannot send email.** `nonProdEmailGuard` suppresses everything unless `NONPROD_EMAIL_ALLOWLIST` is set on the environment (it is not on `Agentweb-backend-env-1`). The guard logs the suppressed SUBJECT, so nothing sensitive belongs in a subject line.
- **Meta's January 2026 AI restriction targets "AI Providers"** distributing general-purpose assistants, not a business using AI for its own customers. Keeping Emma off WhatsApp is a product decision (the 24h window), not a platform rule.
- **Review findings worth remembering (2026-10-12).** An independent review found that the first cut of the tap handler used a separate claim row, which guarded WhatsApp taps only (portal, batch review and Slack write the same status unconditionally), never expired, and survived a re-requested approval. The fix is one conditional DynamoDB update (`approvalDb.answerIfOpen`, condition `attribute_exists AND status IN (pending, needs_changes)`). Same review: a failed WhatsApp send was reported as "no channel" (409) and the engine answered by emailing unreviewed output — it must be a different status (502 `delivery_failed`) so the engine holds. `sendEmail` never throws (it returns `'failed'`), so a `.catch` around it is dead code.
- **`requestApproval` ordering.** For a Slack customer the record is written straight after the Slack post, as before. For a WhatsApp customer it is written before the buttons go out, because buttons cannot be recalled; it is deleted again if nothing was delivered.
- **Three suites failed on main independently of this work** (`admin.gtmPlans`, `admin.crmAnalytics`, `slackLeadNotificationCompact`): ENG-1760 made `admin.ts` read a table prefix fixed at import while the tests flip `NODE_ENV` per case, and one asserted two calls in the same millisecond on a payload that embeds a timestamp. Fixed in their own commit.
- **Tests replaced on purpose**, not to bless behaviour: `leadListAlertService.whatsapp` "independently when both configured" and four `shipNotifyService.whatsapp` "peers" tests asserted the double delivery the one-platform rule forbids.
- **A failed re-request must not erase an earlier verdict (2026-10-13).** `createApproval` is a put on the asset URL, so writing the pending record ahead of a WhatsApp send replaced any earlier record, and the cleanup after a failed send then deleted it. `requestApproval` now reads the earlier record first and puts it back (`approvalDb.restoreApproval`). The neutral route also passes `typedFailures` so a failed Slack send is a 502 `delivery_failed`, not a generic 500.
- **Outside the 24h window an approval was unanswerable.** The portal only reads approval status and nothing else answers one, so the link-only template could not be acted on. A second template, `agentweb_approval_request_buttons`, carries Approve / Reject quick replies; the existing `button` tap parsing handles it. It must be approved by Meta per WABA; until then the notifier falls back on error 132001.
- **A refused verification used to look like "waiting".** `other_platform` / `number_in_use` now mark the row `refused` with the reason, and the status endpoint returns `state: 'refused'` so the portal can say why. The code stays retryable.
- **Failed delivery receipts are logged** (`[whatsapp-webhook] outbound message <wamid> FAILED to deliver (code …)`), a stable string for a log alarm. No state is changed and no window is opened by a status event.
- **360° review round (2026-10-13), fixed:** `/api/approval-requests` no longer reads a Slack `channel` from the body (it had no entitlement check, so the bot would post wherever it was pointed); the undo after a failed send deletes/restores only the record this request wrote and only while it is still pending (a concurrent request or a customer's tap is no longer clobbered); a tap's verdict write also requires the record to belong to the tapping customer; a tap whose correlation cannot be read is answered "tap again" instead of silently dropped; STOP is matched after NFKC folding and stripping punctuation/emoji/zero-width characters ("Stop 🛑", "ＳＴＯＰ"); a redelivered inbound message is claimed by id so it cannot be forwarded or greeted twice; the phone→user claim is one atomic put-if-absent taken BEFORE the user record is written, so two accounts cannot both verify one number; disconnect clears the verification pointer and code row so a used code cannot be replayed and the portal stops showing a disconnected number; the engine treats a 404 as "no channel" only when the body is Express's own "Cannot POST /api/approval-requests"; filenames are shortened by code point (no lone surrogates); the legacy send-approval route answers 403, not 500, for another account's approval; the webhook raw-body limit is 2mb.
- **Accepted, not fixed — decide consciously:** (1) *Opt-out is not a platform decision.* A customer who texts STOP stays "on WhatsApp": Slack stays suppressed and their approvals fail with 502, holding task output with no retry, until an admin disconnects the number. (2) *A send that errors after Meta accepted it* (timeout/5xx) is treated as undelivered: the record is undone, the buttons that did arrive answer "no longer available", the engine holds. (3) *Two concurrent re-requests of the same asset that both fail* can leave a pending record in place of an earlier approved one (a narrow window; the conditional undo prevents the other orderings). (4) Org members still inherit an org owner's legacy Slack channel even when the owner is on WhatsApp. (5) Users connected before approvals were added consented to ship notifications and lead alerts only (none exist in production; verified 0 of 489 users have a messaging channel).

## OPS: nginx timing log emits bare request_time for CloudWatch metric filter (2026-10-07)

- `main_timing` now ends with a bare `$request_time` as the last field (no `rt=` prefix; `$upstream_response_time` dropped because it can be `-` or a comma list) so the per-route p99 metric filter can use `$request_time` as a numeric metric value. Only `/var/log/nginx/access_timing.log` changes; `access.log` is untouched.

## ENG-2403: domain-attach writes require project ownership (2026-10-12)

- `POST /api/domains/custom` and `/subdomain` now 403 (before any Vercel call) unless the caller owns, or has org edit rights (`canUserEditLandingPage`) to, a landing page whose `vercelProjectId` matches the body. Lookup errors fail closed.
- Test: `backend/src/__tests__/routes.domains.test.ts` (ENG-2403 block).

## ENG-2400: modify_work_plan preserves work-plan data on partial/failed modifies (2026-10-11)

- Omitting `description` on an existing step no longer wipes the stored description (same contract as userInstructions/skillIds).
- Steps are deep-copied before mutation, so a failed modify never mutates the read session plan.
- A non-sequential stepCount result (e.g. removing step 2 of 3 without renumbering) now returns an actionable "renumber the remaining steps" message instead of the generic "Failed to modify work plan". The store already rejects it before writing.
- Test: `backend/src/__tests__/modifyWorkPlan.preservation.test.ts`.

## ENG-2399: modify_work_plan schema/handler argument parity (2026-10-11)

- `modify_work_plan` schema and handler validation now share `MODIFY_WORK_PLAN_INPUT_SCHEMA` (backend/src/emma/impl/modifyWorkPlanArgs.ts). `steps` is optional (remove-only / autocomplete-only calls valid), step numbers are positive integers, and rejections return `{errorClass: invalid_args, field, expected}`. No persistence changes.

## ENG-2398: Google Ads read-back for remaining mutation paths (2026-10-11)

updateBudget/updateAdGroup/updateKeyword/updateAd verify requested fields by read-back; all removes (budget, campaign, criterion, ad group, keyword, ad, conversion action) verify REMOVED-or-gone. Mismatch throws GoogleAdsReadBackError (unsupported_field) -> tool success:false. Coverage test enumerates mutation methods; pattern doc docs/ad-api-read-back-pattern.md.

## ENG-1608: save_file structured handler errors (2026-10-11)

save_file validates file_name/file_content before any storage write and returns `error_code` (MISSING_FILE_NAME, INVALID_FILE_NAME, MISSING_FILE_CONTENT, INVALID_FILE_CONTENT, EMPTY_FILE_CONTENT, FILE_TOO_LARGE, STORAGE_WRITE_FAILED) plus an actionable message. Success payload unchanged.

## ENG-1535: typed generate_image provider failures (2026-10-11)

- `classifyImageProviderError` maps image-provider failures to transient/rate_limited/quota_exceeded/policy/config/invalid_args; `generateImage` returns `errorClass` + an actionable message, and agent-mode `generate_image` forwards it.

## ENG-1888: create_html_from_template structured TEMPLATE_NOT_FOUND error (2026-10-11)

Missing template_id now returns error_code TEMPLATE_NOT_FOUND, missing_template_id, and available_templates (cap 25); tool description requires list_html_templates first.

## ENG-2396: Agent Mode image-revision post-merge verifier (2026-10-10)

`backend/scripts/verify-agent-mode-revision.mjs` drives revisionService image revision end to end via
batch-review (create -> needs_changes -> poll readback) on a verifier-owned fixture only: QA account
(`qa-*@agentweb.pro`), a QA-owned Agent Mode session (`VERIFY_SESSION_ID`), a QA-generated source image
(`VERIFY_SOURCE_IMAGE_URL`), and an internal QA Slack channel (`VERIFY_SLACK_CHANNEL`). One revision
(one image-provider call) per run. Offline test: `node --test backend/scripts/verify-agent-mode-revision.test.mjs`.
Negative confirmation-gate classification stays covered by `revisionService.confirmGate.test.ts`.
Approval-state checks retry until the deadline (the new asset lands before the source approval
updates). The new asset's `pending` status is a status check only: GET /batch-review defaults a missing
approval row to pending, so it cannot prove row persistence. No new persisted fields.

## ENG-1778: model registry characterization fixture (2026-10-10)

Added a byte-for-byte characterization test of `getSupportedModelsWithMetadata()` (admin: 44 models, non-admin: 36) with a committed JSON fixture, before any AW-ModelRegistry read-path change. Test-only; no runtime change. AC2-4 (backfill and table read path) remain data-plane gated on ENG-1776.

## ENG-1379: Dedupe scheduled-chat variable-request emails (2026-10-10)

A schedule blocked on missing variables no longer mints a new link and re-emails on every due run. While an unconsumed request sent within 7 days is outstanding, the run is skipped silently, the existing token is kept and its expiry extended; a reminder goes out at most weekly. No new schedule fields. Auto-pause after N blocked runs is deferred (needs new durable state).

## ENG-903: An explicit model on a fixed-model session type is refused, not ignored (2026-10-09)

`POST /api/agent-mode/sessions` and `POST /api/agent-mode/skill/:skillId/session` used to silently ignore a
request `llmModel` for skill, emma-sidebar and every non-`regular` session type (report, image, video,
book, scheduled, ...): those sessions run on an admin-configured model. They now answer HTTP 422
`{ error: 'This kind of session uses a fixed model and does not accept a model choice.', code: 'model_not_selectable_for_session_type' }`
before the skill lookup, the idempotency claim and any write. Absent or blank `llmModel` is unchanged, as are
ordinary chat sessions (still `model_unavailable` 422 for an unserved/unselectable model).

Evidence no known caller sends it: the customer portal creation payloads (ChatSupport/Emma sidebar, Reports,
Images, Videos, Books, CRM, voice lab) carry no `llmModel`; the MCP `emma_create_session` sends only
`llmModel` with no `sessionType` (an ordinary chat session). Not changed here: `runVerifiedChat` still
overwrites the stored model with the task-type model when `requiredFunctions` include
update_html_file/read_file_content/create_blog_article/generate_image/generate_video and no `params.llmModel`
is passed (interactive /verified-generate passes none).

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

## ENG-2386: with-images server-side favorites/approved/limit/cursor (2026-10-09)

Optional query params on GET /api/tasks/executions/with-images; no params = unchanged. Paging via X-Next-Cursor / X-Total-Tasks headers.

## ENG-2371: automatic media-batch continuation, no customer "reply continue" (2026-10-09)

Adds `services/agentMode/mediaBatchContinuation.ts` (in-memory store, runner over the ENG-2370 state machine, structured unit/completion logs) and stops the media-budget deferral prompt from asking customers to reply "continue". No schema changes; durable store is slice C.

## ENG-2370: Pure media-batch unit state machine (2026-10-09)

ENG-1240 slice A. `backend/src/utils/mediaBatchStateMachine.ts`: I/O-free per-unit states, deterministic idempotency keys, capped exponential backoff, lease-expiry resume. Not wired in yet (slice B, ENG-2371).

## ENG-2263: CRM freshness detector reads "a combined count of N leads" as a total claim (2026-10-09)

A scheduled-run test on the preview showed the log-only detector (PR #3351) missing a wrong sum phrased "97 lead lists in total, containing a
combined count of 12,746 leads" (real sum 15,486): only "a total of N leads" was a covered wording. The pattern now also accepts
"combined / overall / aggregate count|total|number of N leads", still requiring CRM wording nearby and still backed by the turn's tool numbers.
Replaying the ~270 saved A/B replies shows no change (110/129 failing flagged before and after; 6/82 correct flagged before and after), so no new
false alarms there. Log-only; the reply is never edited.

## ENG-2361: update_lead_status can save the drafted message on the lead (2026-10-08)

`update_lead_status` accepts optional `message_draft` (LinkedIn text -> `messageDraft.content`) and `email_subject` + `email_body` (-> `emailDraft {subject, textContent}`, format `text`), written in the same update as the status. Lets scheduled drafting agents (Opiner) populate the cross-list Pending Review queue with the exact text they wrote instead of only a daily HTML report. Empty values are ignored and never clear existing drafts; a half email draft is rejected without writing.

## ENG-2263: log-only detector for stale CRM numbers presented as fresh (2026-10-08)

PR #3185 added a prompt rule ("`[verified]` on a CRM number means a tool call happened in THIS turn"). A scripted A/B replay (old vs new
prompt, one-line difference, ~400 runs, 8 models) showed the rule has no consistent effect: on cheaper, user-selectable models Emma
restates a stale account-wide CRM total about half the time, often tagged `[verified: get_lead_lists]` with no such call that turn. The
production default model (`gemini-3.8-flash`, verified on a fresh session) and the strong models (`claude-sonnet-5.5`, `gpt-5.5`) did not
(0 of ~80 runs). `gemini-3.1-flash-lite` is the cost-policy fallback (`optimizedDefaultModel`), not the default.

`utils/crmFreshnessGuard.ts` detects it deterministically (no LLM), log-only, two kinds:
- `cited_tool_not_run`: a `[verified: <CRM tool>]` tag whose cited tool did not run and succeed this turn (`toolCallSucceeded`: not errored,
  not `success:false`, not a duplicate, not deferred). Skipped: tags that say earlier/previous/stale, and a tag the model is only
  *discussing* ("I can't include the [verified] tag because no tool ran"). A bare `[verified]` naming no tool is not judged.
- `inventory_total_not_in_tool_results`: an account-wide total ("N lead lists", "N leads in total", "Total leads across all lists: N",
  "N leads across K lists") whose number is in none of this turn's CRM tool results. `get_lead_lists` returns per-list `leadCount` and
  `totalLists` but no total-leads field, so the model sums it; the check therefore accepts any number in the results, array lengths, the
  sum of `leadCount`, and the sum of per-call match counts. Skipped: honest wording ("earlier", "as of", "previous") within 140 chars.
  "N leads across all lists" is deliberately NOT an inventory claim - that is how a filtered search total reads.

It never edits the reply. Always on, try/catch-wrapped, kill switch `AGENT_CRM_FRESHNESS_GUARD=off`. Every scan is bounded (tag regex
{0,300}, input capped at 200KB, <=200 tags, <=20 claims, linear tag stripper): unbounded `[^\]]*`/`[^>]*` were quadratic (100KB of
unclosed `[verified ` blocked the event loop 1.5s, 500KB 37s).

Replay of the ~270 saved A/B replies with the harness's simulated tool results supplied as evidence (the earlier snapshot was 18 lists / 47
leads; the fresh one 17 / 43): 110 of 129 failing replies flagged (85%). The 19 misses are 9 honest "down from 18/47 earlier" comparisons
(the model re-queried; the harness labels them failures), 9 that label themselves "earlier"/"previous turn" (skipped by design) and 1 hedged
reply - none is an unlabelled stale restatement. This is IN-SAMPLE: the wordings were tuned on this corpus, so it is an upper bound, not a
forecast for production traffic. 6 of 82 correct replies were flagged: 3 short "searched 4 of your 17 lists" subset phrasings and 3
gpt-4o-mini mis-added totals (44/45/46 for a real 43 - correct flags, wrong numbers, not "stale").

`echoesEarlier`: a flag only means "not backed this turn", and a correct breakdown subtotal looks like a stale grand total. Each flagged claim
is also compared with the CRM numbers earlier turns of the SAME session persisted (`metadata.crmEvidence`, numbers only, bounded to 120
messages / 2000 numbers). Equal to one of them and unbacked now means the reply restated an old value; the log line carries an
`echoesEarlier` count and the summarizer reports those lines separately. Nothing is suppressed. Absence means UNKNOWN (a session saved before
evidence was persisted, or a number outside the 64 kept per message), not "not stale". On the replay all 104 number-flagged failing replies
carry the mark and none of the 82 correct ones do.

Reading it: one JSON line per flagged reply, `[crm-freshness-shadow] ... {"sessionId","model","kinds","findingCount","tagsSeen",
"crmToolsSucceeded","claimed":[numbers],"cited":[tool names]}`. It carries NO reply text - only numbers and tool names (an earlier
revision logged a 60-120 char slice of the reply, which can contain names and emails; the PR #3351 review caught it and a test now
asserts the exact key set and that PII in the reply never reaches the line). Summarise with
`node backend/scripts/summarize-crm-freshness-shadow.mjs web.stdout.log` (counts per model/kind, most-claimed numbers, cited tools).
Counts are flagged replies, not rates - the denominator comes from request logs. "Not backed this turn" is not the same as "stale": a
legitimate follow-up that restates an earlier number is flagged too. Decide enforcement only after reading production output.

Continuations: a task that spans several generateMarketingResponse invocations (auto-continuation, an answered question/approval card, a
`generation-timeout-continuation` partial followed by an actual "continue" request - at most 8 words / 60 chars) is read back from persisted
message markers to the request that opened the task. CRM tools run earlier count as run for the tag check, and the numbers they returned
(`PersistedCrmEvidence`, numbers only) back the total check, so a continuation that restates a stale total IS caught. A message saved before
this existed has no evidence and the total check abstains. A plain follow-up question is deliberately NOT a continuation - that is the
failure this detector exists to see. The log line carries `continuation: true|false` and `drift`.

Claim parsing: "1.2k", "12 thousand" and word numbers ("twelve") count; a claim of exactly 1 is ignored in plural-only patterns. Emma
replies are HTML, so block tags become line breaks and `<li>` a bullet; a lead-in line ending in ":" ("From our check earlier, not
re-queried:") labels only the bullet run directly under it.

`drift`: a claim within 0.5% (min 1, >=10) of a number the tools really returned. It is an arithmetic slip (a mis-added column, a concurrent
write between two calls), not a stale or invented total; the summarizer reports it on its own line so it does not inflate the stale count.

Evidence on the preview, real pipeline (turn 1 really calls get_lead_lists, the account then really changes, turn 2 asks a follow-up that
invites restating the old totals; ground truth read from the API, not from the detector):
- `gemini-3.1-flash-lite` 10/10 and `gpt-4o-mini` 9/9 unlabelled stale answers flagged; `gemini-3.8-flash` (the default) 4/4 stale flagged.
- Over 9 + 8 `gemini-3.8-flash` runs, 4 flags landed on replies not stale by my ground truth: 3 had re-queried (the log marks those `drift`,
  off by about one: the account's test list reports `leadCount: -1`, and the three runs shared one account so each other's scratch lead moved
  the totals) and one was a `[verified: get_lead_lists]` tag with no call that turn, which is a true tag finding.
- With `echoesEarlier` (final code, fresh preview, a separate real turn 1 per run): `gemini-3.1-flash-lite` 5/5 stale flagged, 4/5 marked
  (the fifth invented 11,847 leads, a number no earlier turn returned, so it is correctly unmarked); `gemini-3.8-flash` 2/2 stale flagged and
  marked, 6/6 correct or honestly-labelled replies unflagged. The shadow log lines carry only the documented keys, no reply text and no `@`.
- Before the final code, breakdown-heavy `gemini-3.8-flash` replies were flagged 5 of 11 and 5 of 12 times while correct, on group subtotals
  ("44 lists currently have 0 leads", "8,510 leads total across: ...", "held in four lists"). The pattern fixes removed the ones seen; the
  rest are not suppressed - `echoesEarlier` is what separates them in the summary (a subtotal matches no earlier turn's number).
- Caveats: n is small (8-10 per model); the runs shared one account, which adds drift noise; recall is measured on the wordings the
  patterns cover and real traffic will phrase it more widely, so treat it as an upper bound. Two earlier attempts crashed mid-run when the
  turn-2 list read returned nothing (the harness now retries), so they stopped short of the planned count.

Known limits: a total phrased outside the patterns is not seen; after a CRM write the check abstains; only count-like fields (count, total,
totalLists, leadCount, ...) and array lengths back a number - not arbitrary numbers inside lead rows. A flag means "not backed this turn".

## ENG-1094: marketing-action producer slice 1 (2026-10-07)

Added `marketingActionProducer.ts`, which maps pending ENG-502 outcome-ledger recommendations to `MarketingActionCandidate[]` for the ENG-445 selector. It does no prose parsing and no I/O. Persisting via `attachMarketingActions` before `addRunResult` is slice 2 (data-plane gated).

## ENG-0000: Migrate video generation to gemini-omni-1.1-flash (2026-10-08)

**Why:** Google shuts down `veo-3.1-generate-preview`, `veo-3.1-fast-generate-preview`
(and the older `veo-3-generate-preview` / `veo-3.0-generate-preview`) on 2026-10-22.
The replacement is `gemini-omni-1.1-flash`.

**API facts (live-tested 2026-10-08 with the dev key):**
- The model accepts ONLY the Gemini Interactions API. `generateContent` and
  `predictLongRunning` are rejected ("only supports Interactions API").
- `POST https://generativelanguage.googleapis.com/v1beta/interactions?key=KEY` with
  `{model, input, response_format: {type:"video", aspect_ratio:"16:9"|"9:16", resolution:"360p"|"720p"|"1080p"|"4k"}}`.
  `input` is the prompt string, or `[image parts..., {type:"text", text}]`. One image =
  image-to-video; two images (first, then last) = first/last-frame interpolation.
- Synchronous: the response has `status:"completed"` and the clip as base64 in
  `steps[].content[]` (`{type:"video", mime_type:"video/mp4", data}`). No polling,
  no file download. A 360p request took 25s and returned a 10.0s clip.
- Duration (live-verified 2026-10-08): `response_format.duration` is a STRING such as
  `"5s"` (integer 3–10). `{"duration":5}` → 400 Invalid input; `"duration_seconds"` →
  unknown parameter; `{"duration":"5s"}` returned a 5.01s clip. We always send each
  clip's exact length (default 8s). Requests >10s split into <=10s clips that sum to the
  request (14s → 10+4; a <3s remainder borrows from the previous clip: 21s → 10+8+3),
  generated in parallel and stitched in Remotion (`maxClipSeconds: 10`).
- Same secret as Veo: `{dev,prod}/AgentWeb/Google/Video`.

**Pricing:** $17.50/M video output tokens (5,792 tokens/s at 720p ≈ $0.1014/s),
$9/M text output, $1.50/M input. `omniVideoUsageCostUsd` bills the response `usage`;
when absent we estimate $0.1014 x the actual requested seconds. Legacy Veo price entries stay so
historical spend events still re-derive. The price-book version stays `2026-10-08`
(the addition is a new key only; no existing price moved) and the fingerprint pin was
updated.

**Behavior changes:**
- Seedance 2.0 stays the default; its automatic fallback is now gemini-omni-1.1-flash
  (was Veo 3.1). The Veo quota fallback to `veo-3.1-fast-generate-preview` is gone —
  there is one Google model, and a 429 fails clearly with a quota message.
- Retired Veo ids are accepted as input aliases for gemini-omni-1.1-flash everywhere
  (video service, `agent_mode_video_api_default_model` setting, admin dropdown, agent
  engine `video_model`). Read-time only; no stored data is rewritten.
- `VideoService.generateVideo` now returns `model` (the model that actually produced the
  clip, after any fallback) and `costUsd`; Emma's session cost uses them, so a
  Seedance→Omni fallback is no longer costed as the requested model.
- The agent engine's `generate_short_video` default branch calls the Interactions API
  over REST (`requests`) instead of `client.models.generate_videos`.

**Not changed:** `docs/model-roles-inventory.md` is a generated snapshot (its line
references were already stale) and `agent-engine/examples/Get_started_Veo.ipynb` is an
example notebook; neither is a runtime path.

## ENG-903: Work Plan launch and save fail loudly on an unavailable pinned model (2026-10-08)

A Work Plan's non-empty `defaultModel` is an explicit pin. Before this change, launching a plan whose pin was retired, internal-only, live-voice or admin-only (for a non-admin) silently dropped it for the account default (`createSessionWithPlan`, and `applyPredefinedWorkPlan` behind the launch route, the accept-recommendation route and Emma's `launch_predefined_work_plan`), with only a console warning.

- New `services/agentMode/modelPin.ts` holds the single pin rule set (extracted verbatim from the schedule `validateScheduleModelPin` merged in #3365): served registry key or honoured alias, selectable by the user (adminOnly clears only for an admin). The schedule validator now delegates to it.
- Launch: `createSessionWithPlan` (public/anonymous, caller's admin status; anonymous = non-admin) and `applyPredefinedWorkPlan` (session owner's admin status) resolve the pin BEFORE any session or session mutation and refuse with HTTP 422 `model_unavailable` (shared `buildModelUnavailableBody`). `launchWorkPlan` and `acceptWorkPlanRecommendation` map the refusal to 422; the Emma tool returns `success:false, errorType:'model_unavailable'` with the same sentence. An unattended (scheduled) launch is refused the same way and pages oncall (deduped). Empty `defaultModel` = account default, unchanged. An accepted alias is stored as the canonical id.
- Write: user and admin plan create/update routes validate `defaultModel` like schedule pins (422; unchanged stored value tolerated on update; blank clears; trimmed; non-string refused). No new persisted field, table or index.
- Write ordering and compensation: the model is written FIRST (`updateSessionLlmModel` is a single UpdateItem `SET llmModel REMOVE llmUsagePolicyDecision`: no message, audit or SSE). Before it, the plan structure is validated with the same `assertSequentialStepCounts` rule `updateSessionWorkPlan` enforces (so a non-sequential `stepCount` fails with NO state change). The previous `llmModel` and `llmUsagePolicyDecision` are captured; if the plan write then throws, they are restored through `chatbotDb.restoreSessionLlmModelIfUnchanged`: a single UpdateItem with `ConditionExpression llmModel = :planModel` (the value this launch wrote), so a model the user PATCHed in the window is never overwritten (ConditionalCheckFailed = 'someone changed it, leave it', logged at info, not an error). A session that had NO explicit model gets `REMOVE llmModel` (and the decision removed/restored), returning to exactly its prior state rather than a stored default. This is NOT a schema change: existing attributes and a conditional write only. A failed restore (any other error) is logged as CRITICAL with the session id and the caller still gets the failure; the launch success path is unchanged. `createSessionWithPlan` validates the structure before `createChatSession` and, once the session exists, ANY later failure (model, plan, input-request or interactive-share write, default-model lookup) removes exactly the session it just created (best effort, logged with the id on failure), returning 503 `model_save_failed` for the model write and the generic 500 otherwise; a refused launch creates no session at all.
- Failure mapping: a failed model save is HTTP 503 `model_save_failed` (transient, nothing started) from the launch and accept routes and `createSessionWithPlan`; the Emma tool returns `errorType:'model_save_failed'`.
- Anonymous Emma tool: public plan sessions run as `anon_*` users and can call `launch_predefined_work_plan`, so for an anonymous caller both the tool message and `modelUnavailable` use the anonymous-safe wording (no model id, name or reason).
- Admin-status scope on plan writes: an adminOnly pin is accepted only on a private plan owned by an admin that is NOT org-scoped (`orgId` unset); org-shared private plans are launched by org members, so they are validated as non-admin (user and admin POST/PUT). When an admin PUT widens a plan out of that scope (e.g. private -> system/public), the stored/new model is re-validated as a non-admin and refused with the shared 422 even if the model field is not part of the edit.
- Portal surfacing: the 422 body carries both `error` and `message`. The customer-portal Work Plans settings editor currently reads `message`; a companion portal PR makes it read `error` (falling back to `message`). Either way the text is shown whichever PR merges first.
- Canonical-id storage: pin writes (work-plan user/admin create+update, and schedule llmModel/llmBackupModel via the shared `validateModelPin`) persist the CANONICAL registry id, never a legacy alias that could later stop resolving. Blank clears, non-strings 422, and a value unchanged from the stored one (or equal to the stored value's canonical form) is tolerated without re-validation and, when it equals the stored text, not rewritten. A registry double without `resolveGenerationModel` stores the requested value as before. Launches resolve the stored value through `resolvePlanLaunchModel`, so alias or canonical both launch. No new persisted field.
- User plan PUT (`userWorkPlanRoutes`): the adminOnly check uses the plan OWNER's admin status (`isUserAdminSafe(plan.ownerId)`, as the admin PUT does), not the editing user's, because the owner is the launcher; the org-scope rule is unchanged.

## ENG-2363: LinkedIn disconnect oncall alerts carry a per-account Alert Class (2026-10-08)

First and reminder disconnect alerts now set `Alert Class: unipile-disconnected:<accountId>` so intake folds every occurrence onto one open canonical instead of filing a new issue per reminder. Owner email and 12h oncall dedupe unchanged.

## ENG-2359: backend staging env-override script for post-merge proofs (2026-10-08)

Added `.github/scripts/staging-env-override.sh` (+ test, wired into tests.yml) and `docs/staging-env-overrides.md`: set/restore allowlisted env vars on the staging EB env only, with an ENG-2353 proof recipe.

## ENG-2351: exact-sha jest runner for post-merge verification (2026-10-08)

Added `.github/scripts/sha-jest.sh` (+ test, wired into tests.yml script tests) and `docs/sha-jest.md`: detached worktree at a sha with a lockfile-keyed `npm ci` node_modules cache so the verifier can run `jest <file>` at the merge sha. Proven on #3354 toolDispatch.test.ts (124/124).

## ENG-2267: Meta tracking alerts file one canonical per ad account (2026-10-08)

Per-account Meta tracking-monitor alerts now carry `Alert Scope: meta-ad-account:<id>`; intake clusters on class AND scope, so different customers' accounts no longer fold onto one Linear issue. Unscoped alert classes are unchanged.

## ENG-1271: Staff-operated badge in partner-portal admin users list (2026-10-08)

Partner-portal admin Users table shows a "Staff-operated?" chip under Last seen when `selfActivity.staffOperatedSuspect` is true. The flag comes from GET /api/admin/users (#3038). Frontend only, with no persistence change.

## ENG-112: Chat branching ("Branch from here") with no new persisted field (2026-10-08)

**What it does.** `POST /api/agent-mode/session/:sessionId/branch {messageIndex, llmModel?, idempotencyKey?}`
creates an ordinary new session whose history is the source's rows `[0..k]`, so the user can continue on a
different model and compare. Behind the AW-Settings flag `chat_branching_enabled` (default OFF; only the exact
value `true` enables it; an unreadable row is OFF). Logic: `backend/src/services/agentMode/chatBranching.ts`
(pure, injected deps, same shape as `modelComparison.ts`); wiring: `controllers/chatBranchController.ts`.
`GET /model-options` carries an additive `chatBranchingEnabled` hint for the portal.

**Why no schema change.** The branch is built with `createChatSession` from an allowlist (llmModel,
associatedSkills, portalType `agent`, pageIdentifier only if `agent-mode` or `skill-*`, selectedStartupId,
sessionType forced `regular`, the *request's* delegateInfo) and its rows go through `addMessagesToSession`.
Provenance is one free-form key, `metadata.branchOrigin`, on row 0 (the stored system prompt). Row 0 is never
sent to the model (`buildMarketingContext` slices at index 1), model comparison reads only user/assistant rows
and the portal renders no bubble for role `system`. A separate provenance *row* was rejected: a second
`system` row would land at index 1, i.e. in the model's context, and break every "row 0 is the system prompt"
assumption.

**Hazards found while proving it (each has a test).**
- `addMessagesToSession` runs `incrementTokenUsage`; copying `usage` would bill the branch for turns it never ran.
  `usage`, `metadata.feedback`, `clientId` and the stale `messageIndex` are stripped; everything else is copied.
- `addMessagesToMessagesTable` logs and swallows batch items still unprocessed after 3 retries (silent partial
  copy). The service re-reads the new session consistently and fails (the half-built branch stays hidden) unless
  rows are dense `0..n-1`, `messageCount` matches and row 0 carries the provenance.
- Raw `messageIndex` values are sparse in the client view (tool rows and tool_calls-only assistants are hidden).
  The index is resolved against the raw rows, must be visible to the viewer and must be a non-error assistant
  reply; contiguous following tool rows are copied with it.
- ENG-2163: admin-taint is computed from tool-result rows in the turn. For an admin branching inside a tainted
  turn the whole turn is copied so the customer-facing filter still redacts the narration and the prompt.
- `messages[0]` is assumed to be the system prompt in `buildMarketingContext` (`startIdx = 1`).
- A prefix must leave 10 messages of headroom under `MAX_MESSAGE_SIZE_PER_SESSION`.
- `tryClaimSessionGeneration` is an in-process Set (as is `withKeyedMutex`): single-instance assumption, same as
  /generate and compare/select. Idempotency: in-process in-flight/replay map plus the `AGENT_RUN_STORE` `idem#`
  lane createSession uses (so with the store off, only same-instance retries are deduped).

**Review hardening (follow-up commit).**
- Continuation triggers: getSession re-fires a billed `scheduleAutoMediaContinuation` for an owner view whose tail is
  an unresolved media deferral < 1h old (`hasUnresolvedMediaDeferral`). Copied rows therefore lose
  `metadata.mediaBudgetDeferred` and the `deferred` flag of `media_generation_time_budget` entries in `toolCalls`.
- Hidden until verified: the session is BORN archived (`createChatSession` initialState `archived: true`, the
  existing field, excluded by every list), filled, verified, then revealed by `ChatbotDB.unarchiveSession`, which
  REMOVES the `archived` attribute (no new stored shape; every reader treats absent as live) and is conditional on
  the row existing (a vanished id is not upserted; it is logged as vanished, not retried, and answers 500). Reveal
  retries 3x. The new id is logged at creation, so a death mid-copy leaves a hidden, greppable session, never an
  empty visible one.
- Idempotency: scope is `JSON.stringify([...])` (injective). A concurrent request with the same key waits for the
  first and answers 200 with the same branch (replay); replay also checks source session + message index. A
  cross-instance in-flight claim (run store) is still 409 DUPLICATE_SUBMIT.
- Idempotency scope = `branch|source|messageIndex|llmModel|key`. Owner-only (a delegated admin arrives as the
  target). `(branch)` suffix is not stacked. A target with no preceding user row is a 400 `no_user_message`.
- Per-user cap: AW-Settings `chat_branching_max_per_hour` (cached ~60s, last-known fallback; absent/invalid = 30,
  `0` = unlimited), in-memory sliding window per instance, 429 `TOO_MANY_BRANCHES`; counted once the request holds
  the source lock and refunded unless a session was created.
- Share/conversable views drop `metadata.branchOrigin` (`filterMessagesForClient({omitBranchOrigin})`).

**Residual risks.** Analytics that count sessions/user messages (satisfaction scoring, summaries, asset cache,
`engagement.emma_session` CRM event) see a branch as a new session with copied history; assets generated in the
prefix appear in the branch's Images/Videos lists. Only `regular` agent-portal chats are branchable (others carry
session-level state a branch deliberately does not copy).

**Archived sessions and operators.** Admin-only readers (the admin recent-sessions list, the reliability snapshot
cron) can see archived sessions, including a born-archived branch mid-copy and an archived orphan left by a process
death. This is pre-existing behaviour of archived sessions, not new to branching. To find an orphan, grep the
backend log for `ChatBranching: branch session created (hidden until verified)` (it carries `sessionId`,
`sourceSessionId`, `userId`); every later failure line (`unexpected failure`, `could not be revealed`, `vanished`,
`idempotency bookkeeping failed`) carries the same `sessionId`. A branch whose reveal succeeded but whose idempotency
bookkeeping failed still answers 201 and keeps its claim (never released once visible). Exactly what a failed stamp
means: the branch is visible; a retry on the SAME instance replays it via the in-process record (200); with the run
store ON, a retry on ANOTHER instance sees the claim without a session id and gets 409 DUPLICATE_SUBMIT until the
claim TTL expires (no duplicate is created). The run store is OFF in production today (`AGENT_RUN_STORE` unset), so
only the in-process layer is live there.

**Rollback.** Set `chat_branching_enabled` to anything but the exact string `true` (`TRUE`, `True`, ` true ` are all OFF); the endpoint answers 404 and the portal hides
the action. Branches already created are ordinary sessions and need no cleanup.

## ENG-2205: LinkedIn account resolution after the Unipile outage fix (2026-10-07)

- **Root cause (#3275):** a 4-day Unipile outage (502 for every account) made the binary `isAccountConnected` probe
  fail for the whole pool, so `resolveAccountId*` returned null and users were told to connect an account they
  already had. Fix: the resolvers use the tri-state `probeAccountSession`; only a PROVEN `disconnected` is skipped,
  an `unknown` account is returned as a last resort (own before pool).
- **Side effects handled in #3341:** a caller that then makes a real call can throw an infrastructure error.
  `isLinkedInInfraError` (utils/linkedInInfraError.ts: credential fetch, gateway html, transport errors, timeouts,
  and SERVER_ERROR only for gateway statuses 502/503/504 and Cloudflare-style 520-524 - a plain 500 can be
  request-specific) maps these to a handled 503 on
  send-linkedin-message, send-linkedin-invite, sync-linkedin-connections and the prospect preview.
  `import_leads_from_search` hands the agent the generic text and, on a PROVEN dead session only
  (`isProvenDisconnectError`, which excludes a bare 403), clears the probe cache and records account health with
  `ownerUserId` omitted for a shared-pool account.
- **Enrichment is deliberately unchanged from before #3275:** CRM enrichment uses
  `resolveAccountId(userId, { verifiedOnly: true })` (null unless an account is proven live => LinkedIn skipped);
  `resolveAccountIdForEnrichment` is restored byte-for-byte. The skip warning now says "temporarily unreachable"
  when an account exists but could not be verified, and keeps "No LinkedIn (Unipile) account connected" otherwise.
- **Authorization (pre-existing hole):** a client-supplied `accountId` on send-linkedin-message / send-linkedin-invite
  and a sequence step's pinned `linkedInAccountId` were never checked. They now require
  `resolveLinkedInAccountForWrite` (caller's own or org-shared) => 403 with `code: linkedin_account_not_connected`.
  Only LinkedIn-channel steps are checked (a pin left on an email step is inert), and on PUT pins already stored on the
  caller's own LinkedIn steps are exempt so an unrelated edit still saves after an account is disconnected. The drip
  worker re-checks the pin at send time and snoozes that enrollment 30 minutes (typed
  `PinnedLinkedInAccountNotConnectedError`); a failed ownership lookup keeps the normal retry.
- **send-linkedin-message:** the engagement write after a successful send is retried twice (keyed put with a fixed
  event id, so a retry overwrites rather than duplicates); if it still fails the route returns success with
  `engagementRecorded: false` instead of a failure that invites a duplicate message.
- **Ownership gate** (`resolveLinkedInAccountFromList`) accepts either of a row's two ids (`account_id` or Unipile's
  `config.unipile_account_id`; they differ on legacy rows, as `scheduledRunAccountGate` already assumes). Both ids belong
  to a row already scoped to the caller's own/org-shared accounts, so this widens naming, not access.
- **import_leads_from_search** records an account as disconnected immediately only for Unipile's explicit
  `errors/disconnected_account`; a bare 401 needs a fresh probe to confirm first (recording pauses scheduled runs and
  emails the owner).
- **Still true, by design (tracked in ENG-2347):** read/search tools, send-linkedin-message auto-resolve, the full
  resync route and the drip worker's auto-resolved account may use the site-wide pool.

## ENG-1083: Enforce API key scopes at the MCP boundary (2026-10-07)

- `aw_` API keys: `tools:read` permits only `readOnly` tools; `tools:execute` permits all tools. Unknown/non-readOnly tools need `tools:execute` (fail closed). Denials return HTTP 403 JSON-RPC error -32003 naming the missing scope.
- Grandfathering: legacy records with no `scopes` array get both scopes; default key creation already grants both, so existing integrations are unaffected. No stored data changed.
- Rollback: revert this commit. Post-deploy smoke: create a `["tools:read"]` key, confirm a write tool returns 403 and a read tool succeeds.

## ENG-903: Validate scheduled-chat model pins at write time (2026-10-08)

`createScheduledChat`, `updateScheduledChat` and `createScheduleFromTemplate` (per-use override) stored `llmModel` / `llmBackupModel` with no served/selectable check, so a bad pin only surfaced as a failed run plus an oncall alert. They now call `validateScheduleModelPin` (agentModeController.ts), which trims, resolves aliases via `agentModeService.resolveGenerationModel`, and requires `isModelSelectableBy(canonical, isAdmin)`; failure is HTTP 422 with the shared `buildModelUnavailableBody` (`code: 'model_unavailable'`, reason `not_served` | `not_selectable`). Non-strings are 422. Empty/absent = no pin.

Compat rule: on update, a model/backup is validated only when it is being SET to a different non-empty value. Absent, unchanged, or `''` (clear) are never rejected, so old schedules whose model was later retired can still have other fields edited. An unchanged stored backup that is no longer valid is kept as stored.

Not changed (run-time behaviour untouched): MCP/Emma schedule tools (they call these HTTP handlers, so they are covered transitively); template create/update (user and admin) and a template's own stored `llmModel`; admin routes; work-plan `defaultModel` (already filtered by `getSupportedModels` at apply); internal `scheduleDb.updateSchedule` callers (llmModelChangeService, scripts, linkedIn health).

Portal: `useAgentModeSchedules.ts` save handler discards the server `error` text and shows a generic "Failed to save schedule" toast, so the 422 is not surfaced specifically yet (portal follow-up).

## ENG-55: Compare models as a plan-gated add-on (2026-10-08)

Compare models can now be sold as a plan add-on, enforced on the server. It is OFF until an
AW-Settings switch is flipped, so deploying this changes nothing.

**Pieces**
- Subscription feature id `model_compare` ("Compare models") registered in
  `services/subscriptionService.ts`. The partner-portal Subscription Types editor builds its
  checklist from `GET /api/admin/subscription-features`, so it needs no code change.
- AW-Settings `model_compare_requires_entitlement`. Only the string `true` (case/space
  insensitive) enforces; absent or anything else = not required (today's behaviour).
- `services/agentMode/modelCompareEntitlement.ts`: one function used by `/compare`,
  `/compare/select` (via the existing deps seam, a new optional `isEntitled` dep checked right
  after the `model_compare_enabled` kill switch, before any session read, usage check, lock,
  model call or write) and by `GET /api/auth/me` (`modelCompareEntitled`, additive, not stored).
- Entitled = requester is admin, OR `isSubscriptionFeatureEnabled(user, 'model_compare') === true`
  (the effective, org-owner-aware resolver). Unreadable tier or a thrown lookup = denied.
- Denial: HTTP 403 `{ error: 'Compare models is not available on your current plan.', code: 'model_compare_not_entitled' }`.
- The switch is cached ~60s; a failed read keeps the last-known value. A failed read with no
  known value (cold start during a settings outage) fails CLOSED: Compare is treated as required
  (admins and tiers with the feature still pass; an unreadable tier is denied), and the read is
  retried after ~5s. A successful read of an absent/blank/non-`true` row is "not required", so a
  healthy deploy changes nothing. `GET /api/auth/me` uses the same function, so during a settings
  outage `modelCompareEntitled` may briefly be false and the button hidden for non-entitled users.
- Delegated sessions: `req.user` is the target customer, so the customer's plan applies.

**ROLLOUT STEPS (owner)**
1. Deploy backend then portal (either order is safe). After deploy nothing changes: the switch
   is absent, nobody is gated, and the portal shows the button when the hint is missing or true.
2. In the admin Subscription Types editor, tick "Compare models" on every tier that should have
   it and save. NOTE: a saved tier with an explicit feature list that lacks `model_compare`
   loses Compare as soon as the switch flips. Legacy rows that never saved a feature list keep
   it (no list = all features), but the editor shows them with every box ticked and saving
   writes that list explicitly, so review each tier before saving.
3. Set AW-Settings `model_compare_requires_entitlement` = `true`. Takes effect within ~60s per
   instance (cache TTL).
4. Rollback: set the setting to anything other than `true` (or delete it); within ~60s everyone
   is entitled again. Unticking the feature on a tier only matters while the switch is on.
   `model_compare_enabled=false` remains the separate global kill switch (503).

**Dialog hardening (portal)**: default suggested models are derived from the supported list at
runtime (non-legacy, best quality score, one per provider) instead of hard-coded ids that had
become legacy; the dialog shows a usage-multiplier note and a one-line privacy note.

**Needs owner review**: the three user-facing strings (cost note, privacy note, 403 message).

## ENG-110: Per-user cap on concurrently generating Emma chats (2026-10-08)

- Backend: interactive `/generate` and `/verified-generate` now count a user's
  concurrently generating sessions (keyed by the session owner's userId) and answer
  `429 {code:'TOO_MANY_CONCURRENT_RUNS', message, limit}` over the cap. Counter logic
  lives in `backend/src/services/agentMode/concurrentGenerationCap.ts`.
- The slot is taken after the session generation claim succeeds and released in the
  same `finally` as the session lock (success, throw, early return, 409s, disconnect).
- Excluded (never counted, never blocked): scheduled runs, auto-continuations, Slack,
  email, approval-inbox and other system `runVerifiedChat` callers. Compare keeps its
  own separate cap of 2.
- Limit: AW-Settings `max_concurrent_generations_per_user` (cached ~60s, last-known value
  on read failure). Absent/invalid => 3; `0` => unlimited. Rollback = set `0`. No flag.
  Admins are not exempt.
- Accepted limitation: the counter is in-memory per instance. It resets on restart and
  Immutable deploys briefly run two instances, so a user may hold up to `limit` slots on
  each during the overlap (bounded by the deploy window). No data-plane change.
- Portal (companion PR): live generating/finished indicators for background chats,
  friendly 409/429 handling, and a few ENG-110 race fixes.
- Answer/cancel turns (`deckAnswer`, `deckCancel`, `workPlanInputAnswer`) are exempt from the
  cap's refusal but still counted. In `/generate` these run BEFORE the session claim and cap check
  and already consumed state (approved writes dispatched, deck cleared), so a 429 afterwards lost
  the outcome and made a retry 409 APPROVAL_DECK_INVALID. They continue a paused conversation that
  holds no slot, so they take one via `acquireInteractiveGenerationSlot(..., {bypassLimit:true})`
  (may briefly exceed the soft cap by the number of such turns). Chosen over moving the cap check
  earlier because that would need a slot held across the pre-claim awaits and still leave the
  SESSION_BUSY ordering flaw untouched (out of scope). `questionAnswer` has no side effects any more.

## ENG-1459: C3b transport-remnant audit (2026-08-22)

After C3a routed AgentMode text/tool calls through `callLLM` and the shared gateway, the only
remaining unreachable Vertex Claude adapter artifacts were `vertex_client`,
`vertex_client_promise`, and `convertContentToAnthropicBlocks`. They had no callers, and the
converter's former tests covered only that retired transport. They were deleted with an AST-backed
regression guard. The direct Gemini SDK site retained in `performDataAnalysis` is the documented
Gemini code-execution/file-analysis exception, not a text/chat transport. Evidence: guard 21/21,
all `agentMode*` suites green, and backend typecheck clean. Complexity delta: -171 lines overall.

## ENG-1103: route-level authz tests for orphaned org join-request diagnostic (2026-10-07)

Adds `adminOrgDiagnostics.route.test.ts`: unauthenticated 401, non-admin and delegated 403 with no scan, admin 200 breakdown, generic 500, no mutating verbs. Closes AC4 authorization-denied coverage; no runtime change.

## ENG-2268: Encode approved reads-only Meta Toolkit v1 (2026-10-07)

- Record Harsha's approved D1–D5 decisions in the product boundary, with pricing TBD and tier packaging documented only.
- Remove external CREATE/UPDATE advertisement and dispatch allowance. All external writes now fail locally with MetaToolkitRefusal; internal Emma handlers are unchanged.
- Keep launch_* and CUSTOM_AUDIENCE writes excluded. D2's blanket write refusal enforces D4 without scope/persistence changes.
- Verify negative write cases and allowed reads with scoped manifest/gateway/REST/MCP tests. Production read-only E2E requires an existing account-scoped credential and connected Meta account; no key provisioning is part of this change.

## ENG-976: post_on_account replies on X via in_reply_to_post_id (2026-10-07)

`post_on_connected_account` / MCP `post_on_account` accept optional `in_reply_to_post_id` (X only). It routes through TwitterAdapter.createPost -> postTweet({inReplyToTweetId}) behind the same ENG-827 publish re-check. Omitted means the original-post path is unchanged; other platforms are refused with nothing posted.

## ENG-903: An explicit model selection runs on that model or not at all (2026-10-07)

Rule: a model the user explicitly chose (the request carries it, or a schedule pin) is either the model that runs, or nothing runs and the caller is told. It is never replaced by the default, never "corrected", and never overwritten in storage. No selection at all still uses the configured default; usage-paused is still the 429; registry legacy aliases (`LEGACY_MODEL_ALIASES`) still map forward; a user-configured backup model is unchanged.

**How:** `resolveEffectiveModelForUser` throws `ModelUnavailableError` (`services/agentMode/modelUnavailable.ts`) when an explicit model is not served (`resolveGenerationModel(...).fellBack`, which used to mask the policy's `corrected`) or is not selectable. `allowSilentSwap` is true only when there is NO explicit selection (unpinned schedule, no-selection session creation, unselected shared session).

**Behaviour per entry point**
- **Explicit = the REQUEST carries a model** (`llmModel` on `/generate`, `llmModel` on session creation; trimmed, blank = none) or a schedule pin. Those 422 `{ error, code:'model_unavailable', requestedModel, reason }` (`not_served`, or `not_selectable` for internal/admin-only and live-voice ids) before any session write (a deck/work-plan answer is not consumed, the user message is not persisted), no LLM call, no metering, stored `llmModel` untouched, lock and idempotency claim released. A paused account still gets the plain 429.
- A model merely STORED on a session is never explicit (no persisted flag can tell a pick from a system-stamped default, and none is added): `/generate` without `llmModel`, `verifiedGenerate`, shared and conversable chat run on the current default when the stored model is retired or not selectable. The portal always sends the picker value, so portal users still get the 422 and the 'Unavailable' badge.
- Scheduled runs: the run ends `failure` **before** any session, resume claim or lease work, with `actualResponse: 'model_unavailable: pinned model "<id>" is not served|not selectable — ...'`, no requeue, no session; the existing oncall alert is kept (same dedupe key) and now says the run FAILED and nothing ran. Unpinned schedules keep the old alert-only behaviour.
- System-assigned flows are UNCHANGED and keep the `resolveFallbackModel` safety net: Slack threads, session responder, work-plan launch, GTM, onboarding, approval inbox, emma-email. They get the automatically assigned configured default stamped into `session.llmModel`, have no model picker, and a retired default must not hard-fail them. There is no persisted "user picked" flag (and none is added), so `generateSessionResponse` itself is lenient.
- Backup models are unchanged: the user backup is resolved and reported/stored, but the agent loop never retries on it (OpenRouter fails over inside the single request; `agentModeService.ts` ~4040), on `origin/main` as well.

**Deploy prerequisite — run before shipping:** every stored pin that is not a served model or alias starts failing the day this deploys. `scripts/migrateStaleModelReferences.ts` (dry-run is the default) inventories and remaps them (schedules, templates, sessions, work plans, settings). Known example: ENG-903's schedules pinning `claude-sonnet-4-5`.

**Not changed / decided:** no new persisted field, table or key; no owner email for a failed scheduled run (new customer copy needs review); no auto-pause (a failed run still consumes `runCount` like any other failed run); emma-email, work-plan `defaultModel` launch fallback, htmlCreation and the scoring judge are admin/internal configuration and untouched. **Rollback:** revert the PR (no data to repair).

## ENG-55: Compare models in chat (2026-10-07)

`POST /api/agent-mode/compare` fans one prompt out to 2-4 models (unique after alias resolution) as plain, tool-less completions through `agentModeService.callLLM` (no tools, web search, tool_choice or fallbackModels) and returns the answers side by side; `POST /api/agent-mode/compare/select` ("Continue with this answer") persists the chosen answer as a normal user+assistant turn and sets the session model. `/compare` never writes to the session or takes the generation lock. A model that is not honored as requested, is unpriced, live or internal-only is returned as `status:"rejected"`, never substituted; one failing model never fails the others. Responses carry no usage/token/cost data.

Limits (`services/agentMode/modelComparison.ts`): prompt <= 8000 chars, 8192 output tokens (includes reasoning tokens; NOT yet live-smoke-tested with reasoning models, tune afterwards) and a 60s transport deadline per model call, 20 recent text turns / 24k chars of context (normalized to strictly alternating roles), 2 concurrent compares per user, selected content <= 200k chars, select token valid 24h. A `finish_reason: length` answer is returned as `output_limit` with no select token, so a truncated answer can never be continued. `callLLM` retries once on rate-limit/network/5xx/malformed responses (interactive_chat maxAttempts = 2), so worst case per request is 2 x N provider calls and about 2 x 60s plus backoff of latency, not N x. `callLLM` takes no AbortSignal, so a client disconnect does not stop spend, and the concurrency limiter is per instance (in-process). The usage gate runs once before fan-out (same 429 `usage_paused` shape as `/generate`) and the ledger lags, so overshoot is bounded only by the figures above. Calls are metered per call under feature `agent_mode:model_compare`.

`selectToken` is an HMAC-SHA256 (key derived from `JWT_SECRET` with a purpose label) over session owner, session, compareId, prompt, model, sha256(content) and issuedAt; it stops clients forging assistant turns or `llm` attribution without any new storage. Replays are detected by scanning the recent history (newest-first, last 500 messages) for the same user+assistant pair persisted at or after `issuedAt` (so a late replay after more turns is also caught), so they return 200 without appending twice. Both routes return 409 `compare_session_not_started` (checked by `/compare` before any usage check or model call, and again by select) on a session with no user turn yet; a started chat is any chat with at least one user turn, wherever its system message sits (a skill-started chat has the assistant welcome at index 0 and the system message at 1). A comparison yields at most one pair: select returns 409 `compare_already_selected` (no write, session model unchanged) when the history already holds a user turn with the signed prompt persisted at or after `issuedAt` and the request is not the exact replay; a NEW compare with the same prompt has a later `issuedAt` and is selectable. Portal contract: treat `compare_already_selected` as "already added; reload the chat", not a retryable error.

Kill switch: AW-Settings row `model_compare_enabled`; the value `false` makes both routes return 503 `{code:"model_compare_disabled"}` immediately (read per request). Absent or unreadable means enabled. Rollback: set the row to `false`, or revert the PR; there is no schema or data change, and persisted turns are ordinary messages.

Compare has no role logic: an admin and a user get the same result for the same models, and who may select which model is decided only by the registry + usage-policy resolver, never by a model's name or in this feature. The selected model must be the only one that answers: the gateway-reported model is verified (exact id or a dated snapshot of it) and any other answer is discarded as `model_mismatch`, never shown or offered for "Continue".

## ENG-2342: adSetBidAndSchedule test reads metaTools.ts after tools split (2026-10-07)

Test-only path fix: the AD_SET CREATE contract moved from emma/tools.ts to emma/metaTools.ts.

## OPS: nginx request-timing access log for per-route p99 alarm (2026-10-07)

- `backend/.platform/nginx/conf.d/access_log_timing.conf` defines `main_timing` = EB default `main` + `rt=$request_time urt=$upstream_response_time`.
- `conf.d/elasticbeanstalk/access_log_timing.conf` writes it to a separate `/var/log/nginx/access_timing.log`. EB's nginx.conf already has a server-level `access_log access.log main`, so reusing access.log would double-log. access.log is unchanged.
- `.ebextensions/07-nginx-timing-log.config` appends the file to the CloudWatch agent (log group `/aws/elasticbeanstalk/<env>/var/log/nginx/access_timing.log`).
- Follow-up after deploy: per-route p99 alarm excluding `/api/agent-mode/*` and `/mcp`, then retire the interim 60s `prod3-p99-latency` threshold.

## ENG-728: Report corrupt preview overrides as errors (2026-10-07)

Production verification found that the UTM preview has no production caller yet, and source inspection reproduced a separate AC5 defect: malformed nonempty overrides were reported as skipped before validation. Validate overrides inside the per-lander error boundary before protecting valid overrides. Invalid values now produce error rows without reading deployed links. No storage, deployment, or apply boundary changes.

Scoped regression evidence: the existing preview Jest file went from 3 failed / 9 passed to 12 passed with a 768 MB heap. CodeRabbit local light review completed with zero findings. This narrow fix does not complete ENG-728: a read-only deployment adapter/invocation surface and production per-lander evidence remain outstanding.

## ENG-428: Preserve REST draft intent (2026-10-07)

Production artifact verification confirmed `/api/emma/post-on-account` dropped `save_as_draft`, and its service wrapper dropped the implementation's options argument. Forward the existing draft option across both boundaries so LinkedIn drafts remain drafts and other platforms reach the existing explicit refusal instead of publication. Ordinary posts retain the published default. Focused route regression: RED 1 failure/1 pass, GREEN 2/2. No provider writes, schema changes or paid model calls. Original deployed service/adapter tests also exercised DRAFT behavior using mocked HTTP clients. Production closure awaits deployment of this forwarding correction and exact-artifact replay.

## ENG-2334: MCP tool annotation policy + publication CI gate (2026-10-07)

Typed per-tool read/write policy (`mcp/server/toolAnnotationPolicy.ts`) covering all 95 public MCP tools; unclassified tools fail closed. CI gate in `mcp.publicToolInventory.test.ts` asserts annotations match policy, get_chat_history is not read-only, mutating tools are never read-only, and no banned schema fields or description phrases exist. No copy changes.

## ENG-809: dev.md notes become fragments, because append collides exactly like prepend (2026-10-06)

Every PR used to prepend to dev.md line 1, so any two open PRs conflicted, and a conflicted PR cannot
schedule a workflow run (ENG-757 blind window). Appending would not help: two EOF additions touch the
same hunk. Notes now go in `dev/pending/<eng-id>-<slug>.md`; `dev-md-consolidate.sh` folds them in
newest first after merge and refuses to delete any fragment whose lines are not verifiably in the new
dev.md. The guard runs from the base ref so a PR cannot weaken the check judging it, and the
consolidation branch is exempt only when it solely edits dev.md and removes fragments.

## ENG-428: LinkedIn save-as-draft via post_on_connected_account (2026-10-06)

`post_on_connected_account` gains `save_as_draft` (LinkedIn only; other platforms refused, nothing posted). Draft posts use `lifecycleState: DRAFT`, skip the published-posts cache, and return no feed URL.

## ENG-427: list_knowledge_base_files returns signed URL for private KBs (2026-10-06)

getTasksWithKnowledgeBase now keeps the `knowledgeBase` signed URL in its projection, so the KB listing no longer returns url:null for private/org knowledge-base.txt files.

## ENG-336: MCP tools/list emits readOnly/destructive/openWorld annotations (2026-10-06)

Slice 1 of ChatGPT app compliance: `McpToolRegistry.getToolDefinitions()` now attaches MCP `annotations` derived from `readOnly` (undeclared = destructive write), explicit per-tool annotations win, jest gate in `registry.toolAnnotations.test.ts`.

## ENG-1005: Publish, plan, and schedule workflow tools (2026-10-06)

- Add four externally listed MCP workflows: `emma_publish_social_post`, `emma_publish_blog_post`, `emma_create_gtm_plan`, and `emma_schedule_recurring_work`.
- Publishing defaults to local draft previews; only boolean `publish: true` permits publication. Social calls without an account return connected accounts. Granular publish tools remain internal-only (already enforced in this checkout).
- Blog creation/publication had no matching REST adapters; add authenticated, quota-metered adapters around the existing service methods, carrying scheduled consent through to the CMS write. Successful publishers lacking a URL are reported explicitly without suggesting a duplicate publish.
- GTM orchestration uses the actual route contracts (title, whole-plan responses, one work item per request). Schedules need no template; missing prompt variables are named before creation.
- Complexity: four thin workflows, two required REST adapters, no dependencies or persistence changes. Rollback: remove the new workflow imports/list entries and adapters.
- TDD: initial ENG-1005 run was 32 failed / 3 passed before implementation. Verification is scoped Jest only; no servers, browsers, full-repo typecheck, commit, or push.
- Final verification: 311 tests in 13 suites passed (including 47 ENG-1005 tests), plus 3 static quota-classification tests. CodeRabbit's completion-credit finding was reproduced and fixed; its remaining title-normalization suggestion does not apply because the phase route stores titles verbatim.

## ENG-1907: sandbox mode phase 1 — the `eval_` principal becomes a real portal account (2026-09-12)

ENG-1870 shipped a separate mini-product for evaluations (server-rendered `/evaluation` page, a
single-shot Gemini with no tools, a toy simulator, an HTTP allowlist that 403'd every real route).
Harsha rejected it on sight: the candidate never touched the product. Phase 1 of ENG-1906 keeps the
lifecycle that was good — `eval_<uuid>` identity, the `AW-Evaluations` policy row, atomic
provision/revoke/audit, reviewer assignment, the `scope:'evaluation'` delegate token — and
inverts the boundary: a **denylist** (connector OAuth, MCP OAuth/servers/API keys, Stripe, org,
Featurebase identity, public share links, session transfer, Clarity replay registration,
`/api/admin`), socket admission on the same policy check, and **class-based** tool denial
(`SANDBOX_TOOL_CLASSES` in `evaluationPolicy.ts`) enforced in all three dispatchers. Everything
unclassified — Meta tools included — reaches its normal handler. No Meta simulation exists yet
(phase 2/3), so a phase-1 sandbox account simply has no Meta connection.

Assumptions worth knowing when this bites later:

- **`getAllUsers` now excludes `eval_` principals by default** (`{ includeSandbox: true }` opts
  in). That single filter is what keeps a take-home account out of the activation CRM sync,
  onboarding nudges, Meta crons, renewal alerts, LLM unit economics and revenue listings. The one
  caller that opts in is the partner-portal roster (`GET /api/admin/users`) because Access Portal
  lives there. If a sweep ever bypasses `getAllUsers` (the renewal cron's `scanWithFilter` did),
  it needs its own `isEvaluationUser` skip — one test per enumerator pins the current set.
- **Oncall suppression is keyed on identity, never a caller flag.** `sendAgentModeOncallAlert`
  resolves the session owner when no `userId` is passed, so the 30 call sites are untouched. It
  fails open: a lookup error still pages for a real customer.
- **Reliability telemetry skips sandbox runs entirely** (run ids remembered at
  `recordAgentModeRunStarted`, cleared on the terminal event) because
  `agentReliabilitySnapshotCron` has no per-user filter and feeds the closure gate's
  `failedRunRate`/`degradedRunRate`.
- **`install_skills` is deliberately outside the `connectors` class** even though it matches the
  `install_` prefix — denying it would strip every non-foundation tool from Emma.
- **A policy row without `deniedToolClasses` denies every class** (fail closed; this is also what
  the pre-phase-1 row for the Ryan take-home looks like). The store's `get()` normalizes legacy
  fields (`materials`, `artifacts`, `simulation`, `remaining`) away instead of throwing.
- **Provision refuses without the `Sandbox` tier row** (`scripts/ensure-sandbox-tier.ts`,
  compare-and-set append) because an unknown tier name fails *open* to every page, connector and
  skill in `subscriptionService`. The AW-Users item is written with `subscriptionType: 'Sandbox'`,
  seeded `brandGuidelines` (else the portal forces onboarding, which runs real brand extraction),
  and never `adAccount` — `routes/meta.ts` and Emma's Meta credential resolver would otherwise
  fall back to AgentWeb's shared production Meta token.
- Local TDD ran under Node 20 (`/usr/local/bin/node`); the default Node 26 on the Mac cannot load
  `jsonwebtoken`. Merge evidence is the Atem run.

## ENG-1624: the "stopped caching the private key" claim describes a bug that never reached `main` (2026-08-31)

A second correction to this same PR's history (see the entry directly below for the
first). Commit `22bd000c6`'s message also says: "Also stop caching the parsed
service-account secret (private key included) on `driveServiceAccountCredentials` —
only `client_email` is needed... so keep just that." Read on its own, that describes
fixing a security exposure that existed in the codebase.

It didn't. `git log -p -- backend/src/services/agentModeService.ts` shows
`driveServiceAccountCredentials` (the field that cached the full parsed secret) was
introduced AND removed within this same unmerged PR branch — added by an earlier
stage of the pipeline run that produced this PR, then replaced with the narrower
`driveServiceAccountEmail` by the commit whose message makes the claim.
`origin/main` never had a `driveServiceAccountCredentials` field at any point;
`getGoogleDriveClient()` there never cached anything beyond what this PR adds. So
nothing was "removed" in the sense of undoing a production exposure — the vulnerable
code was draft-only and never shipped. What this PR actually does is *add* a narrow
`driveServiceAccountEmail` cache (just the email, needed to name the account in a
share-access error) and document why the rest of the secret isn't retained. That's
good hygiene, but it's not the removal of a private-key leak, and describing it that
way overstates what happened. Left uncorrected in the commit itself (same reasoning
as the entry below — rewriting a pushed, already-in-PR commit isn't worth a
force-push for a wording fix); noting the correction here instead.

## ENG-1624: sub-folder KB traversal fix is correct; one commit's stated motivation isn't (2026-08-31)

Independent re-verification against the live prod session (`822c1ed4-133e-4081-b8c9-ee43547fd463`,
pulled from `AW-ChatSessions` + `AW-ChatMessages`, since the session record's own `messages` list is
empty and the real transcript lives in the separate messages table) confirms the fix. The two actual
failures — matching the session's own `failedFunctions` counter — were both
`materialize_knowledge_base_asset`, at `2026-08-27T15:49:26Z` (file-not-found against the registered
root) and `15:49:36Z` ("Not authorized" against the sub-folder itself). That's ~1.5h before the
issue's stated "~17:19–17:24Z" window, which is actually when the deferred-ads deployment ran and
step 9 completed with 0 ads — close to when the customer's Slack complaint landed (10:31 PDT =
17:31Z), not when the tool itself failed. All four Drive KB call sites
(`materializeKnowledgeBaseAsset`, `readGoogleDriveSharedFile`, `listKnowledgeBaseFiles`,
`searchKnowledgeBase`) now route through `getGoogleDriveFolderTreeIds`; `tsc` and the 195 targeted
tests pass post-merge with `main`.

One inaccuracy survives in the commit log: `22bd000c6`'s message claims "search_knowledge_base was
the call actually exercised by the failing Phoenix session." The transcript shows otherwise —
`search_knowledge_base` was called exactly once in that session, at `18:55:59Z`, *after* Harsha's
manual sub-folder registration had already unblocked `materialize` (`18:50–18:52Z`), for an
unrelated query ("Do Not Say marketing guardrails") that Emma herself determined belonged to a
different client's KB entry, not Phoenix's. The fix to `searchKnowledgeBase`'s Drive branch is still
correct and worth keeping — same class of bug, independently confirmed by reading the code — the
commit message's specific attribution to this session is just wrong. Left uncorrected in the commit
itself (rewriting a pushed, already-in-PR commit isn't worth a force-push for a prose-only fix);
noting the correction here instead.

## ENG-1484: two correct instructions can still lose to each other (2026-08-23)

ENG-1478 (same day) fixed the Work Plan Capabilities section to tell Emma to check
`list_predefined_work_plans` on an unprompted goal statement. Live re-test after that fix deployed:
"I'm interested in making some linkedin posts" *still* skipped the check and drafted 3 posts
directly, despite a matching accessible plan ("Research Based Linkedin Founder Post") existing.

Root cause: a separate "Page & Feature Tool Reference" table — framed for "a user refers to a page
or feature by name" — has `"LinkedIn content", "LinkedIn posts", "LinkedIn page" →
list_connected_account_posts, create_social_media_posts`, an unconditional keyword→tool arrow. Both
this row and the Work Plan Capabilities paragraph are individually correct for what they're written
to cover; neither one references the other, so a request that matches both keyword sets resolves
to whichever pattern is more concrete and direct — the fixed-arrow table row, not the conditional
paragraph. ENG-1478's fix never got a chance to run.

Fix: added an explicit exception to that one row — a stated GOAL (not a literal "show me the page"
request) defers to the Work Plan Capabilities check first. Scoped to the one row Harsha actually
reproduced; the same table has ~15 other keyword→tool rows with the identical latent shape (a goal
statement could plausibly match any of them before ever reaching a relevant work-plan check), but
fixing all of them blind, with no reproduced case for the others, risks unintended behavior change
across many more real flows than this PR can verify. Flagged as a known follow-up, not fixed here.

## ENG-1478: a prompt can describe a branch correctly and still never enter it (2026-08-22)

ENG-1472 added `recommend_predefined_work_plan` (an inline, soft-accept proposal card) and the
system prompt's "Work Plan Capabilities" section already told Emma which tool to call once a
goal-matching template was known: *"states a concrete current goal that clearly matches exactly one
template from list_predefined_work_plans, call recommend_predefined_work_plan..."* That sentence
reads as complete — it names the trigger, the tool, and the guardrails (ask-if-ambiguous, don't
re-recommend). It is not: it silently assumes the plan list is already sitting in context.

Live-reproduced (Harsha, 2026-08-22): a fresh chat, "I'm interested in making some linkedin posts",
with a plan literally named `Research_Based_Linkedin_Founder_Post` accessible to the account —
no recommendation. The prompt has one line just below this section stating the *active* work
plan's status "is automatically provided in your context." Nothing says the same about the
*available templates* — because it isn't true; `list_predefined_work_plans` is a tool call, not
injected context. The branching instruction was written as if discovering a match were free. For
an ordinary conversational turn where the user never mentioned work plans, calling an extra
"informational" tool is exactly the kind of speculative call a model will skip unless told to make
it — and nothing here told it to.

Fix: added one explicit sentence — check for a match before replying; if `list_predefined_work_plans`
hasn't already been called this session, call it now, even though the user never asked about work
plans — plus a line stating outright that templates are not auto-injected the way active-plan status
is. The rest of the branch (single-match → recommend, ambiguous → one clarifying question, no
re-recommend) was already correct and is unchanged.

Verification is the same convention every other `agentModeSystemPrompt.*` section uses: string
assertions against the compiled `AGENT_MODE_SYSTEM_PROMPT` constant
(`agentModeSystemPrompt.workPlanRecommendation.test.ts`) — this repo has 14 sibling files doing
exactly this for other guardrails (menu selection, capability denial, lead-import resume, etc.), so
prompt content here is treated as tested code, not prose. A live multi-turn transcript check (does
the model actually call the tool now) is the residual proof this test shape can't give — flagged in
the PR as the one thing NOT covered by a unit assertion, same as it is for every other guardrail in
this file.

## ENG-1371: deleting a retired gate is easy; the things quietly leaning on it are not (2026-08-19)

Greptile was dropped as a vendor. Its app had already stopped posting — the `Greptile Review`
check-run is absent on every PR opened after 2026-08-19 ~10:00Z — but all of its code was still on
`main`, so every run still paid for a 600s poll that could no longer succeed. This removed the
`greptile-review` job, seven scripts and `greptile.json`. Findings, because almost none of the work
was the deletion:

- **The gate's failure mode had already inverted, and the error message lied.** `greptile-gate.sh`
  returns `unavailable` (exit 75, which passes under ENG-1277's policy) only when no verdict exists
  for **any** commit on the PR. If a stale pre-cutoff review existed, `greptile_alive` was set and
  the timeout was classified `refused` (exit 1) instead, printing *"Greptile reviewed this head and
  it did not clear the bar — a real finding, still blocking."* Greptile had not reviewed that head
  at all. In one captured run the stale review it was ignoring was **5/5**. The `greptile_alive`
  guard was correct when written and was silently invalidated by ENG-1282 setting
  `triggerOnUpdates: false` — after that, every PR with one review and one later push hit the false
  branch. **Two changes that are each individually correct can compose into a lie.**
- **5 of the 6 open PRs failing `merge-evidence.sh` were failing on this and nothing else**
  (#2485, #2481, #2399, #2376, #2417). The queue was blocked by a vendor we no longer used.
- **`merge-evidence.sh` was leaning on the deleted job in a way nothing would have caught.** It used
  `Require Greptile Review` as its draft discriminator, matched by exact name and **fail-closed on
  absence** — so a plain `git rm` of the job would have turned every PR into NO_EVIDENCE, disabling
  the merge gate CLAUDE.md mandates. The replacement was verified before the switch rather than
  after: both discriminators were run against all 18 open PRs and returned **identical verdicts on
  18/18**. `MERGE_EVIDENCE_DRAFT_JOB` already existed as an override, so that A/B needed no code
  change at all — a seam built for renames paid for itself two months later.
- **`detect-changes` is a strictly better discriminator than the job it replaced.** `greptile-review`
  needed `always() &&` in front of its draft check because it declared
  `needs: [detect-changes, backend-tests-a, backend-tests-b]`, and GitHub implicitly ANDs an `if:`
  with `success()` when the expression names no status-check function — so a path-filtered skip
  upstream could propagate into the discriminator. `detect-changes` is the root of the graph with no
  `needs:` at all, so the bare draft check is exactly right. The invariant now asserts **both** the
  `if:` and the absence of `needs:`.
- **An invariant that greps for a vendor name goes vacuous the moment the vendor leaves.**
  `merge-evidence.test.sh` asserted that backend-tests-a/b did not reference `greptile` in their
  `needs`/`if`. With the job deleted that check could never fail again while appearing to pass —
  the exact shape of a control that has quietly stopped working. It now asserts the positive
  property instead: those jobs declare `needs: [detect-changes]` and nothing else, so a reviewer,
  lint gate or approval job added in front of the suite fails in the PR that adds it.
- **Renaming fixtures across a suite is not a `sed`.** The regression fixtures modelled two distinct
  jobs — the discriminator and an ordinary second job that happened to be `Detect changed projects`.
  A blanket rename collapsed both into one name and produced fixtures with the same job appearing
  twice with contradictory conclusions; 7 tests went red for reasons unrelated to the change. The
  ordinary job had to be moved out of the way first, then the discriminator promoted into the freed
  name. The suite caught all of it, which is the point of it existing.
- **dev.md already knew.** The ENG-754 entry recorded, on 2026-07-29, that *"`Require Greptile
  Review` was not actually a required status check — branch protection on `main` required only
  `Detect changed projects`."* That stayed true for three weeks while `tests.yml` asserted the
  opposite in three separate comments and ENG-1320 based a vendor decision on it. **A fact recorded
  once in a log does not propagate to the comments that contradict it.** Branch protection is now
  being fixed under ENG-1373; the comments here were corrected with this change.
- **Ride-alongs taken because the files were already open:** `dependabot-integrity-check.test.sh`
  (20 assertions guarding the one genuinely security-relevant required check) existed but no job
  ran it; the CLI `--testPathIgnorePatterns` *replaces* rather than extends `jest.config.js`,
  silently re-including the opt-in twins suites; five jobs had no `timeout-minutes`, inheriting
  GitHub's 360-minute default; and `eb-config-conflict`'s existing 5-minute ceiling turned out to
  sit BELOW its own `fetch-depth: 0` checkout cost — it was killed at 4m59s on this very PR, having
  survived only because the job is path-gated and had run 6 times in 197 runs without drawing the
  tail. Auditing "jobs with no timeout" and not "jobs whose timeout is wrong" missed it.
- **The one ride-along that had to be reverted, and why it is the most useful finding here.** Job
  B's ignore list used `/__tests__/agentMode` while job A selects on `agentMode`, so 23 files ran
  in BOTH backend jobs on every PR. Making the two lists exact complements looks like free money.
  It is not: coverage is collected ONLY from `src/utils/**` and ONLY by job B, so **which tests run
  in job B is what the coverage number measures**. Two of those 23 are
  `src/__tests__/utils/agentModeAlerts.test.ts` and `.../agentModeErrors.test.ts`, whose targets sit
  inside the coverage scope — and every other test touching those two modules is also
  `agentMode`-named, so excluding the 23 sent both modules to zero. CI went red: branches
  95.2% -> 93.99%, statements 98.35% -> 97.55%. Reverted, with the measurement recorded in
  `tests.yml` so the next person does not rediscover it. **A test-selection change in a repo with a
  coverage gate is a coverage change, whatever it looks like.** Deduplicating the split needs the
  `collectCoverageFrom` scope decided first — ENG-1376.
- **Both of my own errors were caught by CI, not by review or by me.** The coverage drop and the
  timeout kill were each invisible to local suites (391 assertions, all green) because neither is
  expressible as a script test — one needs the real Jest run, the other needs a real runner and a
  real clone. The 5-minute timeout in particular had been latent for months. Local suites prove the
  logic; only the real run prices it.

## ENG-1309: fixing a "prompt bloat causes verbosity" regression without adding to the pile (2026-08-18)

Fix for ENG-1306 (two customers, four sessions, quantified 2x completion-token growth since the
Opus 5 default switch). Human-written behavioral contract (drafted by Fable from Ed Mongiovi's and
Vince Magaline's own words, confirmed by Harsha on ENG-1305): yes/no questions get a yes/no first
line; an explicit stated length is honored within ~20% on the first attempt; factual/config
questions stay under ~150 words by default; the verified/unverified distinction becomes a compact
per-claim tag, not two separate lists. Findings, because the shape generalizes:

- **The contract itself said not to do the obvious thing.** ENG-1305's audit named the last two
  "fix this failure mode" prompt additions (ENG-829, ENG-1187) as contributors to the very
  regression being fixed here — each one grew the reply by adding a rule that had to be obeyed on
  every turn. Bolting a third CRITICAL block on top of the same pile would be the identical move
  that produced ENG-1306. So this PR's one new section (`## Answer Directness & Length`) is
  offset by removing two already-proven-ineffective instructions it makes redundant: a generic
  "keep responses concise but informative" bullet (dead weight — the customer complaints are
  direct proof it was never followed) and a 7-line "Important formatting rules" numbered list that
  had three separate rules all restating "minimal spacing" and a fourth restating "concise."
  Net result: **+961 chars / +163 words** on the 66,893-char (now 67,854) `AGENT_MODE_SYSTEM_PROMPT`
  constant — a real, disclosed increase (+1.4%), not zero, but roughly an order of magnitude
  smaller than treating this as "just add another block" would have produced, and the new section
  constrains *output shape* rather than adding another thing to check before answering — a
  different failure mode than the additive pattern ENG-1305 flagged.

- **Two instructions asking for opposite formats is worse than either alone.** The ENG-829 bullet
  literally said "keep the two lists visibly separate" — the exact anti-pattern criterion 3 of this
  ticket's own contract asks to fix. Adding a new "use a compact tag, never two lists" rule
  *alongside* the old "keep two lists separate" rule would have left the model with two live,
  contradictory formatting instructions for the same claim-labeling behavior — genuinely
  underdetermined, and a worse outcome than not fixing it. The old bullet was edited in place
  (same file, same PR) rather than left for a future cleanup; `agentModeSystemPrompt.answerDirectness.test.ts`
  asserts the old phrase is gone, not just that the new one exists, specifically to catch a
  reviewer or future edit reintroducing it as an "addition."

- **The thinking-budget/model-config lever was deliberately not used here**, despite
  `AGENT_MODE_MAX_OUTPUT_TOKENS` (`agentModeService.ts:197`, raised 12,384→32,000 on ENG-403,
  07-21) and Bedrock's `ConverseCommand` having no thinking-budget cap (`agentModeService.ts` Claude
  path, ~L2248) both being named as root-cause contributors in ENG-1305's audit, and Harsha's own
  decision comment naming "length/thinking-budget config where available" as a preferred lever
  over prompt prose. Reasons for staying prompt-only in *this* PR: (1) `AGENT_MODE_MAX_OUTPUT_TOKENS`
  is a single global ceiling shared by every AgentMode feature, including ones that legitimately
  need long output (GTM plans, audit reports, blog articles) — lowering it to fix short-answer
  verbosity risks truncating unrelated legitimate long-form generation; a targeted fix needs a
  per-request-shape cap, not a global one, which is a bigger design than this ticket's contract
  asks for. (2) Adding a Bedrock `thinking` budget is a live-behavior change across every Opus 5
  call in the product, not just the four named replay fixtures, and needs its own scoped
  investigation/testing — Harsha's ENG-1305 decision comment frames ENG-1309 itself as "the fix"
  (the harness contract), not as the vehicle for that separate lever. Flagging both here so a
  follow-up isn't accidentally treated as novel: if the harness-only contract proves insufficient
  once ENG-1314 unblocks real replay evidence, the next lever is a per-request output-length hint
  derived from the new contract's own thresholds (e.g. cap `max_tokens` lower when no explicit
  depth was requested), not a global constant change.

- **The real behavioral evidence (replay against the four named production sessions) is
  infrastructure-blocked, not skipped.** `loops/eval/agentModeReplayFixtures.ts` (ENG-1312,
  already merged) is the deterministic char/word-threshold harness this contract's own criterion 4
  calls for ("measured in characters/tokens, not judge score") — it already cites this ticket's
  exact thresholds (`ENG-1309 criterion 1/2/3`) in `thresholdSource`, and already proves the
  mechanism catches a regression using a synthetic `'x'.repeat(10524)` payload standing in for the
  real "today 10,524 chars" figure from criterion 2. It runs on synthetic placeholder content
  because the real transcript content is a data-exposure decision (ENG-1314), not a code decision —
  see that module's own doc comment. This PR's tests therefore characterize the only surface a unit
  test actually owns: that the system prompt *states* the contract in terms an LLM can follow
  (same idiom `agentModeSystemPrompt.followExplicitDirection.test.ts` established for ENG-1311) —
  pinned RED (absent) before this change, GREEN (present) after. `agentModeReplayFixtures.test.ts`
  was re-run unchanged and stays green; this PR doesn't touch that module.

## ENG-1312: the satisfaction judge's blind spot, and a real fixture is a data-exposure decision, not a code one (2026-08-17)

Two customers both reported the judge rewarding exactly the behavior they
were complaining about — a 20-page reply to a 2-page ask scored 4/5 with
5/5/5 dimensions, and pushback against a direct instruction scored 5 for
"excellent reasoning." Findings, because the shape generalizes:

- **The judge only had 3 dimensions and none of them measured length,
  instruction-following, or unnecessary caution.** `goalCompletion`/
  `dataAccuracy`/`outputQuality` can all be genuinely high on a reply that is
  simultaneously a regression — verbosity and permission-asking are
  orthogonal to correctness. Added `concision`, `instructionCompliance`
  (both 0-5), and `unnecessaryPermissionRequest` (boolean), plus a rubric
  rule that pushback against a non-spend/non-publish instruction can't score
  `outputQuality: 5` — see `VERBOSITY_PERMISSION_DIMENSIONS_CLAUSE` in
  `sessionScoringService.ts`.

- **New rubric text must be APPENDED, never baked into the hardcoded
  default.** Production carries a live `default-scoring-prompt` AW-Settings
  override, and a custom `ScoringJudge.systemPrompt` is entirely
  user-authored. Editing only `DEFAULT_SCORING_SYSTEM_PROMPT`'s literal text
  would leave whatever prompt is *actually configured* blind to the new
  dimensions — the same masking failure (ENG-392) that let this regression
  hide for two weeks in the first place. Same pattern `NO_TASK_JUDGMENT_CLAUSE`
  already uses; extended, not reinvented.

- **"Replay fixtures with hard thresholds" sounds MOCKABLE and is, right up
  until the fixture needs real content.** All five session IDs named in this
  issue's own acceptance criteria (kept out of this file — see the Linear
  issue text, not git) are real, existing production `AW-ChatSessions` rows —
  verified read-only. The mechanism (`loops/eval/agentModeReplayFixtures.ts`)
  is fully built and tested, but populating it with the REAL transcripts
  means copying a real customer's verbatim conversation content into
  permanently-committed, CI-gating git history, readable by every future
  clone and by Argusoft's external contractors forever. That's a
  data-exposure call under `autonomous-execution-and-merge.md`'s
  database/data-plane gate ("a change that can... expose... existing stored
  data"), not a code call — filed as ENG-1314 (blocks ENG-1312) with three
  concrete options + a recommendation rather than decided unilaterally. The
  lesson: "no live third party" and "no data-plane change" are necessary but
  not sufficient for MOCKABLE — check whether the fixture DATA ITSELF is a
  live customer's content before assuming the classification holds.
  Separately (CodeRabbit, PR #2443): the real session IDs, customer/org
  names, and quoted request text don't need to wait on that decision either
  — they aren't the transcript content ENG-1314 is scoping, so
  `agentModeReplayFixtures.ts`'s fixtures use neutral synthetic `id`/`label`
  values instead, independent of how ENG-1314 resolves.

## ENG-973: the quota gate was one layer above what MCP actually calls (2026-08-08)

`/api/emma/*` is 59 routes (now 60 counting a PATCH the source-level regex sweep missed) and none
of them checked token usage. Findings from the investigation, because the shape of this mistake
generalises:

- **The guardrail and the logic sat on different layers.** `checkTokenUsage` appears 3x in
  `controllers/agentModeController.ts` and 0x in `services/agentModeService.ts`. The `/api/emma/*`
  routes are thin delegates *to the service*. The design intent — stated at the time as "route
  everything through agentModeService so external callers cannot bypass Emma's controls" — was
  therefore never true: delegating to the service hands over the tool logic and skips the
  controller where the control lives. A protection is only inherited by callers that go through
  the layer it lives on.

- **Do not enforce at N call sites when N grows.** The obvious fix was 59 `checkTokenUsage` calls.
  That reproduces the bug at route 60. Enforcement is one router-level middleware plus an explicit
  `EMMA_ROUTE_BUDGET` classification, with unclassified routes failing closed to metered and a
  contract test that reads the router's own stack. That test found `PATCH /work-plans/status`
  within a minute of being written — a route a `grep` for `router.(get|post|put|delete)` had
  silently skipped. Enumerate from the runtime object, not from the source text.

- **A borrowed `node_modules` produced 18 fake type errors.** The worktree symlinked
  `backend/node_modules` to the primary checkout, whose `package.json` predates the
  `@opentelemetry/*` dependencies on `main` (0 references vs 5). `npm run typecheck` reported
  errors in `observability/tracing.ts` and `twitterService.ts` that had nothing to do with the
  change. Per ENG-731: check the environment before believing an unexplained red. Unlink (never
  `rm -rf`, which would follow the symlink into the primary checkout) and `npm ci`.

- **Adjacent finding, filed as ENG-974.** `internal: true` on an MCP tool filters `tools/list` but
  `registry.execute()` never checks it, and `security.mcpServer.test.ts:199-216` asserts that on
  purpose: *"if a tool name is known, it can be called. The real defense is that external clients
  never discover internal tool names."* The ten hidden names include `generate_image`,
  `send_email` and `google_search_web`. They are hidden because they cost money or send something
  outward — so this fix bounds the cost half of that exposure by metering the REST routes those
  tools self-call. The entitlement half remains a decision, because closing it means rewriting a
  test that deliberately asserts the opposite.

- **The March 2026 IDOR report is genuinely closed.** `c03713f46` prevents external clients from
  overriding `userId`, and section B of `security.mcpServer.test.ts` regression-tests it (17/17
  green). The cross-account vector is fixed; what remained were the cost and entitlement holes
  above, which are different bugs wearing its reputation.

## ENG-837: EB accepts a deploy and rejects it later, so "no error" from update-environment proves nothing (2026-08-03)

Production was undeployable for ~17 hours on 2026-08-01 and nobody noticed. The deploy job itself
ran for 2700s and then reported a generic timeout. Investigation findings:

- **`update-environment` returning 0 does not mean the deploy was accepted.** EB validates
  asynchronously. PR #2237 changed resource configuration (`.ebextensions` ALB `IdleTimeout`) and
  instance configuration (`.platform/nginx` + app bundle) in one deploy, which the **immutable**
  deployment policy forbids. EB took the request, rejected it afterwards with `Cannot update
  resource configuration and instance configuration simultaneously with immutable deployments`, and
  left the environment `Ready` on its previous version. Every synchronous signal `eb-deploy.sh`
  checked was healthy.
- **`Ready` on the previous version is a terminal rejection wearing a healthy face.** The verify
  loop polled for `Status=Ready AND VersionLabel=ours`, saw `Ready` with the *old* label, and
  treated it as "not there yet" forever. It is not a slow success: EB has finished, by declining.
  This is the same false-green family as ENG-757 — a check that cannot distinguish "not yet" from
  "never".
- **The reason was in the EB event log the entire time.** `describe-events --severity ERROR` carried
  the exact sentence. Nothing read it, so the failure was misattributed twice to the ENG-777
  autoscaling race — a diagnosis that is usually right (an ephemeral instance is present ~36.9% of
  the time) and was wrong here. A generic "deploy failed" with no classified reason invites exactly
  that.
- **ALB access logs are disabled on prod**, so the per-request forensics path does not exist. Use
  the per-status-code CloudWatch metrics (`HTTPCode_ELB_5xx_Count` split by code) instead — that is
  what settled ENG-846's 502-vs-504 question when the access-log route turned out to be unavailable.
- **Per-PR evidence is necessary and not sufficient.** ENG-757 shipped a gate proving a PR's checks
  really executed against its head, and it worked, and it still let merges land into a trunk that
  could not ship. Nobody was checking the destination. `trunk-deploy-state.sh` closes that.
- **The narrow terminal-pattern list is deliberate.** Failing on any ERROR event would kill
  recoverable deploys (instance replacement, health-check flaps), and a gate that rejects legitimate
  deploys gets switched off within a week. Non-terminal events are logged instead, which is itself
  the fix for the misattribution above.

Open: alerting (AC1) still needs a Slack credential in CI — none exists today, so a failed prod
deploy is still discoverable only by an agent reading `gh run list`.

## ENG-757: the stale run was at the current head SHA, so SHA-binding would have confirmed the false green (2026-07-31)

agentweb#2221 spent ~30 minutes displaying "checks passing" while no check could run against it at
all. The obvious reading — "stale evidence, so bind evidence to the head SHA" — is wrong, and
building that would have shipped a gate that endorsed the exact bug it was written to catch.
Investigation findings:

- **The head SHA never changed, so the misleading run was at the current head.** The conflict on
  #2221 was created by the *base* moving (#2220 merged, colliding on `dev.md`), not by anything
  happening on the PR branch. A head-SHA staleness check compares the run's `head_sha` to the PR's
  `headRefOid`; here they matched. The check would have passed and reported "verified at current
  head". SHA-binding is necessary but nowhere near sufficient.
- **The real defect is the question `gh pr checks` answers.** It answers "did anything fail?" A
  skipped job has not failed, so an all-skipped run is green. Verified live 2026-07-31:
  `gh pr checks 2231` exits **0** on a draft PR whose seven check-runs are six `skipped` plus one
  `success`, and exits **0** on #1814, which is non-draft and `CONFLICTING` right now. Both were
  read as green by the merge procedure in `AGENTS.md`.
- **A conflicted PR cannot schedule a run, which is why the window persists.** GitHub cannot build
  `refs/pull/N/merge` without a mergeable ref, so neither `ready_for_review` nor `synchronize` can
  start a workflow. The ENG-361 fix (`tests.yml` re-runs on `ready_for_review`) is real but cannot
  fire here — there is nothing for it to schedule. The PR keeps displaying whatever ran last.
- **The fix is to invert the question, not to add a third special case.** Requiring positive proof
  that something *executed* against this exact head collapses conflicted / no-run / draft-run /
  unreadable-payload into one rule, because none of them can produce execution proof. Absence of
  failure is not evidence of success. `.github/scripts/merge-evidence.sh` exits 0 PASS, 1 FAIL,
  2 PENDING, 3 NO_EVIDENCE, 4 unreadable.
- **`Require Greptile Review` is the only job that can tell a draft skip from a path-filter skip.**
  `tests.yml` gates the backend jobs on `backend == 'true' && draft == false`, collapsing both
  reasons into one `if`, so both render as `conclusion: skipped`. That one job is gated on
  `draft == false` alone. Discriminator skipped means a draft run; discriminator executed means
  every other skip is a path filter working correctly. The invariant is now asserted against
  `tests.yml` by `merge-evidence.test.sh`, so adding a path filter to that job fails loudly rather
  than silently disarming the distinction.
- **The gate has to live outside CI.** A check-run cannot report on the absence of check-runs, and
  the conflicted PR that most needs reporting on is precisely the one that cannot schedule the job
  that would report it. This is why ENG-757 is a CLI an agent runs, not another required check —
  the same reason ENG-734/743 could not be fixed from inside the deploy job's own success signal.
- **Two bugs in this gate's own first draft were caught by its tests, both false greens.** Using a
  tab as the `read` field separator collapses runs of tabs (tab is IFS whitespace), so two
  consecutive empty fields shifted every later field left and the reason strings described the wrong
  jobs; and one `join` separator was left empty, concatenating the counts so every numeric
  comparison silently failed and the verdict came out `PASS`. Both are why the suite asserts on
  reason-string *content*, not just exit codes. Fields are joined on US (0x1f) now, which is not
  IFS whitespace, so empty fields survive.
- **Live divergence measured across 8 open PRs:** three disagreed with `gh pr checks`, all in the
  safe direction — #1814 (non-draft, CONFLICTING) green to NO_EVIDENCE, #2231 (draft) green to
  NO_EVIDENCE, #1790 green to NO_EVIDENCE (its last run predates the `Require Greptile Review` job,
  so it has no comparable evidence and fails closed). #2233/#2227 PASS with path-filter skips named,
  #2234/#2226 FAIL, #2235 PENDING — all matching the old signal where the old signal was right.

## ENG-281: the Unipile liveness probe existed but was skipped on the path that mattered (2026-07-30)

Sue Xu's LinkedIn Outreach account reported connected while its Unipile session was dead, and every
`linkedin_outreach` action failed with the same opaque disconnect error. The state-surfacing half of
the report was already fixed (`eea9e4604`, 2026-07-01: `list_connected_accounts` derives `is_active`
from a live probe rather than from a `Number.MAX_SAFE_INTEGER` token expiry that never expired, and
the portal renders a Reconnect action off the same source). What remained was the second ask —
fail fast rather than late. Investigation findings:

- **Detection was purely reactive.** `linkedinOutreach` fired the real Unipile call, waited for a
  401, and translated the error. So every action on a dead account burned a full round-trip before
  failing, and a scheduled/automated run repeated that per recipient — which is what made the
  reported session look like a hang rather than a config problem.
- **The probe already existed and was already used — just not on this path.** `isAccountConnected`
  (10-minute cached, timeout-bounded, two Unipile calls) is applied inside `resolveAccountId`, so
  the *fallback* resolution path was covered. It was never applied when the caller passed an
  explicit `account_id` — which is the normal path, because the agent gets that id from
  `list_connected_accounts`, the very tool that already knows the account is dead. The check and
  the knowledge were one function call apart and never met.
- **Write actions were weaker than read actions, which is backwards.** `send-invite` /
  `send-message` / `send-inmail` got an ownership check but no liveness check, while
  `search-people` at least got one via the fallback path. The more consequential action had the
  weaker preflight.
- **The 10-minute probe cache needed an invalidation edge.** A session can die inside the cache
  window, so preflight alone would keep waving it through until expiry. The reactive 401 handler
  is retained as the backstop and now calls `clearStatusCache`, so the next attempt re-probes
  instead of trusting a stale positive.
- **Two copies of the disconnect guidance were about to exist.** Both paths now return one shared
  helper, so the preflight and the reactive handler cannot drift into telling the user two
  different stories about the same account.

## ENG-399: DATASET LIST was broken by the per-pixel edge, not the account-level one (2026-07-30)

`call_meta_marketing_api { entity_type: DATASET, action: LIST }` failed every time with
`(#100) Tried accessing nonexisting field (datasets)`, making Meta pixel discovery impossible
in-product. The ticket's stated hypothesis — account-level entry point broken, per-pixel edge fine —
was **exactly inverted**. Investigation findings:

- **`listPixels` was already correct.** It calls `GET /act_<id>/adspixels` (`metaService.ts`) and had
  a test asserting that URL. The failure was one layer down: `manageMetaDatasets` LIST then looped
  **per pixel** calling `listDatasets(pixel.id)` → `GET /<pixel_id>/datasets`, an edge Graph v25
  removed when Meta unified pixels and datasets. A pixel now IS its own dataset.
- **One dead edge killed the whole call because `handleError` rethrows.** `metaService.handleError`
  ends in `throw enhancedError`, so the first per-pixel rejection propagated out of the `for` loop to
  `manageMetaDatasets`'s catch and returned `success: false`. An account with N pixels also issued
  N doomed round-trips before failing. The fix removes the loop entirely: zero per-pixel calls.
- **This codebase had already reached the right answer elsewhere and never back-ported it.** The
  lander pixel resolver (`resolveMetaPixelForUser`) documents "Meta unified pixel + dataset in Graph
  v25, so the per-pixel `listDatasets` edge (broken, see ENG-399) is never called at all", and
  `metaService.pixelResolution.test.ts` pins that workaround. The tool path just never adopted it.
  Worth checking for this shape generally: a known-broken dependency routed around in one call site
  while every other caller keeps hitting it.
- **Both existing test suites passed while the feature was 100% broken in production**, which is why
  this survived from the 2026-07-19 RankAI incident. `agentModeService.metaDatasets.test.ts` mocked
  `metaService.listDatasets` wholesale, so it asserted against a fabricated success the real edge
  could never return. Worse, `metaService.test.ts` asserted the request URL contained
  `pixel_1/datasets` — a test whose only content was **pinning the bug**. Both were agent-written
  against the implementation rather than against a behavioral contract; this is the exact failure
  mode `loop-acceptance-tests.md` exists to prevent, and the reason the new regression test asserts
  the dead edge is *never called* rather than asserting its mocked return value.
- **The tool description was also lying**, promising "all pixels and their associated datasets
  (server event data sources)" — an entity relationship that no longer exists. Corrected to state
  that each pixel id doubles as its `dataset_id`, since a description that describes a removed
  Graph shape sends Emma looking for a second identifier that is never coming.

## ENG-664: per-user X cost breakdown on the admin user card + LLM-only fix (2026-07-30)

**LLM-only fix.** The user card's "LLM Cost" 📊 opens `getUserOrgUsageRollup` (gross burn vs the LLM
quota counter). Because X writes to the same ledger, X rows were leaking into that rollup — inflating
gross burn and depressing "charged coverage" (X never deducts from the quota counter). Fixed by filtering
`!isVendorEntry(row)` at the query, so gross burn / byModel / members are purely LLM. Per-unit vendor
rows (X/Twitter, v0, …) are excluded; token-priced image/video (recordUsage, no `unit`) stay in — they
DO count toward the cap.

**Per-user X breakdown (Option A).** New `getUserXBreakdown(userId, start, end)` (shares
`groupTwitterRows` with `getXAllocatedTotals`) → `GET /api/admin/users/:userId/usage/x-breakdown`. A new
"X (Twitter) Cost" stat + 📊 on the user card opens a modal (`XCostBreakdown`, bars + table, reusing the
LLM modal's table/bars toggle) showing that user's X spend by tool, labelled **allocated** and noting it
is observe-only (not deducted from any cap). Mirrors the LLM Cost affordance without borrowing its
quota framing.

## ENG-664 (Option B): attribute X ledger to the acting user, bill the owner (2026-07-30)

Aligns X metering with the LLM rail. Previously the X shadow ledger keyed on the account OWNER
(`ownerUserId` is all `twitterService` receives, so token refreshes write back to the owner). The LLM
rail instead records the ACTING user in the shadow ledger and rolls billing to the org owner. For an org
where several members share one X account, owner-keying collapsed all their spend onto the owner — you
couldn't see which member drove it.

Option B records `userId = acting member` and `billingUserId = account owner`, matching LLM. Since
`twitterService` methods only receive `ownerUserId`, the acting user is carried via an
`AsyncLocalStorage` (`runWithXActingUser`) that the two Emma dispatchers (`twitterManagePost`,
`twitterOutreach`) and the `TwitterAdapter` (createPost/listPosts) bind. `meterCall` reads it:
`userId = actingUserId ?? ownerUserId`, `billingUserId = ownerUserId`. An UNWRAPPED path (some future
caller) has no acting user in context and safely falls back to owner-attribution — never an error.

Knock-on: `@handle` enrichment must resolve through the OWNER, so `buildXAccountBreakdown` now enriches
via the row's `billingUserId` (owner), not `userId` (acting member). Pre-Option-B rows have
`billingUserId === userId`, so it still works. This also pre-wires ENG-703 drawdown, which will charge
`billingUserId` (the owner), exactly like the LLM cap already does via `resolveBillingUserId`.

## ENG-664: meter X (Twitter) API usage + cost per account and per tool (2026-07-29)

Builds directly on the [[ENG-693]] vendor dimension — no new table, no new pipeline.

**Metering.** `twitterService.withRetryOn401` is the single chokepoint every data-plane
X call already funnels through (it has `ownerUserId` + `accountId` in scope). It now takes a
**required** `meter: TwitterMeterSpec` arg (`operation`, optional `requiredScope`, `units(result)`,
`text`). On each successful call `meterCall()` fires `recordVendorUsage()` into `AW-UsageRecords`:
- `userId  = ownerUserId`            → per-USER cut ("who spent our X budget")
- `model   = "twitter:{operation}"`  → per-TOOL cut (recordVendorUsage namespaces the model slot)
- `feature = "x-account:{accountId}"`→ per-ACCOUNT cut (the connected account)

Making `operation` a required parameter means an uninstrumented call path **fails to compile**
(acceptance criterion 3 — attribution is never silently dropped). Metering is fully guarded and
fire-and-forget: it never fails or slows an X call (the units/pricing computation is wrapped, and
`recordVendorUsage` swallows its own errors).

**Cost is ALLOCATED, never measured.** X exposes no per-call price at runtime (the rate-limit
headers `twitter-api-v2` returns carry quota, not dollars), so `utils/twitterPricing.ts` applies X's
published pay-per-use rate card (docs.x.com, effective Apr 2026): post-create $0.015 ($0.200 with a
link), post-read $0.005/resource, user-read $0.010, owned-read $0.001, DM-read $0.010, DM-create
$0.015; interaction writes (like/follow/retweet/block/mute/delete) are recorded at $0 since X
publishes no price. Rows carry `costSource: "allocated"`.

**Reconciliation caveat (acceptance criterion 2).** X charges a repeat read of the SAME resource
within a UTC day only once; we do not track resource ids, so a computed total is an allocated
UPPER BOUND — it reconciles as `>=` the X console's billed usage, not to the cent. Exact
reconciliation would need per-resource-id dedup (follow-up, not this PR). The partner-portal view
labels X figures "allocated" and shows the dedup caveat so the number never reads as measured.

**Surface.** New admin **Usage & Cost** tab (`partner-portal/.../UsageCostByUserTab.tsx`) renders the
already-existing `GET /api/admin/usage/cost-aggregation` `topUsers` breakdown as a per-user table with
a provider filter (All / LLM / X / other vendors) and an expandable per-tool breakdown. X spend flows
into it automatically because it lands in the same ledger — no backend aggregation change was needed.

**Handle-resolution sub-calls are metered too (AC1).** Several ops (`follow`/`unfollow`/`block`/`mute`
family, `send_dm`, `get_user_tweets`, `get_dm_conversation`, and `list_followers`/`list_following` when
a handle is passed) make an internal `userByUsername` handle→id lookup — a separate billable **user-read**
($0.010). The meter spec carries `extraUserReads`, and `meterCall` records a companion `resolve_handle`
row so no billable sub-call is left unattributed. `list_followers`/`list_following` for the OWN account
(no handle) resolve nothing, so `extraUserReads` is 0 there.

**Billing-cycle month math.** `currentXBillingCycle` clamps the reset day to the target month's real
length (a `cap_reset_day` of 29–31 must not overflow a short prior month, e.g. Feb 31 → Feb 28) and rolls
the year back at January. Without the clamp the derived allocated window could invert (start>end) and 500
the reconciliation panel for any account whose reset day ≥ 29 early in a month.

**Typed X 402 (credit exhaustion).** X errors carry the HTTP status on `.code`, and the tool taxonomy
only knew `.status`/`.statusCode` and had no 402 branch — so a depleted-wallet 402 (ENG-604/633/662)
classified as a generic `Error` and a mid-run 402 could read as success. Fixed end to end:
- `withRetryOn401` converts any X 402 into a typed `XCreditsExhaustedError` (name stable, `code=402`) at
  the single chokepoint, logging an `X_CREDITS_EXHAUSTED` marker for ops alerting. It is non-retryable and
  never metered (the call did not succeed).
- `classifyToolErrorClass` gains a stable `payment_required` class, reached three ways: status 402 (now
  also reads `.code`, guarded to the 100–599 HTTP range), the typed error's name, and "HTTP 402" in text.
- `classifyToolFailureType` maps `payment_required → config` — a billing/quota gap, excluded from the
  tool-bug rate but visible and clustered, never silently a success.

**Reconciliation (AC #2) — built (on-demand).** X's dedup ("same resource once per UTC day") is
**app-wide** (the credit pool is AgentWeb's one Developer App), so per-user cost can only ever be
*allocated* load attribution, not a fair split of the billed figure. So reconciliation is two numbers,
never conflated: **allocated** (our ledger, above, an upper bound) for "who drives spend", and
**measured** pulled live from X's own `GET /2/usage/tweets`. The shared app's Bearer token lives in the
`{dev,prod}/AgentWeb/Twitter` secret (now exposed on `TwitterCredentials.bearerToken`);
`twitterService.getXProjectUsage()` fetches app-only (never metered — not a user call) and returns
`projectUsage`/`projectCap`/`capResetDay`. `GET /api/admin/usage/x-reconciliation` derives the current
billing cycle from `capResetDay` (`currentXBillingCycle`), sums our allocated X ledger over that same
window (`getXAllocatedTotals`, filtered to `twitter:*`), and returns measured beside allocated + the
dedup delta + a cap gauge. Rendered as the "X API reconciliation" panel in the admin tab; an
X-unreachable failure degrades to a warning (502) without breaking the tab.

Note what `/2/usage/tweets` covers: **post-read consumption against the 2M cap** — X's authoritative,
deduped count. It does NOT report writes or dollars, so `measuredDerivedCostUsd = measured reads × $0.005
+ our directly-counted non-read allocated`; that's a *tighter* dollar figure than allocated-from-log
because the read count is already deduped. A `(utcDay, resourceId)` dedup table would give exact per-user
*billed* numbers but costs one write per resource read — deferred unless finance needs per-user billed
(not load) figures. A scheduled poller for historical snapshots + low-credit alerting is the next step.

**By-account cut + @handle enrichment.** Each X call records `feature = x-account:{accountId}`, so the
cost aggregation groups those rows into `byXAccount`. There is **no global GSI on account_id** (connected
accounts are nested in the User record), so a scan-free handle lookup needs the owning userId — which the
ledger row's partition key already carries. `buildXAccountBreakdown` groups by accountId, tracks per-user
spend, and best-effort resolves the @handle via `getAccountById(accountId, heaviestSpenderUserId,
'twitter')` (the heaviest spender is the owner in the common case) → `config.username`. This mirrors the
existing `topUsers` email enrichment: a miss (e.g. an org-shared account the heaviest caller doesn't own)
yields `handle: null` and the UI falls back to the raw accountId. Never fails the aggregation. The admin
tab renders `@handle` (raw id alongside) via `xAccountRows`/`xAccountLabel`, falling back to the
client-side `byFeature` derivation if the server omits the enriched cut.

**Fair per-user drawdown (the ENG-664 "eventually" goal) — design only.** Because dedup is app-wide,
enforcing a cap on raw allocated numbers over-bills shared reads. The right mechanism is **proportional
settlement**: keep the live ledger allocated, then a periodic settlement pulls the measured app total,
computes `factor = measured / allocated`, and charges each org owner their allocated-weighted share so
`Σ charged = measured` exactly (reconciles) and each pays in proportion to load (fair). Applied at the
org-owner level (`resolveBillingUserId`, as LLM already does) and kept behind `ENFORCE_COST_CAP=false`
(observe-only) until ENG-703 defines Emma-Credit pricing. `recordVendorUsage` deliberately does NOT call
`incrementUserTokenUsage` today — X spend is visible but does not draw down any cap yet.

## ENG-746: the closure gate was blocked by an env var nobody set (2026-07-31)

`GET /api/admin/loops/reliability-trend` returned `{count: 0, snapshots: []}` on every window, so
closure-gate check 4 ("burn-in clean, `failedRunRate`/`degradedRunRate` no worse than the
pre-release snapshot") failed for every issue and nothing on the board could close. Fourteen items
were queued behind it. Investigation findings:

- **It is NOT the ENG-593/CaptureGate problem, despite looking like one.** Worth stating because
  the two are easy to conflate: both are "the loop never reaches a verdict". The reliability trend
  is written by `runAgentReliabilitySnapshot` (`backend/src/cron/agentReliabilitySnapshotCron.ts`),
  which is pure telemetry — it reads raw `agent-mode` events from `Dev-AW-LoopEvents` and aggregates
  them under `loopId='agent-reliability-daily'`. It never calls `pollDecision()`, never touches
  `CaptureGate`/`ApprovalGate`, and never reads the `LearningStore`. ENG-593 governs the *learning*
  verdict, which is what makes `/loops/health` report `pending_approval` — a different pipeline.
  Fixing this needed no ApprovalGate flip.
- **The writer had never run, once, ever.** `server.ts` gated the cron behind
  `AGENT_RELIABILITY_SNAPSHOT_ENABLED === 'true'`, and that variable is absent from
  `Agentweb-backend-env-prod-3` while `AGENT_MODE_LOOP_ENABLED`, `AGENT_RUNTIME_SPINE_ENABLED`,
  `AI_EVAL_LOOP_ENABLED`, `AI_READINESS_LOOP_ENABLED` and `ONBOARDING_LOOP_*` are all `true`. It was
  simply missed when the feature shipped. Measured live: **121,389** raw `agent-mode` events,
  **0** rows in the `agent-reliability-daily` partition. The source data was never the problem.
  A 7-day window reading `count: 0` meant "never written", not "quiet week" — as suspected.
- **The zero-denominator guard is a false-green generator.** `computeReliabilitySnapshot` returns
  `degradedRunRate: 0` and `failedRunRate: 0` when `totalVerdicts === 0`. A window in which *nothing
  ran* therefore renders as a flawless 0% failure rate — strictly better than any real baseline, so
  a naive comparison reads a dead window as the best possible result. This sat directly in check 4's
  path. `evaluateBurnIn` rejects a sub-`minRunCount` window on **both** sides of the comparison
  rather than comparing its rates. Same family as ENG-734/743/754/777: a control reporting a value
  it cannot substantiate.
- **Turning the cron on is necessary but not sufficient.** Writing only "today" leaves one snapshot
  with no pre-release baseline, so check 4 stays `insufficient_data` for another day; and the cron
  first fires at the next 17:45 UTC, so a fresh deploy reads empty until then. Hence `catchUpDays`
  (fills recent dateless days from events already stored, one event-partition read regardless of
  span) plus a boot seed that runs if and only if the partition is empty.
- **`passesClosureCheck4 === (verdict === 'clean')` is the whole safety property.** Every failure
  path — no snapshots, no baseline, no post-release reading, too few runs, unparseable `releaseAt`,
  a 500 — returns `insufficient_data`/`false`. There is deliberately no boolean-only form of the
  result and no fourth "unknown" state a caller could coerce.
- **Tolerance is a deliberate 2 points, not a weakening.** Daily rates move a point or two on
  ordinary variance, and a zero-tolerance `<=` would mark healthy days `regressed` and rebuild this
  same deadlock in a new shape. It only ever decides `clean` vs `regressed`; it cannot turn missing
  data into a pass, because the run-count gate runs before any comparison.

## ENG-754: the Greptile 5/5 bar is now a check, not a habit (2026-07-29)

`Require Greptile Review` used to poll Greptile's own `Greptile Review` check-run and pass on
`conclusion=success`. Greptile marks that check-run success for **every completed review regardless
of confidence score**, so the job was green on four below-bar reviews in one day — agentweb#2215
(4/5), #2219 (3/5), portal#985 (3/5, twice) — each carrying a live P1. All four were caught only
because an agent chose to open the comment and read the score. Investigation findings:

- **Greptile publishes no structured score. Checked all four plausible surfaces before parsing
  prose.** The check-run's `output.summary` is `"Greptile has reviewed the Pull Request.\n\nN files
  reviewed, M comments added."` with `output.text: null`; its PR review object is
  `state: COMMENTED` with an empty body; the commit status API carries no Greptile context; and
  Greptile's public API is repository query/indexing, with no credential of ours in Secrets Manager
  anyway. The comment body is the only place the verdict exists, so the gate parses it strictly and
  fails closed rather than pretending a structured source exists.
- **Greptile edits its original comment in place — it never posts a second one.** On portal#985 a
  single comment advanced `Reviews (2)` → `Reviews (3)`, each with a different `Last reviewed
  commit`. So `id`, `created_at` and the comment *count* are all stable across re-reviews and are
  useless as freshness signals; only `updated_at` and the body move. Anything waiting for a *new*
  comment waits forever. This is also why the earlier worker on #985 misread the state: it saw 3/5
  against a superseded SHA and could not tell a stale read from a fresh verdict, because the comment
  was the same object either way.
- **"Score present but SHA mismatched" must resolve to pending, never to pass or fail.** The body's
  `commit/<40-hex>` pointer is the only authority on which commit a score belongs to. The gate
  compares it to the head SHA positionally and never against `$REPO` — the footer URL lower-cases
  the org (`github.com/agentwebpro/agentweb/...`) while `github.repository` is `AgentWebPro/agentweb`.
- **A lenient parser would have recreated the same bug one layer down**, so every ambiguity fails
  closed and dumps the raw body: no verdict footer for our head, a footer with no 40-hex pointer,
  zero or multiple `Confidence Score` values, a non-`/5` scale, a score outside 0–5, or a non-JSON
  payload. In particular a missing pointer must never fall back to "the score I found".
- **The gate runs the PR's own copy of the script**, per the ENG-743 lesson that whatever gates
  merges has to gate its own changes — this PR's merge was blocked by the gate it adds. The
  corollary is worth stating plainly: a PR can edit `greptile-gate.sh` (or `tests.yml`) to neuter
  the gate for itself. That is a pre-existing property of every `pull_request` workflow here, not
  something this change introduces, and it is visible in the diff Greptile reviews.
- **The script's 20-minute deadline sits under a 25-minute step timeout**, so the gate always fails
  with a diagnosable message rather than being killed mid-poll — the ENG-734 shape of a step timeout
  undercutting the budget it is meant to contain, which is exactly what Greptile's own 3/5 review
  caught on #2219.
- **`Require Greptile Review` was not actually a required status check.** Branch protection on
  `main` required only `Detect changed projects`; the Greptile job merely gated the staging-deploy
  job. Acceptance criterion 5 (human merges gated identically) therefore needed the context added to
  branch protection, which this change does — code alone could not have closed it for humans.
- **Left alone deliberately:** `agentweb-customer-portal` and `agentweb-landing-page` keep Greptile
  advisory. Neither has a `greptile.json` or a `Require Greptile Review` job, so this mechanism does
  not reach them; porting it is Harsha's call (criterion 6).

## ENG-744: Claude 5 generation added to the model catalog (2026-07-29)

Added `anthropic.claude-opus-5`, `anthropic.claude-sonnet-5` and
`anthropic.claude-haiku-4-5-20251001-v1:0` to the registry, the ENG-683 profile map, and the
price book. Investigation findings:

- **A listed ACTIVE inference profile is NOT proof of account access, and the difference is
  invisible until runtime.** `list-inference-profiles` in us-west-2 reports
  `us.anthropic.claude-opus-5` and `us.anthropic.claude-sonnet-5` ACTIVE, but invoking either with
  the app's default credentials (992382574572) returns
  `AccessDeniedException: ... is not available for this account`. Both are only reachable from the
  **bearer-token account (231030591963)** — the same cross-account path Opus 4.8 already uses. Adding
  them on the strength of the profile listing alone would have shipped two picker entries that 403
  for every user. Always invoke before adding.
- **Haiku 4.5 is the opposite case and must NOT be given bearer auth.** It IS served on the default
  account, so it takes a normal `global.*` cross-region ARN and stays out of
  `BEDROCK_BEARER_TOKEN_MODELS`. The account assignment is per-model, not per-generation — there is
  no "Claude 5 goes to the bearer account" rule to lean on.
- **Opus 5 returns a `reasoningContent` block before its text block** (thinking is on by default on
  Opus 5, unlike 4.8/4.7 where omitting the `thinking` param meant no thinking). The Converse parser
  in `agentModeService` collects *all* `text` blocks and ignores unknown ones, so this is handled —
  but a parser that assumed `content[0].text` would silently return empty replies for Opus 5 only.
  Verified against live Bedrock via ConverseCommand, with and without a tool.
- **Opus 5 and Sonnet 5 reject `temperature` with HTTP 400 `"temperature is deprecated for this
  model"`** — hence `supportsTemperature: false`, matching Opus 4.8. Haiku 4.5 still accepts it.
  Confirmed empirically rather than inferred from the generation number.
- **Haiku 4.5's price key is a canonicalization trap.** `llmPricing` already had
  `anthropic.claude-haiku-4-5`, but the registry id is
  `anthropic.claude-haiku-4-5-20251001-v1:0`, and `canonicalModelId` only strips a trailing bare
  `-YYYY-MM-DD` — not `-20251001-v1:0`. Without its own key the lookup misses and `getModelPrice`
  returns null, which the ledger books as $0. The pre-existing key covers a *different* id than it
  appears to.
- **`gemini-3-pro-preview` was withdrawn by Google on 2026-03-09 and we kept serving it for ~4.5
  months.** A live probe returns 404 `"This model models/gemini-3-pro-preview is no longer
  available."` while it was still listed by `GET /api/agent-mode/public/llm-models`, so every user
  who picked it hit a hard failure. **Removed from the registry** under explicit authorization
  (recorded on ENG-744 and in the PR body) — ENG-744 AC #7 forbids *silent* removal, not documented
  removal. Migration target is `gemini-3.1-pro-preview`. The price entry is intentionally retained.
  The signal was already in the tree and nobody joined it up: `llmPricing.ts` carried
  `// DEPRECATED 2026-03-09` and a registry comment noted the id 404s for the *vision* path — but
  neither was generalized to "this model is gone everywhere".
- **A model can 404 on a real call while still appearing in Google's `ListModels`.**
  `gemini-3-pro-preview` did exactly this. Discovery endpoints are therefore not evidence a model
  works — verify by invoking. The same asymmetry runs the other way: Google enforces published
  shutdown dates inconsistently (two image previews past their stated date still return 200), so
  "it still responds" is not evidence of safety either. Trust the published date in both directions.
- **The Gemini Pro line is not behind — Google has not shipped one.** `gemini-3.1-pro-preview` is
  the newest Pro in the live catalog; there is no 3.5/3.6 Pro despite 3.5/3.6 Flash existing. The
  "Pro lags Flash" reading of our catalog is Google's release cadence, not our drift.
- **Live voice is healthy; the `generateContent` 404 against it is a probe artifact.**
  `gemini-3.1-flash-live-preview` only advertises `bidiGenerateContent`, the WebSocket method
  `liveVoiceService` actually uses. It is not withdrawn. It does, however, have **no GA successor**
  in the catalog — as does `gemini-3.1-pro-preview` — which is the live exposure to watch ahead of
  the 2026-10-20 Gemini platform migration.

## ENG-743: the staging deploy gate now has to observe the deploy (2026-07-29)

`backend-staging-deploy` in `.github/workflows/tests.yml` now calls
`.github/scripts/eb-deploy.sh` — the script ENG-734/#2219 already shipped and proved — instead of
its own inline `|| echo "...continuing..."` block plus a readiness wait that only looked at `Status`
and `Health`. Investigation findings:

- **This was the worse half of ENG-734, because the merge gate cites it.** Production's false green
  misreports a deploy that already happened. Staging's false green is *upstream of the decision to
  merge*: `autonomous-execution-and-merge` counts "staging deploy passed" as end-to-end evidence, so
  a swallowed `update-environment` let a backend PR merge on evidence of a deploy that never applied.
  Every backend merge today rested on this signal.
- **Path filters made the fix unprovable, which is why #2219 deliberately skipped it.** The job is
  filtered on `backend/**`, so a PR that only touches `.github/**` never runs it — a rewritten deploy
  path would have shipped unexercised, and the first thing to exercise it would have been an
  unrelated backend PR. The filter is now the fix: `.github/workflows/tests.yml` and
  `.github/scripts/eb-deploy.sh` count as backend changes, so **whatever gates backend merges gates
  its own changes**, and this PR runs the job it rewrites. That property is permanent, not a
  one-off for this issue.
- **The version label did not identify a build, so asserting on it proved nothing.** Staging labelled
  every deploy `backend-<date>-pr<N>`, identical across all of a PR's pushes and reusing the same S3
  key. So `create-application-version` hit the tolerated already-exists path, the S3 object was
  silently rewritten under a label EB had already served, and — the real hole — the environment was
  *already reporting that VersionLabel before the run started*. "Ready on our version" would have
  been satisfiable without a deploy: the fix would have inherited the bug it was closing. The label
  now carries the short SHA.
- **Staging and production share EB application `agentweb-backend`.** They also shared the label
  namespace, so a same-day staging deploy for PR N and the production deploy after merging PR N
  produced the same label and S3 key: prod's `create-application-version` hit already-exists and
  reused a version whose bundle staging had written. The SHA suffix removes that collision, so
  production now always creates a fresh version. `MaxCountRule` is enabled at 200 versions (201
  present today), so per-push staging labels churn that window faster rather than growing it —
  bounded, at the cost of some rollback depth in days.
- **Budget preserved, not extended.** The old steps allowed 5 min for the AWS calls plus 30 min of
  readiness polling. The script gets `EB_TOTAL_TIMEOUT_SECONDS=1800` under a 35-minute step timeout,
  so its own deadline always fires first and the log names the reason instead of the runner killing
  it mid-poll.

## ENG-630: Meta Insights `filtering` shape + preserved 400 detail (2026-07-29)

New pure module `backend/src/utils/metaInsightsFiltering.ts`, wired into
`callMetaAdsInsightsApiWrapper`. Investigation findings:

- **The reported `(#100) param filtering must be an array` is one of TWO defects sharing a root
  cause, and the unreported one is worse.** The guard was `...(filtering?.length && { filtering })`.
  A JSON *string* from the model has a truthy `.length`, so it went to Meta verbatim and got the
  reported 400. A bare filter *object* has no `.length` at all, so the key was **silently omitted**
  and Meta answered with whole-account rows — which the model then narrated as campaign-scoped
  numbers. An error is loud; a widened query is a confident wrong answer. Both shapes are now
  normalized, and anything unhonourable throws instead of being dropped.
- **Normalization happens before `getMetaCredentials`**, so a malformed filter costs neither a
  credential fetch/refresh nor an API call. The Insights path is an async report job (submit → poll
  up to 60×10s → page results), so a filter defect that reaches the wire is expensive.
- **`IN`/`NOT_IN`/`ANY`/`ALL`/`NONE` with a scalar value is the same shape defect one level down**
  and is lifted to a single-element list. An `IN` with an *empty* list throws rather than being
  forwarded: it can never match, so Meta would return a clean empty report for a question the user
  really did ask — the same silent-empty failure class as ENG-629.
- **`filtering` stays a native array in the POST body, not a JSON string.** The sibling `time_range`
  object already rides this same `axios.post` body as a real object and works, so the transport was
  never the problem — only the shape reaching it. No transport change was needed.
- **A Meta 400 was collapsing to axios's `"Request failed with status code 400"`.** Meta's actual
  explanation lives at `response.data.error` (`message`, `error_user_title`, `error_user_msg`,
  `code`, `error_subcode`, `type`). `describeMetaGraphApiError` surfaces it and returns `undefined`
  for a non-Graph rejection (socket hang-up, our own bug), so the caller keeps its own message
  rather than reporting a misleading Meta explanation. Sanitization follows the precedent set by
  ENG-629: `access_token=…` fragments and bare `EAA…` tokens are redacted, and `fbtrace_id` is
  never included at all.
- **Scoped around ENG-629 (PR #2211), in flight on the same file.** That PR edits
  `getMetaCredentials`, `listMetaAdsCampaigns`, and `listConnectedAccounts`; this one edits only
  `callMetaAdsInsightsApiWrapper`. Its `if (error.isMetaAuthError) throw error;` rethrow channel is
  preserved and pinned by a test, so the re-consent path added there is unaffected by the new error
  description. Neither PR masks the other's failure class.
- **Verification is mock-only, deliberately.** OPS-79 means our own Meta connection currently lacks
  `ads_read`, so no live Insights call is possible; the issue's AC5 forbids one regardless. Every
  assertion is against the request body we hand axios and the error object we hand back.
- **The filter `value` was the last unvalidated hop, and review caught it, not the tests.** The
  first cut validated `field` and `operator` but forwarded `value` verbatim, so a supported
  operator carrying an object or a nested array still travelled to Meta — the exact class of defect
  the module was written to stop, surviving inside the fix for it. Values are now asserted scalar
  (and each element of a list-operator value individually). Non-finite numbers go too: `NaN` and
  `Infinity` have no JSON representation and serialize to `null`, so they filter on a value nobody
  asked for. Generalizable: **when you add a boundary, enumerate every field crossing it — a guard
  that covers two of three fields reads as "validated" and is trusted like it.**

## ENG-693: vendor dimension on the existing usage ledger (2026-07-29)

Five optional non-key attributes on `AW-UsageRecords` (`provider`, `sessionId`, `unit`, `quantity`,
`costSource`) plus a `recordVendorUsage()` entry point delegating to the same `incrementUsage()`.
Findings that shaped it, for the eight metering slices blocked on this one:

- **A row is a DAILY AGGREGATE, not a call.** The sort key is `{date}#{model}#{feature}`, so N calls
  collapse into one item and every counter is an `ADD`. This is the single most load-bearing fact
  for anything downstream: a "usage entry" is a bucket, so any new attribute is either a counter
  (`ADD`) or a description of the bucket (`SET`). `quantity` is a counter. `provider` / `unit` /
  `costSource` / `sessionId` are descriptions, written `if_not_exists` so the first writer's value
  sticks instead of flapping between concurrent callers.
- **Same-key collision is the real hazard, and it was designed around, not fixed.** Two vendors
  writing the same `{model}#{feature}` on the same day would share one row and overwrite each
  other's `provider`. `recordVendorUsage` therefore namespaces the model slot as
  `{provider}:{operation}` — the sort key FORMAT is untouched (changing it is a real key change and
  out of scope) while making a cross-vendor collision impossible by construction. The residual case
  is narrower and still open: two providers serving an *identical model string* on the LLM path
  (`openai` vs `azure-openai` for `gpt-4o`). That is ENG-700's "derive the provider label from the
  client that served the call". Do not assume per-provider LLM splits are exact until ENG-700 lands.
- **`unit` is the discriminator between token-priced and unit-priced spend.** When `unit` is set,
  `incrementUsage` omits the token counters *entirely* rather than writing zeros — otherwise "this
  vendor does not bill by tokens" and "this call used zero tokens" are the same row. Consequence for
  readers: `UsageRecordRow`'s token fields are now optional. Every existing reader
  (`usageAnalyticsService` `toRow`/`addInto`/`aggregateBurn`) already coalesced with `|| 0`, so this
  was type-only — `npm run typecheck` is clean with no reader changes.
- **No backfill, and none is needed.** Every new attribute is optional, so a pre-change row stays
  valid. `isVendorEntry(row)` requires BOTH `provider` and `unit`, so a legacy row reports false and
  is never surfaced as a vendor entry costing $0 — its real token cost keeps reading from
  `costMicroUsd`. This is what keeps the slice clear of the data-plane gate.
- **`unit` is a DynamoDB reserved word.** All four descriptive attributes go through
  `ExpressionAttributeNames` for that reason; dropping the `#unit` alias produces a
  `ValidationException` at runtime, not at compile time.
- **No rate card here, deliberately.** `recordVendorUsage` records the dollar figure its caller
  supplies and states its provenance via `costSource` (`measured` = vendor-reported, `allocated` =
  our rate applied). Existing LLM dollars are stamped `allocated`, which they always were with
  nothing saying so. Choosing the allocated rates is ENG-703; making an unpriced unit fail loud is
  ENG-700. Neither is guessed at here.
- **`taskId` is still dropped at the write.** It is declared on `RecordUsageContext` and populated by
  call sites alongside `sessionId`, but ENG-693's scope names only `provider` and `sessionId`. Left
  as-is rather than widening the slice.
- **Not every descriptive attribute is safe to pin to a row — session was the exception** (Greptile
  P1). The `if_not_exists` "first writer wins" rule above is sound only when the attribute is
  *constant across every writer to that key*. `provider` / `unit` / `costSource` satisfy that because
  `recordVendorUsage` namespaces the model slot as `{provider}:{operation}`, so a row cannot mix
  vendors. `sessionId` does not: it is call-level, it is not in the sort key, and N sessions share one
  `{date}#{model}#{feature}` bucket whose counters accumulate all of them. So a stored `sessionId`
  reads as "this session owns this usage" while another session's tokens pile up underneath it —
  false for every session but one, and silently so. Neither `if_not_exists` (first) nor plain `SET`
  (last) fixes that, because the defect is the *name*, not the write mode. Renamed the stored
  attribute to `lastSessionId` under plain `SET`: the name now states exactly what the value is — a
  trace breadcrumb to the most recent contributing session, never an attribution key. The input field
  on `UsageRecordIncrement` stays `sessionId` (accurate: it is that call's session). Real
  session-granular spend needs the session in the sort key, which is a key change this slice
  deliberately excludes. Generalizable rule for this table: **before adding a descriptive attribute,
  ask whether it is single-valued for the whole key; if not, either it belongs in the key or its name
  must admit it is a sample, not a fact about the row.**

## ENG-705: unauthenticated share generate + unrate-limited duplicate could burn v0/LLM credits (2026-07-29)

Two cost-leak surfaces closed with primitives that already existed. Investigation findings:

- **The filing's AC 2 (attribution) was already satisfied — only the gate was missing.** The issue
  read as "these paths spend LLM budget with no usage gate **and no attributable user**". The first
  half was true, the second was not: `generateSharedResponse` passes `session.userId` into
  `generateSessionResponse`, which reaches `incrementUserTokenUsage(userId, ...)` in
  `agentModeService.ts`. Share spend has always been booked to the share **owner**. So the fix is
  one `checkTokenUsage(session.userId)` call, not a new attribution path or an anonymous-budget
  concept. Two of the new tests pass against pre-fix code by design — they are characterization
  tests pinning that fact so a future refactor cannot quietly lose it.
- **`checkTokenUsage` was already imported in `agentModeController.ts`** (used by the authenticated
  `/generate` path at the `usageStatus` check). The share gate is deliberately the *same* call in
  the *same* shape returning the *same* 429 — zero new imports, zero new concepts.
- **Gate placement matters for the session lock.** It sits inside the `try` that follows
  `tryClaimSessionGeneration`, so the existing `finally { releaseSessionGeneration(...) }` releases
  on the 429 path. Placing it before the claim would also have worked, but inside the try mirrors
  the authenticated path exactly and is covered by a regression test asserting the owner is not
  locked out of their own session after a visitor hits the limit.
- **Duplicate reuses the module's existing `rateLimiter`, deliberately sharing generate's quota
  bucket** rather than getting its own. A separate limiter would have let a caller drain 10
  generates *and* 10 duplicates. Sharing the map means duplicate cannot be used to obtain fresh
  quota — asserted directly.
- **`"view"` → `"edit"` on duplicate is net-subtractive.** Duplicate was a third authorization
  shape (deploy/iterate required `"edit"`, duplicate required `"view"`); it now matches iterate.
  The pre-fix test run proved the impact concretely: a view-only org member received `201` — a
  full v0 generation — on someone else's page.
- **Gotcha for anyone adding a dependency to `generateSharedResponse`:** five test suites drive it
  (`ishareModel`, `ishareAnonymousSender`, `agentModeSharing`, `sharingIntegration`,
  `interactiveShareExpiration`). The first four needed a `tokenUsageService` stub added; each was
  verified green on `origin/main` first so the failures were provably the new dependency, not a
  regression, and no assertion was changed. `interactiveShareExpiration` needs none — it exercises
  the expired-share 410 path, which returns before the gate.
- **Known limitation, unchanged by this PR:** the landing-page rate limiter is an in-process
  `Map`, so limits are per backend instance rather than global. Pre-existing; worth noting if
  ENG-666/ENG-694 metering makes cross-instance accounting a requirement.
- **The gate's first shape shipped a disclosure, and our own test hid it (Greptile P1, review of
  `1c0a078a`).** Mirroring the authenticated `/generate` 429 "exactly" was right for the *check*
  and wrong for the *response*: the authenticated path returns `tokenUsage: usageStatus` to the
  account that owns it, but this route sits before `authenticateToken`, so the same body handed
  any share-link holder the owner's allowance, bonus, effective allowance, billing month, dollar
  spend (`costUsed`), cost cap and enforcement state — the same object the authenticated
  subscription-usage endpoint serves. **Symmetry across an authentication boundary is not
  symmetry.** When copying a response shape, re-ask who the reader is.
- **The agent-written test asserted the bug.** It required the body to *contain* `tokenUsage`
  (`expect(body.tokenUsage).toEqual(expect.objectContaining({...}))`), so the leak was pinned as
  intended behavior and the suite went green over it — the exact failure mode
  `loop-acceptance-tests.md` exists to prevent, and it survived because none of the six
  human-written ACs constrain the denial body. The replacement asserts the ownership boundary
  instead: no `TokenUsageStatus` field may appear under any key, so a future re-add by spread or
  rename fails too. Worth remembering: a test written by whoever wrote the code will happily
  describe the code rather than the requirement.

## ENG-629: fail closed + prompt re-consent when a Meta connection lacks Ads scopes (2026-07-29)

Live signal: OPS-79 fired twice in 24h — the scheduled Meta Ads report on account
`922903076601160` failed with `(#200) Ad account owner has NOT granted ads_management or ads_read
permission`, while `list_connected_accounts` reported the account connected + active and the
unattended run produced a report with no data. Investigation findings that shaped the fix:

- **`BaseOAuthConfig.scopes` is not a capability signal for Meta — it is a copy of our own OAuth
  request.** `routes/metaAuth.ts` stored `scopes: flowCfg.scopes` after the token exchange, and the
  token response was only destructured for `{ access_token, expires_in }`. No `debug_token` or
  `/me/permissions` call existed in the marketing flow. So every Meta marketing connection records
  `ads_read` + `ads_management` regardless of what the user actually ticked at the consent dialog.
  **This is the trap**: a pre-flight gate reading `config.scopes` would have passed for exactly the
  account that is failing in production, and the whole fix would have been a no-op. The gate had to
  be built on a newly captured `granted_scopes`, mirroring the existing Gmail/YouTube/HubSpot field.
- **Capability is tri-state, not boolean.** `granted_scopes` present without an ads scope is an
  authoritative refusal; `granted_scopes` absent (every pre-existing record) is genuinely *unknown*.
  Treating unknown as "missing" would lock out every working legacy connection; treating it as
  "granted" reproduces the bug. `getMetaAdsScopeState` returns `granted | missing | unknown`, and
  only `missing` refuses work before calling Meta.
- **The soft-result shape was the actual user-visible defect.** `listMetaAdsCampaignsNew` caught the
  Meta error and returned `{ success: false, ... }` with no `campaigns` key, which reads to the model
  as "this account has no campaigns" — hence a clean-looking empty report instead of a failure. Meta
  auth errors already had a rethrow channel (`error.isMetaAuthError`); the scope error joins it, so
  it throws rather than degrading.
- **Self-heal closes AC3 for legacy records.** When Meta authoritatively refuses, we now write the
  learned grant back via the existing `updateAccountConfig` contract, so the *next* read fails at the
  pre-flight gate without another API call. Best-effort by design — a persistence failure logs and
  still surfaces the actionable error, never masking it. Re-consent overwrites `granted_scopes` at
  connect, so the record self-corrects; no cache invalidation logic was needed.
- **Scoped exclusions, deliberate.** Code 190 (expired token) and code 100 (validation — the
  `filtering must be an array` defect owned by ENG-630) are explicitly NOT classified as scope
  problems; misrouting either would hand the user the wrong remedy. Tests pin both.
- **Non-secret by construction.** Meta echoes access tokens and `fbtrace_id` into error strings, so
  the upstream error is attached as `cause` for logs and never interpolated into the message. One
  canonical message for every trigger, so this is "one actionable error", not a family of near-duplicates.
- **Self-review catch worth keeping.** The first cut of the self-heal wrote back the retained
  grant, which for a legacy record collapses to `[]` — and `[]` was mapped to `unknown`, not
  `missing`. So the pre-flight gate would have fallen through to Meta on every subsequent run,
  defeating AC3 for exactly the records that needed it. The original test ("persisted array has no
  ads scope") passed anyway, because `[]` trivially satisfies it. The fix is an explicit
  `ads_scope_revoked_at` marker that makes the refusal unambiguous, plus a behavioral test that
  feeds the persisted config back in and asserts the second read never calls Meta. Lesson: assert
  the *downstream consequence* of a write, not the shape of the write.
- **A permission classification is not evidence of a missing scope** (Greptile P1-2). The first
  predicate returned true for any code 10 / 200-299, and `metaService.handleError` stamps
  `PERMISSION_ERROR` on that whole family — missing `business_management`, an inaccessible ad
  account, a disabled asset. Since the normalization path *narrows the stored grant*, that would
  have stripped `ads_read` from a connection that genuinely had it and then blocked every later
  request behind re-consent advice that cannot fix anything: a transient upstream error converted
  into a bricked customer connection. The costs are asymmetric — a false negative just falls
  through to the pre-existing soft error path carrying Meta's own message, while a false positive
  destroys working state — so the bar is asymmetric too: Meta must NAME an Ads scope, and a
  permission code alone is never sufficient. Renamed to `isMetaAdsScopeRefusal` because "permission
  error" was the wrong concept and the loose name invited the loose check.
- **The 95% CI coverage gate only measures `src/utils/**`** (`jest.config.js` `collectCoverageFrom`),
  and the coverage shard additionally ignores `/__tests__/agentMode*`. Two consequences worth
  knowing before adding a util: `services/` and `routes/` changes are not measured at all, so the
  *only* file in this PR the gate could see was `utils/metaAdsScope.ts` — which is why one new
  pure module could drag the global branch number from >=95% to 94.81% on its own.
- **Deep `?.`/`??` chains are a coverage tax.** istanbul counts every optional-chaining hop as a
  branch, so `error?.response?.data?.error?.code` alone contributes four. Meta delivers errors in
  several shapes, so the first cut spelled out five code paths and seven text paths as inline
  chains — ~19 branches for what is really two lookups, most unreachable without absurd permutation
  fixtures. Replaced with declared path lists plus one `pick()` reducer: same behavior, the shapes
  are now a readable table, and the file went 89.44% -> 100% branch coverage while getting shorter
  in intent. Prefer a data-driven lookup over a nested optional chain when probing foreign payloads.
- Gate coverage note: the pre-flight gate sits in `getMetaCredentials`, the single choke point for
  every connected-account Meta tool, so it covers all ads paths including writes. Post-flight
  normalization is wired into the campaign read path named in the reporter signal; once the
  self-heal records the missing grant, every other path fails pre-flight too.
- AgentMode chat behavior (outputs, tool selection, prompts, model defaults) is untouched. The
  system prompt already forbade fabricating metrics; it needed no edit.

## ENG-446: canonical action payloads on existing report/run data (2026-07-29)

New pure module `backend/src/services/marketingActionEnvelope.ts` — the transport/persistence seam
ENG-445 deliberately left to this issue. Investigation findings that shaped it:

- **There is no `ReportResult` / `RunResult` / `ReportEnvelope` type in the backend.** The two real
  envelopes are (a) the scheduled-chat run result — an inline object literal returned by
  `runScheduledChat` (`controllers/agentModeController.ts`) and persisted untyped
  (`scheduleDb.addRunResult(scheduleId, runResult: any)`, `services/db.ts`), and (b) the HTML-report
  file entry (`ResultFile`, `routes/tasks.ts`). Both already carry arbitrary JSON, so the payload
  needed **no new table, no new attribute path, and no new storage system** — assertion 1 is
  satisfied by one optional field, `marketingActions`, on the existing envelopes.
- **The payload is stored as a native array, not a serialized string.** `parseMarketingActions`
  (ENG-445) takes JSON text, so `readMarketingActions` round-trips via `JSON.stringify` into it.
  That keeps exactly ONE parser and ONE identity check in the system whatever the transport, and
  the canonical-id re-derivation still rejects a drifted or foreign id.
- **Assertion 6 (retry mints no new ids) is free from ENG-445's design** — `marketingActionId` is a
  normalized content hash of (actionType, scopeId), so re-attaching the same underlying actions is
  inherently idempotent, including across cosmetic producer variance in case/whitespace. What was
  NOT free: a retry re-attaching would reset status to `proposed`. `attachMarketingActions`
  therefore carries forward any status already recorded against a canonical id, so a duplicate
  scheduled delivery can never silently un-approve a move a human approved.
- **Two read paths, one helper.** `GET /scheduled-chats/:id/test-history` and the
  with-html-reports response both call `normalizeMarketingActions`. Neither re-ranks: stored order
  is returned verbatim (assertion 3), and legacy rows normalize to `[]` (assertion 4). The report
  route's inline post-processing was extracted to `buildHtmlReportsResponsePayload` so it is
  directly testable — the pre-existing searchableText JSON round-trip (which exists to avoid racing
  the background enrichment writer) is preserved unchanged inside it.
- **Gotchas confirmed and left alone**: `agentModeController` deletes `actualResponse` before
  persisting a run result (space saving, re-hydrated on read) — `marketingActions` survives that
  path; and `GET /scheduled-chats` strips `runResults` wholesale, so an eventual portal "3 moves
  today" card must read `/test-history`, not the schedule list. Noted for ENG-444.
- No producer of `MarketingActionCandidate` exists yet by design — deriving candidates from
  campaign data is downstream of ENG-444's taste gate. This PR is the carrier, so a producer needs
  zero further plumbing. AgentMode chat behavior (outputs, tool selection, prompts, model defaults)
  is untouched.

## ENG-445: shared marketing-action contract + deterministic top-3 selector (2026-07-28)

New pure module `backend/src/services/marketingActionContract.ts` — ONE typed contract for "a
recommended marketing action" and ONE deterministic selector (`selectTopMarketingActions`, cap 3)
for the ENG-444 "3 moves today" surfaces. Investigation findings that shaped it:

- **ENG-87 campaign-health signal code does not exist in this repo** (no `campaignHealth`/
  `healthSignal`/`struggling` module) — the contract therefore does not import a signal engine; it
  is fed candidates by producers (ENG-446 wires existing report/run data into it).
- **There is no `reportId` primitive anywhere in the backend.** "Source report/run ID" is an
  opaque `sourceKind: 'report'|'run'` + `sourceId` pair, so `AW-AgentRuns` runIds, loop `RunId`s,
  and report artifact ids all fit without a new table.
- Shape reuse: tiers mirror `RcaRankedFix` (ai-eval-funnel), provenance mirrors loops/core
  `MutationProposal`, stable-id + "recommendation is the product" mirrors
  `agentMode/core/askUserQuestion.ts`; pure-module style mirrors `healthScoreService.ts`
  (the existing top-3 tie-break precedent is `onboardingLoopApproval.ts:181`).
- Determinism: identity = normalized sha256 of (actionType, scopeId) → duplicates collapse onto
  one id and status changes never move it; ranking is a total order (critical/campaign tier →
  weighted 5-factor score → per-factor tiers → id → canonical JSON), so output is invariant under
  input permutation. Weights (5/4/3/2/1) encode the contract's stated factor order; campaign
  priority is a hard tier that only `critical: true` overrides.
- No consumers changed in this PR by design — ENG-446 (blocked by ENG-445) exposes canonical
  payloads through existing report/run data.

## ENG-259: Fathom→Linear router — cloud wiring in shadow mode (2026-07-28)

The canonical reconciliation engine (`services/fathomLinearRouter.ts`, carried forward from the
preserved `swarm/eng-259-fathom-linear-router` branch) is now WIRED: `/api/webhooks/fathom` runs
deterministic extraction (`services/fathomExtraction.ts` — no LLM; retries produce byte-identical
ids so `fathomKey` idempotency holds) and reconciles through the engine via the `LinearPort`
resolved from `services/fathomLinearPortRegistry.ts`. Mode = `FATHOM_LINEAR_ROUTER_MODE`
(off | shadow | live, default shadow — real board reads, zero writes, full run report logged as
one `[FathomLinearRouter]` JSON line). Decision of record: ENG-447 selected Option 1 (managed
durable workflow in the existing backend, Fathom-first, shadow before writes, no laptop fallback).

Assumptions / boundaries:
- The production LinearPort adapter is ENG-536 (blocked-by this): until it registers at the
  composition root, the webhook answers `routed:false, reason: LinearPort not configured (ENG-536)`
  with extraction counts — deliberate 200 so Fathom does not retry-spiral on a known-inactive path.
- The legacy `meetingIntakeService` path was REMOVED from the webhook (it wrote to placeholder
  Notion/ClickUp deps — dead destinations since the Linear migration). The service itself stays:
  Emma's `fathom_route_action_items` tool still imports it, and changing Emma tool behavior is out
  of swarm scope.
- The ENG-246 onboarding leg (`FATHOM_ONBOARDING_AUTOMATION_ENABLED`) is preserved unchanged and
  self-contained (never throws the webhook).
- Extraction Harsha-filter: items explicitly assigned to a non-Harsha person become
  `actionable:false` FYI (reported `notFiled`, never silently dropped) per issue scope #2.
- Customer ambiguity is CRM-derived only (≥2 distinct crm_matches companies → `needsPm`); a
  multi-external-domain call yields customer=undefined (absent, not ambiguous) so the engine's
  anchor rule (customer+workflow required to bind) stays safe without flooding Needs PM.
- Fathom's exact webhook payload field names for crm_matches/action-item assignees are asserted
  loosely (string|object accepted, defensive) — verify against a real org-account payload when
  ENG-447's credentials land; shadow mode makes any mismatch observable without writes.

## ENG-529: report-ui-bug returned 500 on reports it had already filed (2026-07-27)

Production `POST /api/support/report-ui-bug` 500'd three times on 2026-07-26 (17:15:04, 17:15:11,
17:19:38 UTC) while **successfully filing every attempt**. Root cause chain, verified in
`routes/support.ts`:

1. The title was `` `${config.titlePrefix}: ${description.trim().slice(0, 80)}` `` — a RAW slice, so
   a multiline description carried real newlines.
2. That same string was reused verbatim as the Resend subject
   (`[${subjectLabel}] ${title} — reported by ${email}`). Resend answers
   `422 validation_error: "The \n is not allowed in the subject field."` and rejects the send.
3. The `await resendService.sendEmail(...)` sat inside the route's ONE success-critical try/catch,
   whose catch returns `500 "Failed to submit report"`. So a durable, already-filed report was
   reported to the user as a total failure.
4. The client's generic failure toast invited retries; each retry re-ran `fileUserIssue` →
   `createTicket`, producing reporter tickets #169, #170, #171 for one report.

**Assumption checked, not assumed:** prod backend is a SINGLE EC2 instance
(`describe-environment-resources` on `Agentweb-backend-env-prod-3` returns one instance) and
`server.ts` does not `cluster.fork()`. So an in-process replay guard covers every retry that reaches
the API today. If the env is ever scaled out the guard degrades to per-instance and intake's own
canonical dedup still groups the reports — it gets looser, never wrong. A durable cross-instance
store would need a new DynamoDB table (database/data-plane gate), which this fix deliberately avoids.

**Fix shape:** `utils/reportIntake.ts` owns (a) the ONE normalization of the shared title —
whitespace/control collapse BEFORE truncation, so the summary is 80 characters of readable text —
and (b) `fileReportOnce`, a 10-minute replay guard keyed on
`sha256(userId, reportType, pageUrl, normalizedDescription)`. In-flight duplicates share the same
promise; completed filings replay; a FAILED filing is never cached, so a genuine retry really
re-files. The route now has two failure boundaries instead of one: filing failure → 500 claiming
nothing tracked; notification failure → the user still gets success + tracking link, and the failure
is recorded via `reportUIError('support:report-ui-bug:notification')`.

**Pattern to remember:** any user text that reaches an email subject must be single-lined at the
source, and a best-effort side effect must never share a try/catch with the durable one.

## ENG-114: durable MCP session store so sessions resolve across instances (2026-07-21)

MCP Streamable-HTTP sessions lived only in a per-process `Map` in `mcp/server/mcpServer.ts`. On a
multi-instance deploy without sticky routing, a tool call that lands on an instance which did not
create the session gets a 404 → the SDK client auto-reinitializes (the ENG-97 fix). That is
transparent but costs an extra round-trip each time the LB bounces (churn). This is the durable fix.

**Key SDK constraints I verified by spiking `@modelcontextprotocol/sdk@1.25` before designing:**
- The live `StreamableHTTPServerTransport` cannot be shared across instances — only the small
  session *metadata* (agentUserId, isInternal) can.
- The protocol layer (`Server`) refuses ANY request before an `initialize` handshake — a bare
  `tools/call` on a fresh transport 400s in BOTH stateful and stateless mode. So naive stateless
  mode does NOT serve a post-init call either.
- Priming the Node/Express-wrapper transport with synthetic `req`/`res` is unreliable (the hono
  wrapper rejects fake IncomingMessage/ServerResponse). But the `WebStandardStreamableHTTPServerTransport`
  primes cleanly with synthetic `Request` objects (init + `notifications/initialized`), after which
  it serves the real request. That is the mechanism `mcpSessionRehydration.ts` uses.

**Design (all behind `MCP_SESSION_STORE`, default `memory` = single-instance, byte-for-byte
unchanged):**
- `mcpSessionStore.ts`: `McpSessionStore` interface + `InMemoryMcpSessionStore` (default) +
  `DynamoMcpSessionStore` (`AW-MCPSessions`, `ttl` epoch-seconds native TTL + read-time expiry check
  for consistent cross-instance eviction; throttled touch writes). Follows the AW-OAuthSessions /
  AW-MCPOAuth* pattern.
- `mcpServer.ts`: persists metadata on init, touches on activity, evicts on DELETE, and — for a
  session unknown locally but present in the shared store — rehydrates + serves it (no client 404).
  A same-principal IDOR guard means one caller can never be handed another user's session (the
  session id is a bearer capability; external sessions require a matching authenticated userId,
  internal sessions require an internal caller). With the in-memory store the store mirrors the local
  map, so the rehydrate branch never fires and behavior is identical to before.

**Scoped boundary (named, not silent):** rehydration covers the POST tool-call path (what AC #1
specifies). The GET SSE server→client notification stream still 404s cross-instance and the client
reconnects (best-effort) — deferred as a follow-up. Rehydrated transports are created per request
and closed immediately (memory strictly bounded — no cross-instance transport accumulation); a
local rehydrated-transport cache to skip re-priming is a possible later optimization.

**Rollback:** unset `MCP_SESSION_STORE` (or leave it default) → in-memory store → prior behavior.

## ENG-415: Meta ad sets set destination_type=WEBSITE for website goals (2026-07-20)

Found during RankAI ad review (Matt request via Harsha). Every ad set in RankAI's account
(26242538088719416) had `destination_type=UNDEFINED`, so the ad-level Destination read as "not
selected" in Ads Manager even though the creative link + LEAD pixel fire fine. Root cause: the
backend never set `destination_type` anywhere (`grep destination_type` → 0 hits) —
`metaService.createAdSet` mapped a fixed whitelist without it and `createMetaAdsAdSet` never derived
one.

Fix (deterministic, additive): `createMetaAdsAdSet` defaults `destination_type='WEBSITE'` when the
caller omits it AND `optimization_goal` ∈ `META_WEBSITE_OPTIMIZATION_GOALS`
(LINK_CLICKS / LANDING_PAGE_VIEWS / OFFSITE_CONVERSIONS / VALUE); an explicit caller value always
wins; non-website goals (engagement/reach/app/instant-form) are untouched. `metaService.createAdSet`
forwards `destination_type` only when present (literal key — not guaranteed on the SDK `AdSet.Fields`
enum), and the Emma tool schema exposes it.

Assumptions / non-goals: (1) the `url_tags` / "URL Parameters" half was ALREADY shipped in ENG-239
(`metaService.resolveUrlTags` auto-sets `url_tags` on new creatives) — the RankAI ads that show UTMs
baked into the link predate it (magnet) or were built by the 07-19 raw-Graph-API rebuild (the `-conv`
pair), so they never hit the fixed path; new Emma ads are already correct. (2) `utm_source` value
convention (meta vs facebook) stays a Session:Taste call in ENG-327. (3) Backfilling the live RankAI
ads is a separate real-money action (rebuilding existing-post ads would drop social proof) — not in
this PR.

## ENG-413: X posting fails silently — 3 code gaps made a read-only grant undiagnosable (2026-07-20)

The live 403 (Reply Guy scheduled chat, all `twitter_manage_post` replies 403'd while reads worked)
is NOT a code bug — the X Developer App for `clientId` in SM `prod/AgentWeb/Twitter` is set to
"Read" under *User authentication settings → App permissions*, so X caps the OAuth2 token to read
regardless of the `tweet.write` we request. That flip (→ "Read and write" + reconnect) is Harsha's
manual portal change, tracked separately. This PR fixes the three CODE gaps that made the broken
write path fail *silently*:

1. **Granted-scope persistence** (`routes/twitterAuth.ts`): finalize stored the requested
   `TWITTER_SCOPES` constant, so the DB claimed `tweet.write` on a token that can't write. Now
   stores the GRANTED `scope` from the `loginWithOAuth2` token response (twitter-api-v2 types it as
   `TOAuth2Scope[]`; a `normalizeGrantedScopes` helper also tolerates a space-delimited string).
2. **Pre-write scope guard** (`services/twitterService.ts`): `getClient`/`withRetryOn401` gained an
   optional `requiredScope`; every write method (tweet/reply/quote/delete/retweet/like + outreach
   follow/dm/block/mute/bookmark) now declares its write scope, and the guard throws a clear
   "connected read-only — reconnect with write permission" error (naming `@handle`) BEFORE any X
   call when the granted scopes are known and lack it. Assumption: it only blocks when `config.scopes`
   is a non-empty array (legacy accounts, which stored the full requested list, and unknown/empty
   scopes defer to X so nothing is bricked). Reads are never guarded.
3. **X error body surfaced** (`utils/twitterErrors.ts` → both AgentMode twitter catches): the catch
   collapsed the failure to `error.message` (a bare `Request failed with code 403`), dropping
   twitter-api-v2 `ApiResponseError.data` (X's real `title`/`detail`/`errors`). `describeXApiError`
   duck-types on `.data` (works across mock/module boundaries) and surfaces the real payload + HTTP
   status. Lives in its own util module (not twitterService) because the AgentMode twitter tests
   fully mock `twitterService`/`connectedAccountsDb` — a helper there would be undefined under mock.

Behaviour-preserving on the success path: a write with `tweet.write` granted still posts unchanged.

## ENG-393: generate_image `missing_brand_logo` no longer blocks first-logo CREATION (2026-07-20)

Customer bug (AgentCapX, no logo on brand guidelines): `generate_image` on the pure text-to-image
path returned `missing_brand_logo`, blocking a user from generating their FIRST logo — which also
blocks landing-page generation (needs a logo). Root cause: the ENG-326 gate in
`agentModeService.generateImage` fires whenever `promptRequestsLogo(prompt)` is true and no logo is
persisted (no `logo_image`/inputImages). That gate is meant for COMPOSITING an existing brand logo
("add our logo to this banner") — but "create a logo for X" also mentions "logo", so it over-fired
on CREATION.

Fix: added `promptCreatesLogo(prompt)` to `services/agentMode/brandLogo.ts` (a pure discriminator:
creation-verb-directly-modifying-"logo" + logo-noun creation phrases like "logo for", "logo
design", "logo from scratch"). The gate now also requires `!promptCreatesLogo(prompt)`, so creation
asks pass through and generate, while compositing asks still gate (composite the persisted logo →
AC-2, or ask the user when none is persisted → AC-3). Behavior-preserving for ENG-326: all existing
`agentModeService.generateImage.brandLogo` + `agentModeBrandLogo` tests stay green.

Assumption (no human AC on the issue): intent is "text-to-image logo creation must not require an
existing logo" without reopening the ENG-326 invented-logo hole — so I split creation vs
compositing rather than dropping the gate outright (dropping it entirely would regress the shipped
ENG-326 AC-2/AC-3 tests). Flagged this assumption on the Linear issue. Extreme non-real inputs
(e.g. "don't create a logo") are out of scope — you wouldn't call generate_image to NOT make one.

Env note (worktree only, not shipped): the primary checkout's shared `node_modules` predates
origin/main's `@opentelemetry/*` and `twitter-api-v2` deps, so tests/typecheck against main need
those installed (done at the worktree-root `node_modules` via upward resolution; the primary tree
is never touched).

## ENG-409: default customer-bug assignee changed Harshit → Manan (2026-07-20)

Directed by Harsha. Customer-filed bug canonicals (`fileBugReport` in `services/intakeService.ts`)
now default-assign to **Manan Varma** (`cabadf7c-b95d-4455-b9ec-df11d5d83f5f`) instead of Harshit
Shah (`4c29baa4-…`). The assignee is the hardcoded constant `BUG_DEFAULT_ASSIGNEE_ID` — confirmed
there is NO `LINEAR_BUG_DEFAULT_ASSIGNEE_ID` env override in the code (an earlier line in this file
claimed one; corrected). Behaviour is otherwise unchanged: bugs still land in Todo with the same
funnel-derived priority; feature requests and auto/telemetry issues stay unassigned.
`intakeService.funnelTriage.test.ts` now pins the Manan UUID.

## ENG-383: local agent relay tools deprecated to stubs (2026-07-17)

The local agent relay (ngrok tunnel to a Codex agent on a Mac) is permanently dead — ngrok account
suspended (ERR_NGROK_6008) and the host machine is gone (ENG-381/ENG-383). `run_local_agent_task` +
`check_local_agent_status` are now fail-fast deprecation stubs in `src/emma/localAgentTools.ts`
(registered so legacy/forced calls get `local_agent_deprecated: …` instead of "tool not found"; no
network/SM/S3), and both were removed from `DEFAULT_FOUNDATION_TOOLS` and the chatbot customer tool
list. NOTE: the runtime foundation list is DB-overridable — AW-Settings (Dev- prefixed in dev) key
`foundation_tools`, loaded in `AgentModeService.initialize()` (per service init, not per request) —
so the prod setting row must also be updated (data-side, outside this PR). Replacement for web
research is `you_search_web` (this PR adds optional `freshness` + `include_domains` params for the
Reddit-digest repoint); full workload replacement tracked in ENG-381.
`src/scripts/patch-skills-remove-local-agent.ts` strips the tools from all skills' toolNames.

## ENG-164 phase 1: nodemailer Gmail SMTP path deleted — backend email is Resend-only (2026-07-16)

The 2026-07-02 buy-vs-build audit verdict, executed. `emailService` no longer owns a Gmail SMTP
transporter; every backend email leaves through `resendService`.

1. **Fix-first (AC-2): `resendService` failures now propagate.** Previously `retryWithBackoff`
   returned `null` after exhausted/non-retryable failures, `performSend` returned `null` when the
   API key was missing, and the send queue could only resolve — so a caller could not tell a dropped
   email from a sent one. Now the queue rejects the failed item's promise (and keeps processing later
   items), non-retryable 4xx errors reject immediately, and a missing key throws instead of turning
   every send into a no-op.
2. **SMTP branches deleted.** `sendEmail` (best-effort, unchanged contract) and `sendEmailStrict`
   (throws; `messageId` = Resend id) route through the system sender `AgentWeb
   <hi@updates.agentweb.pro>` with replyTo `support@agentweb.pro`. The SMTP-vs-Resend dual paths in
   `sendTaskExecutionEmail` / `sendSubscriberWelcomeEmail` collapsed into one send with task-level ->
   account-level -> system-default sender fallback; history rows now always carry
   `senderType: 'resend'` + the real Resend id.
3. **Dependency dropped:** `nodemailer` + `@types/nodemailer` removed from package.json.

### Assumptions to validate
- **~20 existing `resendService.sendEmail` call sites keep their null-guards** (`if (!result)` in
  crm.ts, admin.ts, agentModeService.ts, dripSequenceWorker.ts, sequences.ts…). Audited every site:
  each is inside a try/catch whose failure handling matches (or improves on) the old null branch, so
  the guards are now dead-but-harmless defense; left untouched to keep this PR one seam. Follow-up
  cleanup can delete them.
- **The only fire-and-forget call** (`emma/tools.ts` issue-report notification) already had a
  `.catch()`, so the new rejection contract cannot produce an unhandled rejection there.
- **`SMTP_USER`/`SMTP_PASS`/`FROM_EMAIL` env vars are now unread by the backend.** The Gmail secret
  pair itself stays alive until agent-engine phase 2 (`email_utils.py` still uses smtplib) — that is
  the explicitly-parked phase 2 issue, not a leftover.
- **Default-sender task-report emails now come from `hi@updates.agentweb.pro`** (previously the Gmail
  `FROM_EMAIL`) and failures in that path propagate to callers instead of silently logging — callers
  were audited (controllers/tasks.ts, routes/slack.ts) and handle rejections.
## /stop session-ownership check (2026-07-16, ENG-360)

Closed the last open lane from the ENG-346 ownership audit: `POST /api/agent-mode/session/:sessionId/stop`
(`stopGeneration`) did no session read at all — any authenticated user with someone else's sessionId could
cancel their in-flight generation and flip their SSE progress to complete. Now: fetch session → 401 no user
(defensive; route sits behind `router.use(authenticateToken)`) → 404 missing (was silent `{ success: true }`)
→ 403 unless owner-or-admin (same predicate as updateSessionTitle / uploadImageToSession /
updateSessionLlmModel and the ENG-346 generateResponse check; delegated tokens already resolve `req.user`
to the target user). Public ishare lane (`stopGenerationPublic`, conversable token) untouched — it remains
the anon stop path.

### Assumptions to validate
- No legitimate caller stops a session it doesn't own: the customer portal stops only the session it is
  actively generating on (owner), delegated admins resolve to the target user, and anon/ishare users use the
  public lane. If some flow stops an `anon_`-owned session through the authed endpoint pre-transfer, it now
  gets 403 — none found in partner-portal; customer portal is a separate repo (grep found no such lane).
- The 404-on-missing change is safe: stop is fire-and-forget in the UI; a 404 where a silent 200 used to be
  should surface nothing user-visible (frontends don't branch on the stop response).
## /generate session-ownership check (2026-07-16, ENG-346)

Closed the pre-existing gap where `POST /api/agent-mode/generate` never compared `session.userId`
to `req.user`: any authenticated user with someone else's sessionId could generate on that session.
Check now sits BEFORE the ENG-147 idempotency claim + session-busy lock, so an unauthorized request
touches no shared state (previously it would also have been able to squat the interactive idem claim
and 409 the real owner for the ttl window).

### Ownership audit of the session-parameterized agent-mode lanes (2026-07-16 snapshot)
- Already checked: `getSession`, `verifiedGenerate` (strict), `uploadImageToSession`,
  `updateSessionLlmModel`, `updateSessionTitle` (owner-or-admin), `getProgress` (owner or
  delegated-admin-own-session). `transferSession` only mutates `anon_`-owned sessions.
- `generateResponse` was the only GENERATE lane missing it — fixed here with the getSession
  predicate (owner or admin; delegated tokens already resolve `req.user` to the target user).
- **Still open**: `stopGeneration` (`POST /session/:sessionId/stop`) does no session read at all —
  any authenticated user can cancel another user's in-flight run. Different verb + different
  blast radius (adds a DB read to a fire-and-forget lane), filed separately as ENG-360.

### Assumptions to validate
- Raw (non-delegated) admins keep generate access for parity with every other session endpoint.
  If the product stance becomes "admins must delegate to act on a user's session", tighten to the
  `verifiedGenerate` strict predicate — one-line change, tests pin both lanes.
- Error-precedence delta accepted: missing session is now 404 before the token-usage 429 read
  (previously claim → lock → 429 → 404). No client observed depending on 429-before-404.
- An authenticated user generating on an `anon_` session pre-transfer would now 403 — but
  `getSession` already 403s that same read today, so no working client flow can hit it.

## ENG-358: v0-credit alert dedupe at the intake gate — class clustering + Duplicate-state leak (2026-07-16)

The hourly v0-credit alert filed a new Linear issue per occurrence (14 near-identical issues in 5
days, ENG-292…350) and, after a manual dedupe pass, appended its recurrence comments to a canceled
**Duplicate** (ENG-350) instead of the open canonical (ENG-337). Two root causes, both fixed at the
ENG-240 intake gate:

1. **Titles embed occurrence data.** `v0 credits LOW — $59.15 spendable` changes with every balance
   move, so `fileAutoIssue`'s normalized-title fallback never matched and each occurrence filed
   fresh. Fix: (a) alert-class clustering — the v0 filer now passes `"Alert Class": "v0-credits"` +
   `"Alert Priority"` in its context; the gate matches candidates whose body carries the rendered
   `Alert Class: <name>` line before any title comparison (same context-key mechanism as the
   Session/Schedule idempotency keys), and escalates the open canonical in place (raise-only
   priority + title refresh via new `linearService.escalateIssue`) on low→critical. (b) The title
   norm is now amount-insensitive (`$58.51` ≡ `$59.15`) so pre-existing canonicals without the
   class marker keep matching post-deploy.
2. **Linear's Duplicate state has its own state type.** Verified live on ENG-350: `statusType:
   "duplicate"` — NOT `"canceled"`. `listOpenIssuesByLabel` / `listOpenBugCanonicals` filtered with
   a `nin: [completed, canceled]` blacklist, so duplicate-state issues stayed dedupe candidates and
   absorbed recurrences. Both now WHITELIST open state types (`triage, backlog, unstarted,
   started`), which also future-proofs against new closed-ish types.

**Assumptions to validate**
- The hourly re-fire itself (24h in-memory `lastAlerted` window not holding across prod
  instances/worker restarts — observed 5+ alerts in one morning) is NOT fixed here; the gate now
  makes re-fires converge on one issue, but each still sends an oncall email. If email cadence
  matters, the window needs durable state (ENG-345 seam). Flagged on the Linear issue.
- Priority mapping chosen: v0 `low` → High, `critical` → Urgent. Adjust in
  `ALERT_PRIORITY_BY_LEVEL` (v0BillingService) if the board should rank ops alerts differently.
- Amount-insensitive title normalization intentionally treats two auto-issue titles differing only
  by a dollar figure as the same issue. No current Auto filer embeds amounts except the v0 alert.

## ENG-326 review hardening: org dead-ends, unverified persists, guard false negatives (2026-07-15)

Senior review of the ENG-326 branch surfaced four real bugs in the first cut; all fixed with tests.

1. **Org accounts hit a dead end in both missing-logo gates.** `updateBrandGuidelines` and brand-config
   uploads write the **ORG** record for org members, but the ad-image gate read `user.brandGuidelines`
   only — so "upload your logo in brand config, then regenerate" could never be satisfied. The
   ad-image trigger AND the landing-page routes now resolve brandGuidelines org-aware
   (`resolveBrandGuidelinesForLoadedUser` / a `brandGuidelinesOverride` param on
   `buildBrandContextFromUser`).
2. **Unverified logo URLs are never persisted.** `downloadBrandLogoToS3` now returns a discriminated
   outcome (`uploaded | svg | download-failed | upload-failed`). The onboarding step falls back to the
   raw discovered URL only on `upload-failed` (bytes proven raster, just the S3 pin failed) — a dead /
   hotlink-protected URL or an SVG served from an extensionless URL never becomes the canonical brand
   asset. Emma-facing `extractCSSFromURL` output is unchanged (characterization suite untouched).
3. **Landing pages got the missing half of AC-3.** `/generate` and `/generated/:id/duplicate` return
   `422 { error: "missing_brand_logo" }` pointing at brand config when no logo resolves, BEFORE side
   effects (lead-list public-access flip, site-mode lock). Previously v0 silently invented a wordmark.
4. **Negation guard tightened.** The 0–40-char window swallowed positive asks ("no text, just our
   logo", "Do not crop the logo"). Negators must now sit directly on the logo mention (≤2 whitelisted
   filler words); `don't`/`do not` understood.

### Assumptions to validate (delta over the section below)
- **422 on logo-less landing-page generation is the intended UX** for the frontend — same reasoning as
  the ad-image gate (Fangfang's brand-config guidance), but the portal UI may render the 422 as a
  generic failure until it learns the `missing_brand_logo` code. Duplicate of a pre-gate page with no
  persisted logo is now also blocked by design.
- **`upload-failed` remote-URL fallback is safe**: the bytes were just downloaded successfully, so the
  URL serves a real raster; if the site later takes it down we degrade the same way any hosted asset
  does.

## Brand logo never persisted during onboarding → random logos in assets (2026-07-15, ENG-326)

Root cause (named by Fangfang on the 07-14 Argusoft night call): the whole logo pipeline EXISTED —
cssExtractor discovery heuristics, a download+S3 block inside `extractCSSFromURL`, the
`brandData.logoUrl` field on `update_brand_guidelines`, logo-preferring consumption in ad-image and
v0 prompts — but the only thing connecting them during onboarding was a PROMPTED Emma session
(`onboardingBrandBuildService`) that was merely *asked* to include `logoUrl` in its one
`update_brand_guidelines` call. When she didn't, the account had no logo anywhere, and every
downstream generator "helpfully" invented one (Gemini renders an approximate mark; the ad-image
builder falls back to a typographic wordmark; v0 gets no Logo URL line at all).

Fixes (all deterministic, none rely on the LLM volunteering):
1. **`services/agentMode/brandLogo.ts`** — new module. The download+S3 block was extracted out of the
   `agentModeService.extractCSSFromURL` monolith (characterization test pins the old behavior); adds
   `ensureBrandLogoPersisted` (post-scrape onboarding step) and one shared logo resolver.
2. **Brand build** runs `ensureBrandLogoPersisted` after every successful Emma session: no logo on the
   account → discover on the company URL → pin to S3 → persist `brandData.logoUrl` + a `logo`
   attachment via the same `updateBrandGuidelines` path Emma uses.
3. **`generate_image`** — prompt asks for a logo + model passed no `logo_image` → inject the persisted
   logo; none persisted → return an ask-the-user tool result pointing at brand config. Never invent.
4. **Onboarding ad images** — no persisted logo → run fails with "upload your logo in brand config"
   instead of shipping wordmark variants; with one, every variant composites it as a real image input.
5. **Landing pages** — the two duplicated brand-context blocks in `routes/landingPageGeneration.ts`
   collapsed into `v0Service.buildBrandContextFromUser`, which resolves the logo attachments-first
   with a `brandData.logoUrl` fallback (the route previously read attachments ONLY, so a
   scrape-persisted logo never reached v0).

### Assumptions to validate
- **Resolution precedence: attachments beat `brandData.logoUrl`.** Rationale: an explicit brand-config
  upload (`routes/brand.ts`) writes ONLY an attachment, while `brandData.logoUrl` can hold a stale
  scraped URL — what the user sees in brand config must be what generation composites. If Emma
  re-scrapes and updates only `brandData.logoUrl`, the older auto-attachment still wins; acceptable
  because the deterministic step writes both with the same URL.
- **Failing the onboarding ad-image run on missing logo is the intended UX** (vs. generating wordmark
  variants). Matches Fangfang's interim guidance ("upload/review the logo in brand config before image
  creation") and AC-3, but it's a visible behavior change on accounts with undiscoverable logos.
- **The `promptRequestsLogo` heuristic** (`/\blogos?\b/i` with a negation guard) is deliberately
  narrow; prompts that mean the logo without saying "logo" ("with our brand mark") won't trigger the
  gate. The model still passes `logo_image` explicitly on those per its tool description.

## Resolve-bridge @Emma parrot: mention serialization pinned live + a PII hijack closed (2026-07-15, ENG-316)

The resolve bridge now parrots the latest `@Emma <message>` comment on a bug canonical as the
reporter resolution email. Three findings from the review/finalize pass worth keeping:

### How a Linear mention ACTUALLY serializes (verified live, not guessed)
Probe: created a comment on ENG-316 through Linear's own agent surface (it builds a genuine
ProseMirror `suggestion_userMentions` node — confirmed via `comment.bodyData`), then read it back
through the exact GraphQL field the service uses (`comments { nodes { body } }`). **A real
workspace mention round-trips as plain `@displayName`** (`@harsha`) — no bracket/link markup at
all. So plain-text `@emma` is the mainline matcher; the bracketed forms (`@[Emma](url)` /
`[@Emma](url)`) never occur in raw bodies and are tolerated only for hand-written markdown. Also
verified: `issue(id:)` accepts both UUID and identifier, and `comments(orderBy: createdAt)`
returns **newest-first** (so `first: 250` overflow drops the oldest). Note: no "Emma" user exists
in the workspace today (2026-07-15) — the convention works via plain-text `@emma` until one does.

### The hijack class: intake comments carry CUSTOMER-controlled text
Intake appends `Their report:\n<raw customer description>` to canonical comments, and customers
address the agent as "@emma" in bug reports — so any anywhere-in-body mention matcher lets one
customer's report (plus their email in the marker line) become EVERY reporter's resolution email.
Closed twice over: the mention must be the comment's LEADING token (the documented `@Emma
<message>` convention), and any comment carrying a `[reporter-ticket #N]` marker is excluded from
parrot candidacy outright. Assumption to validate if intake formats ever change: intake-authored
canonical comments always carry the reporter-ticket marker.

### Linear's 50-node connection default, third sighting
The un-sized `comments` connection silently caps at 50 — same trap `getTeamMeta` documents for
states/labels. Any Linear connection query in this repo must be explicitly sized (250 max) with a
loud `pageInfo.hasNextPage` log. Grep for un-sized connections when touching `linearService`.

## Eval-queue Ad vs Organic Post categorization (2026-07-15, ENG-90)

Matt's ask: reviewer feedback on an image differs by use case, so eval-queue items need an
Ad / Organic Post classification he can see and filter on. Shipped the substrate: additive
`HumanEvalCandidate.category` (`ad | organic_post | uncategorized`), a bold `*Category:*` tag in the
Slack eval post, and an admin-only filterable `GET /api/human-eval/candidates`.

### Call-site classification (traced every enqueue path)
- `agentModeService.generateImage` auto-enqueue is the ONLY image enqueue path today. The
  `generate_image` tool serves BOTH ad and organic asks with no hard flow signal in its inputs —
  genuinely ambiguous, so it stays `uncategorized` rather than guessing from prompt text.
- Emma `enqueue_human_eval` tool: flow unknown at enqueue; tool inputSchema deliberately untouched
  (AgentMode prompt-surface change = Harsha's call). Follow-up filed as ENG-343.
- v0 landing-page + lead-enrichment enqueues: not images — no category passed. The lead-enrichment
  feedback rerun inherits the original candidate's category.
- `onboardingAdImageService` calls `imageService.generateImage` directly and never enqueues eval
  candidates, so it is not a categorization site today.

### Assumptions to validate
- Consequence of the no-guessing rule: every auto-enqueued image posts as Uncategorized until a flow
  self-declares (ENG-343 is the unlock). The filter/display substrate is what this PR delivers.
- Fail-open normalization (`unknown → uncategorized`) is correct on the WRITE path only — it protects
  enqueueing. On the READ path a typo'd filter must 400, never coerce: reviewer caught that
  `?category=ads` silently returned the uncategorized set with `success:true`. Strict
  `parseHumanEvalCategoryFilter` now guards the list route (unknown status/reviewType also 400).
- `listCandidates` is a paged scan capped at 20 pages (table is small, keyed by candidateId only).
  If the queue ever exceeds ~20 scan pages, results silently truncate — a GSI on status/createdAt is
  the eventual fix if listing becomes a hot surface.

## Run-survival remainder shipped behind AGENT_RUN_STORE (2026-07-15, ENG-147)

The 6/27 duplicate-session storm (one question → ~30 full agent runs, RCA on ENG-147) is now
guarded at both storm seams, salvaged from closed PR #2006 and re-scoped against today's main per
Harsha's 2026-07-14 comment: durable run records + idempotency submit-locks — a fresh, smaller PR.
Everything is behind `AGENT_RUN_STORE=true`; flag absent = byte-identical behavior, pinned by
BEHAVIOR-PRESERVING tests in every touched suite.

### What shipped
- `services/agentMode/runStore.ts` — one DynamoDB table (`AW-AgentRuns`, pk hash, PAY_PER_REQUEST)
  with two item kinds: `run#<runId>` (30d ttl) and `idem#<key>` conditional-put submit-locks (10m
  interactive). NO-FALLBACK create; best-effort terminal marks (retry once → one deduped alert),
  conditional so a failed create never upserts a ttl-less phantom.
- `createSession` accepts an optional client `idempotencyKey`: exactly one of N duplicates creates a
  session; losers attach to the winner (200 + `idempotentReplay`) or get 409 `DUPLICATE_SUBMIT`
  while it's in flight. Key is sha256-scoped by userId — no cross-user attach.
- `/generate` claims `idem#sha256(sessionId|userMessage|llmModel)` BEFORE the in-process
  `activeSessionGenerations` Set (two layers, one concept: cross-restart dedupe + in-process
  concurrency; B2's atomic Set claim was already on main and is untouched). Loser gets the existing
  409 `SESSION_BUSY` shape + the in-flight `runId`.
- `runScheduledChat` failure sites: oncall alerts get `(user, schedule, errorClass)` keys with a
  1h window — one flapping schedule cannot flood oncall.

### Review fixes (same day, senior-review pass)
- **DynamoDB TTL reaping is EVENTUAL, not a bound.** The original claim design relied on the native
  TTL reaper to clear leaked locks; an expired item still exists (documented minutes-to-hours lag),
  so a hard crash between claim and release could 409 identical resubmits far past the promised 10m.
  Fixed: `claimIdempotency`'s conditional put is now `attribute_not_exists(pk) OR #ttl < :now` and
  the loser-path read (`ConsistentRead: true`) treats an expired item as absent. Staleness is now
  genuinely bounded by the ttl window regardless of reaper lag. **Do not write any future
  `attribute_not_exists` claim that relies on the reaper.**
- **The incident#<runId> dedupe lane was inert and got deleted.** Every production
  `runScheduledChat` mints a fresh uuid (no `preGeneratedRunId` outside the isTest lane) and the
  two filing sites are mutually exclusive per invocation, so `claimIncident` always won — a DDB
  item kind with zero production effect, and the third filer (sendOncallAlert's own
  `fileAutoIssue`) bypassed it anyway. The pre-existing ENG-240 sequenced search-gate remains the
  real incident dedupe. Structural per-run dedupe, if wanted, means threading one runId through
  `sendOncallAlert`'s filer + deciding loser semantics (occurrence comment / URL) — filed as a
  follow-up Linear issue rather than shipping dead weight.
- **Still-building early returns now mark run records terminal** (`completed` /
  `detached_still_building`) instead of leaving `running` phantoms for the 30d ttl.

### Assumptions to validate
- The frontend does not yet SEND `idempotencyKey` on createSession — the backend seam is ready and
  inert until the client half (disable-submit + key per send action) lands. Filed as follow-up.
- Interactive idem ttl (10m) assumes no legitimate identical resubmit of the same message to the
  same session within a run's lifetime; the lock releases at every terminal state, so only a
  crash between claim and release leaves the (ttl-bounded) 10m window.
- Enabling the flag requires the table (`create-tables.ts` now creates `AW-AgentRuns`) + manual TTL
  enable on `ttl` — same manual step as UsageRecords/LoopEvents. With the flag on and the table
  missing, `/generate` 500s loudly BY DESIGN (run records are core state, no silent fallback).
  Correctness never depends on TTL enable (claims tolerate expired items); it only controls
  storage growth.

### Deliberately deferred (re-scope per Harsha's comment; each inert without the flag anyway)
- Scheduled fire-window idempotency (`scheduledIdempotencyKey` exists in the store, unwired) +
  scheduled durable run records.
- The ishare/`generateSharedResponse` lane submit-lock (mirror of /generate).
- Threading the run record's runId into worker telemetry (`agentRuntimeRunId` unification).
- `createSessionWithPlan` idempotency — the route is public; anonymous callers can't be
  user-scoped, needs a key-design decision.

## Landing pages: the residual wedge + hang the first fix left behind (2026-07-13, ENG-287 follow-up)

The 07-11 fix (PR #2066, below) correctly killed the sync-create 300s race. But the same failure
CLASS was still reachable by other doors, and the sync→async switch introduced two regressions. An
audit of the merged code found the following, each verified against the code and now fixed with tests.

### The semantic bug underneath all of it
A `succeeded` guard row records that the **chat was created** — NOT that a page was delivered. It was
then reused unconditionally and forever: no TTL on `AW-V0Usage`, never clobbered, age-blind. So ANY
post-create failure left the row behind and every retry reused the same dead chat. And because #2066
deliberately removed the prompt from the key, retrying with a **different prompt** reused it too.

### Wedges (a route that can never be built again)
1. **Vercel build error RETURNS instead of throwing** (`addPageToExistingRepo`), so the catch that
   frees the identity never ran. v0 emits code that will not compile → guard row stays `succeeded` →
   every retry re-downloads the same broken version. Forever. Deterministic, and the user has no lever.
2. **The DELETE route never freed the identity.** It calls `deleteLandingPageByRecord`;
   `deleteLandingPage` (which did free it) is imported by that route and never used. Combined with the
   prompt-free key, a surviving row **hijacks the next generation**: delete a page, regenerate the same
   slug with a new prompt, get the OLD chat back — the new prompt is never sent to v0.
3. **No backstop.** Now `V0_CHAT_REUSE_CEILING_MS` (45 min) bounds reuse even on paths nobody
   anticipated, so "cannot wedge forever" is a guarantee rather than a hope.

The fix draws the line explicitly (`isDeadEndV0Failure`): a **dead end** (v0 marked the version failed
/ output will not validate / code will not build) frees the identity so the retry mints a fresh chat; a
merely-**slow** generation keeps it so the retry RESUMES the same chat for free. Freeing on slowness
would mint a second full-cost chat while the first is still generating — the exact orphan-chat credit
burn this whole issue is about.

### The original hang, still live
`withRetry`'s default re-burns our synthetic 300s ceiling 3×. Four sites still used it —
`downloadVersion` ×2 and the post-correction `getById` ×2 — and they sit INSIDE a 3-round validation
loop: worst case **3 × 3 × 300s = 45 min**, worse than the 15-min hang that started this and past the
MCP tool's own 25-min budget. Also, the "~16 min" poll budget bounded **sleeps, not wall-clock** (each
status read was allowed 300s → a real ceiling near 3h, and the error message said 16 min). Now: an
ABSOLUTE deadline (`V0_GENERATION_BUDGET_MS` 20 min), status polls bounded at 30s, and fail-fast at all
four sites (5xx/network stay retryable).

### Regressions introduced by the async switch
- **First-page builds spent their whole generation in `draft`.** Async create returns in seconds and
  the long poll moved into `deployLandingPage`, but the record was flipped to `draft` first — a status
  `IN_FLIGHT_STATUSES`, the janitor, and route-reuse all ignore. Agent mode (10-min run timeout) could
  not find the in-flight job, told the user it **FAILED**, and the retry built a **duplicate site**
  (second repo, second Vercel project). That is the ENG-189 class, reopened. Now stays `generating`;
  `deployLandingPage` accepts that status only for its own auto-deploy, so a user-initiated deploy
  still refuses an actively-generating record.
- **`deployLandingPage` rethrew a bare `new Error()`**, destroying `error.code`. It is the ONLY place
  the first-page path reaches the version poll, so `generateFirstPage`'s dead-end branch was
  unreachable **dead code** — the safety net did not exist. Code + cause now preserved.

### Constants (coherent ladder)
| constant | value | why |
| -- | -- | -- |
| `V0_STATUS_POLL_TIMEOUT_MS` | 30s | a status read is a cheap GET; 300s let wall-clock reach ~3h |
| `V0_GENERATION_BUDGET_MS` | 20 min | ABSOLUTE deadline, threaded through the whole build (initial wait + every correction round) so it is spent ONCE. Computing it per call re-armed it, letting one build poll 3 × 20 min and outlive both ceilings below. |
| `V0_RESERVATION_TTL_MS` | 20 min | unchanged; `reserved` now lives seconds (async create) |
| `STUCK_CEILING_MS` | 30 min | janitor + route reuse; above the generation budget, so a live build is never swept |
| `V0_CHAT_REUSE_CEILING_MS` | 45 min | > 2 generation budgets, so a resume-after-timeout retry always lands inside it |

**The real transport ceiling is 15 min, not 25.** `mcp/server/httpClient.ts` installs a global undici
dispatcher with `headersTimeout: 15 min`, and the backend sends no headers until the generation
finishes — so `generate_landing_page`'s `timeoutMs: 25 min` can never be reached; the fetch aborts at
15 min with `UND_ERR_HEADERS_TIMEOUT`. A generation in the 15–20 min window therefore always loses its
MCP call even though the backend budget allows it. That is survivable — the durable/reconnect path
(`findInFlightJobForSession`) and sub-page route-reuse both pick the build back up — but it means the
in-band MCP call is NOT the thing that delivers a slow build, and nobody should size a constant
against the 25-min number.

### Also fixed
- A long build **heartbeats `updatedAt`**, so the janitor cannot mark a LIVE build failed (which let a
  retry run a second build into the same repo). This is why draft→generating and the heartbeat had to
  land together.
- `isStuck`/`isZombieInFlight` now measure from `updatedAt`, matching the janitor. Keyed on `createdAt`
  they declared a long-but-progressing build dead, and `deliverStuckFailure` **burned its one-shot
  completion claim** — so the real success could never be delivered afterwards. The page went live at a
  URL the user was never given.
- The **correction key gained an `attempt`** component. It was `(user, scope, chatId)`, so round 2
  returned `{skipped:true}` and the loop re-downloaded the same broken zip: a 3-attempt self-heal that
  was really 1. (Appended only when supplied, so chat-create keys stay byte-identical to prod rows.)
- The post-correction version is **status-gated** rather than read raw off `latestVersion` — the exact
  mistake `waitForCompletedV0Version` exists to prevent (shipping a half-generated page).

### Sub-page builds died on `Module not found: '../components/landing/nav'` (found in manual test)

Our bug, not v0's. `remapFilesForSubPage` rewrote exactly two import forms — the
`@/components/*` alias and `./_components/*` inside component files. Plain **relative** imports were
never touched, and v0 emits those too. They are correct at the repo root (`../components/landing/nav`
from `app/page.tsx` = `components/landing/nav`), but we move the file to `app/<slug>/page.tsx`, where
that same string means `app/components/landing/nav` — nonexistent — and the component itself has also
moved into `_components/`. Wrong twice over. It looked intermittent only because it depended on
whether v0 happened to emit alias-style or relative-style imports.

Fix: resolve every relative import against the file's ORIGINAL directory and re-emit as `@/...`
(always resolves from the repo root) BEFORE the alias pass, which then handles moved components
uniformly. Also fixes the same latent break for `../lib/*`, `../hooks/*`, `../components/ui/*` — none
of which move, and which nobody had hit yet.

Worth noting how it surfaced: the ENG-287 fix is what let us *see* it. The Vercel build error now
frees the route identity, so the retry minted a fresh chat. Pre-fix that route would have silently
re-downloaded the same broken version forever.

### Caught in adversarial review of THIS change (worth knowing about)
- **A Vercel poll `timeout` is NOT a dead end.** `pollVercelDeployment` gives up after 5 min and also
  degrades API flakiness to `timeout`. The first cut of this fix freed the identity on it — which
  would have been the orphan double-spend it exists to prevent: a normal Next.js cold build outruns
  the poll, the page goes live a minute later, and the user's retry mints a second full-cost chat and
  pushes a second commit. Only `buildStatus === "error"` frees the identity.
- **`setupVercelDeployErrorMock()` in the test suite does not test the build-error path.** Its
  deployment carries no `meta.githubCommitSha`, so `pollVercelDeployment`'s SHA-match guard never
  selects it and the poll falls through to `timeout`. Any test that wants a real build error must set
  the SHA. (Pre-existing; the helper predates the SHA guard.)
- **The guard must fail OPEN, both halves.** `canReuseChat` refuses to reuse a `succeeded` row with an
  unreadable `createdAt` — so the reserve condition needs a matching
  `attribute_not_exists(createdAt)` clause, because in DynamoDB a `<` against a missing attribute is
  false. Without it the row matches nothing, the conditional put fails on every attempt, and the route
  wedges forever: exactly the bug, reintroduced by the fix for it.
- **Deleting an IN-FLIGHT page must not free its identity** — the archived record is invisible to
  route-reuse, so the guard row is the only thing left deduping, and freeing it lets a second chat
  build into the same repo concurrently.

### iterate: the last sync v0 call (now fixed)

`iterateLandingPage` was the last v0 call still sitting behind the 300s ceiling. A >300s iteration
failed FOUR ways at once: v0 applied the edit and charged for it anyway; the record never incremented
and stayed `deployed`; `deployLandingPage` then REFUSED it ("Cannot deploy a landing page with
status: deployed"), stranding the edit inside v0; and the retry re-sent the same message with no
guard, so v0 applied it TWICE.

Async was blocked for a real reason: `deployLandingPage` reads "the latest completed version", so an
iterate that returned before v0 published the new one would let the deploy ship the **pre-iteration**
version and silently lose the user's edit — worse than failing. `waitForCompletedV0Version`'s
`afterVersionId` guard is what unblocked it: we do not return until v0 publishes a version that is
genuinely NOT the one we started from, so the hazard is structurally impossible.

`pendingIteration {baseVersionId, messageHash}` is recorded the instant v0 ACCEPTS the send (before
the wait). A retry of the same message resumes instead of re-sending; if v0 has since published a
newer version, the edit landed and we adopt it. v0's own state is the source of truth, not a guess.

Note what is deliberately NOT done: the status is not flipped to `generating` during an edit. The
page is still live, and a crash mid-iterate would then let the janitor mark a LIVE page `failed`.

### Still open
- **The 15-min transport ceiling.** `mcp/server/httpClient.ts` sets a global undici
  `headersTimeout: 15 min`, so any generation or iteration past that loses its in-band HTTP response
  no matter what the backend budget says. The work still lands and the record is left correct
  (deployable), so the user finishes from the portal — but the in-band call is not what delivers a
  slow build. Removing this properly means returning 202 immediately and having the portal poll
  (ENG-290 pattern 5) — a product change, not a bug fix.
- `bestEffortPut` fails open on a Dynamo outage → a bounded double-spend across instances. Accepted
  trade-off; the alternative is recreating the permanent wedge.
- The DynamoDB `ConditionExpression` in `v0UsageGuard` is only asserted as a STRING in tests (the
  DocumentClient is mocked) — it has never executed against a real table. If its semantics are wrong,
  the symptom is the wedge it exists to prevent. Worth one real exercise against a dev table.

## Landing-page generation failing routinely (RankAI/Opsera/internal) — root cause + fix (2026-07-11, ENG-287/ENG-277)

Matt reported the landing-page builder "keeps failing routinely" for RankAI (07-10); Opsera's urgent
Monday case hit "another bug on the v0 side"; internal evals were rescuing Opsera-branded attempts by
hand. Anurag's earlier fixes (ENG-135/157/158/159/160/189, merged 07-02..07-08) were real but fixed
DIFFERENT failure modes (coding-agent 422 preview-branch, zombie durable records, opaque errors,
model timeout). The 07-09/07-10 failures are a distinct, never-fixed mode.

### Root cause (adversarially verified, prod evidence in AW-V0Usage + v0 chat list)
1. **Sync-mode create loses a race against our own timeout.** `v0.chats.create` was called with no
   `responseMode` → sync → the HTTP call blocks for the FULL generation. Prod generations of
   brand-enriched prompts take 3–15 min; our per-attempt ceiling is 300s (`V0_CALL_TIMEOUT`). Every
   slow generation = guaranteed client-side "timeout" while v0 finishes anyway → **orphan chat,
   credits burned, user sees failure** (v0 chat list showed 4 orphan "Forge + Cursor rebrand" chats at
   a 5-min retry cadence on 07-10; ~$39 of the $50 on-demand block burned in 10 days).
2. **Our reliability layers amplified it**: `withRetry` re-burned the 300s timeout 3× (≈15-min hang),
   and the idempotency guard (volatile prompt-hash key, no TTL, failed-blocks-retry) converted
   failures into the permanent "already in flight" wedge (ENG-277, rankai-book-a-demo).
3. **NOT credits, NOT auth** (Harsha's two hypotheses ruled out): prod key healthy (200s on
   /user, /plan, /billing, /rate-limits; account deploy@agentweb.pro, v0-team, OWNER); balance
   existed at failure time and creates succeeded later the same day. **BUT balance is now LOW:
   ~$12.76 spendable, and the orphan-burn loop would exhaust it within days** — top-up is a
   Session: Money item; the fix stops the orphan burn.

### The fix (branch `defense/lander-reliability`, supersedes PR #2065)
Merged Manan's `manan/v0-subpage-generation-timeout` + Codex's `codex/landing-page-idempotency`
(conditions tightened: only `failed` or stale-`reserved` records are reclaimable — both originals
could clobber a `succeeded` record), then the root-cause work: async `responseMode` on both create
sites + `waitForCompletedV0Version` (status-gated ~16-min poll; `pending` never downloaded, `failed`
fails fast), fail-fast on iterate/correction sends, universal abandoned-build janitor (portal builds
included, poller unconditional), stale in-flight records excluded from route reuse, correction-guard
reclaim, usage-identity cleanup on page delete.

### Assumptions to validate
- v0 async responseMode returns the chat id in seconds under load (observed for reads; not yet
  measured for async creates at scale).
- The ~16-min poll budget covers p99 generation time (evidence maxed ~15 min; janitor + retry path
  cover the tail).
- ENG-277's wedged prod record self-heals on next retry via failed-not-blocking + janitor (verify
  live after deploy; a one-off data fix is the fallback).
- Iterate/corrections stay sync deliberately (async there risks deploying the pre-iteration version;
  needs version-id tracking — follow-up).
## Linear webhook fired customer comms too early / repeatedly — root cause + fix (2026-07-07)

The Linear→customer-comms bridge (`POST /api/integrations/linear/webhook`, `backend/src/routes/integrations.ts`) was firing the full resolve bridge (`notifyCanonicalResolved`: Resend "Resolved" email to every reporter + Featurebase card flip to Completed + Slack ship ping) on the wrong events. Surfaced during the 2026-07-07 merged≠done investigation; the premature-email proof is ENG-173 (an xCures reporter was emailed 2.9s after PR merge, pre-deploy).

### Two root causes
1. **Gated on state CATEGORY, not the Done state.** The predicate was `data.state.type === 'completed'`. The board now runs Merged → Verifying → Done and all three are completed-type in Linear, but only **Done** is customer-communicable — so a move into Merged or Verifying emailed reporters. Fix: gate by the Done **state ID** (`LINEAR_DONE_STATE_ID`, ENG Done = `b36918be-3026-4a37-b788-47eef453a581`), not by name — a rename would silently kill or misroute the bridge.
2. **Not transition-detecting.** It fired on EVERY Issue `update` while the issue sat in a completed state (a later title/label edit on an already-Done bug re-emailed every reporter — the Slack ping is deduped via `claimSetMember`, but the email + card re-flip are not) and also on `action:'create'`. Fix: use the webhook's `updatedFrom.stateId` (Linear puts the prior value of each changed field there) to fire only on an ACTUAL transition into Done — `updatedFrom` must carry a `stateId` key whose value ≠ Done.

### Fail-loud config guard
If `LINEAR_DONE_STATE_ID` is unset the handler refuses to fire (logs a distinct `[linear-webhook] LINEAR_DONE_STATE_ID is not set …` line, returns 200 `ok:false`) rather than reverting to firing on any completed state — not silently open, not silently closed. 200 is kept so Linear doesn't retry-storm.

### Tests
`backend/src/__tests__/integrations.linearWebhook.test.ts` (new — the route had zero tests): Merged/Verifying → 0 comms, already-Done edit → nothing, transition into Done → fires once, non-Done completed ID → nothing, missing config → loud no-op, signature enforcement. The Linear-side fix (git-automation merge→Merged, states created) shipped 2026-07-07; this is the code-side hardening (ENG-222).

## "Priority: High" in text but priority field unset — root cause + fix (2026-07-07, ENG-231)

Argusoft reported auto-generated Linear bugs whose descriptions say "Priority: High" while the actual Linear priority field is None and the issue sits in Backlog unassigned — invisible to priority-sorted triage. 11 live issues had this shape (ENG-167/189/190/191/197/200/201/202/203/209/213; hand-backfilled 2026-07-07).

### Root cause (adversarially verified)
`createInternalLinearIssue` (linearService) set only teamId/title/description/labelIds + stateId=Backlog — never `priority`/`assigneeId`. Emma's `report_product_issues` accepts a `priority: High|Medium|Low` param but only rendered it as description text via `issueContext['Priority']` → `contextLines()`. The legacy Notion path (`createOncallItem`) set an Owner + Move-to-Current-Sprint, so the Linear migration had silently regressed triage visibility.

### Fix
`FileUserIssueParams.priority` (text) is now mapped onto the Linear priority field in `fileBugReport` (urgent=1/high=2/medium=3/low=4; absent/unknown → Medium — bugs never arrive "No priority" per the board doc). High+ additionally lands `startInTodo` + default bug assignee (Manan as of 2026-07-20 / ENG-409; a hardcoded `BUG_DEFAULT_ASSIGNEE_ID` constant — there is NO `LINEAR_BUG_DEFAULT_ASSIGNEE_ID` env override in the code). `getTeamMeta` resolves `todoStateId`; `createInternalLinearIssue` gained optional `priority`/`assigneeId`/`startInTodo`.

### Assumptions to validate
- Dup-grouped High re-reports do NOT escalate the existing canonical's priority/state (kept out of scope; the reporter-count modifier in the board doc may want this later).
- `fileAutoIssue` (telemetry/oncall) still files unset-priority Backlog items by design — no text/field mismatch there, but they remain triage-invisible until ENG-187-style intake rules cover them.

## LinkedIn send-invite returns "Invalid parameters" for a valid <200-char note — root cause + fix (2026-07-07)

Scheduled LinkedIn outreach (ENG-213; reported by info@pmps.ai, session 3cac962b, and hit live on Hannah K's account NN-72jZtRD6nQSzEeK6n1g) kept failing send-invite with a generic `Invalid parameters`. The note-length red herring threw the first triage: the very first attempt failed correctly on a 203-char note (over LinkedIn's 200 limit), but after both notes were trimmed to 194 and 197 chars send-invite *still* returned `Invalid parameters` — for provider_id-based calls AND a profile_url-based call. search-people, get-profile, and list-sent-invitations all worked in the same session, so the fault was isolated to the invite endpoint, not auth or the note.

### Root cause (identifier form, not note length)
The agent passed a **public-identifier slug** (e.g. `william-kwak`, `leah-marcus-bab4981a0`) as `provider_id`. Unipile's profile-lookup endpoints accept *either* the slug or the canonical member URN, so `get-profile` and `search-people` worked fine — but Unipile's **invite** endpoint accepts **only** the canonical `provider_id` (member URN) and rejects a slug with the generic, undifferentiated `Invalid parameters`. Our send path (`LinkedInOutreachService.sendInvitation`) resolved the input via `resolveProviderId` (which for a slug just forwards the slug through) and sent that raw value straight to `client.users.sendInvitation`, so any slug-based invite was rejected regardless of note length.

### Fix
`checkIsNotAlreadyConnected` — the connection-check profile fetch we already perform before every invite — now **returns** the canonical `provider_id` revealed by the live profile lookup, and `sendInvitation` sends *that* rather than whatever identifier the caller passed. When the lookup fails or reveals no `provider_id`, it falls back to the passed identifier so a transient lookup failure never blocks (or breaks) the invite. No extra API call: we reuse the profile fetch that was already happening for the already-connected guard. Covered by the send-invite canonical-resolution test in `backend/src/__tests__/`.

## Scheduled runs crash with no assistant response — process-group SIGTERM kills the LLM worker mid-run (2026-07-07, ENG-202)

Second instance of the same signature (first: the Daily Token Usage report). A scheduled chat (session `64ebbde3`, xCures Daily Site Health Check, opus-4-8) died with `messageCount=2` (only the trigger), `totalTokens`/`totalCost` null — the run crashed before persisting any assistant message. A sibling site-scan schedule (session `d7d45dea`, sonnet-4-6) completed the same class of task 5/5 in the same window, so the failure is NOT task- or model-inherent; it's an execution/infra abort.

### Root cause (NOT the model path)
`generateSessionResponse` runs the LLM turn in a **forked child** (`services/generateMarketingResponseWorkerService.ts` → `workers/generateMarketingResponseWorker.ts`). A forked child shares its parent's process group by default. When the platform terminates the instance (Elastic Beanstalk deploy, autoscaling replacement, health-check restart) it broadcasts SIGTERM to the **whole group**, so the worker received SIGTERM directly. With no handler installed, Node's default action killed it instantly, mid-run — surfacing as `Worker process exited with code null and signal SIGTERM` and zero persisted assistant messages, even though the parent's graceful drain (`shutdown()`) would gladly have waited for the in-flight request to finish. The opus-4-8 correlation is a red herring: opus turns are longer, so they're simply more likely to be in flight when a group SIGTERM lands.

### Fix (shipped on main as ENG-201, PR #2038 — same root cause landed in parallel)
The runtime fix was authored twice independently for the same worker-crash signature; ENG-201 (PR #2038 — opened ~30 min after this ENG-202 PR #2037, but reviewed and merged first) landed the runtime code, so this branch defers to its implementation and this entry documents the shared root cause plus the one net-additive guard ENG-202 adds.
- `workers/workerShutdownGuards.ts` (`installWorkerShutdownGuards`), wired at the worker's module load (`generateMarketingResponseWorker.ts:13`). The worker now **ignores SIGTERM/SIGINT** — its lifecycle is owned entirely by the parent, which drains in-flight requests and then issues an explicit kill. Ignoring the racing group-signal lets the in-flight run complete during the drain instead of being aborted. As an orphan-safety net, the worker still exits on IPC `disconnect` (parent channel closed → no parent left to orchestrate shutdown).
- `GenerateMarketingResponseWorkerService.shutdown()` teardown switches `SIGTERM` → `SIGKILL`, since the worker no longer honors SIGTERM. Safe by that point — the drain above already let in-flight requests finish (or force-failed them at the ceiling).
- **ENG-202 addition:** a module-load wiring guard in `agentModeService.publishFixes.test.ts` asserting `installWorkerShutdownGuards()` is actually invoked at the top of the worker (not merely imported) — so accidental removal of the call, which would silently reintroduce this crash, fails a test.

### Assumptions — VERIFIED
- The worker is a `fork()` child sharing the parent group (confirmed in `generateMarketingResponseWorkerService.ts`), so a group SIGTERM reaches it directly — matching the `signal SIGTERM`, `code null` crash signature.
- Ignoring SIGTERM cannot strand the worker: the parent owns kill via `shutdown()` (drain → SIGKILL), and IPC `disconnect` covers the orphaned-parent case. Pinned by `workerShutdownGuards.test.ts` (SIGTERM/SIGINT ignored, `disconnect` exits) and the `shutdown` SIGKILL assertion in `generateMarketingResponseWorkerService.test.ts`.

## Featurebase feature requests land as run-on blobs in Linear — root cause + fix (2026-07-06)

Customer feature requests filed via Emma's `report_product_issues` were showing up in Linear as one giant run-on paragraph (reported on ENG-204). Chased it to ground truth.

### Root cause (NOT Emma's output)
Emma authors reasonable paragraph structure — the stored Featurebase post for ENG-204 had 39 newlines. Featurebase's `content` field is **HTML** (their docs: "content should be formatted as HTML"; it entity-encodes `&`/`<`/`>`). We send Emma's markdown/plaintext with raw `\n` and **no block tags**, so Featurebase renders `\n` as line breaks on its own board (nl2br) but its native `integrations.linear:true` push treats `\n` as insignificant HTML whitespace and collapses the whole body into one paragraph. Inline markers (`**bold**`, `##`) survive; all vertical structure dies.

Proof: FB-pushed issues (ENG-204; ENG-166 `"## The ask When a customer…"` — heading newline collapsed) are blobs, while issues our own code creates via `linearService.createInternalLinearIssue` (bugs ENG-151, autos ENG-205) preserve `\n\n` + `* ` bullets. The Linear API faithfully returns `\n`, so the flattening is genuinely in Featurebase's push. Editing an existing FB post's content does NOT re-sync to Linear.

### Fix
`featurebaseService.mdToFeaturebaseHtml()` converts the intake layer's markdown/plaintext to HTML block tags, applied at both send sites (`createPost`, `createTicket`). Hand-rolled (not `marked`) because the backend is CommonJS and marked is ESM-only — a static import risks ERR_REQUIRE_ESM breaking all intake; the converter also HTML-escapes input so raw user text can't inject markup. Native `integrations.linear:true` sync is left intact (it's load-bearing for the resolve→notify-upvoters flow).

### Assumption — VERIFIED live
That Featurebase's create-time Linear push preserves HTML block structure. Confirmed via a hidden (`inReview:true`) test post → pushed Linear issue: `<p>` → `\n\n` paragraphs, `<ul><li>` → `* ` markdown bullets. Headings lose their `#` and `<strong>` is dropped (cosmetic), but the vertical structure that caused the blob is fully preserved. Test artifacts cleaned up (FB post deleted; Linear ENG-216 canceled).

## Truthfulness bundle — finalize guard + instructive-error retryability (2026-07-02)

Built the ENG-143/135/124 truthfulness bundle from the EMMA-HARNESS-PARITY-PLAN "Build-Now Design" (PR-T1 + the ENG-124 retry-spiral half). Generalizes the shipped ENG-104 single-tool pattern into ONE enforcement seam at the loop edge.

### What shipped
1. **`services/agentMode/core/finalizeGuard.ts`** (PURE, ports-injected, same style as `toolDispatch.ts`). Runs after the final assistant message, before emit/persist, behind **`AGENT_FINALIZE_GUARD` (env, DEFAULT OFF — A-or-B migration flag, not an on-error fallback)**. Flow: lexicon prefilter for 6 high-harm completed-action claim classes (email_sent, task_created_or_updated, post_published, schedule_created, crm_saved, asset_generated) → ONLY on hit, one structured-output judge call via the existing `callLLM` → deterministic match against successful ledger entries (`status==='success' && !toolResultError(result)`; asset claims via `mediaGenProducedAsset` — the xCures 76×-images check generalized) → mismatch → ONE corrective turn → re-check → still mismatched → VISIBLE appended correction + `claim_mismatch` verdict reason (`computeRunVerdict` → degraded → 17:30 UTC cluster cron sees the class). Judge failure = deliver unchanged + loud `agent_claim_check_error` event (documented best-effort; blocking delivery on a judge outage would be failing badly). Never a silent rewrite.
2. **`services/agentMode/core/errorRetryability.ts`** — every model-visible tool error at the dispatch boundary now carries `[Retryable: yes/no — <next step>]` derived from `toolErrorClassifier` classes (rate_limit/timeout/network/upstream_5xx → yes; auth/upstream_rejected/invalid_args/tool_unavailable/invalid_output/policy_blocked → no + stop signal). Non-retryable classes **fast-trip the per-run breaker at 2 identical failures instead of 3** (`agentToolGatewayService`). empty_result/not_found deliberately NOT fast-tripped (same error text across different legitimate args).

### Assumptions to validate
- The lexicon prefilter windows (120 chars, completion verbs) are tuned on synthetic examples, not a prod claim corpus — expect some false negatives; the judge bill is bounded by prefilter hits.
- Claim-class → tool-name matchers are name-pattern based (e.g. `/^send_.*email/`); new tools with unusual names need a matcher touch. One seam to update.
- The ON-path characterization pins the corrective-turn transcript with the run's own `llmModel` as judge. If a cheaper judge model is wanted (DIAGNOSIS_MODEL), that's a one-line port change — deliberately not done to keep the flip decision (and prompt lane) with Harsha.
- Fast-trip threshold 2 changes when `AgentToolRepeatedFailureError` fires for terminal classes — reliability tightening (fewer wasted identical retries), verified against the June retry-spiral shape in gateway tests.

### Follow-up work on this branch (Manan, 2026-07-02/03)
- Closed two coverage gaps the ticket's own examples exposed: added a 7th claim class `settings_saved` (backed by `save_memory`/`save_org_memory`/`update_brand_guidelines`/`update_market_strategy`), and widened the `task_created_or_updated` lexicon to catch "landed"/"now in" phrasing (the literal "landed in ClickUp" example).
- Wired `claim_mismatch` verdicts into `AgentFailureRuleSet` so the 17:30 UTC cron actually clusters them — previously computed but never consumed by the policy layer.
- Found and fixed a footgun: `AGENT_FINALIZE_GUARD=true` alone gives zero telemetry without `AGENT_RUNTIME_SPINE_ENABLED` also set (the recorder is a no-op otherwise) — `checkFinalizeGuardMisconfiguration()` now warns loudly at boot.
- Added `AGENT_FINALIZE_GUARD_SHADOW` (detect + telemetry only, never rewrites the message) so real judge precision/recall data can be collected from production traffic with zero user-facing risk, ahead of the Okareo claim-faithfulness check this PR already flagged as unvalidated.
- Switched the judge call to a cheap/fast model (`gemini-3.1-flash-lite`, same as `triageSlackMessage`) instead of the run's own model — the corrective-turn call stays on the real model.
- Added a loose (keyword-only) matcher tier: a strict-matcher miss with a loose match on a real successful tool call is now treated as ambiguous (logged, not corrected) rather than confidently unbacked, to avoid false-correcting a true claim on a matcher coverage gap. Caught and fixed a self-introduced regression while building this (the asset_generated loose matcher initially also matched known `MEDIA_GEN_TOOLS`, which would have broken the xCures confirmation-gate-pause case) before it shipped.
- Live-tested on env1 (both flags on): confirmed `agent_run_verdict` events write correctly end-to-end; could not force a genuine judge mismatch through manual chat probing (Opus 4.8 self-corrected both attempts) — judge accuracy on adversarial/real traffic remains unvalidated, same gap this PR already called out.

## Slack ship-notify: Featurebase webhook → customer channel ping (2026-07-02, ENG-170)

Added `shipNotifyService` + `POST /api/integrations/featurebase/webhook`: when a reported item ships, ping the reporter in their own Slack channel — additive to the email paths (bug resolve-bridge Resend email; Featurebase-native upvoter email for feature requests). Channel = first of the existing personal → org → org-owner resolution (`getEffectiveAllowedChannels`, moved from `emma/slackMessageTools` into `slackService`). Idempotency = atomic per-item claim (`settingsService.claimSetMember`, DynamoDB string-set ADD with UPDATED_OLD — no read-modify-write) taken BEFORE the send; a failed send releases the claim so Featurebase's delivery retry re-attempts. The webhook 200s immediately and fans out detached (a slow fan-out must not trip Featurebase's delivery timeout → concurrent retry → duplicate pings). Post titles are user-generated → Slack control chars (`&<>`) escaped and non-plain-http(s) URLs dropped, so a public post title can't smuggle `<!channel>` or disguised links into customers' channels. Endpoint is dark until `FEATUREBASE_WEBHOOK_SECRET` is set; signature = HMAC-SHA256 over `${timestamp}.${rawBody}` (headers `X-Webhook-Signature` hex + `X-Webhook-Timestamp`, ±300s).

**Assumptions — VALIDATED LIVE 2026-07-02 (full E2E on test env, real Featurebase deliveries):**
- ~~`changes[].field === "status"`~~ **WRONG — caught live.** Status transitions arrive as DOTTED entries (`status.id`, `status.name`, `status.type`), never a bare `status`. Fixed in commit `e2067f84` (filter accepts both). This was the one silent-drop bug; a hand-written payload test would have locked it in — the live capture caught it.
- `data.item.postUrl` and `data.item.author.email` ARE present on `post.updated` (captured payload) — the `GET /v2/posts/{id}` fallback is rare-path as designed.
- Featurebase webhook `timeoutMs` is **5000ms** (from the webhook object) — the immediate-200 + detached fan-out design is mandatory, not optional.
- E2E proof (Linear ENG-174 → FB post flip → webhook → Slack): ping delivered to the mapped channel in ~4s; `<!channel>` injection probe in the title arrived ESCAPED (no broadcast); re-completing the item did NOT re-ping (atomic claim held); unsigned requests 401; endpoint dark without the secret.
- Ops finding: `SLACK_BOT_TOKEN` in the `agentweb/test-env` backend-env secret is STALE (`invalid_auth`) — E2E used the prod token. Refresh the secret so future test envs have working Slack.
- Voter list is fetched single-page (limit 100, warn on `nextCursor`) — fine at current board size.

Rollout: create webhook in Featurebase Settings → Advanced → Webhooks (topic `post.updated`, nova version) pointing at prod, set `FEATUREBASE_WEBHOOK_SECRET` (value in the Featurebase dashboard per-webhook), redeploy. Kill switch: unset the env var (endpoint goes dark again). Per-user opt-out: `slackShipNotifyDisabled` on AW-Users.

## OTel spine shipped — spans over the agent loop, dual-emit with the loops recorder (2026-07-02, ENG-141)

Added `backend/src/observability/` (tracing.ts + semconv.ts) and three span sites: `invoke_agent` opens/closes exactly with the run-recorder lifecycle in `agentModeService` (verdict from `computeRunVerdict` on end), `chat` brackets the loop's `callLLM` including the backup-model retry, `execute_tool` wraps the gateway call inside `toolDispatch.runOne` (errorClass from `toolErrorClassifier`). Two direct OTLP/proto exporters — Langfuse (`LANGFUSE_OTEL_HOST`+`LANGFUSE_PUBLIC_KEY`+`LANGFUSE_SECRET_KEY`, Basic auth) and Okareo (`OKAREO_API_KEY`, api-key header) — each registered ONLY when its env config is present; no env = tracing off; no collector. `session.id` + `gen_ai.conversation.id` carry the Emma sessionId for Okareo sim-linking. DUAL-EMIT: `Dev-AW-LoopEvents` stays the policy/learning store; the bridge is by IDs only (`traceId` added to `agent_run_started` dimensions). Prompt/completion content capture is `AGENT_OTEL_CAPTURE_CONTENT`-flagged, default OFF.

**Design choices to remember:** provider is module-private and NOT registered on the global OTel API, no context manager — parenting is explicit via a runId-keyed span registry (async-context propagation through a 24k-line monolith would be un-auditable). `gen_ai.*` names are pinned in `semconv.ts` because the upstream semconv is Development-status (renames must land in one file).

**Assumptions to validate:**
- Spans are produced in the WORKER process; `flushTelemetry()` runs in the parent's `gracefulShutdown`. The 2s BatchSpanProcessor delay + the worker drain window should export worker spans before the child is killed, but a worker SIGKILL <2s after a run ends can still drop that run's spans. If deploy-window traces go missing, add a bounded flush to the worker's per-run tail (next to `flushAgentRunRecorderSafe`).
- Langfuse OTLP trace path is `{host}/api/public/otel/v1/traces` (signal-specific URL, since the exporter takes the full URL). Verify on first real export.
- Okareo protobuf ingest accepts the `api-key` header form and links sims via `session.id`.

## Prod outage: partner-portal "Failed to load users" — full disk + nginx PrivateTmp trap (2026-06-26)

Three stacked failures, only the last self-inflicted by the attempted fixes:

1. **What filled the disk (true root cause).** `services/devEnvService.ts` `teardownEnvironment()` only guarded `if (!instanceId)`, so a dev-env Notion page stuck at the placeholder `"pending"` made it call EC2 `terminateInstances(['pending'])` → `InvalidInstanceID.Malformed` on every webhook tick (~12.5k times), and each failure retried commenting on a maxed-out Notion thread, dumping full AWS-SDK + Axios error object graphs (request `config`+`data`) to stdout at ~79 MB/day → `/var/log/messages` = 424 MB (98.6% app stdout). Root volume was the AL2023 default **8 GB** (RootVolumeSize unset), no `RootFilesystemUtil` metric/alarm, instance up 11 days.
2. **Why only `/admin/users` broke.** That response is ~1.9 MB (AW-Users rows inline `marketStrategy`/`competitorResult`/`brandGuidelines` = 62%), exceeding nginx in-memory proxy buffers, so nginx must spill it to an on-disk temp file. At 03:17 UTC a scheduled deploy tipped the disk to 100% → temp write fails → response never completes → "Failed to load users". Smaller endpoints fit in RAM and kept working.
3. **Why the fixes made it worse.** A custom `client_body_temp_path /var/tmp/agentweb-nginx` + predeploy hook were added. AL2023 nginx.service runs `PrivateTmp=true`, so nginx can't see the host-created dir and fails startup: `nginx: [emerg] mkdir() ".../client_body" failed (ENOENT)`. `nginx -t` PASSES out-of-band (host namespace) but the unit's own `ExecStartPre nginx -t` runs in the private namespace and ENOENTs → `systemctl start` exit 1 → every fresh deploy fails → env can't self-heal. SELinux refuted (errno 2/ENOENT, not 13/EACCES; the only AVC was permissive on error.log).

**Assumptions validated:** the count fan-out in `getAllUsers` is real but was NOT the cause (GSI COUNT queries, ~1,181 ops/req, 4.1 s — a latency time bomb near ~1,000 users, separate follow-up). The #1968 payload whitelist (already on main) cuts 1.9 MB→130 KB and is behavior-preserving (FE reads none of the dropped fields).

**Fixes.** Mitigated by EB rollback to `backend-20260625-pr1955`. PR #1971: remove the custom nginx temp path + hook, keep `proxy_buffers.conf` (the 1.9 MB response stays in memory). Hardening PR: devEnv `'pending'` guard + concise error logging; root volume 8→40 GB gp3; publish `RootFilesystemUtil` + 80% alarm → `agentweb-oncall-alerts`; weekly instance refresh; log caps. **Never override nginx temp paths to a custom `/var/tmp` dir on AL2023 EB — stock `/var/lib/nginx/tmp` is outside PrivateTmp's isolation.** The scheduled prod deploy runs daily 02:00 UTC, so the broken main config had to be fixed before then.

## Landing-page builder reliability — telemetry-driven hardening of the GitHub commit path (2026-06-13)

Scanned `AW-LandingPages` (prod) to ground "the builder is unreliable" in data rather than one anecdote.

### What the telemetry says
- **110 pages, 26 failed = 23.6% failure rate.**
- Failure modes (clustered by errorMessage):
  - **15 "fetch failed"** (58% of all failures) — a Node transient network error to an upstream (v0 / GitHub / Vercel) that was NOT retried.
  - **6 × v0 HTTP 500** — v0 outage symptom.
  - **2 × 422, 2 × 409** — GitHub ref-update conflicts (non-fast-forward).
  - 1 stuck `generating` (the orphan/timeout-lie class — addressed separately by the durable-execution work).

### Root cause of the dominant failures
`withRetry` already covers `fetch failed`/5xx/429/ECONNRESET, and the **v0 calls** and the **first-page repo creation** (`createGitHubRepoAndPush`, ~line 1700) ARE wrapped. But the **sub-page commit path in `addPageToExistingRepo`** was **bare axios with no retry** — five sequential GitHub calls (get-ref → blobs → tree → commit → patch-ref). A transient blip on any one failed the whole build as "fetch failed". That path is exactly where the 15 "fetch failed" came from.

Plus a **race**: the ref-update `patch` used a parent SHA read ~40 lines earlier. If another commit landed on `main` in between — which happens when two pages generate into the **same repo concurrently** — GitHub returns 422 "not a fast forward" (the 422/409s). **Unified multi-site makes this worse**, because it routes more pages into one repo.

### The fix
New `commitFilesToRepoMain(repoFullName, ghHeaders, files, message, maxAttempts=4)` wraps the commit sequence with retry + **rebase**: every attempt re-reads the current `main` SHA and bases the new commit on it, so a concurrent commit is rebased onto rather than rejected. `isRetryableGithubPushError` decides retry: non-fast-forward 422 / 409 (race) and transient 5xx/429/408/`fetch failed`/ECONNRESET/timeout → retry with backoff; 404/auth/validation → fail fast. `addPageToExistingRepo` now calls it instead of the inline axios sequence.

This kills the dominant "fetch failed" class AND the concurrent-commit race in one move. Flag-independent — strictly more resilient, applies to `main` today. Branch `harsha/harden-landing-commit-retry`.

### Duplicate/unnecessary builds — does retrying make it worse? (the right question)
Telemetry says duplicate building ALREADY happens, independent of any retry: **18/110 orphaned failed records** (started, produced nothing), **11 `(repo,slug)` pairs built >1× (some 3×)**, **7 retry storms** (same user+page <10min apart). Source: users/Emma re-asking + orphaned/detached builds (the durable-reconnect work targets that class).

The naive commit-retry would have ADDED a vector: if `patch-ref` succeeds on GitHub but the response is lost ("fetch failed" on the reply), a blind retry re-commits → a 2nd commit + 2nd Vercel build for the same page. Fixed with **idempotency**: `commitFilesToRepoMain` tracks the commit it tried to set and, on any failure, re-reads `main` — if it's already at our commit, the patch landed (lost response) → return success, never re-commit. A non-fast-forward 422 (patch rejected, main NOT at our commit) correctly falls through to rebase+retry. So retries can rebase and recover transient failures but can never double-build.

### Route-level idempotency — kills the 11 duplicate builds at the source (DONE)
A multi-agent audit + a fresh telemetry pass established the key fact: **all 11 duplicate `(repo,slug)` routes came from DIFFERENT chat sessions re-asking the same route** — not concurrency, not the same session. So the right key is **route identity (userId, slug)**, not a session lock or a serial writer. `generateLandingPage` now calls `findReusablePageForRoute(userId, slug)` in the existing-site branch: if a non-archived page at that slug is already `deployed`/`generating`/`deploying`, it's returned (reuse) instead of building a duplicate. Explicitly NOT `failed` (a retry after a failure must rebuild); legitimate refreshes go through the dedicated iterate endpoint. ~15 lines, no lock — the lightweight "idempotent entry" the design research endorsed as the simplest first step.

### Design direction (research, separate doc) — platform-native, net-removes complexity
Research (Webflow/Framer/Vercel/v0 + canonical patterns) concluded the simplest *target* is "repo is the source of truth, content-addressed, read live state": Vercel already returns the existing deployment for an already-seen commit SHA and cancels superseded builds (`autoJobCancellation`), so the duplicate/race/orphan problems are best solved by leaning on that + a `generationKey` idempotency on the v0 call, which would let us DELETE the orphan-sweep + redeploy poller + scattered guards rather than add more. The route-dedup above is the first, direction-agnostic step toward it.

### Still open (audit-confirmed, safe, next)
- **Vercel calls are bare axios** (createVercelProject/triggerVercelDeployment/poll/status) — wrap in `withRetry` (extend the classifier for axios `err.response.status`), the same gap as the GitHub commit path. High value (the 6 v0-500 + transient deploy failures).
- **First-page push** (`createGitHubRepoAndPush` blob/tree/commit/ref-patch) is still bare — route it through `commitFilesToRepoMain`.
- `generateFirstPage` put + `cleanupOrphanedFailedPages` could use conditional writes (compare-and-swap) to close the first-page concurrency race.
- v0 HTTP 500s (6) are retried by `withRetry` but a sustained v0 outage still surfaces; consider a longer/again-later retry or a user-facing "v0 is down, try again" rather than a hard fail.
- Vercel deploy 422 (1) — check `createVercelProject` / `triggerVercelDeployment` retry coverage next.

## Loop Slack egress gated to prod — fixes "Emma Dev yaps" class (2026-06-13)

Root cause of the duplicate "Emma Dev" AI-readiness DMs: ≥2 stale test-env backends had AI_READINESS_LOOP_ENABLED=true set per-instance (not in the shared secret — verified: the shared `agentweb/test-env/backend-env` secret sets the emma_dev Slack token but NO loop flags), and the loop's Slack post was gated only by that per-loop flag. So any dev box with the flag flipped could DM the founder via the shared emma_dev bot. Only ai-readiness yapped because only that one flag was ever turned on in dev.

### Fix (this PR) — best-practice, defense-in-depth
`shouldSuppressLoopSlackPost(env)` in `loops/adapters/awsAdapters.ts`, applied at the single Slack egress (`SlackPort.postMessage`) every loop uses (digest, attribution, dispatcher). Non-prod (`NODE_ENV !== 'production'`) suppresses the post and logs instead; overridable with `LOOP_SLACK_ALLOW_NONPROD=true` for intentional dev-channel testing. The per-loop enable flag controls behavior; this controls blast radius — they're separate concerns. emma_dev stays usable for everything else; only loop DMs are gated.

### Note
This prevents recurrence but does NOT stop already-running stale backends (their process is up). Those were stopped separately (see below / ops action 2026-06-13). The durable systemic fix beyond this is a TTL reaper on test-env instances (the real enabler was boxes living Feb→June) — filed as follow-up.

### Assumptions to validate
- After deploy, the prod readiness loop still DMs (NODE_ENV=production on prod EB → not suppressed). Falsified if prod stops posting — would mean prod env isn't NODE_ENV=production (it is, verified).
- No other legit non-prod loop posting relied on the old behavior. If a dev/staging channel digest was wanted, set LOOP_SLACK_ALLOW_NONPROD=true there.

## AgentMode B2 — session-generation claim made atomic (no double-proceed race) (2026-06-14)

WS-B / B2 reliability increment. The `/generate` and the interactive-share `/generate`
endpoints in `controllers/agentModeController.ts` each rejected concurrent requests for the
same session via a hand-rolled `activeSessionGenerations.has(sessionId)` check followed by a
separate `.add(sessionId)`. The two statements were duplicated at both call sites (re-grepped:
the regular path was ~line 2185, the interactive-share path ~line 2980 on `harsha/swarm` at
`187a06a9`).

**Assumption validated:** the pair is race-free *today* only because nothing `await`s between
the `has` and the `add` (Node's single thread won't interleave synchronous code). The fragility
the spec names is structural — any future edit inserting an `await` between check and set
(easy to do, since the two statements look independent and are separated by other request
setup) re-opens a window where two near-simultaneous `/generate` calls both pass the check and
both proceed, corrupting the single-flight guarantee.

**Fix (behavior-preserving):** co-located check-and-set into one indivisible primitive,
`tryClaimSessionGeneration(sessionId): boolean` (returns `true` for the winner, `false` for a
busy session), plus a symmetric idempotent `releaseSessionGeneration(sessionId)`. Both call
sites now call the primitive; an `await` can no longer be wedged between the check and the set,
so the claim is atomic by construction. Single-request path is unchanged (same 409 SESSION_BUSY
body, same lock lifecycle). No new tables/flags/branches; net moving parts ~flat (one helper
pair added, two duplicated 2-statement blocks collapsed to one call each).

**Tests:** `agentModeController.atomicClaim.test.ts` (5 cases) pins the contract — two
back-to-back synchronous claims on one sessionId yield exactly one `true` + one `false`;
cross-session independence; release-then-reclaim; idempotent release. Existing
`agentModeController.concurrentRequests.test.ts` (6) + `errorHandling.test.ts` (24) +
`delegatedCrmAccess.test.ts` (3) stay green unchanged → behavior preserved. `npx tsc` clean.

---

## AgentMode B3 review fix — trim WeakMap memo DROPPED after splice-path staleness found (2026-06-14)

Independent review of PR #1878 found the B3 WeakMap memo unsafe — and it failed on exactly the assumption flagged below in "Assumptions to validate (a)": the append-only invariant does **not** hold. `updateConversationContext()` (agentModeService.ts ~:3411-3434) runs on the same `messages` array reference inside the loop (called ~:2547, before the trim call ~:2603) whenever the agent installs skills. Its install_skills path does `messages.splice(idx, 1)` (remove the prior skill-context message wherever it sits) then `messages.splice(1, 0, …)` (reinsert near the top) — a remove-then-reinsert that is **net-zero in length** but shifts every absolute index between the two positions. The memo's `cached.length <= messages.length` guard sees no growth, walks an empty tail, and serves STALE absolute indices (`toolIndices` / `toolIdToIndex`) against the shifted array → wrong `preserveSet` / `oldAssistantIndices` → trimmed output DIVERGES from the original algorithm. Not behavior-preserving; AC-breaking.

**Fix:** removed the WeakMap memo entirely. Kept the `tool_call_id → index` Map — that alone kills the originally-reported per-call nested O(n²) scan (O(1) lookups) and is fully behavior-preserving on every path including splice/reorder, because the scan is recomputed against the live array each call and can never go stale. Net effect: fewer lines and less per-instance state than the merged PR, no correctness caveat.

**Proof:** added a `splice/reorder safety` describe block to `agentModeService.trimToolContext.test.ts` with two cases (net-zero reorder that shifts the preserved tail + a length-changing reorder), each mutating the SAME array ref and asserting deep-equality against the golden oracle on the post-splice array. Both FAIL against the memo'd version (verified by reverting the service file) and PASS with the memo removed. Existing golden-oracle characterization + sub-quadratic perf tests retained and still pass (32/32 across trim + publishFixes suites; `npx tsc` clean).

**Lesson:** a length-only memo guard cannot detect an in-place reorder that preserves length. The "Assumptions to validate (a)" note below correctly predicted this; the safe move was to not ship the memo at all, since the Map already solves the reported defect.

---

## AgentMode B3 — `trimToolMessagesForContext` made incremental, killing per-iteration O(n²) reprocessing (2026-06-14)

`AgentModeService.trimToolMessagesForContext()` (agentModeService.ts ~:16612) is called once **per loop iteration** from the main agent loop (`while (iteration < maxIterations)` at :2501, call site :2603) on the full, monotonically-growing `messages` array. Old shape was O(n²) *per call*: the `oldAssistantIndices` pass ran a nested forward scan (for each assistant-with-tool_calls, scan all following messages looking for a preserved tool result). Across an N-iteration session that's O(N²)+ total reprocessing of the same history.

**Fix (behavior-preserving, internal only):**
1. Replaced the per-assistant nested forward scan with a single `tool_call_id → tool-message-index` map built in one linear pass, so the "is this assistant old?" predicate is O(1) lookups instead of an O(n) scan. A single call drops from O(n²) to O(n).
2. Added a per-instance `WeakMap<messagesArray, {length, toolIndices, toolIdToIndex}>` memo. The agent loop only ever **appends** to `messages` (verified: the sole in-loop mutation is `messages.push` at :3181 — no splice/shift/reorder), so on repeat calls with the same array reference the scan only walks the appended tail. Amortized per-call cost is O(tail); a full session is O(n) total. The memo is validated by `cached.length <= messages.length`; any reference/shrink mismatch falls back to a full O(n) rebuild, so a stale memo can never corrupt output.

**Exact predicate preserved:** the original flips `allOld=false` only when a resolving tool result exists at an index `> i` AND is in `preserveSet`. The map stores the first tool index per `tool_call_id` (ids are unique by construction), and the new check is `resolvedIdx !== undefined && resolvedIdx > i && preserveSet.has(resolvedIdx)` — identical semantics.

**Proof:** new characterization test `agentModeService.trimToolContext.test.ts` carries a golden reference that replicates the original nested-loop algorithm and asserts deep-equality of production output on a long synthetic session AND across the real incremental (append-per-turn, same array ref) calling pattern. Validated TDD-style by stashing the fix: against the ORIGINAL code the 4 characterization tests pass (golden == original) and the 2 sub-quadratic tests fail (4×-session work ratio 14.1× ≈ quadratic; incremental case 15,750 `role` reads). With the fix all 6 pass (ratio < 6, linear). Existing 24 `publishFixes` trim tests unaffected.

**Assumptions to validate:** (a) the in-loop append-only invariant holds for all code paths feeding this method — if a future change ever reorders/removes earlier messages on the same array reference *without* shrinking length, the memo could go stale; the `length`-only guard would not catch that. Mitigation if that ever happens: also stamp a cheap head-identity check. Today no such path exists. (b) `chatbotService.ts` has its own standalone copy of `trimToolMessagesForContext` (:3702) — NOT touched here; same optimization could be applied there in a follow-up.

---

## B5 — Dedupe/rate-limit context-limit oncall alerts (stop flooding) (2026-06-14)

The context-limit error path in `controllers/agentModeController.ts` fires `sendAgentModeOncallAlert` (`utils/agentModeAlerts.ts`) on **every** occurrence. Two sites hit it: the regular `/generate` path (re-grepped to ~line 2453) and the shared/interactive-response path (~line 3111). On a high-concurrency day, one user repeatedly retrying a too-long session would generate one oncall email **per request** — pure noise.

**Notion side was already deduped**: `autoReportContextLimitToNotion` sets a per-session `contextLimitReported` flag and skips if set, so Notion only ever files one issue per session. The flood risk was the **oncall email**, which had no dedupe at all.

**Fix (contained, behavior-preserving):** added an opt-in `dedupeKey` + `dedupeWindowMs` (+ injectable `now` for tests) to `sendAgentModeOncallAlert`. When `dedupeKey` is set, an in-memory `Map<key, lastAlertTs>` suppresses repeat alerts inside the window (default 10 min); the map is lazily pruned past 1000 entries. When `dedupeKey` is absent, behavior is unchanged — every call fires (all other ~14 call sites untouched). The two context-limit sites now pass `context_limit:<userId|sessionId>` and `context_limit_shared:<userId|shareId>` respectively (distinct error classes key independently).

**Assumptions to validate:**
- In-memory dedupe is per-process. With multiple backend workers, the worst case is ~1 alert per worker per window (still a >N× reduction from per-occurrence). A shared store (Dynamo/Redis) would make it global but adds a moving part — deferred unless per-worker volume is still noisy in prod.
- 10-min default window chosen to match a typical retry-storm; tune via `dedupeWindowMs` if oncall still sees clusters.
- The user-facing 413 `CONTEXT_LIMIT_EXCEEDED` response is unchanged — dedupe only gates the alert email, never the HTTP response (existing `errorHandling` test 1026 still passes).

---

## Layer 4→5 closed: real Slack-reaction approval gate that stamps shippedAt (INCREMENT C1, 2026-06-14)

The dev.md-named #1 learning-loop gap (2026-06-09): production `ApprovalGate` is `CaptureGate` (`loops/core/gates/captureGate.ts`), whose `pollDecision()` ALWAYS returns `pending` → `shippedAt` is never stamped → the attribution cron (`loops/core/learning/attribution.ts:143`, filter `decision.status in {approved,auto_shipped}` AND `shippedAt` set AND `verdict==null`) has nothing to grade → every loop sits at `pending_approval` forever.

**Shipped:** `loops/core/gates/slackReactionGate.ts` — `SlackReactionGate implements ApprovalGate`. `requestApproval` posts the proposal DM via the injected `SlackPort` and returns a handle (`{channel, ts, approver}`). `pollDecision` reads reactions and resolves via the pure `resolveReactionDecision(reactions, approver, now)`: ✅ `white_check_mark` from the approver → `approved`; ❌ `x` → `denied`; none → `pending`. **Reject wins over approve** when both present (safety). Reactions from non-approvers ignored (matches the `slack.aiEvalReaction` handler convention + `awsAdapters.getReactions`). `settleDecision(store, loopId, mutation, decision)` performs the Layer-5 write: approved → appends a record with `decision=approved` + `shippedAt` stamped (the exact shape attribution grades); denied → record `decision=denied`, NO `shippedAt`; pending → no-op. Idempotent per proposal (in-process `settled` set) so a repeated poll never double-ships.

**Assumptions to validate (NOT yet wired into the live runner):**
- This PR ships the capability + tests, NOT a prod flip. `CaptureGate` is still the registered `agentModeGate`. The gate is gated behind `AGENT_MODE_SLACK_REACTION_GATE` (default OFF) via `buildAgentModeSlackReactionGate()` in `instances/agent-mode/index.ts`, which builds-but-does-not-register.
- **Why deferred:** `createInstanceRunner` (`loops/core/instanceRunner.ts:48`) types its held `gate` as `CaptureGate` and `drain()`s it each tick to batch the digest DM. Promoting `SlackReactionGate` into the runner means restructuring that drain path — a separate, larger change with its own behavior-preserving proof. Doing it here would change the digest-batching behavior, which is out of C1's contained scope.
- C2 (attribution reaches a verdict) depends on this gate's `settleDecision` actually running in prod, which depends on the runner-wiring PR above. Until then `shippedAt` is stamped only in tests.
- Reaction polling is single-shot per `pollDecision` call; no long-poll. The watchdog cron cadence determines how fast an approval is observed — confirm the cron actually calls `pollDecision`+`settleDecision` once wired.

---

## C2 — approval→attribution→verdict path verified end-to-end; found + fixed a `computeLoopHealth` stall (2026-06-14)

Verified WS-C2 ("attribution reaches a verdict"): drove the real Layer-4→5 approval write (`recordLoopApproval`, the C1 gate contract — stamps `decision=approved` + `shippedAt`) → elapsed the settle window → ran the generic `runAttribution`. The grading path itself works: a verdict (`improved`/`regressed`) is computed and appended to the learning store, and the dedup is idempotent (a second pass writes nothing). New end-to-end mocked test: `backend/src/__tests__/loops.c2.approvalToVerdict.test.ts` (in-memory learning store + fake sensor, zero network).

**But the loop never visibly came off `pending_approval`, which is the AC.** Root cause = the learning store is **append-only**: one logical proposal accumulates a `pending` row → an `approved`+`shippedAt` row (from `recordLoopApproval`) → a graded `verdict` row. `computeLoopHealth` (`loops/core/health.ts`) counted EVERY matching row, so:
- the original `pending` row kept counting as `pendingApproval` even after the ✅ → state stuck at `pending_approval` forever; and
- the pre-verdict `approved`+`shippedAt` row kept counting as `inFlight` even after grading → state stuck at `in_flight`, never reaching `learned`.

`GET /api/admin/loops/health` reads with no status filter (`loopHealthService` → `queryHistory({loopId})`), and both `InMemoryLearningStore` and `DynamoLearningStore` return all rows — so this misreport is real in prod, not a test artifact.

**Fix (behavior-preserving, pure):** in `computeLoopHealth`, de-dup by proposal/mutation id — count a `pending` row only if no later row has resolved that proposal (approved/auto_shipped/shipped/graded), and count an `in_flight` row only if no graded verdict exists for it. Each logical proposal is now summarized by its furthest-progressed row. All 22 existing `loops.health.test.ts` cases stay green (single-row states are unaffected — there's no later row to supersede them).

**Assumptions to validate:**
- The attribution **scheduling** wasn't exercised here (this drives `runAttribution` directly); `loopAttributionCron` already iterates manifests + skips paused loops (covered by `loops.attributionCron.test.ts`). The settle-window gating is `runAttribution`'s own logic.
- C1 (the Slack-reaction `ApprovalGate` that calls `recordLoopApproval` on a ✅) is **not yet landed on `harsha/swarm`** — production gate is still `CaptureGate` (`pollDecision` always `pending`). This test builds against the documented C1 contract (the persistence primitive `recordLoopApproval` that produces `approved`+`shippedAt`). Once C1 lands, its gate must call that primitive for the health transition to fire in prod.
- The health de-dup keys on `proposalId ?? mutationId`, matching attribution's own `recordKey`. If a future loop emits rows with neither id, those rows can't be de-duped (they fall back to counting as-is) — acceptable since every current emitter sets a proposal.

---

---

## AgentMode B1 — worker-crash session-lock leak: already-released on crash, but session→request map leaked (2026-06-14)

Investigated WS-B1 (worker crash holds `activeSessionGenerations` until `GENERATION_TIMEOUT_MS`). Re-grepped the current sites:
- The session-generation lock is `activeSessionGenerations` (`controllers/agentModeController.ts:40`), claimed at `:2192`/`:2987`, released in a `finally` at `:2356`/`:3032`. `GENERATION_TIMEOUT_MS` = 600s (`:56`).
- `generateSessionResponse` (`:1592`) `await`s `generateMarketingResponseWorkerService.runInWorker` (`:1819`). The worker is a forked child (`services/generateMarketingResponseWorkerService.ts`).

**Finding (assumption corrected):** the literal "lock only releases after the timeout on crash" is NO LONGER true. The worker `error`/`exit` handlers (worker service `:201`/`:216`, added Feb 2026 in the "Improved Agent Mode Response Speed" change) already reject every in-flight `pendingRequests` entry on worker death. That rejection unwinds through `runInWorker` → `generateSessionResponse` → the controller's `try/finally`, which deletes the lock **immediately**. Pinned by `agentModeController.workerCrashLockRelease.test.ts` (simulated worker death → next `/generate` for the same session is accepted, no timer advanced) — passes on the pre-fix code.

**Real remaining defect in the same region (this is what the fix addresses):** both crash handlers (and `shutdown`) reject + `clear()` `pendingRequests` but never clear `sessionToRequestId`. So after a crash a dead session's `requestId` lingers — a later `cancelSession()` for that session mis-fires a `{type:'cancel'}` at the *fresh* worker, and the map grows unbounded across crashes. Fixed by a single `failAllPendingRequests(error)` helper that rejects pending requests and clears BOTH maps; `error`/`exit`/`shutdown` now call it (dedupes three near-identical handler bodies → net-negative branches). Behavior-preserving: the rejection path and error messages are unchanged; only the stale-mapping/leak is closed. Repro test: `generateMarketingResponseWorkerService.test.ts` "clears the session→request mapping when the worker crashes" (failed pre-fix: stale cancel fired; passes post-fix).

Assumptions to validate: (a) no caller depends on `sessionToRequestId` surviving a crash (verified: only `cancelSession` reads it, and post-crash there's nothing to cancel); (b) the controller path remains the sole lock owner (verified: lock lives only in the controller, worker service has no reference to it).

---

## B4 — SSE zombie progress: worker death now clears progressStore at the source (2026-06-14)

WS-B4 fragility fix. `progressStore` (`utils/sseProgress.ts`) is an in-memory `Map<sessionId, ProgressUpdate>` that backs the agent-mode progress SSE stream. The frontend treats a stored entry whose `status` is not `complete`/`suggestions` as "still generating" (`hasActiveProgress`, controller). Cleanup was entirely the controller's job: every terminal path calls `markProgressComplete(sessionId)` (emit `complete` → `progressStore.delete`).

**Re-grepped the spec's line refs (the monolith moves):** `progressStore` is set only in `emitProgress` (`sseProgress.ts:45`); deleted in `cleanupProgress`, `markProgressComplete` (controller ~1545), and inline at controller ~2213/2992/5695/5749. The generation worker is `generateMarketingResponseWorkerService` (fork child process); on `worker.on('error')`/`worker.on('exit')` it rejected all `pendingRequests` but did **nothing** to `progressStore`.

**The gap:** progressStore cleanup depended on the *awaiting* controller path reaching a `markProgressComplete`. The detached fire-and-forget plan-start path (controller ~5693, `.then().catch()`, not awaited by any HTTP handler) and any future caller that doesn't wrap in that exact catch leak a stale entry forever when the worker dies mid-iteration → frontend streams "Thinking…" indefinitely even after reload. This is the charter's "crash of a turn must not orphan a stream" invariant.

**Fix (behavior-preserving, additive on the crash path only):**
- New leaf helper `clearTerminalProgress(sessionId)` in `sseProgress.ts` — the single definition of terminal cleanup: emit `complete` *iff* a live entry exists (so it never resurrects an already-cleaned entry), then delete. Active SSE connections are intentionally left registered so a reconnecting client still gets `complete`.
- `generateMarketingResponseWorkerService` now calls `clearProgressForInFlightSessions()` (iterates `sessionToRequestId`, best-effort `clearTerminalProgress` per session) inside both the `error` and `exit` handlers, before clearing the maps. Also clears the previously-leaked `sessionToRequestId` map on death.

No change to chat outputs, tool selection, prompts, or model defaults — only guaranteed reliability cleanup on worker death.

**Assumptions to validate:**
- `sessionToRequestId` holds exactly the sessions with in-flight worker requests at death time — confirmed: set in `runInWorker`, deleted on the matching `message` response. A session whose request already settled is not in the map, so we don't touch its (possibly post-run `suggestions`) progress.
- Importing `sseProgress` (a zero-dependency leaf util) into the worker service introduces no import cycle — confirmed (`sseProgress.ts` imports nothing).
- The controller's happy/cancel paths are unchanged (`markProgressComplete` left intact), so this is purely a second, source-level safety net for the crash case.

## "Emma Dev" Slack chirping — agent-mode reliability loop DM'd Harsha on EVERY run, killed (2026-06-14)

**Symptom:** a recurring "Emma Dev" Slack DM chirp that only ever came from the **AI Reliability loop** (the agent-mode tool-reliability loop), arriving at seemingly **random** times with no obvious source.

**Where it came from:** the "Emma Dev" sender is the backend's `SLACK_BOT_TOKEN` Slack app (`loops/adapters/awsAdapters.ts` `awsSlackAdapter` → `chat.postMessage`). `server.ts:700` schedules the agent-mode tool-reliability loop behind `AGENT_MODE_LOOP_ENABLED` (on in prod): each booting process does `setTimeout(→ next 17:30 UTC)` then `setInterval(24h)`. After each run, `loops/instances/agent-mode/index.ts` `onRunComplete` called `postLoopDigest(...)`, which DMs `manifest.approval.slackUserId` (`U08TM4QFQ1L` = Harsha). That digest is the chirp.

**Why it chirped (the "for some reason"):**
1. **Only this loop is both scheduled AND enabled in prod.** Siblings `ai-eval` (`AI_EVAL_LOOP_ENABLED`), `ai-readiness` (`AI_READINESS_LOOP_ENABLED`), and `onboarding-v2` (`ONBOARDING_LOOP_V2`) are env-gated off, so they never fire. Only `AGENT_MODE_LOOP_ENABLED` is on.
2. **It DM'd unconditionally, even on empty/quiet windows.** `postLoopDigest`/`buildLoopDigestLines` (`loops/core/digest/loopDigest.ts`) always renders a message. `ai-eval` guards its post with `if (drained.length > 0 || result.eventsScanned > 0)`; agent-mode had **no such guard** (only `if (drained === null) return`, and `drained` is never null because the loop holds a `CaptureGate`). The recorder that feeds it is gated *separately* by `AGENT_RUNTIME_SPINE_ENABLED` (off in prod), so every run scanned **0 events** and still fired the "_No agent-mode tool events… not 'healthy', just empty_" DM. Pure noise content.

**Why it felt RANDOM (the part the first writeup missed) — no daily-dedup claim + multi-process prod:** `ai-readiness` wraps its DM in `claimDailyDigestPost()` (`ai-readiness-funnel/index.ts:285`) — a DynamoDB conditional `put` keyed on `(digestDate, slackUserId)`, so only ONE poster per calendar day wins and every other process gets `ConditionalCheckFailedException` → "already posted, skipping duplicate." **Agent-mode has no such claim** — `onRunComplete` posts directly. Prod runs on Elastic Beanstalk with **multiple instances + a worker process**, and each process schedules its own boot-aligned timer. Every redeploy, autoscale event, crash-restart, and the nightly 2am scheduled deploy spins up a fresh process with a fresh `setTimeout` → **duplicate DMs at staggered, unpredictable times**. That's the "random": not one daily chirp, but N-per-day from N independent processes with no lock.

**Note (correcting the loop's own dev.md §~110):** the gate being `CaptureGate` does NOT mean the DM is dead — approval is out-of-band (Harsha ✅ → `routes/slack.ts` → `recordLoopApproval`, and `shippedAt` IS stamped via `approvalPersistence.ts`). So the digest was *actionable*; it was just noisy + duplicated. The kill is about noise, not because the DM never worked.

**Fix (complete kill, reversible):** `onRunComplete` now returns before posting unless `AGENT_MODE_LOOP_DIGEST === 'true'` (default off) — the dedicated flag. This kills the chirp **regardless of how many instances/processes fire**, because every process checks the flag and stays silent (so it also sidesteps the missing-dedup problem). The loop still registers, records, runs, and surfaces via `GET /api/admin/loops/health` — it is simply **silent**. No EB env change needed: even with `AGENT_MODE_LOOP_ENABLED=true` the chirp is gone. To re-enable, set `AGENT_MODE_LOOP_DIGEST=true`. The exact digest wire format is still pinned by characterization tests (now under that flag) so the dispatcher contract is preserved.

**Proper follow-up if the digest is ever re-enabled:** add the `claimDailyDigestPost()` dedup (copy the `ai-readiness` pattern) so the multi-process duplication is fixed at the source, not just muted by the flag. Tracked as a TODO in the dev.md, not done here (the flag fully solves the reported problem).

**Tests:** `loops.digestCharacterization.test.ts` — added "is silent by default — posts NO digest DM even when tools are failing"; the 3 verbatim-format tests run under `AGENT_MODE_LOOP_DIGEST=true`. `npx tsc` clean, 22/22 pass.

---

## Live tool-failure telemetry — 227 failures classified; raw failure-rate OVERSTATES breakage (2026-06-13)

Pulled actual error strings from `Dev-AW-LoopEvents` (failure events carry `dimensions.errorClass`/`errorMessage`; `agent_tool_invoked`/`agent_tool_succeeded` do NOT — a failure = invoked-without-a-matching-succeed, which is how the loop derives rates). 227 sampled failures classified by root cause. Confirms + makes empirical the Section-C "tool-list truncation" finding below and the 2026-06-11 #eng thread with Rui (June 9–12 window: 223 runs, 1,016 calls, 78 failures).

**THE updated assumption (this changes retire/keep decisions): raw per-call failure rate ≠ breakage.** Only a minority of the 227 are real tool bugs. Buckets:
1. **Model calling tools that aren't installed** — "Tool X is not available. You must install the required skill first" (`search_tool_response` ×15, `describe_image` ×8, `linkedin_outreach` ×8, `read_file_content`, `wait_seconds`, `get_login_credentials`…). This is the **live symptom of the Section-C tool-list truncation** (~141 tools vs 128 Azure cap, `agentModeService.ts:2070`): dropped tools become "not available" when the model calls them. NOT per-tool bugs — fixing truncation (tool-search instead of drop) removes a large share of ALL failures at once.
2. **Validators correctly rejecting bad input (working-as-designed, NOT failure)** — `run_local_agent_task` "Task rejected: web browsing/data extraction only" ×10 + forbidden-pattern `post.*comment` ×2; `linkedin_outreach` "Should delay new invitation to this recipient" ×9 (LinkedIn anti-spam delay). These inflate the rate; a naive ">30% → retire" rule would kill tools that are working. (run_local was the "55%" in the thread — most of it is this.)
3. **Schema-validation rejections caught pre-execution (cheap)** — `read_tool_response` ×18, `search_tool_response`, `wait_seconds`: "arguments failed schema validation" / "s3_key and query required". Fix = mark args required; #1818 gateway pre-flight already catches these before execution.
4. **Real config/infra bugs (the actually-actionable list):**
   - **Legacy search-provider 429 — CONFIRMED LIVE across every variant** (web/news/video/local/image_search all "429 Too Many Requests"; summarizer failures were a *cascade* — nothing to summarize once web-search 429s). One shared key throttled. Fix: consolidate on `search_web` (failed only 2×, both benign "No search results").
   - `perform_data_analysis`: `404` / "The specified bucket does not exist" — missing/misconfigured S3 bucket.
   - `call_meta_ads_insights_api`: "Meta Insights Job timed out" — matches the Section-A background-job fix.
   - `slack_get_recent_messages`: "The Slack bot is not a member of channel …" ×4 — backend bot needs inviting (same class as the `LEAD_CAPTURE_ALERT_SLACK_CHANNEL` / #lead-capture caveat).
   - `coding_agent` "Not authorized to edit this landing page" / `get_file_contents` GitHub "Bad credentials" — per-user secret/auth gaps.

**Decision implication:** retire/keep cannot run off raw failure rate — it needs failure-**type** classification first (real-bug vs by-design vs model-error vs config). This is exactly Fangfang's #eng point (a human, then an LLM judge, classifies output + tool-call quality *before* fixes). The loop's *sensing* works; the missing layer is **failure classification, not more sensing**. Concretely: tag each `Dev-AW-LoopEvents` failure with one of {bug, by_design, model_uninstalled_tool, schema_reject, config} so the weekly scorecard reflects real tool health.

**UPDATE — classifier SHIPPED (`utils/toolFailureType.ts`, 100% cov; `runRecorder.toolFailed` now stamps `dimensions.failureType`; backfilled all 227 historical `agent_tool_failed` via `scripts/backfillFailureTypes.ts`).** Final distribution of the 227:

| failureType | count | share |
|---|---|---|
| bug (real candidates) | 63 | **28%** |
| config | 56 | 25% |
| schema_reject | 49 | 22% |
| model_uninstalled_tool | 34 | 15% |
| by_design | 25 | 11% |

So **only 28% of "failures" are real bugs** — the scorecard/policy should filter `dimensions.failureType = 'bug'`. Classifier reads signals from the error *message* too, so pre-classifier events (errorClass `'Error'`) still classify provider 429s correctly.

**UPDATE 2 — classifier TUNED + Theme 1 fixed.** Investigated the 63 `bug`s: many were misclassified. Tuned the classifier (LinkedIn "cannot resend"/"recipient cannot be reached"/"no results"/bad-PDF → by_design; invite-too-long → schema_reject; summarizer cascade / 404 / aborted-op → config) and re-tagged all 227 (`backfill --force`, 27 changed). **Real `bug` count: 63 → 36 (16%).** New split: config 66 / schema_reject 55 / by_design 36 / **bug 36** / model_uninstalled_tool 34.

The 36 real bugs cluster into: **opaque error propagation** (run_local "success=false", Meta "unknown error", linkedin "Invalid parameters", describe_image 400) · stale-file editing (`update_html_file` hash mismatch) · browser flakiness (playwright timeouts/snapshots) · misc (`get_leads` bad pagination key, `report_product_issues` self-failure).

**Theme 1 (opaque errors) — central fix SHIPPED:** extracted `toolResultError`/`extractToolResultMessage` to `utils/toolResultError.ts` and hardened it to surface object-shaped errors (Meta Graph `{error:{message,code,error_subcode}}`) + status/reason instead of the opaque "Tool returned success=false". **`run_local_agent_task` source fix SHIPPED:** `buildLocalAgentResult` (localAgentTools.ts) now always populates a failure reason (`error` → `result` → `returncode N`) so an ok:false relay response is never opaque. Remaining per-integration follow-ups: Meta subcode extraction at its handler, describe_image 400-body capture.

---

## Platform state audit — reliability fixes, complexity levers, SOTA gaps, learning-loop health (2026-06-13)

Whole-backend deep-dive (6 parallel agents; reliability + complexity findings adversarially verified, 0 false-positives). Recorded as the "where we are vs where we need to be" baseline so it isn't re-researched. Loop framework = `backend/src/loops`. Findings cross-checked vs `origin/harsha/dev`. Branch at audit time: `harsha/durable-landing-multisite` / `harsha/retire-stale-agent-models`.

### A. Reliability — fixes needed (all verified, file:line)

**CRITICAL**
- **Stripe webhook user lookup is a single-page full-table Scan → silently drops billing events at scale.** `findUserByStripeCustomerId` (stripeService.ts:1024) → `userDb.scanWithFilter` (db.ts:1133-1147) is one `.scan()` with NO `LastEvaluatedKey` loop; once `AW-Users` exceeds ~1MB a real paying user on a later page returns null. Called at the top of every webhook handler (handleSubscriptionUpdated stripeService.ts:534, handleInvoicePaymentSucceeded :643, +4). On null, `isNonRetryableError` (stripeController.ts:27-33) treats "user not found" as permanent → HTTP 200 → Stripe STOPS retrying. This IS the State-Reconciliation failure mode. Fix: GSI on `stripe_customer_id` + Query; interim, paginate the scan (`scanAllItems` helper already at db.ts:1193) and make "user not found" retryable (500). Effort M.

**HIGH**
- **No event-level idempotency + ordering bug on Stripe webhooks.** Switch dispatch (stripeController.ts:86-143) has no `event.id` dedup → redeliveries re-run; stale-guard (stripeService.ts:544-553) compares only `subscription.id`, never `event.created`, so out-of-order `.updated` events both pass and the later-arriving-older event clobbers `subscription_status`/`current_period_end` (stripeService.ts:569,596-601). Replayed `.created` (isNew bypasses guard) resurrects a canceled sub. event.id dedup exists ONLY in the fire-and-forget CRM mirror (stripeController.ts:307), not on user state. Fix: persist processed event.ids (TTL item + attribute_not_exists) + per-sub last-event-created ordering guard. Effort M. ← core of the State Reconciliation epic.
- **googleAdsService uses bare axios, no timeout** (6 calls; only image download :681 has one) while every peer (hubspot/attio/linkedIn 15s, apollo/enrichSo 30s) uses `axios.create({timeout})`. Hung socket blocks forever. Fix: module-level `axios.create({timeout:15000})` + 429/5xx backoff. Effort S.
- **call_meta_ads_insights_api blocks the agent run up to 10 min synchronously** (agentModeService.ts:12441-12492): 60×10s poll, no axios timeout, unbounded pagination — the documented 41% failure source. Fix: background-job pattern (return report_run_id + separate poller) + per-poll timeout + maxPages. Effort L.
- **uncaughtException handler only logs, never exits** (server.ts:298-304) → process serves traffic in an undefined state; EB won't restart a hung-but-alive instance. Fix: log+flush+metric+`process.exit(1)`; add unhandledRejection alarm metric. Effort S.

**MEDIUM**
- **Fire-and-forget `void` re-throws → unhandled rejection that only logs** (crmFindEmailRunner.ts:80-83 records then `throw`s; called `void` at autoEnrich.ts:165 with no `.catch`). With the no-exit handler, silent in prod. Effort S.
- **Boot crons are in-process setInterval, no distributed lock** (onboardingLoop server.ts:545-561 — gated by ONBOARDING_LOOP_ENABLED; watchdog :572). Multi-instance → double-fire; restart near schedule → skip. Copy the correct `claimAction` pattern from socialEngagementExecutor.ts:168. Effort M.
- **Generation timeout releases the lock but doesn't cancel upstream work** (agentModeController.ts:50-53) — no AbortController, so orphaned generations (the Meta poll, hung axios) keep running/spending. Effort L.
- **Agent-tool gateway has no per-tool timeout** (agentToolGatewayService.ts:488) — the (real, working) repeated-failure breaker only trips after 3 failures; a first-call HANG is never counted, blocks until the 10-min outer timeout. Fix: per-effect timeout feeding the breaker. Effort M.

**LOW**
- **updateUser is get-then-write, no conditional/version guard** (db.ts:1244-1297) — per-field SET avoids whole-record clobber, but same-field concurrent writers (webhook vs settings) are last-write-wins. Effort M.

**Verified GOOD (do NOT re-flag):** the agent-tool repeated-failure circuit breaker DOES exist + is correctly wired (agentToolGatewayService.ts:107-166, 459-505 — file is flagged binary, use `grep -a`); metered LLM factory is non-blocking (llmClients.ts:118-168); payment history dedups by invoiceId+eventType; the generation lock has a wall-clock timeout that fixed the 409-busy-forever deadlock.

### B. Complexity — reduction levers (verified behavior-preserving)

- **agentModeService.ts = 24,225 LOC / ~270 methods god-object.** Extract LeadCrm (8287-10521, 22 methods), GtmPlan (7238-8287, 13), Book, Media (describeImage:5850/describeVideo:5945/performDataAnalysis:6331) — ~5,000+ LOC verbatim relocation. Effort L.
- **getMockToolResult (973 LOC switch, agentModeService.ts:4648) is benchmark-only** (only benchmark.ts:351 sets mockMode:true). Move to a benchmark module. CAVEAT: prod-tree unit tests call it via `(svc as any).getMockToolResult` (mockResponses/searchKnowledgeBase/knowledgeBaseFiles tests) — move those too. Effort M.
- **Primitives.tsx (2,340 LOC dev gallery) is eager-imported into the prod customer bundle** (App.tsx:90 static import, route :197, no lazy/DEV guard; App.tsx has zero React.lazy). Fix: React.lazy + `import.meta.env.DEV` gate. Effort S — easy win.
- **13 copy-paste model-getter methods** (agentModeService.ts:999-1197) → one `resolveConfiguredModel(settingName, fallback)`. ~185 LOC. Effort S.
- **Agent-tool gateway policy runs observe-only on every call** (agentToolGatewayService.ts:289 `allowed = !enforce || ...`; AGENT_TOOL_GATEWAY_ENFORCE set NOWHERE in tree or origin/harsha/dev) → 726 LOC of per-call eval for zero enforcement. NOTE: the "double eval" is NOT redundant (first feeds arg-repair, second runs on repaired args — don't naively dedupe). Decide: enable enforcement or make it sampled/async.
- **CRM.tsx = 11,169 LOC / 183 useState single component.** Extract state islands into hooks/subcomponents (pattern exists: LeadDetailPanel, SequenceBuilder, ExternalCrmSyncDialog). Effort L.
- **crmEnrichment V1 (106KB) + V3 (51KB+65KB) co-live mid-migration** with dual waterfalls; old service has 13 prod importers and V3 imports a type from it → tracked cutover, not blind delete. ~130KB once done. Effort L.
- **loops framework 7,356 LOC, all 4 instances env-gated OFF; ai-eval-funnel (1,384 LOC) superseded by ai-readiness-funnel (501 LOC)** — delete ai-eval-funnel incl. server.ts:588-614 block + index.ts registration. Effort M.
- **Build lever: jest maxWorkers 2→4** (jest.config.js:8 + package.json:9,11; ts-jest preset, isolatedModules already on). Cost-negative (CI isn't the gate). Optional: @swc/jest transpile-only. Effort S.
- **~11,300 `any`/`as any` in backend/src** (agentModeService 818, crm.ts 234, db.ts 161) — root enabler of god-object growth. Type the 3 hottest boundaries (ToolArgs, DynamoRecord<T>, LLMToolResult) alongside the agentModeService split. Effort L, advisory.

### C. SOTA gaps — where we lag (the models themselves are current)

Good: model IDs are current (claude-opus-4-8, claude-sonnet-4-6, gpt-5.x, gemini-3.x); prompt caching IS wired (Bedrock cachePoint, agentModeService.ts:1544); native Bedrock toolConfig used.

- **HIGH — zero extended-thinking / effort on any Claude call.** grep for thinking/reasoningConfig/effort/budget_tokens returns no model-call hits; Converse sends only maxTokens (agentModeService.ts:1567-1576). Opus 4.8 / Sonnet 4.6 support adaptive thinking + effort — the single biggest quality lever, ~free given models are current. Pass `thinking:{type:'adaptive'}` + per-surface effort (high/xhigh agent loop & codingAgent, low/medium classify/score) via additionalModelRequestFields.
- **HIGH — tool failures handled by text-injected "do not retry" guidance + SILENT tool-list truncation.** ~141 emma tools vs a 128 Azure cap → tools dropped non-deterministically (agentModeService.ts:2070); args parsed with bare JSON.parse→{} (:1328,1777); no strict schemas / structured output / programmatic arg-repair. Upstream cause of the 27/55/41% tool failures. Fix: strict input schemas + validate-before-dispatch + one structured repair; tool-search instead of truncation.
- **HIGH — no eval harness / tracing.** No Okareo, no OTEL/Sentry/Langfuse; only shadow usage metering + an internal LLM-judge (sessionScoringService.ts). The repeated silent-telemetry-table failures (3 in 2 days) are the symptom. Stand up Okareo seeded from real sessions + per-turn trace ids.
- **MEDIUM — model selection not centralized.** agentModeService has its own Bedrock/Vertex/Azure/Gemini clients separate from the metered factory (llmClients.ts); inference-profile ARN map duplicated in 3 files (agentModeService.ts:1525, codingAgentService.ts:1375, llmService.ts:74) — a model swap touches 3-4 files. Route the agent loop through the factory + one shared ARN map.
- **MEDIUM — non-streaming agent loop** (ConverseCommand not Stream; maxTokens hardcoded 12384) → long Opus/Fable turns risk request-timeout truncation. Switch to ConverseStreamCommand (factory already meters streaming, llmClients.ts:280).

### D. Learning loop — ~30-40% closes, one instance only

Architecture (sensor→policy→tools→gate→learning, host-agnostic `core/`):
- **Sensor**: agent-mode runRecorder writes real tool telemetry → Dev-AW-LoopEvents (WORKING, gated by AGENT_RUNTIME_SPINE_ENABLED). Funnel sensors wired but starved (<10 captures/wk).
- **Policy**: agent-mode failure-clustering (DSL, no LLM) WORKS; the LLM-analyst policy used by ai-readiness + onboarding-V2 is INERT — the prod Bedrock adapter throws unconditionally (awsAdapters.ts:151-156), analyst swallows it → zero proposals from those two loops.
- **Gate**: CaptureGate.pollDecision() always returns 'pending' (captureGate.ts:30-34); no SlackReactionGate exists. Real approval is OUT-OF-BAND: digest DM → Harsha ✅ → routes/slack.ts:582 → recordLoopApproval. **CORRECTION to earlier notes (incl. the 2026-06-13 "wrote to a void" entry below): shippedAt IS now stamped** (approvalPersistence.ts:102-112) now that Dev-AW-LoopLearning exists.
- **THE structural break (highest-leverage, new): proposal-provenance bug.** orchestrator.ts:163-169 writes the pending record WITHOUT the `proposal` field; recordLoopApproval copies that undefined forward (approvalPersistence.ts:105-110); CooldownRuleSet.onCooldown (cooldownRuleSet.ts:61) and lastOutcomeForRule (dynamoLearningStore.ts:89) both key on `proposal.sourceRuleId` = undefined → the policy can NEVER read back its own outcomes. The loop records verdicts it structurally cannot consume. **Fix: carry `proposal` onto the pending record in orchestrator.ts:163-169 (~3 lines).** This is the one thing that makes everything else matter.
- Other gaps: analysis runs env-gated (likely OFF in prod) → attribution has nothing to grade; loop tables hardcoded to Dev- prefix (eventTableEventSource.ts:27, dynamoLearningStore.ts:27) even in prod.

**Verdict:** plumbing is genuinely impressive; ~30-40% closes for the agent-mode loop only (live sensor → DSL policy → fix-spec → ✅ → Notion+cloud-dev → shippedAt). It does NOT yet learn because (1) LLM-policy loops inert, (2) outcome read-back severed by the proposal bug, (3) gated on manual ✅ + likely-off flags. Fix order to actually close it: (1) proposal-provenance ~3-line fix; (2) implement awsBedrockAdapter.invoke against the existing Claude client; (3) confirm prod AGENT_RUNTIME_SPINE_ENABLED + AGENT_MODE_LOOP_ENABLED ON; (4) env-aware loop table names.

### Assumptions to validate
- **Stripe Scan blast radius:** check current `AW-Users` size + whether a `stripe_customer_id` GSI already exists in prod. If the table is already >1MB, billing events are ALREADY being dropped — look for webhooks that Stripe retried then gave up on. (Falsified if a GSI exists / table is small.)
- **"Settings.gmail crashes blocking Mega PR #600" is UNVERIFIED** (read-only audit) — the test has no skip markers and mocks cleanly, so a crash is likely environmental (jsdom/act), not a code defect.
- **Prod EB instance count (single vs multi)** sets the blast radius of the cron-lock + in-memory-breaker findings.
- **Which loop env flags are true in prod** (AGENT_RUNTIME_SPINE_ENABLED, AGENT_MODE_LOOP_ENABLED, AI_*_LOOP_ENABLED) — determines whether the learning loop runs at all.
- **Prod table prefix:** recorder/learning hardcode `Dev-AW-LoopEvents`/`Dev-AW-LoopLearning`; confirm prod isn't expecting unprefixed `AW-Loop*` (which would also be missing).

## report_product_issues was never on the EXTERNAL MCP surface — #1851 enriched the wrong registry (2026-06-13)

Reconnecting the claude.ai Emma connector surfaced that `report_product_issues` is not exposed to it at all. Root cause: AgentWeb has TWO tool registries — `emmaToolRegistry` (in-app Emma chatbot/agent mode, ~141 tools) and `mcpToolRegistry` (the EXTERNAL MCP server at api.agentweb.pro/mcp that claude.ai connectors talk to, ~72 tools from apiTools.ts). `report_product_issues` is registered only on `emmaToolRegistry`. PR #1851 enriched it there (attachment_urls, run_id, MCP-source tag) and its test asserted against `emmaToolRegistry` — so it went green while testing a surface the external connector never sees. Net: in-app Emma got the enrichment; Claude-Code-via-MCP bug reporting (the actual goal) was unreachable.

### Fix (this PR)
One-line bridge in emma/tools.ts after the registration block — `mcpToolRegistry.register(emmaToolRegistry.getTool('report_product_issues'))` — same pattern the codebase already uses for `visualContextTool` (tools.ts:5973). The handler reads `context.userId` (agentUserId for external clients) and `context.externalMcp` (true only on the external server, for the MCP Reported tag), so the same handler is correct on both surfaces.

### Lesson (process)
When a tool must be reachable from the external MCP connector, the test MUST assert against `mcpToolRegistry` (the external surface), not `emmaToolRegistry`. The new test `mcpReportProductIssuesExposure.test.ts` guards exactly this. Two registries existing is itself latent complexity — future consolidation candidate, but out of scope here.

### Assumptions to validate
- After deploy + connector refresh, `report_product_issues` appears in the claude.ai Emma tool list with attachment_urls + run_id. Falsified if the connector still doesn't show it — would mean the external server caches tool lists beyond a reconnect, or apiTools registration order drops the late bridge.

## Fix: self-healing telemetry-table provisioning — close the silent-missing-table class (2026-06-13)

Three missing-table incidents in two days (AW-OnboardingMetrics, Dev-AW-LoopLearning, and the loop tables) shared one root cause: tables are defined in create-tables.ts but the script is never run on deploy, and every writer swallows ResourceNotFound — so an absent table is invisible until someone reads the data weeks later. For the loop tables the entire gate→attribution→verdict chain ran as a no-op with zero signal.

### What shipped (this PR)
- `services/ensureCriticalTables.ts` — idempotent, non-fatal boot-time ensure for the three critical telemetry tables (LoopEvents, LoopLearning, OnboardingMetrics). Table-name constants imported from the modules that WRITE them, so the ensure can never drift from the writers. createTable swallows ResourceInUseException; any other failure logs loudly ("telemetry for this loop will be lost until fixed") but never blocks startup.
- Wired fire-and-forget into `server.ts` boot (after listen). On every deploy, missing telemetry tables self-create.
- Added the missing `createOnboardingMetricsTable()` to `scripts/create-tables.ts` (it was never in the script — the source-of-truth gap that caused the 2026-06-12 incident).

### Why self-heal instead of "run the script on deploy"
No ops dependency, no risk of a hard boot crash, and it fixes past + future instances in one place. Matches the silent→loud principle: the only way a missing telemetry table now persists is if createTable itself is denied, which logs an ERROR every boot.

### Assumptions to validate
- After deploy, prod logs show either "created missing table X" once or nothing (all present). A recurring "could NOT ensure" ERROR = IAM lacks CreateTable; fix the role.
- This does NOT cover non-telemetry tables (users, tasks, etc.) — those predate the issue and are assumed present. If a core table ever goes missing the symptom is louder (immediate 500s), not silent, so they are intentionally out of scope here.

## Dev-AW-LoopLearning table was missing — the entire gate→attribution→verdict chain wrote to a void (2026-06-13)

Checking for pending-approval proposals (now that gate persistence #1841 is live) surfaced that **`Dev-AW-LoopLearning` did not exist in this account.** `dynamoLearningStore.ts:27` hardcodes the table name; `scripts/create-tables.ts:2043` defines `createLoopLearningTable()` — but the script was never run against this account, so the table was absent. Every `learning.record()` (proposals, approvals, shippedAt, verdicts) hit ResourceNotFound and was swallowed best-effort.

Impact: the whole point of the "close Layer 4→5" sprint was inert. Even after #1841 wired Slack approvals to write shippedAt, the write went nowhere — so CooldownRuleSet read empty history, attribution had nothing to grade, and a ✅ on any loop proposal (e.g. the AI-readiness quiz-start-leak) would never reach a learned/regressed verdict.

**Fix applied 2026-06-13**: created `Dev-AW-LoopLearning` in us-west-2 (PK `loopId` HASH / `sortKey` RANGE, PAY_PER_REQUEST) mirroring the create-tables definition. The loop can now persist decisions.

### Systemic finding (third instance)
This is the THIRD table defined-in-code-but-never-created in this account: `AW-OnboardingMetrics` (2026-06-12), now `Dev-AW-LoopLearning`. Root cause: `create-tables.ts` is not run when new tables are added, and every writer is best-effort/swallowed so the absence is invisible until someone reads the data. **Follow-up: run `NODE_ENV=... create-tables.ts` against dev AND prod as part of deploy, or add a startup assertion that required tables exist (fail loud, not silent).**

### Assumptions to validate
- After this table exists, the next ✅ on a loop proposal should write a record with decision + shippedAt, visible via `GET /api/admin/loops/health` moving that loop to `in_flight`. Falsified if health still shows `empty`/`pending_approval` after an approval — would mean the prod backend uses an unprefixed `AW-LoopLearning` that ALSO doesn't exist (check prod table list).
- Prod (NODE_ENV=production) may resolve a different table name than dev. The recorder hardcodes `Dev-AW-LoopEvents` (env-agnostic); confirm the learning store does the same vs. honoring a prefix — if prod expects unprefixed `AW-LoopLearning`, that table needs creating too.

## Landing-Page Generation Failures — Empathia Incident Root-Cause + Durable-Execution/Multi-Site Fix (2026-06-12)

Triggered by Angela (Empathia, `demo@empathiaai.com`, userId `a643f408-4ddf-4790-a9ae-4aa7f99de87a`) reporting landing-page "bugs, it's matching things" during an active evaluation (decision ~Jun 17–18; campaign sends Jun 15). Reconstructed prod session `332dafe1-ec34-44c5-a55a-40ae4131a43a` (Jun 8, 14:03–14:55 UTC) from `AW-ChatMessages`. Five failures in one 52-minute session; they collapse into **two root causes**, both the same shape: **identity is implicit and reconstructed by runtime heuristics.**

### What failed (timeline)
1. **14:03 — attachment never read.** `read_knowledge_base_files` → "Knowledge base not found"; fallback file read threw `Cannot read properties of undefined (reading 'startsWith')`. Page built WITHOUT the product doc. Separate bug.
2. **14:13 — timeout lie #1.** Run hit `GENERATION_TIMEOUT_MS` (600s, `agentModeController.ts:55`) while `generate_landing_page` was still running (its MCP timeout is 25min, `apiTools.ts:1301`). The run lost a `Promise.race`, released the session lock, and showed "took longer than expected" — but the generation was **not aborted; it kept running detached and updated `AW-LandingPages` to `deployed`** (`agentModeController.ts:50-53`). Nobody reconnected to it.
3. **14:15 — prompt-as-name → poisoned repo.** Page `name` was the full multi-line prompt → broke the Next.js build and blocked all later builds; `deploy_landing_page` 404'd. (Prompt-as-name now capped/slugified at `landingPageGeneration.ts:335` / `v0Service.ts:104`.)
4. **14:42 / 14:54 — timeout lie #2**, two manual retries before it went live. Each retry started a *new* build racing the first (lock already released) — the source of the poisoned repo.
5. **Wrong project/subdomain.** Final URL `empathia-ai-cardiology-demo.agentwebforms.com/front-desk-emma-empathia-ai` — physician campaign on a subdomain named after a Jun 1 throwaway demo.

### RC1 — no durable job identity (telemetry ≠ durability)
The spine in flight (Agent Run/Event/Tool Gateway) is *telemetry* — makes failures visible, orthogonal, does NOT fix this. The failure is *durable execution*: the long tool runs inside the HTTP request; on run-timeout the work detaches and finishes but nothing reconnects → the timeout lie + the retry race. Rui's Jun 9 point (a redeploy on a long backend task "causes problems… also for other users") is the same class and correct. Fix: a tracked job (`originatingSessionId` + atomic `claimedCompletionAt`) — on late completion, post back into the session (`io.to('user:'+userId)`, primitive exists `gtmPlan.ts:1499`; `addMessagesToSession` already persists). A retry **reconnects** to the in-flight job instead of starting a second build. **Honest limit:** in-process detachment survives a run-timeout but not a backend redeploy — a `dripSequenceWorker`-style poller is the redeploy backstop; full mid-build survival is the eventual separate-engine's job.

### RC2 — no site identity
`findUserSiteRecord` (`v0Service.ts:2482`) returns the oldest repo forever (+ a read-time `isRootPage` mutation inside a `find`), so every page is a route in page #1's project and the subdomain is frozen to page #1's name. Fix: explicit `siteId` on each page; the tool gains `site_id` (omit → new site with its own domain; pass → add to existing). Opt-in, existing single-site users backfilled to their root id (byte-identical).

### Why the fix REDUCES complexity (the point)
Both bugs are heuristics compensating for missing explicit identity. Adding `siteId` + the job marker lets us DELETE: `findUserSiteRecord`'s 3-way guess + its read-time mutation; `isOrphanedFailedPage` + `cleanupOrphanedFailedPages` + the reusable/recyclable orphan-scavenging scan in `generateLandingPage` (these exist only to scavenge orphans the missing lifecycle creates); and the landing-page false-failure diagnostic branch. One explicit job+site identity model replaces four scattered heuristics, a side-effecting finder, and a lie. Flag-gated `DURABLE_LANDING_GENERATION`, fail-open, scoped to landing-page generation. Full spec: `docs/durable-execution-rc1-spec.md`. Plan: `~/.claude/plans/swift-humming-meadow.md`.

### Assumptions to validate
- The `startsWith` crash (#1) reproduces independently — needs its own repro/ticket.
- Late completion's `responseMessages` may be persisted before OR after the timeout race; the hook must handle both orderings (suppress the false-failure message, never double-append).
- Re-pointing Empathia's *current* live page is operational (custom-domain tooling); the multi-site change only prevents the *next* page from repeating it.

## Lander funnel was unmeasurable from agent-tool telemetry — service/route-layer lifecycle sensor added (2026-06-12)

Attempting to answer "why do 32 landing-page sessions produce only 3 publishes" exposed two instrumentation holes that made the funnel analysis come back blind (24 "created" sessions, 0 visible previews/publishes/errors — obviously wrong):

1. **The runtime spine only sees agent tool calls.** The lander lifecycle spans two channels — Emma tools AND portal UI buttons — and UI actions never touched the spine. The agent tools call the same `/api/landing-pages/v0/*` routes via `mcpFetch` that the UI calls directly, so the routes are the single chokepoint both channels share.
2. **`create_html_file` is generic** (email templates, analysis outputs), so tool-name-based session classification over-counts "landing-page sessions."

### What shipped (this PR)

- `services/landerLifecycleEvents.ts` — best-effort emitter (same swallow-errors contract as AgentRunRecorder) writing `lander_created / deploy_retried / iterated / edited / published / publish_reverted` events into the shared `Dev-AW-LoopEvents` table under loopId `lander-lifecycle`, keyed by pageId, with dimensions: channel (`agent`/`ui`), mode (`cold_start`/`incremental`), outcome, userId, sessionId.
- Hooks in all six mutation routes in `routes/landingPageGeneration.ts` (generate incl. failure path, deploy, iterate, github-edit, publish, revert-publish).
- `mcpFetch` now sends `X-AgentWeb-Channel: agent` so routes can attribute agent-channel requests; absence of the header = UI.

Complexity note: net simplification — a few emit lines replace an entire class of inference (guessing artifact lifecycle from ambiguous tool names across channels). No new tables, no new loop registration (sensor-only v1; events are queryable but the loop has no policy/manifest yet — deliberately, until the funnel data says what the policy should be).

### Assumptions to validate (next 1–2 weeks)

- **The routes are the complete chokepoint.** Falsified if landers get created/published through any path that bypasses these six routes (e.g. a batch job or admin script) — check for pageIds in the landing-pages store with no `lander_created` event.
- **Real funnel numbers within ~1 week of deploy**: cold-start publish rate, where sessions die (created→never-touched-again vs iterated→abandoned vs published). The June 12 estimate (9% publish rate) is unverified until this data exists.
- **Channel split matters**: expectation is agent-channel creations dominate, UI-channel publishes dominate. If everything is one channel, the header plumbing was unnecessary (cheap, but note it).
- **Junk-lander rate**: count of `created` events with no subsequent lifecycle event after 48h — the candidate definition of "junk." If that definition misfires (users legitimately park drafts for weeks), redefine before building any cleanup.

### Follow-up (deliberately NOT in this PR)
- Eval-loop wiring: commit-point (`lander_published`) → Slack tag to Matt with the Emma session link; enrichment execute → Fangfang (~5/wk and ~7/wk projected). Blocked on this sensor accumulating ~1 week of data first.

## Prod AW-OnboardingMetrics table was missing — heartbeat blind since launch (2026-06-12)

The onboarding heartbeat's recurring "No step timing data found yet; verify AW-OnboardingMetrics writes" warning had a trivial root cause: **the prod table `AW-OnboardingMetrics` never existed**. `Dev-AW-OnboardingMetrics` exists (100 items — dev writes work), but there is no entry for it in `scripts/create-tables.ts`, so the dev table was created ad-hoc and prod never got one. Every prod write hit ResourceNotFound and was swallowed by `logStepMetric()`'s fire-and-forget catch; the heartbeat's read hit the same missing table and degraded to empty.

**Fix applied 2026-06-12**: created `AW-OnboardingMetrics` in prod (us-west-2) via aws cli, mirroring the dev schema — PK `metricId` (S), GSI `StepStartedAtIndex` (`step` HASH / `startedAt` RANGE, ALL projection), PAY_PER_REQUEST.

### Assumptions to validate
- Step metrics should start appearing in tomorrow's heartbeat ("Step timings" section non-empty) as users complete brand/ICP/ad steps. If still empty after 48h with real onboarding activity, the writer has a second issue (IAM PutItem permission is next suspect).
- The 86% "(unset)" funnel state is a SEPARATE, expected artifact — legacy users predate `onboardingStage`; only users emitting onboarding events get a stage. No fix needed unless we want a backfill migration.

### Follow-up
- Add `AW-OnboardingMetrics` to `scripts/create-tables.ts` so environments stop diverging ad-hoc (small PR).

## Replay-eval groundwork — failed runs become eval cases (2026-06-12)

Frontier-agent robustness pattern: failed trajectories become regression tests. The spine records every run; nothing turned the failed/degraded ones into reusable eval material. This is the Phase-4 seed (white-box beats Okareo — we own the trace).

### What shipped (this PR)

1. **`loops/scripts/exportEvalCases.ts`** — CLI: queries agent-mode spine events (default 7d), exports each failed/degraded run as a JSON eval case (verdict + reasons, per-failure toolName/errorClass/errorMessage, decision context with upstream-redacted arg previews) plus a worst-first `toolName × errorClass` cluster summary. Output to `backend/eval-cases/` — gitignored, fixtures never committed.
2. **Pure core** (`buildEvalCases` / `summarizeEvalCases`) exported for tests + future runners. Pre-verdict-era runs are judged by `computeRunVerdict` over their counts so history exports too.

### How this becomes the eval harness

1. Run the export → `_summary.json` names the worst clusters (June data: linkedin_outreach × invalid_args, run_local_agent_task, legacy search × rate_limit).
2. Harsha + Fangfang curate: pick top clusters, write HUMAN expected-behavior assertions per cluster (per loop-acceptance-tests discipline).
3. v2 runner replays curated cases against the current contract layer / tool schemas on change — regression suite from production failures.

### Assumptions to validate

- Run the export once against real data: `cd backend && npx ts-node src/loops/scripts/exportEvalCases.ts --days 7` — expect ~35 cases. If far fewer, the grouping window or the tsSession key-condition prefix logic needs a look.
- Arg previews are sufficiently redacted for fixture storage (they go through AGENT_RUNTIME_REDACTED_ARG_KEYS upstream); spot-check one case file before sharing any externally.

## Post-run outcome verdicts — degraded-run detection (2026-06-12)

Telemetry blind spot: 165 runs in the June window, ZERO hard failures, 60+ tool failures silently absorbed. "Completed" ≠ "succeeded" — the user feels the degradation but nothing durable records it, so the agent-mode loop (whose sensor reads spine events) could never learn from degraded runs. The inspector's read-time flags don't help the policy: they exist only in the projection.

### What shipped (this PR)

1. **`agent_run_verdict` spine event** emitted alongside every terminal run event. Dims: `verdict: ok|degraded|failed`, machine-readable `reasons`, counts.
2. **`computeRunVerdict()`** (pure, exported): failed terminal → failed; ≥3 failed tool calls OR ≥1/3 failure ratio OR same tool failing ≥3× (the linkedin_outreach retry-spiral shape) → degraded; else ok. Thresholds tuned so the typical healthy-but-imperfect run (28 calls, 1-2 failures) does NOT flag.
3. **`maxSameToolFailures`** computed at both run-completion call sites from the toolCalls array — catches retry spirals a low overall ratio hides.
4. **Inspector surfacing**: `outcomeVerdict`/`outcomeReasons` on run summaries + a `degraded_run` warning flag.

### Assumptions to validate

- Degraded-rate baseline: expect ~20% of runs degraded based on June data (35/165 runs had ≥1 failure; threshold ≥3 cuts that down). If >40% flag degraded, thresholds are too tight to be actionable.
- The agent-mode loop's failureRuleSet does NOT yet consume verdict events — next step is a policy rule that clusters degraded runs by reasons + dominant errorClass. Verdicts accumulate from deploy time so that rule will have data when written.
- One extra event per run (~165/day) is negligible Dynamo volume.

## Semantic tool-error taxonomy + contract-layer counters (2026-06-12)

Telemetry finding from the June 9-12 window: every recorded tool failure had errorClass "Error" — tools throw plain `new Error(message)`, so the constructor-name fallback carried zero signal. The failure policy could only cluster by toolName; the model (and the breaker) could not distinguish retryable timeouts from terminal auth failures.

### What shipped (this PR)

1. **`utils/toolErrorClassifier.ts`** — `classifyToolErrorClass()`: stable semantic classes `timeout | auth | rate_limit | invalid_args | not_found | network | upstream_5xx | policy_blocked | repeated_failure`, derived from gateway error names, numeric status props, and message heuristics. Unrecognized errors keep the legacy name-based class (named custom errors lose nothing).
2. **Run recorder** uses it for `errorClass` on `agent_tool_failed` / `agent_run_failed` events.
3. **Decision telemetry counters** (#1818 follow-up): `argsRepairedCount` (contract layer repaired args pre-execution) and `schemaErrorCount` (failures classified invalid_args) per decision event — the data needed for the AGENT_TOOL_GATEWAY_ENFORCE go/no-go.

### Assumptions to validate

- The taxonomy covers the real distribution: after a few days, `SELECT errorClass COUNT` on new agent_tool_failed events should show <20% falling back to legacy names. If higher, extend classFromMessage patterns from actual messages.
- Provider 429s → rate_limit and Meta 5xx → upstream_5xx in prod (heuristics verified against June messages, not live traffic).
- errorClass consumers (failureRuleSet clustering, inspector) benefit rather than break from the rename — historical events keep old classes, so mixed-class clusters during transition are expected for ~7 days.

## Approval persistence closes the learning loop (Layer 4→5) (2026-06-12)

The June 8 audit's last open item: Slack ✅ approvals dispatched cloud-dev fixes but never wrote `decision`/`shippedAt`/`verdict` back to `Dev-AW-LoopLearning`. Net effect measured this week: CooldownRuleSet was wired but inert (reads `shippedAt`, always null) and the 18:00 UTC attribution cron had zero gradable records. The system sensed and proposed but could not learn.

### What shipped (this PR)

1. **`loops/core/learning/approvalPersistence.ts` — `recordLoopApproval()`**: finds the run's `decision:'pending'` records by the digest's Run ID, appends one `decision:'approved'` record per proposal with `shippedAt` set when its dispatch succeeded. Dispatch failures are recorded approved-but-not-shipped with `mutation.error` — auditable, still re-proposable.
2. **Dispatcher wiring** (`loopSlackApprovalDispatcher.ts`): both dispatch branches persist after launching, post a `📒 Learning store: N approved, M shipped` thread line, and loudly warn when no pending records match (legacy digests).
3. **Test-double parity fix**: `InMemoryLearningStore` status/ruleIds filters passed records with no decision/proposal; `DynamoLearningStore` excludes them. Aligned in-memory to Dynamo semantics — test doubles must match prod behavior or tests lock in bugs.

### Matching semantics (deliberate)

Digest item ↔ proposal matching: exact `sourceRuleId`, `:slug` suffix (AI Readiness analyst ids), `proposalId`, or `mutationId`. Unmatched proposals (generic digests use synthetic ids) are marked shipped only when EVERY dispatch succeeded. Bias: when uncertain, leave a rule re-proposable rather than wrongly suppress it for the 14-day cooldown.

### Assumptions to validate

- Digest Run IDs uniquely identify one loop's run (sort-key collision across loops would mis-attribute approvals).
- The first ✅ on a digest covers all its items — partial approval (✅ some items only) is not modeled; v2 could parse per-item reactions.
- Attribution at 18:00 UTC will now grade these records once the settle window elapses — verify the first `improved/regressed/no_change` verdict appears in `/api/admin/loops/health` within ~windowDays of the first persisted ship.
- The `📒 Learning store` thread line appears on the next real ✅ (first live validation of the whole write path).

## AgentRun Telemetry Failure Analysis → Gateway Circuit Breaker + Tool Guidance Fixes (2026-06-11)

First product decision driven by the runtime-spine telemetry. Analyzed all 3,172 agent-mode events in `Dev-AW-LoopEvents` (June 9–12: 223 runs, 1,016 tool calls, 78 failures = 7.7% tool failure rate; 35 runs had ≥1 failure; zero hard run failures — failures are absorbed and runs "complete" degraded).

### Top failure clusters found

- `linkedin_outreach` 16/59 (27%) — the single worst run retried it **15 times in 16 seconds**: 7× "Invitation message is too long (201–231 chars)" then 6× blind "Invalid parameters" retries in the same second.
- `run_local_agent_task` 11/20 (55%) — model keeps sending out-of-scope tasks; rejection message only echoed the forbidden regex.
- Legacy search tools ~41% (429 rate limits), `call_meta_ads_insights_api` 41% (sync wait on slow async job) — NOT fixed here; belong to search consolidation / background-job pattern respectively.

### Root cause of the LinkedIn cluster — misleading schema text

The tool schema said "message must be 300 characters or fewer". The real limit is **per-account: 200 free / 300 Premium** (`linkedInOutreachService.ts` `INVITE_MESSAGE_MAX_CHARS_FREE`). Every too-long failure was 201–231 chars — the model was *obeying the documented 300* and failing on a free account. Lesson: when telemetry shows the model consistently landing in a narrow wrong band, suspect the tool description before the model.

### What shipped (this PR)

1. **Per-run repeated-failure circuit breaker** in `agentToolGatewayService.ts`: same tool + same error head (80 chars) failing ≥3× in one run → subsequent calls return `AgentToolRepeatedFailureError` with model-visible "do not retry / change approach" guidance, without executing. A success for the tool clears its counts (mixed batches not punished). Keyed by `runId` (threaded from `agentRuntimeRunId` at both gateway call sites); no runId = no breaker, so non-AgentMode callers are untouched. State is in-memory, capped at 500 runs (oldest evicted) — acceptable because a runaway retry loop is intra-run by nature.
2. **Schema descriptions** for `linkedin_outreach` now teach 200-free/300-premium + "don't invite FIRST_DEGREE connections, use send-message" (the already-connected failure, independently the same branch Fangfang is adding to the event-lead skill).
3. **`run_local_agent_task` rejections** now state the read-only browsing scope and name the right alternative tools (`coding_agent`, `perform_data_analysis`, `search_web`).

### Assumptions to validate against next week's telemetry

- **Breaker threshold 3 / error-head 80 chars is right.** Watch for `AgentToolRepeatedFailureError` in `Dev-AW-LoopEvents` (it flows through the normal toolFailed path, so it's queryable via `/api/agent-runs`). If legit retry patterns trip it (e.g. polling tools that fail transiently), raise threshold or exempt tool classes.
- **The schema text alone fixes the too-long cluster.** If 201–231-char invite failures persist after deploy, the model isn't reading the description and the fix moves to a gateway pre-flight that knows `is_premium` from config.
- **Enforcement stays narrow.** This breaker is deliberately the ONLY enforcing gateway rule; `AGENT_TOOL_GATEWAY_ENFORCE` (policy flags) stays off pending trace review per PR #1808.
- **In-memory breaker state is fine on EB single-instance.** If prod backend scales to multiple instances, breaker counts fragment per instance — degrades gracefully (each instance still breaks at 3), but note it.

### Not fixed, filed for owners

- Legacy search-provider 429s (consolidate on `search_web` at 1% failure) — Rui/backend.
- Meta Insights timeout → background-job + poll pattern (same shape as CRM push #1791) — Rui.
- `coding_agent` landing-page auth — already fixed by Rui's open #1835.

## Resend Sender Domain DKIM Verification Failure — mail.incentivpay.com (2026-06-11)

Reported by user `info@pmps.ai` (userId `1359ace4-0565-4018-9926-f51efdcf4c47`): the email sender domain `mail.incentivpay.com` shows DKIM **failed** in Resend even though the user says they added the DKIM record in GoDaddy. Investigation only — no code changed.

### What the live data shows

The DB side is **correct** — no app/wiring bug. User `info@pmps.ai` is properly linked: `emailDomain = mail.incentivpay.com`, `resendDomainId = 7d133b9e-663d-4faf-8a89-ec88d60c49e7` (matches the Resend domain). (Lookup was a one-off scan of the prod `AW-Users` table by email/emailDomain/resendDomainId.)

Resend domain state (prod account, id `7d133b9e-663d-4faf-8a89-ec88d60c49e7`, US East, created 2026-06-02), pulled live from `GET https://api.resend.com/domains/{id}`:

| Record | Host (relative) | Type | Resend status |
|--------|-----------------|------|---------------|
| SPF (MX) | `send.mail` | MX | ✅ verified |
| SPF (TXT) | `send.mail` | TXT | ✅ verified |
| **DKIM** | `resend._domainkey.mail` | **TXT** | ❌ **failed** |

DKIM value Resend expects (TXT): `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCZNDIpPbcMn89NOxV5JtOfgx28SS2dDrRWMB6i4eBE2QySQ7HeiHObv1eQ1rwbqeEY+v9gbA7x6r3EAa4UvTPnigYOJti70VPMbdviX+nt2lTAFtFqqWaUGLBs96lpuSSK9tRMi80Mr7OwqViESrRArLrcrmoFN+x0wnywYD2YNwIDAQAB`

The overall domain badge reads "failed" **only** because of the single DKIM row; both SPF rows already passed.

### Root cause: the DKIM TXT record is NOT actually published in DNS

Live DNS-over-HTTPS lookups (Google DoH) confirm the DKIM TXT record returns **NXDOMAIN** at the correct host and at every common GoDaddy-mistake variant, while the SPF host resolves fine:

- `resend._domainkey.mail.incentivpay.com` (TXT, correct host) → **NXDOMAIN**
- `resend._domainkey.incentivpay.com` (TXT, "forgot the .mail") → NXDOMAIN
- `resend._domainkey.mail.incentivpay.com.incentivpay.com` (TXT, GoDaddy double-append) → NXDOMAIN
- `resend._domainkey.mail.incentivpay.com` as CNAME → NXDOMAIN
- `send.mail.incentivpay.com` (SPF TXT + MX) → **resolves** ✅ (this is why SPF verified)

So the user successfully added the two SPF entries but the DKIM TXT entry is absent from the zone — never saved, saved at the wrong host, or saved as the wrong type. Domain was created 2026-06-02, so 48h propagation is long past; this is a data-entry problem, not propagation.

### Likely GoDaddy entry mistakes (in order of likelihood)

1. **Host entered as FQDN.** Resend shows the host relative (`resend._domainkey.mail`). GoDaddy auto-appends the zone, so the user must enter `resend._domainkey.mail` (NOT `resend._domainkey.mail.incentivpay.com`, which GoDaddy stores doubled).
2. **Wrong record type.** This domain's DKIM is a **TXT** record (some Resend setups use CNAME). If added as CNAME it won't match.
3. **Value truncation.** GoDaddy can split/truncate the long `p=…` TXT value.
4. **Record silently not persisted** by GoDaddy.

### Exact record the user must add in GoDaddy

- **Type:** `TXT`
- **Name/Host:** `resend._domainkey.mail`  (relative — do NOT append `.incentivpay.com`)
- **Value:** the `p=MIGf…IDAQAB` key above
- **TTL:** default / 1 hour

Then click **Verify Domain** in the portal (no Resend dashboard needed — see below).

### Verify path in our UI

There IS a "Verify Domain" button in the customer portal: CRM page → Email Sender Domain section, shown whenever the domain is registered-but-unverified, directly under the DNS records table.
- `customer-portal/src/pages/CRM.tsx:10690` — the button → `handleVerifyDomain` (`CRM.tsx:1009`) → `POST /api/crm/email-domain/verify` → `resendService.verifyDomain(resendDomainId)`, which re-queries DNS and re-renders per-record status. "Change Domain" (`handleChangeDomain`) resets the config.
- Caveat: the button only **re-checks**; it has no effect until the record actually exists in DNS. Clicking it now will keep returning "failed."

### Note: same issue on mail.pmps.ai

`mail.pmps.ai` (resendDomainId `2b581c4e-3849-49da-b70b-6fdc3ae09bfa`) is also in `failed` state in the same Resend account — likely the same DKIM gap if the user intends to use it.

### Possible product improvement (not implemented)

The DNS records table (`customer-portal/src/pages/CRM.tsx:10625-10714`) renders `rec.name` raw from the Resend API (e.g. `resend._domainkey.mail`) with only generic "add at your registrar" helper text — no note that GoDaddy/Namecheap hosts are **relative** and the root domain must not be appended. That's exactly the trap that produced this failure. A short per-provider hint ("enter the host *without* your domain") would prevent repeat cases.

## Self-Learning Loop Adoption — Health Endpoint + AgentMode as a Loop (2026-06-09)

Follow-up to the YC-style learning-loop audit + retro. PR #1799 (branch `rui/self-learning-loop-adoption`). The retro's framing: a *bug-feedback* loop (user/Emma notices → Slack/Notion → eng fixes → next bug) is useful but is **not self-learning**. A *self-learning* loop must **store the decision, ship or reject the change, measure the outcome, and feed that result back into future policy** — the five layers Sensor → Policy → Tools → Quality gate → Learning, with Layer 5 writing back into Layer 2.

### Key finding: the audit predates Harsha's hardening commit

The audit was written **before** `6665655f feat(loops): harden product learning loop` (already on `main`). That commit closed most of the *product-loop* gaps, so they did **not** need redoing:
- Prod loops (`ai-eval-funnel`, `ai-readiness-funnel`, `onboarding` v2) switched `InMemoryLearningStore` → `DynamoLearningStore` (`Dev-AW-LoopLearning`). Without durable storage the loop forgot every proposal/outcome on redeploy and could never read its own history back.
- `loops/cron/loopAttributionCron.ts` → `runLoopAttributionOnce()` wired into `server.ts` at 18:00 UTC (gated `LOOP_ATTRIBUTION_ENABLED`). For each shipped mutation whose settle window elapsed, it computes the target metric before-vs-after and writes a verdict (`improved / no_change / regressed / inconclusive`) back to the store.
- `CooldownRuleSet` wraps every live policy — reads the learning store and suppresses re-proposing a fix that is still in flight or recently regressed/did-nothing (`improved` is not suppressed).
- Registry boot-order fragility removed via idempotent `registerOrReplace*` + `getRegisteredLoopManifests()` + dedup guards in each instance; `app.ts` registration wrapped in try/catch so one failing loop can't take down the rest.

So only audit items **#6 (loop health endpoints)** and **#7 (AgentMode wired into the apparatus)** were genuinely open. PR #1799 builds exactly those.

### What was built (#6 — operator visibility)

`GET /api/admin/loops/health` (admin-only). Per registered loop it reports one of **empty / blocked / pending_approval / in_flight / learned / regressed / idle**, plus counts and the last graded outcome.
- `loops/core/health.ts` — pure `computeLoopHealth` (no I/O, exhaustively unit-tested, most-urgent-state-wins precedence).
- `loops/health/loopHealthService.ts` — reads each loop's **own** learning store; a single failing loop degrades to an `error` entry instead of failing the whole report.
- `routes/loopHealth.ts` — mounted admin-only.

### What was built (#7 — AgentMode as a first-class loop, not a parallel system)

AgentMode reuses the **same** registry, `DynamoLearningStore`, attribution cron, and health endpoint as the funnel loops. In `loops/instances/agent-mode/`:
- `eventTypes.ts` — run/decision/tool/outcome vocabulary (`agent_run_started`, `agent_decision`, `agent_tool_invoked`/`_succeeded`/`_failed`, `agent_run_completed`/`_failed`).
- Hot-path hook in `agentModeService.ts` fires these into the shared `Dev-AW-LoopEvents` table keyed by `sessionId` (the debugging timeline). Best-effort + gated, so it never slows a live chat.
- Policy `AgentFailureRuleSet` clusters failures **per tool** over a 7d window; a tool past the count+rate threshold yields a cloud-dev fix-spec proposal (wrapped in `CooldownRuleSet`).
- Target metric `tool_success_rate = agent_tool_succeeded / agent_tool_invoked`. Risky changes (code, prompts) never auto-ship.
- Daily analysis cron at 17:30 UTC.

### Known remaining gap — why no loop reaches a verdict yet

The production `ApprovalGate` is still `CaptureGate`, whose `pollDecision()` always returns `pending` — so **`shippedAt` is never stamped by a gate**, and attribution only grades mutations that have `shippedAt`. Net effect: every loop runs Sensor → Policy → Tools → Gate (DM sent) then **stalls at `pending_approval`**; it never reaches `learned`/`regressed`. The new health endpoint makes that stall visible per loop. Building a real Slack-reaction gate that sets `shippedAt` + approval status is the single remaining piece that turns the apparatus from "wired" to "actually closing the loop" — the next highest-leverage work.

### Watch plan (next ~1–2 weeks)

Letting the loops run and observing before building the gate. What to watch:
- `GET /api/admin/loops/health` — confirm `agent-mode` + the funnel loops show up and accumulate events (state should move `empty` → `pending_approval` as proposals fire). If everything stays `empty`, telemetry/ingestion isn't landing.
- Whether the AgentMode policy surfaces *real* repeatedly-failing tools (signal) vs. noise — tune the count/rate thresholds in `AgentFailureRuleSet` from what we see.
- The 17:30 UTC Slack digest: are the proposed fix-specs actionable as-is?
- Once enough loops are stuck at `pending_approval`, that's the cue to prioritize the real approval gate.
## Judge Scoring False-Negative on Brand/Topic Mismatch (2026-06-05)

Systemic pattern across 3 sessions (satisfaction score 2): when a requested content topic (email, LinkedIn post, ad, analysis) does **not** match the stored brand guidelines, the agent correctly flags the mismatch and either asks a clarifying question or proceeds with placeholders (`[Brand Name]`, `[URL]`). This is the **desired** behavior — but the satisfaction judge was scoring these sessions low (`goalCompletion` 1–2), treating the flag/clarification as a failure. The fix is to the **judge**, not the agent.

Affected sessions: `4e39ce3e-...` (Webinar follow-up email), `9456689d-...` (Sustainable Packaging LinkedIn post), `fd071af6-...` (Budgeting App ad analysis).

### Key finding: the live scoring prompt is stored in DynamoDB, not code

`DEFAULT_SCORING_SYSTEM_PROMPT` in `backend/src/services/sessionScoringService.ts` is only a **fallback**. The active judge prompts are stored in the `AW-Settings` table (prefix `Dev-` in dev, none in prod):
- key `default-scoring-prompt` — overrides the default judge prompt
- key `scoring-judges` — JSON array of custom judges, each `{id, name, systemPrompt, ...}`. **Prod** has `Fangfang Judge` (the one that produced the score-2 evals) and `Matt Judge`; **dev** has `fangfang judge`.

The stored prod prompts are richer than the code constant (extra "Expected outcomes" / "Tool Execution after Nudges" clauses), confirming the DB is the source of truth. Any scoring-behavior change must update **both** the code constant (fallback + tests) **and** the DB rows (default + every custom judge, in dev and prod).

### The clause added

Inserted immediately before the "In addition to the overall score, rate three specific dimensions" section of each prompt:

```
IMPORTANT: Brand / topic mismatch:
- If the user requests content (an email, LinkedIn post, ad, analysis, etc.) on a topic that does NOT match the stored brand guidelines (e.g. brand guidelines describe an AI marketing company but the user asks for a budgeting-app post), it is CORRECT and desirable for the assistant to briefly flag the mismatch before proceeding
- Do NOT penalize the assistant for surfacing a brand/topic mismatch, asking a clarifying question about it, or proceeding with placeholders (e.g. [Brand Name], [URL]) — this is the expected, helpful behavior, not a failure
- Only lower the score for a mismatch if the assistant repeatedly refuses to produce ANY usable output after the user has clearly pushed back and asked it to proceed anyway. Flagging once (or flagging and then delivering a best-effort draft) should score as satisfied (score ≥ 4)
- A brief flag followed by a usable deliverable is ideal; a flag with a clarifying question is acceptable and should not be treated as the user "having to repeat themselves"
```

### Where applied

- **Code (PR #1774):** clause added to `DEFAULT_SCORING_SYSTEM_PROMPT` + 4 assertions in `sessionScoring.bugReported.test.ts`.
- **Dev DB:** applied directly via an idempotent script to `Dev-AW-Settings` (`default-scoring-prompt` + `fangfang judge`).
- **Prod DB:** the user applied the clause manually via the admin Scoring settings UI (default prompt + `Fangfang Judge` + `Matt Judge`). Direct prod DynamoDB writes are intentionally blocked from the test-env EC2 role (`AccessDeniedException` on `dynamodb:UpdateItem`), and the `test@example.com` account is deactivated in prod — so prod must be edited through the admin API/UI.

## LinkedIn Invite to Gundars Katlaps — "Sent Without Approval" Investigation (2026-06-03)

Reported by user `yuan@carley.ai` (userId `5fed2022-2e0f-4534-b09f-86ae95afc035`): angry that a LinkedIn connection invite was sent to lead **Gundars Katlaps** (Chief of Thoracic & Cardiovascular Surgery, Tampa General Hospital) without his approval. Investigation only — no code changed.

### What the production data shows

Lead `AW-Leads` (listId `list_1779111185801_aop37bg0b`, leadId `lead_1780320898801_ow2ank8ty`, LinkedIn `gundars-katlaps-ba684211`) has **`linkedInInviteSentAt = 2026-06-01T16:22:11.730Z`** — the invite.

Two separate events on 2026-06-01, often conflated but NOT the same:
1. **13:34–13:35 — scheduled session** "Daily ICP Lead Finder — docuCODER" (sessionId `d68dab40-e09f-4811-a434-ad98f8843c4b`, `sessionType=scheduled`). Its 26 messages (pulled from `AW-ChatMessages`, since the inline `messages` array on `AW-ChatSessions` is empty) show `linkedin_outreach` called 4× — **all `search-people` (read-only)** — plus one `add_leads_to_list`. This is only how Katlaps got *added to the CRM list*. **No `send-invite` occurred here.**
2. **16:22 — the invite itself**, stamped ~2.5h later, with **no chat/agent session at that timestamp**.

### Root cause: manual one-click send with no confirmation gate (NOT automation)

`linkedInInviteSentAt` is written in **exactly one place** in the codebase: the user-facing CRM route `backend/src/routes/crm.ts:4396` (`POST /lists/:listId/leads/:leadId/send-linkedin-invite`). The agent-mode `linkedin_outreach` `send-invite` handler (`agentModeService.ts:22200`) does **not** stamp it. So the invite went through the **CRM UI endpoint** — a logged-in click — not the scheduled agent and not any automation. Confirmed there is **no bulk-invite / auto-connect / drip / scheduled invite path**: the drip worker sends messages only, the sync cron is read-only, and this user has zero active schedules and zero drip/sequence enrollments.

Why it *felt* unapproved — the manual flow's UX (`customer-portal/src/components/crm/LeadDetailPanel.tsx`):
- Opening a lead's **LinkedIn tab** auto-drafts an invite note via Gemini and pre-fills the textarea (`useEffect` ~line 570, draft ~583).
- The **"Send LinkedIn Invite" button** (~line 902) → `handleSendLinkedInInvite` → `CRM.tsx handlePanelSendLinkedInInvite` (~1137) **POSTs immediately. There is no confirmation dialog.**

A single click on a pre-populated panel fires a real connection request instantly — easy to trigger thinking you're drafting/saving, especially since the note was auto-generated by an earlier scheduled lead-finder run that silently added the lead the same day.

### Recommendation (not implemented)

Add a confirmation step before the invite POST (e.g. a "Send connection request to {name}?" modal in `LeadDetailPanel.handleSendLinkedInInvite` / `CRM.handlePanelSendLinkedInInvite`), and optionally stop auto-arming the Send button on tab open. There is no automated-sending bug to fix — the gap is the missing confirmation gate on the manual action.

## Coding Agent Timeout Fix + Sonnet 4.6 vs Opus 4.8 Eval (2026-06-01)

Reported via session `ac42f498-a553-48b1-a63e-54503ec3ae33` (user `lyndi@every.io`): a landing-page compliance edit via `coding_agent` timed out before completing; the session showed "No tasks have been run."

### Root cause (FIXED)

The bug report hypothesized the edit was "too broad" and should be split into single-concern passes. **The evidence contradicts that.** Tracing the session messages against the code: both `coding_agent` calls — the broad one AND a narrow retry (font + CTA only) — returned `iterations: -1`. That value is produced *only* by the outer `timeoutPromise` in `runCodingAgent` winning the `Promise.race`; the loop never returned, didn't hit the 50-iteration ceiling, and didn't error. Task breadth was not the cause.

The trigger: the coding-agent default model (`agent_mode_coding_agent_default_model` setting) had been switched to `anthropic.claude-opus-4-8` hours earlier. Opus 4.8 routes through the bearer-token Bedrock client, which used the **blocking `/invoke` endpoint**. Each non-streaming turn (up to 16K tokens) had to fully complete before the loop advanced, and the 10-minute run budget allowed only ~2 slow Opus turns — exhausting the budget before the agent could read → edit → deploy.

**Fix (`backend/src/services/codingAgentService.ts`, 3 commits):**
- **Stream the bearer path:** replaced `/invoke` with `invoke-with-response-stream`. Added `_parseEventStreamFrames` (hand-rolled `vnd.amazon.eventstream` binary frame parser, no new dependency) + `_accumulateBedrockStream` (folds the streamed Anthropic events back into the exact `Anthropic.Message` the loop already consumes — `create()` contract unchanged). Wire format was empirically confirmed against the live dev endpoint (text + tool_use) before writing the parser.
- **Coherent timeouts:** replaced the fixed 5-min per-request cap with a **2-min inter-chunk idle timeout** (a long-but-progressing generation is healthy; only true stalls abort), and raised `AGENT_TIMEOUT_MS` 10m → 20m so several legitimate slow turns fit.
- **Honest aborts:** idle-timeout aborts are tagged `status: 408` + `isTimeout`, reported as "timed out" (not swallowed as a generic error) and not retried by `callWithRetry`. Applied to both the bearer and Vertex paths.
- **Cost observability:** added a guarded `context.onUsage` hook (the loop previously discarded `response.usage`); no behavior change when unset.
- Tests: `codingAgentService.test.ts` (+8) cover frame parsing (whole/partial/multi), message reconstruction, empty-stream → retryable 5xx, throttling-exception → 429, and 408-is-reported-not-retried. 61/61 pass. Verified end-to-end in a real browser (Opus 4.8 path completed iters=6, deployed, preview headline correct).

### Eval: Sonnet 4.6 vs Opus 4.8 (recommendation: STAY ON SONNET 4.6)

Built a real eval harness driving the actual `runCodingAgent` loop against a real test page (24 runs: 4 edit tasks of increasing complexity × 2 models × trials). Each run used a fresh `draft/` branch, deployed to a real Vercel preview, and correctness was scored objectively from the deployed DOM (required strings present, replaced strings absent). Cost measured via the `onUsage` hook. Eval branches/PRs cleaned up after.

| Metric | Sonnet 4.6 | Opus 4.8 |
|---|---|---|
| Success rate | **12/12 (100%)** | **8/12 (67%)** |
| Correct when completed | 12/12 | 8/8 |
| Latency (avg / median) | 51s / 51s | 79s / 54s (up to 166s) |
| Cost per successful edit | **$0.09** | **$0.48 (5.3×)** |

All 4 Opus failures were identical: `Bedrock request timed out after 120s of inactivity` — the bearer-token Bedrock account intermittently stalls with zero stream bytes (one stalled on the very first call). A clean confirmation run got Opus 8/8, confirming these are intermittent infrastructure stalls, not quality issues. On correctness the models tied — Opus produced no better edits, including on the 3-change task.

**Recommendation:** keep the coding agent on **Sonnet 4.6**. Opus 4.8 offers no correctness advantage on these edit tasks while costing 5×, running slower, and being less reliable (bearer-account stalls). Prod is already set back to Sonnet 4.6. The streaming fix is still worth keeping — it makes Opus usable when the account is healthy, and its honest 408 timeout is what surfaced the stall pattern.

## CRM Lead List & LinkedIn Message Sync Bugs (2026-05-30)

Reported against list `list_1770238037853_wh6sswaay` ("LinkedIn Connections - Rui", user `be754b6c-767e-44ec-b181-4042cfe45ea9`).

### Bug A — non-connected leads show hundreds of unrelated LinkedIn messages (FIXED)

**Symptom:** "first lead not even connected but many messages are synced."

**Production data:** The list had 1,021 `linkedin-<listId>` message events. They were attributed to 10 profile URLs; one lead (`karthy-chandra`) held 996 of them. The 996 messages were the user's entire sent history to many different people, dated 2022–2024 (e.g. "Hey Kevin…"), stamped `processedAt` 2026-04-15. All events have eventId prefix `linkedin_msg_*` → they came from the **live Unipile sync** (`POST /sync-linkedin-messages`), which is auto-fired on every lead-detail panel open (`CRM.tsx openLeadDetail`).

**Root cause:** `sync-linkedin-messages` synced for any lead with a LinkedIn URL, with no connection check. For a non-connected attendee, `linkedInOutreachService.getMessagesWithContact()` → `getAllChatsFromAttendee()` resolves to an unrelated chat and `getAllMessagesFromChat` dumps up to `MAX_PAGES*100` (~1000) messages onto that one lead. Cross-checked `AW-UnipileConnections` for account `LIBGE2pYS1eckwgo7wUIGQ` (69 real connections): **every** lead that received messages (karthy-chandra, billnbarry, aviharsh, …) is `connected=false`.

**Fix:**
- `crm.ts` `POST /sync-linkedin-messages`: gate on connection. Resolve the account as `list.linkedInAccountId || resolveAccountId(userId)`, then `getConnectionByProfileUrlAndAccount(leadLinkedIn, accountId)`. If not connected, stamp `linkedinMessageSyncAt` (so auto-sync doesn't re-hit Unipile every open) and return `{ synced: 0, connected: false }` without writing events. Connection cache is refreshed every ~10 min by `linkedInConnectionSyncCron`, matching the panel's 10-min auto-sync throttle.
- `linkedInOutreachService.getMessagesWithContact`: defense-in-depth — return `[]` if the resolved chat has no `id` (an empty `chat_id` makes Unipile return account-wide messages).
- Tests: `crm.syncLinkedInMessages.test.ts` (skip when not connected, stamp syncAt, prefer list account, `connected:true` on success).
- Cleanup of existing bad data: `backend/src/scripts/cleanup-misattributed-linkedin-messages.ts` (dry-run by default). Dry run on this list flags all 1,021 events for deletion (all attributed to non-connections). NOT yet applied to prod — destructive, awaiting approval.

### Bug B — "Lead list not found" when clicking leads + auto-sync (FIXED — hardening)

**Symptom (clarified by user):** "When I click on a lead, it will auto sync LinkedIn and I see the lead list not found error when I clicked many leads."

**Investigation:** Clicking a lead → `openLeadDetail` fires two background actions for this list (it has a `linkedInAccountId` and leads have LinkedIn URLs): the LinkedIn message auto-sync (`POST .../sync-linkedin-messages`) and, for leads without a draft, an agent-mode auto-draft. Both, plus `GET .../engagements`, call `getLeadListById(selectedList.listId)` and return 404 `'Lead list not found'` only when that listId does not exist. The referenced list and its 37 leads exist, and normal clicks send a valid id — so the 404 indicates a **stale `selectedList`**: a list deleted/recreated in another tab/session or by a re-import while the open tab kept the old id. "Many leads" fits — every lead in the stale view 404s on click. Confirmed a real correctness gap: `fetchLeadLists` only *updated* `selectedList` when the list was still present and never *cleared* it when gone, so the stale selection persisted and each lead click kept 404ing.

`handleDynamoDbError` always rethrows, so throttling under load yields a 500, never this 404 — ruling out load as the cause.

**Fix (customer-portal `CRM.tsx`):**
- `fetchLeadLists`: when the previously-selected list is no longer in the refreshed set, clear `selectedList`, close the detail panel, and drop the selected lead — so clicks stop auto-firing against a dead listId.
- Added `isLeadListNotFound(err)` + `handleStaleLeadList()`: on a 404 `'Lead list not found'` from the lead-click auto-sync or `fetchEngagements`, show a single toast ("Lead list unavailable …") and refresh lists (self-heal), guarded by `staleListNoticeRef` against toast spam across many clicks.
- Test: `CRM.test.tsx` "Stale lead list self-heal".

NOTE: this hardens the stale-list path (the only code path that yields this 404 on the click flow). If the user still sees it on a list that genuinely exists, the next datum needed is the exact `listId` in the failing Network request vs. the URL's listId.

## Gemini Interactions API Sunset — June 8, 2026 Assessment (2026-05-27)

### Background

Google sent a notice that the legacy schema in the **Interactions API v1 beta** will be permanently removed on June 8, 2026. After that date, the `Api-Revision: 2026-05-07` opt-out header stops working, and older SDK versions (Python 1.x, JS 1.x) will fail.

Affected Google Cloud projects: `gen-lang-client-0974358743`, `gen-lang-client-0298423887`.

### Investigation

Audited all Gemini/Google GenAI SDK usage across the codebase (backend TypeScript, agent engine Python, both frontends).

**SDK versions in use:**

| Package | Version | Status |
|---------|---------|--------|
| `@google/genai` (JS) | 2.0.0 | ✅ Already on new SDK |
| `@google/generative-ai` (JS) | 0.24.1 | ⚠️ Legacy package — not sunset-related (see below) |
| `google-genai` (Python) | `>=1.8.0` pin | ⚠️ Constraint allows 1.x installs |

**The Interactions API is not used anywhere in this codebase.** All Gemini calls use standard content generation APIs (`generateContent`, `generateContentStream`, `generate_content`, `generate_content_stream`, `generate_videos`). The live voice feature (`liveVoiceService.ts`) uses `ai.live.connect()` from `@google/genai` v2, which is the new SDK.

### Conclusion

**No action required for the June 8 deadline.** The sunset only affects the Interactions API schema, which we do not use.

### Optional Future Cleanup

Two files still import the legacy `@google/generative-ai` package (separate from `@google/genai`):
- `backend/src/services/agentModeService.ts` — data analysis file processing
- `backend/src/services/imageGeneration.ts` — `gemini-2.5-flash-image` generation

These could be migrated to `@google/genai` v2 to consolidate to a single SDK, but this is non-urgent. The Python `environment.yml` pin (`google-genai>=1.8.0`) could also be tightened to `>=2.0.0`.

## perform_data_analysis: Unknown Tool Errors and Timeout in Scheduled Reports (2026-05-15)

### Problem

Session `a01ef8a3-436b-403e-96c1-6590488e57e9` ("Scheduled: Daily User Activity Report") scored 2/10. The judge reported repeated "Unknown tool" errors and a timeout during `perform_data_analysis`.

### Investigation

The schedule had run successfully on May 10, 11, 13 — all completed without calling `perform_data_analysis`. On May 14 the same Gemini model non-deterministically decided to use it for the first time.

**What actually happened in the failing run (from `calledFunctions` and `failedFunctions`):**

1. `get_chat_history`, `list_all_clients` — succeeded, output offloaded to S3
2. `__other_skills__:read_tool_response` × 3 — **"Unknown tool" errors**. The LLM hallucinated skill-prefixed tool names (e.g. `__other_skills__:read_tool_response`) before installing the skill. These show up in `failedFunctions` as `__other_skills__:read_tool_response`.
3. `install_skills` — LLM self-corrected and installed `__other_skills__`
4. `read_tool_response`, `search_tool_response` × many — worked after install
5. `perform_data_analysis` — **timed out** on the large dataset (all 24h of session data sent as a single payload)

The root cause has two parts:
- `perform_data_analysis` was not in `FOUNDATION_TOOLS` and not in any published production skill. It lived in `__other_skills__`, which requires explicit `install_skills` to access. In sessions with no `requiredFunctionCalls`, skills are not auto-installed, so the LLM had to discover and install `__other_skills__` on its own — leading to the hallucinated prefixed tool names while it was figuring out the skill system.
- Once the tool was accessible, calling it with a full 24-hour dataset in a single request hit the 20-minute Gemini timeout.

### Fix

**Done by Rui in the partner portal (no code change):** Added `perform_data_analysis` to the `foundation_tools` setting in `AW-Settings`. This makes it immediately available in every session without requiring skill installation, consistent with other analytical primitives like `search_web` and `search_tool_response`.

**Code change (PR #1548):** Also improved timeout error handling — when the Gemini API call times out, the LLM now receives guidance to break the analysis into smaller subsets (by date range or category) rather than retrying the same large payload. Also fixed a condition ordering bug in `formatToolError` where timeout messages containing "too large for a single call" were misclassified as payload-too-large errors.

### Why `perform_data_analysis` Belongs in Foundation Tools

More scheduled reports and workflows are now using this tool organically. Keeping it in `__other_skills__` means any session that hasn't explicitly installed that skill will hit the same install-then-call friction, with the attendant hallucinated-prefix errors. It's a core analytical primitive — same category as `search_web`, `save_memory`, `search_tool_response`.

---

## DynamoDB Versioning for Brand Guidelines & Market Strategy (2026-05-14)

### Problem

Brand guidelines and market strategy data stored in `AW-Users` and `AW-Organizations` can be overwritten by agent actions or user edits with no way to recover a previous good state.

### Investigation

Considered an application-level versions table (`AW-ContentVersions`) with snapshot-on-write, but rejected it because:
- Requires wiring up every save path in code
- Doesn't cover future data fields automatically
- Adds write overhead and table maintenance

**Decision: DynamoDB Point-in-Time Recovery (PITR)**

PITR was already the right answer — it covers every field in every table automatically, requires zero application code, costs ~$0.20/GB/month, and retains 35 days of continuous backups.

### Status

PITR enabled manually via AWS Console on:
- `AW-Users`
- `AW-Organizations`

No code changes required.

### How to Recover a Corrupted Record

When a brand guideline, market strategy, or any other field is corrupted and needs to be reverted:

**Step 1 — Restore the table to a point in time**

In AWS Console → DynamoDB → Tables → select the table (e.g. `AW-Users`) → Backups tab → "Restore to point in time". Choose a timestamp just before the corruption occurred. Restore to a new table name, e.g. `AW-Users-restore-YYYYMMDD-HHMM`. This takes 5–20 minutes depending on table size.

Or via CLI:
```bash
aws dynamodb restore-table-to-point-in-time \
  --source-table-name AW-Users \
  --target-table-name AW-Users-restore-20260514-1400 \
  --restore-date-time 2026-05-14T14:00:00Z \
  --region us-west-2
```

**Step 2 — Extract the old item from the restored table**

```bash
# For AW-Users (key: email)
aws dynamodb get-item \
  --table-name AW-Users-restore-20260514-1400 \
  --key '{"email": {"S": "user@example.com"}}' \
  --region us-west-2

# For AW-Organizations (key: orgId)
aws dynamodb get-item \
  --table-name AW-Organizations-restore-20260514-1400 \
  --key '{"orgId": {"S": "org_abc123"}}' \
  --region us-west-2
```

To extract just the specific field (e.g. brandGuidelines):
```bash
aws dynamodb get-item \
  --table-name AW-Users-restore-20260514-1400 \
  --key '{"email": {"S": "user@example.com"}}' \
  --query 'Item.brandGuidelines' \
  --region us-west-2
```

**Step 3 — Write the recovered field back to the live table**

Use `update-item` to patch only the affected field without touching anything else:
```bash
# Save the recovered value to a file first
aws dynamodb get-item \
  --table-name AW-Users-restore-20260514-1400 \
  --key '{"email": {"S": "user@example.com"}}' \
  --query 'Item.brandGuidelines' \
  --region us-west-2 > /tmp/recovered-brand.json

# Then apply it back (wrap in the DynamoDB attribute format)
aws dynamodb update-item \
  --table-name AW-Users \
  --key '{"email": {"S": "user@example.com"}}' \
  --update-expression "SET brandGuidelines = :val" \
  --expression-attribute-values '{":val": <paste-recovered-value-here>}' \
  --region us-west-2
```

For orgs, use `AW-Organizations` with key `{"orgId": {"S": "org_abc123"}}`.

**Step 4 — Delete the restore table**

```bash
aws dynamodb delete-table \
  --table-name AW-Users-restore-20260514-1400 \
  --region us-west-2
```

### Notes

- Restored tables inherit no GSIs automatically — they're read-only lookup tables, so this is fine for recovery purposes.
- The restore operation creates a full independent copy of the table — it does not affect the live table at all.
- PITR window is 35 days. For older recovery needs, use DynamoDB on-demand backups (manual snapshots via AWS Console).
- If you need to recover a different field (e.g. `marketStrategy`, `configs`, any future field), the same procedure applies — just change the `--query` path and `--update-expression` field name.

---

## Emma Silent on Slack Third-Party Mentions — Investigation (2026-05-13)

### Problem

In Slack agent mode sessions, when a thread message mentions another person (e.g. `<@U08TWRKGESG> test`), Emma responds to it as if it's a task for her — creating noise. The message is directed at a third party, not at Emma.

### What Was Tried (All Failed)

**Attempt 1: BE_SILENT in system prompt**
Added a `[Silence Rule]` to the Slack session system prompt instructing Emma to respond with `BE_SILENT` if the message isn't directed at her. The Slack handler then checked for this sentinel and suppressed posting.
- Failed because the system prompt is only injected on the *first message* of a session. Thread replies in existing sessions never see the rule.

**Attempt 2: Structural pre-flight check (skip LLM entirely)**
Added `isMessageDirectedElsewhere()` — extract `<@USERID>` mentions from message text, and if none are Emma's bot ID, `return` before calling `generateSessionResponse`.
- Rejected by user: Emma loses context on silent turns because the message is never saved to the session, breaking future responses.

**Attempt 3: BE_SILENT appended to each thread reply message**
Appended `[Silence Rule] ... respond with exactly: BE_SILENT` to `formattedMessage` on every thread reply, so Emma sees the instruction on every turn regardless of when the session was created.
- Failed because Emma's agent instructions are stronger than the hint. She interpreted `<@U08TWRKGESG> test` as "send a Slack message tagging that user with text 'test'" rather than a side-conversation to ignore.

**Attempt 4: Save context + skip LLM (structural, with context preserved)**
Before calling `generateSessionResponse`, detect third-party mentions structurally. If found: save the message to the session (for context) then return. Emma sees the message in history but doesn't respond.
- User rejected this too — they want Emma herself to decide whether to be silent, not backend logic.

### Resolution

No code change applied. The actual solution is simple: the **user can just tell Emma to be silent** in the Slack thread (e.g. "ignore messages not directed at you"). Emma will honor a direct instruction from the user in conversation far more reliably than any injected hint or system prompt addition. No backend change needed — this is a prompt/UX pattern, not an engineering problem.

---

## SeaDance 2.0 Video Generation — Investigation & Blocked (2026-05-09)

### Context

Investigated adding SeaDance 2.0 (ByteDance's advanced video model) as an alternative to Google Veo for video generation. SeaDance 2.0 offers flexible durations (4–15s native), multiple resolutions, aspect ratio control, and native audio — advantages over Veo's fixed 8s/clip limit.

### Approach Attempted

Initial plan was to integrate via **Runway AI** (Gen-4 Turbo) as a well-supported third-party provider with an existing API. However, Runway Pro subscription requires a **debit card** — credit cards and other payment methods are not accepted — making sign-up impossible at this time.

SeaDance 2.0 itself (`bytedance/seedance-2.0`) is currently available on **fal.ai**, but fal.ai's pricing for this model is not yet stable/published, making it a less reliable integration target.

### Status: Parked

Will revisit when one of the following becomes available:
- ByteDance offers a direct API and subscription for SeaDance (no third-party intermediary)
- A reliable third-party API (fal.ai pricing stabilizes, or another provider) is confirmed

### Proposed Design (for when we revisit)

See investigation notes from 2026-05-09 conversation. Summary:
- Add `@fal-ai/client` npm package to backend
- Add secrets: `dev/AgentWeb/Fal/VideoApi` and `prod/AgentWeb/Fal/VideoApi`
- Add `generateWithSeadance2()` in `backend/src/services/videoGeneration.ts` using `fal.subscribe("bytedance/seedance-2.0/text-to-video")` or `image-to-video` endpoint
- fal.ai accepts image URLs directly (no base64 conversion needed, simpler than Veo)
- Multi-clip threshold: 15s native (vs. Veo's 8s), so fewer splits needed
- Files to update: `videoGeneration.ts`, `agentModeService.ts`, `emma/tools.ts`, `AdminDashboard.tsx`, `TaskDetails.tsx`

---

## Scaling to 100 PRs/Day — Investigation & Conclusion (2026-05-08)

### Context

Explored how to scale development throughput from ~20 PRs/day to 100+ PRs/day, inspired by reports that the Claude Code founder achieves this scale using parallel Claude Code sessions and the `/loop` feature.

### Options Investigated

**Option 1: Slot-based parallelism on a single EC2**
Multiple git worktrees on one instance, each running on offset ports (3001/5173/5174 for slot 0, 3011/5183/5184 for slot 1, etc.). Each slot gets its own DynamoDB table prefix (`Dev1-`, `Dev2-`, etc.) for data isolation. Rejected: complex to manage, slots contend for RAM, and the existing architecture already solves this more cleanly.

**Option 2: One EC2 per Claude session (current architecture extended)**
The current system already does the right thing — one EC2 instance per task, each fully isolated by default (separate filesystem, ports, tmux sessions, logs). The only missing piece is auto-dispatch: today a human manually launches each EC2 and terminates it when done. Auto-dispatch (claim task from Notion queue on boot, self-terminate on completion) would be ~100 lines of shell and is straightforward to implement when needed.

**Option 3: Approved task queue gate**
Add an `approved` status in Notion so auto-dispatch only pulls from curated tasks. Eliminates compute waste from low-priority backlog items. Makes sense as a companion to auto-dispatch.

### Root Cause of 20 PR/day Ceiling

The bottleneck is **not** infrastructure — it is task volume. There are genuinely only ~20 worthwhile tasks per day given the current product stage and team size. The EC2/Claude infrastructure is already capable of 50–80 PRs/day if the task supply existed.

Running 100 simultaneous instances against an empty or low-quality queue would produce:
- Noise features nobody needs
- Token burn with no product value
- PRs that slow review rather than accelerate delivery

### Conclusion

**Do not over-engineer for a throughput target we don't need yet.** 20 PRs/day on focused, high-value work is the correct operating mode now.

Throughput will improve organically by:
1. **Epic decomposition** — when a large feature is scoped, break it into 15–30 atomic tasks upfront rather than treating it as one PR
2. **Better task inflow** — user feedback, error monitoring, SEO signals, and competitor analysis will grow the natural task supply as the product matures
3. **Auto-dispatch when the queue is full** — implement the Notion claim/release + EC2 self-terminate pattern only when there are consistently more approved tasks than active instances

Revisit this when the backlog problem is real, not hypothetical.

---

## "Bounced" Users Investigation — info@pmps.ai, admin@btstravel.be (2026-05-04)

### Context

Two users appeared in the Admin Users tab with a "Bounced" subscription status despite having valid Stripe customer IDs (`cus_USLZ3JNSb1epH2` and `cus_UQlSsGMRJCJSZ0` respectively). No corresponding subscription records could be found in Stripe.

### Root Cause: Abandoned Checkout

The "Bounced" label is working correctly. It is a frontend-derived status defined in `partner-portal/src/pages/AdminDashboard.tsx` (around line 3774):

```
bounced = stripe_customer_id set  AND  subscription_status null  AND  subscription_amount null
```

The exact sequence that produces this state:

1. User registers → `subscriptionType: Free`, no Stripe fields set
2. User opens the checkout flow → `POST /create-checkout-session` (`backend/src/routes/stripe.ts:442–448`) runs a "find or create Stripe customer" step and saves the new `cus_xxx` ID to DynamoDB immediately
3. User **abandons the checkout page before entering payment info** → no subscription is ever created on Stripe
4. No `checkout.session.completed` webhook fires → `subscription_status`, `stripe_subscription_id`, `subscription_amount` are never populated

Result: DynamoDB has a `stripe_customer_id` but zero subscription fields → frontend labels the user "Bounced."

| User | Stripe Customer ID | Account Created |
|------|--------------------|-----------------|
| info@pmps.ai | cus_USLZ3JNSb1epH2 | 2026-05-04 |
| admin@btstravel.be | cus_UQlSsGMRJCJSZ0 | 2026-04-30 |

### Verification

You can confirm by searching these customer IDs in the Stripe dashboard — the customer objects exist but have no subscriptions attached.

### No Code Fix Required

The system is behaving as designed. "Bounced" is an accurate label for users who started but did not complete checkout. These users are candidates for re-engagement outreach.

---

## RankAI Meta Ads Account Security Investigation (2026-05-04)

### Context

Matthew Wilmer received a Meta Business Manager email notification at 12:56 AM on April 29, 2026: `Dmitriy Lizin (dmitriylizin@gmail.com)` had joined RankAI's ad account. The client is `dyllan@rankai.ai` (userId: `4e29ce4e-8661-45bd-9881-3075d9a76971`). Matthew removed Dmitriy immediately and flagged the incident for investigation.

Question: was AgentWeb the attack vector, and who added Dmitriy?

### Findings

**AgentWeb was not the attack vector.** Evidence:

- `dmitriylizin@gmail.com` has zero presence in AgentWeb — no account, no sessions, never authenticated against our system
- On April 29, 2026 (the incident date), the only AgentWeb activity for Dyllan's account was a scheduled **Website Scan** of rankai.ai — a pure Playwright browser audit with zero Meta API calls
- All three Meta Ads report schedules were paused before April 29
- No `AW-EmailEvents` records for this user — no phishing or exfiltration pattern through our platform

**Access structure is expected.** The Rankai Meta ad account has 3 AgentWeb team members with Full Control (Harsha Vankayalapati, Matthew Wilmer, Rui Wang) plus 3 system users (AdMgmt Integration, 2× Conversions API System User) — this reflects the managed-services agency relationship where AgentWeb operates Meta Ads on RankAI's behalf.

**Live token with elevated scope.** The Meta access token stored in `AW-Users.connected_accounts[].config.access_token` for this user was verified still valid as of the investigation date:
- `is_valid: true`, non-expiring long-lived token
- Scopes include `business_management` — grants ability to add/remove users from Meta Business Manager
- Token belongs to Matthew Wilmer's Meta account (Meta user ID `10240394354459797`), issued 2026-03-27

**Who added Dmitriy — inconclusive.** The Meta Graph API `/{business_id}/activity_logs` endpoint has been removed (returns OAuthException 2500 on all API versions). Production nginx logs from April 29 are unrecoverable — the EB instance that was running then has been terminated and logs rotated. Matthew confirmed he cannot see the Security Center activity log in the Meta Business Suite UI either.

### Current Status

**Investigation closed pending Dyllan's response.** Matthew will ask Dyllan whether they recognize adding Dmitriy Lizin. If Dyllan confirms they did not add this user, the investigation will be reopened.

### Reopen Criteria

If Dyllan does not recognize the add action, next steps are:
1. File a formal support request with Meta referencing Business Manager ID `1900317767512083` for April 29 audit trail — Meta retains internal logs even after the API endpoint was removed
2. Audit whether the `business_management`-scoped token was exposed anywhere (agent session logs, S3-hosted HTML reports, or API responses)
3. Rotate the Meta access token immediately (revoke via Meta app settings for app ID `1842366079956363`, re-authenticate via AgentWeb)

### Platform Risk Item (Separate from Incident)

Meta access tokens are stored **in plaintext** in `AW-Users.connected_accounts[].config.access_token`. Any DynamoDB read access exposes live third-party OAuth tokens. This is a pre-existing platform-level risk unrelated to this incident but should be addressed — tokens should be encrypted at rest.

## EB Autoscaling Flapping — Investigation (2026-05-01)

### Context

Multiple instance launches observed in production (`Agentweb-backend-env-prod-3`) within a short window: 3 new `t3.large` instances added between 16:31–16:46 UTC, one terminated, health warnings. Initially suspected OOM crashes or instance failures.

### Root Cause: NetworkOut autoscaling threshold too low

The EB autoscaling alarm was configured to trigger on **NetworkOut** (not CPU):
- **Scale up:** `NetworkOut > 6 MB / 5-min period`
- **Scale down:** `NetworkOut < 2 MB / 5-min period`

The backend serves large API responses that easily exceed 6 MB on a single instance:
- `GET /api/agent-mode/sessions?limit=50` → ~2.2 MB response
- `GET /api/tasks/executions/with-html-reports?limit=1` → ~4.2 MB response

A few concurrent users hitting these endpoints concentrate traffic on the single instance after a scale-down (min=1), causing the scale-up alarm to fire. The new instance takes ~7 minutes to become healthy, during which load stays on the original instance — appearing as repeated "crashes."

Peak NetworkOut observed: **23.9 MB/instance** at 16:35 UTC.

### Fix Applied

Raised autoscaling thresholds via EB console:
- **Scale up:** `NetworkOut > 30 MB / 5-min period` (was 6 MB)
- **Scale down:** `NetworkOut < 6 MB / 5-min period` (was 2 MB)

### Not Done: Minimum Instance Count

Raising the minimum from 1 → 2 would eliminate the "all load on one instance" window after scale-down, but adds ~$140/month in EC2 cost. There is no convincing evidence this is necessary given the threshold fix — the flapping was the symptom, not instance capacity. Revisit if flapping resumes after the threshold change.

### How to diagnose in future

1. Check EB events: `aws elasticbeanstalk describe-events --environment-name Agentweb-backend-env-prod-3 --region us-west-2 --max-records 20`
2. Check ASG scaling activities to distinguish scale-out (alarm-triggered) from crash-replacement (health-check failure)
3. Check which alarm fired: `aws cloudwatch describe-alarms --alarm-names <AlarmName>` — look at `Metric` and `Threshold`
4. Plot `NetworkOut` metric on the ASG to see what triggered the alarm

---

## coding_agent "No GitHub / No Vercel" — Investigation (2026-04-29)

### Context

John (`founders@agentweb.pro`) reported that the `coding_agent` tool failed on the "Free AI Eval" landing page (`ai-eval-85a928ad`, `https://audit.agentweb.pro/ai-eval`) after 8 iterations with "No GitHub repository / No Vercel project" errors on all file-editing and deployment tools.

### Root Cause 1: Missing `githubRepoUrl` / `vercelProjectId` on DynamoDB record

The page record existed with `status: deployed` and a live `deployedUrl`, but `githubRepoUrl` and `vercelProjectId` were completely absent. Every coding agent tool — `list_files`, `read_file`, `edit_file`, `check_deployment` — calls `getLandingPage()` and checks these fields before doing anything.

**Why it happened:** `addPageToExistingRepo()` copies these fields from a sibling page at record creation, but the final deployed-status `UPDATE` only wrote `status` and `updatedAt`. If the initial PUT was incomplete for any reason, the record was permanently broken.

**Fix:** The `UPDATE` in `addPageToExistingRepo()` now also re-writes `githubRepoUrl` and `vercelProjectId` (`v0Service.ts`). Backfilled the specific record in production using `repair-landing-page-repo-fields.ts`.

### Root Cause 2: Stale `vercelProjectId` across all pages

After fixing root cause 1, `get_landing_page_preview_url` and `get_deployment_status` failed with 500. The stored Vercel project ID `prj_8MJIkLDVNod9XRj5Kbl0FIk7EhJ3` was stale — the Vercel project had been recreated. All 5 of john's pages had the old ID.

**Fix:** Checked the Vercel dashboard (`vercel.com/agentweb/agentweb-landing-page`), found the new project ID `prj_lH8z68FO47QtpLrLa45FnFRc2xwV`, and ran `repair-vercel-project-id.ts` to update all 5 pages in production.

### How to diagnose this in future

1. Check the DynamoDB record directly: `aws dynamodb get-item --table-name AW-LandingPages --key '{"id":{"S":"<page-id>"}}'` — look for `githubRepoUrl` and `vercelProjectId`.
2. If `vercelProjectId` is present but deployment APIs return 500, test it: `curl -H "Authorization: Bearer <VERCEL_TOKEN>" "https://api.vercel.com/v9/projects/<vercelProjectId>"`. A 404 means the project was recreated — check the Vercel dashboard for the new project ID.
3. When a Vercel project is recreated, update all pages sharing the old ID using `repair-vercel-project-id.ts` (update `OLD_ID`/`NEW_ID` constants first).

### Lesson

When the Vercel project is recreated or migrated, all `AW-LandingPages` records pointing to the old project ID become silently broken. There is no automatic sync. Any time Vercel project management happens (delete, transfer, recreate), run the repair script immediately.

---

## Emma 3-Dimension Scores Missing — Investigation (2026-04-28)

### Context

Emma was asked to pull chat history with `sync=true` and report per-session dimensional scores (`goalCompletion`, `dataAccuracy`, `outputQuality`). The scores were consistently absent from all sessions — Emma could only see the top-level integer score.

### Root Cause

The production `AW-Settings` table has a custom `default-scoring-prompt` that was saved on **2026-04-15**, before the dimensional scoring feature was introduced on **2026-04-26**. The old prompt ends with:

```
Respond with ONLY valid JSON: {"score": <1-5>, "reason": "<brief explanation>"}
```

`getDefaultScoringPrompt()` in `sessionScoringService.ts` checks the DB first and uses whatever is stored there. Since the DB prompt predates dimensions, the LLM never returns a `dimensions` field, and `parseDimensions()` always returns `undefined`. All 57 production sessions in the queried window had `dims=None`.

### Why PR #1347 Didn't Fully Fix It

PR #1347 (`fix(scoring): re-score sessions missing dimensional scores on sync`, 2026-04-27) fixed the **re-scoring guard** — sessions with a score but no dimensions were previously being skipped as "already scored." That guard was updated to re-score when `dimensions` is absent. However, re-scoring still used the old DB prompt, so the LLM still returned no dimensions. The guard fix was correct but incomplete.

### Fix

Update the `default-scoring-prompt` in `AW-Settings` (via Admin → Scoring Judges → Default edit icon) to append the dimensions instruction before the JSON format line:

```
In addition to the overall score, rate three specific dimensions (1-5 each):
- goalCompletion: Did the assistant fully accomplish what the user asked?
- dataAccuracy: Did the output contain plausible, consistent, and factually coherent data?
- outputQuality: Was the output well-structured, specific, and actionable?

Respond with ONLY valid JSON:
{"score": <1-5>, "reason": "<brief explanation>", "dimensions": {"goalCompletion": <1-5>, "dataAccuracy": <1-5>, "outputQuality": <1-5>}}
```

The two custom `IMPORTANT` sections in the existing DB prompt ("Expected outcomes" and "Tool Execution after Nudges") should be preserved — they are prod-only additions not in the hardcoded fallback.

### Verification

Tested on dev by stripping dimensions from a live session, then calling `GET /api/admin/chat-sessions?sync=true`. Confirmed dimensions were backfilled correctly after the prompt update.

### Lesson

When adding new required fields to the scoring LLM output format, also update `AW-Settings` `default-scoring-prompt` if a custom version is stored. The hardcoded `DEFAULT_SCORING_SYSTEM_PROMPT` constant in `sessionScoringService.ts` is only a fallback — any stored DB override takes precedence.

---

# April 27, 2026: Investigation — Drip Campaigns vs. Sequences Overlap

## Context

Audit of the Drip Campaigns feature (customer-portal `/crm/drips`) added in PRs agentweb #1218, #1220, #1301 and agentweb-customer-portal #673 (all by Harsha Vankayalapati). The feature was originally built in partner-portal then migrated to customer-portal. Concern: it may duplicate or conflict with the Sequences feature already in the CRM.

## What Drip Campaigns Does

A drip campaign is a single-email broadcast that repeats on a cadence (every N hours/days/weeks) to all leads currently matching a segment filter. Key attributes:

- **Fields:** `name`, `subjectLine`, `templateHtml`, `segmentQuery` (lifecycle, minHeatScore, utmSource, leadListId), `cadenceUnit`, `cadenceValue`, `maxSends`, `isActive`, `killSwitch`
- **Execution:** `dripExecutor.ts` cron runs every 15 min; for each active campaign, queries matching leads and sends if cadence + safety gates pass
- **Emma tool:** `manage_drip_campaign` (list/get/create/update/pause/resume/delete)
- **Tables:** `AW-DripCampaigns`, `AW-DripSends`
- **Routes:** `backend/src/routes/dripCampaigns.ts`
- **UI:** `customer-portal/src/pages/Drips.tsx`

## What Sequences Does

A sequence is a multi-step email journey where leads enroll explicitly and advance through steps on configurable delays. Key attributes:

- **Fields:** `name`, `description`, `campaignType`, `status`, steps (each with `delayDays`, `subject`, `bodyHtml`), `enrollmentTrigger`, `enrollmentCondition`, `exitConditions`
- **Execution:** `dripSequenceWorker.ts` processes due enrollments; advances per-lead state, evaluates exit conditions
- **Emma tool:** None — UI only
- **Tables:** `AW-DripSequences`, `AW-SequenceEnrollments`
- **Routes:** `backend/src/routes/sequences.ts`
- **UI:** `customer-portal/src/components/crm/SequencesTab.tsx`, `SequenceBuilder.tsx`

## Comparison

| | Drip Campaigns | Sequences |
|---|---|---|
| Steps | Single email, repeating | Multi-step series |
| Trigger | Implicit cadence (cron matches leads) | Explicit enrollment (manual, lifecycle, list) |
| Per-lead state | `AW-DripSends` send history only | Full enrollment record with currentStep, nextSendAt |
| Exit conditions | Kill switch / isActive only | Lifecycle change, email engagement, unsubscribe |
| Emma tool | Yes | No |
| Use case | Broadcast to dynamic segment | Personalized nurture journey |

## Decision

**Drip Campaigns to be removed.** Sequences is the more capable and correctly designed feature — multi-step, per-lead state, enrollment conditions, exit conditions. Drip Campaigns was accidentally added by Harsha's Claude Code session and was not intentionally designed as a separate product feature. Harsha confirmed this and agreed to remove it.

Work required (tracked separately):
- Delete `customer-portal/src/pages/Drips.tsx` + route + nav entry
- Delete `backend/src/routes/dripCampaigns.ts`
- Delete `backend/src/services/dripCampaignDb.ts`, `dripSendsDb.ts`, `dripExecutor.ts`
- Remove `manage_drip_campaign` Emma tool from `backend/src/mcp/server/apiTools.ts`
- Re-assign `manage_drip_campaign` skill assignment (currently in CRM & Lead Management skill) to Sequences or remove
- Drop `AW-DripCampaigns` and `AW-DripSends` DynamoDB tables in prod (after confirming no active campaigns)

---

# April 26, 2026: Investigation — Design4Space Scheduled Chat 400 Error (Azure OpenAI Tool Limit)

## Context

Scheduled chat "Design4Space Website Scan" failed at `2026-04-26T14:19:08` with:

```
400 Invalid 'tools': array too long. Expected an array with maximum length 128, but got an array with length 143 instead.
```

Model: `gpt-5.4` (Azure OpenAI deployment). The earlier run at 04:59 succeeded; the 14:19 run failed.

## Root Cause

Azure OpenAI enforces a hard limit of 128 tools per API request. The session ended up with 143 tools split as:

- **34** foundation tools (always included)
- **22** Browser automation skill tools
- **2** SEO & Website Analytics skill tools
- **~85** from `__other_skills__` — the virtual catch-all skill

`__other_skills__` is auto-installed by `runVerifiedChat()` when a required function call isn't assigned to any named skill. The session needed `navigate_to` (which wasn't in any named skill), so the system installed `__other_skills__`, which at the time held ~85 orphaned tools — every registered tool not assigned to a published skill.

The 04:59 run succeeded because it had a different execution path that happened to stay under 128. The 14:19 manual test run hit the full tool list immediately after skill install.

## Fix 1 — Safety net (PR #1334)

Added `maxTools: 128` to all Azure OpenAI model configs (`gpt-5-chat-2`, `gpt-5.2-chat`, `gpt-5.4`) and truncation logic in `callLLM()` in `agentModeService.ts`. Prevents the hard 400 crash even if tool counts exceed the limit again.

## Fix 2 — Root cause (dev environment only, via partner portal UI)

Audited all registered tools against published skills. Found **65 orphaned tools** in `__other_skills__` that had never been assigned to any named skill. Assigned all of them to their proper skills via the Skills Management UI at `/skills`:

| Skill | Tools added |
|---|---|
| Meeting Intelligence | `fathom_route_action_items` |
| LinkedIn Outreach | `linkedin_outreach` |
| Meta Ads Management & Publishing | `list_meta_ads_campaigns`, `get_meta_ads_metrics` |
| CRM & Lead Management | `ask_crm`, `set_lead_contact_status`, `delete_leads_by_filter`, `update_lead_status`, `get_lead_list_statuses`, `configure_lead_statuses`, `analyze_crm_data`, `assign_lead`, `promote_to_deal`, `get_hot_leads`, `log_contact_event`, `import_leads_from_search`, `enrich_leads_preview`, `enrich_leads_execute`, `enrich_lead_custom`, `get_user_profile`, `report_product_issues`, `manage_drip_campaign` |
| Landing Page Builder | `get_landing_page_preview_url`, `publish_landing_page_changes` |
| Landing Page Design | `create_html_template` |
| Knowledge Base | `perform_deep_research`, `search_ads_knowledge_base`, `list_books`, `get_book_details`, `get_book_content`, `update_book_content`, `generate_book_content`, `create_book`, `create_book_outline`, `create_blog_article`, `publish_blog_article`, `list_cms_categories`, `repair_blog_article` |
| GTM Tracking | `account_summary`, `get_clarity_metrics`, `list_task_templates`, `create_task_from_template`, `create_task_from_prompt`, `create_image_task_from_prompt`, `create_revision`, `get_task_subscriber_metrics`, `remove_c2pa_from_image`, `rotate_primary`, `list_schedule_templates`, `manage_schedule_template`, `create_schedule_from_template`, `slack_list_channels`, `slack_get_recent_messages`, `slack_get_thread_replies`, `slack_send_message`, `send_for_review`, `notify_session`, `wait_seconds`, `search_tool_response`, `email`, `post_on_connected_account`, `perform_data_analysis` |
| B2B Ad Image Batch Generation | `search_web`, `read_page_source` |

After these assignments, `__other_skills__` is empty in dev.

## Decision

**Always assign new tools to a named skill when deploying them.** Do not leave tools unassigned — they silently pile into `__other_skills__` and inflate the tool count for any session that needs the catch-all. The `maxTools` truncation is a safety net, not a substitute for correct skill assignment.

---

# April 21, 2026: Investigation — Agent Mode "Unknown Error" with claude-opus-4-7

## Context

User `ftan@agentweb.pro` hit the generic "I apologize, but I encountered an error processing your request" error in Agent Mode when using model `anthropic.claude-opus-4-7`. This triggered an "Unknown Error in Generate Response" oncall alert.

## Root Cause

`anthropic.claude-opus-4-7` is registered in the model registry but **not provisioned on this AWS Bedrock account**. Bedrock returns:

```
ValidationException: anthropic.claude-opus-4-7 is not available for this account.
You can explore other available models on Amazon Bedrock.
```

This is a 400-class error, but the AWS SDK surfaces the HTTP status on `error.$metadata.httpStatusCode` rather than a top-level `error.status` field. The existing error classifier in `generateMarketingResponse` only checked `error.status === 400`, so the Bedrock ValidationException fell through to the generic catch-all and triggered the oncall alert instead of showing a sensible "issue processing your request" message.

## Fix

- Added `error.$metadata.httpStatusCode` as a fallback when reading the HTTP status in the error classifier (`agentModeService.ts`). Going forward, Bedrock validation errors will map to the correct user-facing message.
- The model is kept in the registry because: (1) it is admin-only (`getSupportedModels` filters out any model with "opus" for non-admins), so regular users are never exposed to it; (2) it may become available on this account in the future, at which point it will work automatically.
- If AWS provisions the model on this account, no code changes are needed — the inference profile ARN is already configured.

## Decision

**Do not remove `claude-opus-4-7` from the registry.** It is safely gated behind admin-only access, and the error classification fix means any future Bedrock unavailability errors will show a proper message rather than triggering a generic alert.

---

# April 8, 2026: Investigation — Lead Tech Stack Enrichment Options

## Context

Investigated options for enriching CRM leads to discover what software products/services lead businesses use — both customer-facing integrations and back-office tools.

## Current Enrichment Capabilities

- `crmEnrichmentService.ts` — web search (via agentModeService.searchWeb) + Gemini LLM extraction. Custom instructions + output fields. 20 parallel workers.
- ICP matching — OpenAI analysis of lead fields vs. user-defined ICPs.
- LinkedIn profile enrichment via Unipile integration.
- Existing guidance hint for `tech_stack` fields uses LLM inference from search results.

## Options Evaluated

**Option A: Pre-built "Tech Stack" enrichment template** — Add preset instruction + output fields to existing enrich-web flow. Zero new infrastructure. Misses back-office tools not in public web results.

**Option B: BuiltWith API** — REST API ($295/mo or $0.12/lookup), scans domains for frontend/web technologies. High accuracy for analytics, CDN, ecommerce, email marketing, payment processors. Doesn't cover internal back-office tools (Salesforce, payroll, etc.).

**Option C: Apollo.io Enrichment API** — `/organizations/enrich?domain=` returns `technology_names` array scraped from job postings and LinkedIn. Free tier 50/day. Best for back-office tools (Salesforce, NetSuite, Jira, AWS). Less accurate for smaller/newer companies.

**Option D: Job Posting Analysis via LLM** — Add second web search per lead targeting LinkedIn/Indeed job listings. "Experience with X required" reveals tech stack. Zero extra cost; only works for actively hiring companies.

**Option E: Browser automation (agent engine)** — Playwright scrapes company websites, integrations/partners pages, footer badges. Most thorough, ~30–60s per lead.

## Decision (final)

**Implement Option D (LLM + web search) via existing `CrmEnrichmentService`** — reuses the same LLM + Google Search pipeline already powering "Enrich with Web". The route uses a tech-stack-specific instruction that targets job postings ("Experience with X required"), integrations/apps pages, and partner badges.

- Route: `POST /api/crm/lists/:listId/leads/enrich-tech-stack` (in `crm.ts`)
- Service: `CrmEnrichmentService` with `sources: ['web_search']` and `TECH_STACK_INSTRUCTION` preset
- UI: "Discover Tech Stack" in CRM dropdown, dedicated dialog with LLM preview (2 sample leads enriched at preview time) + progress bar
- Fields: `tech_stack_analytics`, `tech_stack_cms`, `tech_stack_marketing`, `tech_stack_infrastructure`, `tech_stack_integrations`
- Zero extra cost; 20 parallel workers; ~2–5s per lead

**Note:** `builtWithService.ts` was created as an intermediate attempt (puppeteer scraping `builtwith.com`) but abandoned after BuiltWith captcha blocked automated access. The file remains in the repo but is no longer used by the route.

---

# April 8, 2026: Investigation — Who Started Running Ads for Waldium Account

## Background

User `amrutha@structuredlabs.com` (Waldium) has active Meta Ads campaigns and a recurring 48-hour performance check-in schedule running in their account. Rui (admin) did not recall initiating these, raising a question about which actions were taken by the admin vs. the user, and surfacing a broader gap: the platform has no comprehensive audit trail for actions taken via admin delegate access.

## Investigation

**User ID:** `1a9a40c5-5ec0-41de-996f-cee3b82fa74e`

Queried `AW-ChatSessions` (UserIdIndex GSI) and `AW-TaskSchedules` for this user. Found ~90 sessions spanning Dec 2025–Apr 2026.

### Session Attribution Summary

| Date | Session | Title | Initiated By | Notes |
|------|---------|-------|--------------|-------|
| Jan 7, 2026 | `37429d16` | Emotional Facebook Ad for Waldium DevRel Backlog | **User** (no delegate) | Ad creative only, no Meta Ads API |
| Feb 15–20 | `e13847b4` | AI Assistants Recommend Competitors Facebook Ad | **matthew@agentweb.pro** (delegate) | Ad creative only |
| Feb 15–Mar 25 | `3cccd7e3` | Waldium Multi-ICP AI Ad Video Generation Plan | **matthew@agentweb.pro** (delegate) | Ad video creation |
| **Mar 17** | `dc3b404d` | Meta Ads Multi-Campaign Performance Report | **ruiw@agentweb.pro** (delegate) | **First Meta Ads API session.** 58 msgs. Called `call_meta_ads_insights_api` x10, `call_meta_marketing_api` x1, `manage_scheduled_chat` x3. Created the recurring "Multi-Campaign Performance Report" schedule (every 3 days). |
| Mar 17 | `762ad27b` | Test: Waldium Meta Ads — Multi-Campaign Performance Report | Automated (scheduled) | First automated run of the above schedule |
| **Mar 31–Apr 2** | `d0a87f37` | Meta Ads Status Check – Running vs Paused Campaigns | **ruiw@agentweb.pro** (delegate) | 47 msgs, interactive. Called `call_meta_marketing_api` x4. Checked/changed campaign statuses, ran performance audit, helped with custom audience uploads. Judge score 5/5. |
| **Apr 2–6** | `3fcc89e8` | Meta Campaigns Schedule Lookup | **ruiw@agentweb.pro** (delegate) | 62 msgs, interactive. Set up the "Landing Page Lead Magnets - 48hr Check-in" monitoring schedule (every 2 days). Judge score 5/5. |

### Active Schedules

| Schedule ID | Created | Frequency | Status | Description |
|-------------|---------|-----------|--------|-------------|
| `135c535c` | Mar 17 | Every 3 days | Active | Waldium Meta Ads Multi-Campaign Performance Report |
| `77289d04` | Apr 6 | Every 2 days | Paused | Landing Page Lead Magnets - 48hr Check-in (campaign ID: 6865354788715, account: 883347640787043) |
| `623db84f` | Apr 7 | Daily | Active | Website Scan - waldium.com |

### Findings

1. **Admin (Rui, `ruiw@agentweb.pro`) initiated all Meta Ads API usage** via delegate access, starting March 17. The user (amrutha) never directly triggered Meta Ads API calls — her own sessions were limited to ad content creation (images, copy) in Jan–Feb.

2. **Rui does not recall these sessions.** The `delegateInfo` field records which admin account was used but not who was physically at the keyboard, nor what the original prompt was.

3. **The "Landing Page Lead Magnets" campaign (ID: 6865354788715) was pre-existing** in Meta Ads Manager — the monitoring schedule was set up to watch it, not to launch it.

4. **Root cause of the attribution gap:**
   - `AW-ChatSessions.startingMessage` is null for most sessions — original prompts are not persisted
   - `AW-TaskSchedules.createdBy` is null — no record of who created a schedule
   - Session messages are archived/cleared; only `calledFunctions` counts and judge scores survive
   - No dedicated admin action log exists

## Audit Gap Options Evaluated

Four options were considered:

- **Option A** — Persist `startingMessage` + add `createdByAdminEmail` to schedules (1–2 days, low effort)
- **Option B** — New `AW-AdminActions` table logging every delegate action (3–5 days)
- **Option C** — Email account owner when admin takes high-impact actions via delegate (2–3 days)
- **Option D** — Session message retention policy / compact session summaries (5–7 days)

## Decision

**No ad-hoc tracking added now.** These gaps are real but any point solution (e.g. logging just schedule creation, or just delegate sessions) would be incomplete and create a false sense of coverage.

The right fix is a **comprehensive user activity tracking solution** that covers all action types (sessions, schedules, task executions, config changes) across both user and admin-delegate contexts, with a queryable admin UI. That work should be scoped and prioritized as a standalone initiative rather than bolted on per-investigation.

**Until that exists:** When investigating admin delegate sessions, use `delegateInfo` on `AW-ChatSessions` + `calledFunctions` counts + judge scores as the best available signal.

---

# April 9, 2026: Investigation — Emma Taking Irrelevant Actions (CRM/Lead Creation During Website Scan)

## Context

Reported session: `f3e85582-8f82-4c62-a9d3-a37692e94088`
Schedule: `f6418b77-81a1-4dad-9c1f-6d77adff2c6e` ("Design4Space Website Scan")
User: `1f32123d-23b3-456e-81cd-52bae8bb5851`

A scheduled website scan session where Emma was observed creating a lead list and adding a contact to CRM — actions completely unrelated to the task.

## What Happened

The schedule's starting message was:
> "Visit and scan the website https://www.design4space.com.sg/. Report issues that are directly observable from the site..."

Emma completed the scan correctly (Playwright browser tools). The user then sent a follow-up in the same session:
> "write a short message to inform Connie about the results and suggested changes"

Emma's response to this follow-up:
1. Installed "CRM & Lead Management" skill (via `install_skills`)
2. Called `get_lead_lists` — checked for existing lead lists
3. Called `create_lead_list` — created a new list "Website Audit Contacts"
4. Called `add_leads_to_list` — added Connie as a CRM contact
5. Called `get_leads` + `update_email_draft_for_lead` — created a full email campaign draft

The user wanted a short text message to copy/paste. Emma instead built a full CRM workflow.

In addition, `install_skills` was called 3 times total across the session (Browser automation, CRM & Lead Management, other_skills), reflecting the same pattern: Emma installs whatever skill it thinks it needs, even when the requested output is plain text.

## Root Cause

Emma's system prompt instructs it to "analyze every request, identify all required skills/tools, and install them before executing." There is no rule saying: if the output is text, just write it — don't create data records.

When Emma saw "write a message to Connie," it interpreted this as needing CRM infrastructure (find the contact, draft a personalized email template, save to campaign). The system prompt actively encourages this kind of over-tooling via the Analyze-Install-Execute protocol.

### Relevant System Prompt Location

`backend/src/services/agentModeService.ts` — `getMarketingSystemPrompt()` method (~line 2046), the `## Critical Rules` section. This is where tool usage rules live.

## Fix Considered

Adding two Critical Rules to the system prompt:
- **Minimum Necessary Tools**: Only install skills when the output genuinely cannot be produced without them. "Write a message" = write text, no tools needed.
- **No Unsolicited Data Creation**: Never create persistent records (lead lists, contacts, GTM plans, campaigns) unless the user explicitly asks.

## Decision

**No action taken.** The fix direction is correct but the impact of modifying Emma's core system prompt is unclear. The Analyze-Install-Execute protocol is central to Emma's behavior across many workflows; adding blanket "don't use tools" rules could break legitimate flows where CRM or campaign tools are genuinely needed. The risk/reward tradeoff is uncertain without more testing.

**Longer-term options to consider:**
1. Add the two Critical Rules above and A/B test against a sample of real sessions
2. For scheduled chat sessions specifically, inject a stricter constraint in the schedule context (already injected at `agentModeController.ts:1403`) — e.g. "Only use tools required to complete the stated task. Do not install additional skills or create new records."
3. Add a session-level "allowed tool categories" config on the schedule definition, so the schedule creator can restrict which skill categories Emma can use at runtime

---

# April 6, 2026: Investigation — Claude Code Source Analysis (Agent Architecture Patterns)

## Background

Anthropic's Claude Code CLI source was recently deobfuscated and analyzed by the community (~386K–500K lines, ~1,900 files). Two primary analysis repositories surfaced:
- `github.com/chat2dev/ClaudeCodeAnalysis` — 7-part architectural breakdown
- `github.com/luzhenqian/Claude-Harness` — 31-article deep-dive series

Investigated what patterns could be borrowed into AgentWeb's agent infrastructure (`agentModeService.ts`, `toolRegistry.ts`, Emma pipeline).

## Key Findings

### 1. Tiered Context Compaction (three layers, zero-cost first two)

Claude Code uses a three-layer compaction strategy triggered before context overflow:

- **Layer 1 (free)**: Replace old `tool_result` content with `[result cleared]` placeholders. No LLM call — the model has already acted on these results.
- **Layer 2 (free)**: Use a pre-built "session memory" object maintained in the background after each turn (key decisions, completed actions, open questions). No extra API call — the summary is ready when needed.
- **Layer 3 (LLM call)**: Full summarization via a forked agent with an `<analysis>`/`<summary>` prompt structure. Strips reasoning from the stored output.

**Circuit breaker**: After 3 consecutive compaction failures, auto-compaction is disabled for the session. This was added after a production incident where 1,279 sessions experienced 50–3,272 consecutive failures, wasting ~250K API calls/day.

### 2. Hybrid Token Counting

Rather than re-estimating the full message history every turn (slow) or using pure heuristics (inaccurate), Claude Code uses the last API response's `usage.prompt_tokens` as an anchor and only estimates deltas for new messages (~4 chars/token). Four pressure thresholds: warning → auto-compact → blocking → effective-window.

AgentWeb already captures `response.usage` at `agentModeService.ts:1429-1445` — this data is available to implement the same pattern without any API changes.

### 3. Tool Safety Metadata + Smart Concurrency

Each tool declares `isConcurrencySafe(input)`, `isReadOnly(input)`, and optional `isDestructive(input)` at the type level. The `StreamingToolExecutor` runs read-only tools in parallel and serializes write tools. Critically, `isConcurrencySafe` accepts the actual input (same tool can be safe or unsafe depending on what it's operating on).

AgentWeb's `ToolRegistry` currently has no such metadata — `AgentTool` is `{name, definition, execute}` only. Tools already run in parallel (`agentModeService.ts:1503-1505`) but with no write-safety guarantee.

### 4. Tool Pair Integrity on Context Trim

When pruning old messages, Claude Code enforces that a `tool_use` (assistant message) is never left without its matching `tool_result`. An orphaned `tool_use` causes certain LLMs (especially Claude-family) to return an API error. The function `adjustIndexToPreserveAPIInvariants` enforces this.

AgentWeb's `trimToolMessagesForContext` (`agentModeService.ts:13144`) only trims `tool` role messages — it does not check or remove the paired assistant `tool_calls` block. This is a latent correctness issue for very long sessions.

### 5. Analysis-Output XML Separation in LLM Prompts

For complex structured outputs, Claude Code prompts include `<analysis>` (reasoning, gets stripped) and `<summary>` (output, gets stored) tags. The analysis block gets stripped before storing — the model reasons without the reasoning eating into future context budget. This reliably improves quality for structured generation (work plans, summaries, reports).

### 6. Max-Tokens Recovery Message

Claude Code's continuation injection explicitly bans preamble:
> *"Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces."*

AgentWeb's current version (`agentModeService.ts:1463`) says *"Please continue exactly where you left off"* — allows the model to start with an apology and restatement before resuming.

### 7. Error Withholding Pattern

Recoverable errors (`max_output_tokens`, `prompt_too_long`, media-size) are withheld from the caller while recovery is attempted. The error is only surfaced if all recovery strategies fail. This prevents SDK consumers from terminating sessions on transient errors.

AgentWeb has basic max-tokens continuation (3x) and backup model fallback, but `prompt_too_long` has no recovery path — it propagates immediately to the user.

## Current AgentWeb Gaps vs. Claude Code

| Area | AgentWeb Current | Claude Code Pattern |
|------|-----------------|---------------------|
| Context compaction | `trimToolMessagesForContext` (crude truncation) | 3-layer tiered strategy with circuit breaker |
| Token awareness | None | Hybrid counting + 4 pressure thresholds |
| Tool safety metadata | None (`AgentTool` has no `isReadOnly`) | `isConcurrencySafe`, `isReadOnly`, `isDestructive` per-tool |
| Tool pair integrity | Not enforced | `adjustIndexToPreserveAPIInvariants` |
| Prompt quality | Direct prompts | `<analysis>`/`<output>` separation for structured generation |
| Recovery message | Allows preamble | Explicitly bans apology/recap |
| `prompt_too_long` | Propagates immediately | Reactive compaction + retry |

## Decision

**No immediate adoption** — AgentWeb sessions are not yet long enough to make context compaction a user-visible problem. No urgent need to invest the engineering time.

**Future work signal**: If any of the following happen, revisit these patterns:

- Long agent sessions (>50 turns) start failing or degrading in quality
- Context window errors appear in production logs (`prompt_too_long` / 400 errors)
- Users report agents "forgetting" earlier context in long sessions
- We add sub-agent / coordinator-worker orchestration (then tool safety metadata becomes critical)

**Prioritized if/when adopted** (easiest wins first):
1. Fix max-tokens recovery message (1-liner, `agentModeService.ts:1463`)
2. Tool pair integrity in `trimToolMessagesForContext` (prevents latent API errors)
3. `<analysis>`/`<output>` separation in work plan / GTM plan generation
4. `isReadOnly` / `isDestructive` metadata on `AgentTool` interface
5. Token pressure thresholds using existing `response.usage` data
6. Full tiered context compaction (largest investment, highest long-session impact)

---

# April 4, 2026: Investigation — Axios Supply Chain Attack (AWS Security Alert)

## Background

Received an AWS Security email warning that our organization "may have been the target of potentially inappropriate activity" related to malicious axios npm package versions `1.14.1` and `0.30.4`, published March 30–31, 2026 via a hijacked maintainer account.

AWS recommended checking for network connections to `142.11.206.73:8000` during March 31, 5:15–8:15 PM PDT, rotating credentials on affected hosts, and auditing CloudTrail.

## Investigation

### Axios versions in our lock files

| Component | Resolved axios version | Status |
|---|---|---|
| backend | 1.9.0 | Safe |
| partner-portal | 1.11.0 | Safe |
| customer-portal | 1.11.0 | Safe |
| agent-engine | Python only — no axios | Not applicable |

The `1.14.1` hits that appeared in the lock file grep were for `tslib` (a TypeScript utility), not axios.

### Why we were never exposed

- **`npm ci` everywhere**: CI pipeline and cloud-dev test env both use `npm ci`, which installs exact lock file versions — no semver range resolution occurs.
- **Lock files were clean during the attack window**: Confirmed via `git show 32c1b508:backend/package-lock.json` — backend had axios `1.9.0` as of the March 31 commit. No package-lock.json changes landed during March 30–31.
- **EB deploys bundle the lock file**: The zip artifact includes `package-lock.json`, so EB also installs only locked versions.
- **Agent engine is Python**: No axios dependency at all.

### AWS Health Dashboard

Checked the Affected Resources tab — no resources listed. This confirms the alert was a false alarm. AWS sent these notifications broadly to any account that uses axios as a dependency, as a precautionary measure.

## Conclusion

No compromise. No credential rotation needed. No affected hosts.

The `package.json` semver ranges (`^1.9.0`, `^1.7.9`) would theoretically allow resolving to `1.14.1` under a bare `npm install`, but since all install paths use `npm ci` the lock file versions were always used. The malicious versions were removed from npm shortly after discovery. Low-priority housekeeping: update lock files to pin axios past `1.14.1` when convenient.

# March 29, 2026: Investigation — Sonnet 4.6 vs Opus 4.6 Cost & Quality Comparison for Agent Mode

## Problem

Agent Mode defaults to Opus 4.6 (`anthropic.claude-opus-4-6-v1`) for all sessions. Opus is the most expensive Claude model. Need to determine whether switching the default to Sonnet 4.6 would meaningfully reduce costs without degrading output quality for typical marketing tasks.

## Approach

Ran identical marketing tasks on both models using the test account (`test@example.com`) and compared cost, token usage, and output quality.

### Tasks Tested
1. **SWOT Analysis** — "Create a SWOT analysis for my business"
2. **LinkedIn Posts** — "Create 3 LinkedIn posts for my business"
3. **Email Nurture Sequence** — email marketing content
4. **Brand Guidelines Review** — brand strategy analysis
5. **Competitor Analysis** — competitive landscape research

## Results

### Cost Comparison (Same Tasks, Same Account)

| Task | Sonnet 4.6 Cost | Opus 4.6 Cost | Opus Premium |
|------|-----------------|---------------|--------------|
| SWOT Analysis | $0.091 | $0.677 | **7.4x** |
| LinkedIn Posts | $0.062 | $1.270 | **20.5x** |

**Average: Opus costs ~14x more per session for comparable marketing tasks.**

### Sonnet 4.6 — Full Test Results

| Task | Session | Cost | Output Tokens |
|------|---------|------|---------------|
| SWOT Analysis | 9246850b | $0.091 | 10,526 |
| LinkedIn Posts | 53c768c5 | $0.062 | ~7,000 |
| Email Nurture | d41e9b3c | $0.062 | ~7,000 |
| Brand Guidelines | dfdc46b6 | $0.106 | ~10,000 |
| Competitor Analysis | 067d7bd5 | $0.159 | ~14,000 |

**Average Sonnet session cost: $0.096**

### Opus 4.6 — Test Results

| Task | Session | Cost | Output Tokens |
|------|---------|------|---------------|
| SWOT Analysis | d3173b8a | $0.677 | 10,468 |
| LinkedIn Posts | 9b0603f3 | $1.270 | 8,654 |

**Average Opus session cost: $0.974**

### Pricing Reference

| Model | Input (per 1M tokens) | Output (per 1M tokens) |
|-------|----------------------|------------------------|
| Sonnet 4.6 | $3 | $15 |
| Opus 4.6 | $15 | $75 |

## Quality Assessment

Both models produced **excellent, production-quality** marketing outputs:

- **SWOT Analysis**: Both generated comprehensive strategic frameworks with tables, bullet points, and actionable recommendations. Indistinguishable quality.
- **LinkedIn Posts**: Both created well-crafted content. Opus was slightly more "feature-aware" — it discovered and used the `create_social_media_posts` tool to save posts directly, while Sonnet presented them inline. The extra tool usage drove Opus cost much higher.
- **Email/Brand/Competitor tasks** (Sonnet only): All produced thorough, well-structured outputs comparable to what Opus would generate.

### Key Observation

Opus's main advantage is being more likely to discover and use platform tools (e.g., `create_social_media_posts`, `install_skills`). However, this increases cost significantly (more iterations, more tool calls) and the end-user output quality is equivalent.

## Projected Monthly Savings

Assuming ~500 agent mode sessions/month:
- **Opus monthly cost**: ~$487 (500 × $0.974)
- **Sonnet monthly cost**: ~$48 (500 × $0.096)
- **Potential savings**: ~$439/month (~90% reduction)

## Recommendation

**Switch the default model to Sonnet 4.6.** The quality difference is negligible for marketing tasks, and the cost savings are dramatic (7-20x per session). Opus can remain available as a manual selection in the model dropdown for users who want it.

### Also Investigated: Auto_CostSaving Meta-Model

Explored building an `Auto_CostSaving` meta-model that dynamically routes between Claude models per iteration based on task complexity. Implementation was completed but ultimately unnecessary — since Sonnet handles all tested tasks at equivalent quality, a simple default switch is cleaner than a dynamic routing system.

**Decision:** Discard Auto_CostSaving code; switch default model to Sonnet 4.6 instead.

---

# March 28, 2026: Investigation — SESSION_MESSAGE_LIMIT_EXCEEDED on Scheduled Chat (BirdDog Blog Articles)

## Problem

Schedule `527a6748-abc5-4475-aa1e-e9e77cd09d09` ("BirdDog Blog Articles", user `7856055c-298f-4478-ba4c-183240fe2db2`) failed after ~80 minutes with:

```
SESSION_MESSAGE_LIMIT_EXCEEDED: Adding 14 message(s) would exceed the maximum of 300 messages per session (current: 289). Please start a new session to continue the conversation.
```

Session: `e1694c29-ca30-42cf-981a-2a30f1ed2eda`

## Root Cause

**The LLM refused to call `search_web` despite it being listed as a required function in the schedule config.** The `runVerifiedChat` retry loop kept requesting the LLM to call `search_web`, but the LLM repeatedly declined or ignored the instruction, causing the loop to retry up to its max attempts. Each retry added ~12-18 messages (user prompt + LLM response + tool calls + tool results), and after ~15 attempts the session had accumulated 289 messages — 11 short of the 300 hard limit.

This is fundamentally a **prompt-following issue** — the LLM did not comply with the instruction to call `search_web`, and the retry mechanism had no way to detect that the LLM was systematically refusing a specific tool call vs. simply needing another attempt.

A secondary issue: `runVerifiedChat` had **no pre-flight check** on the session message count before retrying, so it kept retrying until it hit the hard limit and crashed instead of stopping gracefully.

## Fix

1. **Config fix (immediate):** Removed `search_web` from `requiredFunctionCalls` in the schedule config. The tool is not essential for blog article generation — the LLM calls it organically when needed, and forcing it via `requiredFunctionCalls` creates a brittle dependency on the LLM's willingness to comply.

2. **Code fix (defensive):** Added a pre-flight message count check in `runVerifiedChat` (`agentModeController.ts`). Before each retry, the session's `messageCount` is compared against `MAX_MESSAGE_SIZE_PER_SESSION - 50`. If within 50 messages of the limit, the retry loop breaks gracefully and returns the partial result instead of crashing.

## Lesson

- **Don't require tool calls that aren't essential.** If the LLM can produce acceptable output without calling a specific tool, don't add it to `requiredFunctionCalls`. The retry loop will burn through attempts (and messages) trying to force a tool call the LLM may not see as necessary.
- **LLM prompt-following is not guaranteed** — especially for tool calls the model deems irrelevant to the task. Design retry logic to degrade gracefully rather than assuming the LLM will eventually comply.
- **Session message limits need proactive checking**, not just reactive enforcement. The hard limit at 300 was only checked when writing messages, not when deciding whether to retry.

---

# March 28, 2026: Investigation — Why Some Sessions Do Not Have Usage Data

## Problem

Some chat sessions in `AW-ChatSessions` have no `totalTokens` or `totalCost`, even though they contain messages and had LLM calls. Need to determine scope and root cause.

## Investigation

Analyzed last 500 sessions in production (queried `AdminUpdatedAtIndex`).

### Data Breakdown

| Portal Type | Total | With Usage | Without Usage | Multi-Msg Without Usage |
|-------------|-------|------------|---------------|------------------------|
| agent       | 118   | 96         | 22            | 4                      |
| emma-sidebar| 202   | 1          | 201           | 0                      |

### Emma-sidebar sessions (201 without usage) — NOT A BUG

These are auto-created sessions when a user navigates to a page. 196 of 200 `messageCount=1` sessions have `updatedAt ≈ createdAt` (within 1 second) — the session was created with a system message in AW-ChatMessages, but the user never actually chatted. No LLM calls were made.

The 1 Emma session that had a real conversation (7 messages) correctly has usage data.

### Agent sessions with messageCount=0 (18 without usage) — NOT A BUG

Sessions created but never started (e.g., predefined work plans set up but user hasn't interacted).

### Agent sessions with messages but no usage — 4 sessions

| Session | Type | Msgs | Model | Root Cause |
|---------|------|------|-------|------------|
| `f8cf70d9` | predefined-work-plan | 30 | gemini-3-pro | **Pre-dates usage tracking** (created 2026-03-16, earliest session with usage is 2026-03-26) |
| `c3615c1c` | predefined-work-plan | 25 | claude-opus-4-6 | **Same** — created 2026-03-16 |
| `a19cc80d` | scheduled | 2 | gemini-3.1-pro | Only system+user msgs, **AI response never persisted** (worker timeout/crash) |
| `1e5af232` | regular (slack-bot) | 2 | undefined | Only system+user msgs, **AI response never persisted**, model undefined |

### Root Causes

1. **Historical sessions**: Sessions created before usage tracking was deployed (pre March 26). All messages have `hasUsage=false`. No fix needed.

2. **Failed/incomplete sessions**: Worker crashed or timed out during `generateMarketingResponse`. Usage is completely lost because:
   - Usage extraction only happens when `response.responseMessages` are persisted via `addMessagesToSession`
   - If worker throws/times out, `responseMessages` is never populated
   - `incrementTokenUsage()` at chatbotService.ts:803 is never reached
   - No fallback to capture partial usage from the worker process

### Gap: Usage Lost on Worker Failure

When `generateMarketingResponseWorkerService.runInWorker()` fails:
- User message: saved (before worker call)
- AI response messages: NOT saved
- Token usage on session: NOT tracked
- User token allowance: NOT decremented (even though LLM was called)
- Error message: saved for scheduled sessions only

The worker (generateMarketingResponseWorker.ts) catches errors and sends them back to the parent process, but the error message contains no usage data. The LLM may have been called (and tokens consumed) before the error occurred.

## Architecture Note

**`chatbotService.ts` is legacy infrastructure** — it powers the partner portal chatbot and provides shared DB operations (session CRUD, message persistence, token tracking). The primary intelligence service is **`agentModeService.ts`** (Agent Mode), which handles all agent, emma-sidebar, scheduled, and Slack bot sessions. The `generateChatResponse()` function in chatbotService is only used by the partner portal's `/api/chatbot` endpoint and is not actively maintained. Future work should consolidate onto the Agent Mode path and deprecate the chatbot-specific response generation.

## Recommendations

1. **Capture partial usage on worker failure**: When the worker throws, include accumulated usage data in the error payload so the parent can still call `incrementTokenUsage()`.
2. **Backfill historical sessions**: For sessions created before usage tracking (pre March 26), usage data is unrecoverable since individual message usage was never recorded.
3. **Monitor for incomplete sessions**: Add alerting for sessions where `calledFunctions` is populated but `totalTokens` is missing — indicates a worker failure with lost usage.

# March 27, 2026: Investigation — Sessions Not Showing Up in Customer Portal

## Problem

Admin page (Users tab) shows 15+ sessions for a customer (`harshitshah1989@gmail.com`), but the customer portal only shows 1 session. The session counts between admin and customer views are inconsistent.

## Root Cause

**Portal type filtering mismatch between admin count and customer portal query.**

### Production data for the affected user (userId: `100c8fa5-8444-4dfb-81b3-805f29d8e39e`)

- **16 total sessions** in `AW-ChatSessions`
  - 1 session with `portalType = 'agent'` (main agent chat)
  - 15 sessions with `portalType = 'emma-sidebar'` (Emma assistant sidebar)
  - None archived

### Admin page count (`db.ts` → `getChatSessionCount`)

Queries `AW-ChatSessions` `UserIdIndex` with only an archived filter — counts ALL session types:
```
COUNT(sessions WHERE userId = :userId AND (archived not set OR archived = false))
```
Result: **16 sessions**

### Customer portal list (`agentModeController.ts:1570`)

Defaults `portalType` to `'agent'` when not passed by the frontend:
```typescript
const portalType = (req.query.portalType as string) === 'emma-sidebar'
  ? 'emma-sidebar' as const : 'agent' as const;
```
The frontend hook (`useAgentModeSessions.ts` → `loadSessions`) calls `GET /api/agent-mode/sessions?limit=50` without a `portalType` parameter, so it defaults to `'agent'` and only returns agent sessions.

Result: **1 session**

### Additional note on emma-sidebar session creation

The 15 emma-sidebar sessions were created in rapid bursts (many within seconds of each other around 09:13 and 09:59 UTC on March 26), suggesting repeated page loads or sidebar reconnections are creating new sessions each time.

## Fix Options

1. **Fix admin count** — filter `getChatSessionCount` by portalType so it matches what the customer sees (or show a breakdown)
2. **Show emma-sidebar sessions in customer portal** — include them in the session list
3. **Both** — accurate admin counts AND full session visibility in customer portal

---

# March 27, 2026: Investigation — Landing Page Preview URLs Returning `not_found`

## Problem

The coding agent's `get_landing_page_preview_url` tool was consistently returning `buildStatus: "not_found"` for draft branch preview deployments. Observed in session `2db6affe-75f1-4502-8cbc-5e2c476dab6b` (Waldium hero banner redesign) — the tool was called 3 times, all returning not_found despite the draft branch having valid commits pushed via the GitHub API.

## Root Cause

**Two Vercel projects existed for the same customer**, created at different times:

1. **Original project** (`waldium-lander`, `prj_P6X3YHKGydAVFN3xtml1dxl1Haqo`) — linked to the consolidated repo `AgentWebPro/v0-waldium-lander`, serving production at `start.waldium.com`, receiving all branch push webhooks and creating preview deployments correctly.
2. **Auto-generated project** (`lp-waldium-value-first-landing-pa-0ae94752`, `prj_ZlAxFRUuxfowuTCAsjyiDngVBj0p`) — created by the `createVercelProject()` flow in `v0Service.ts` when a new landing page was generated. Linked to a stale auto-generated repo `AgentWebPro/lp-waldium-value-first-landing-pa-0ae94752`, which had no draft branches and no recent deployments since March 18.

All 5 Waldium landing page records in `AW-LandingPages` had `vercelProjectId` pointing to the **wrong** (auto-generated) project. When `getPreviewDeploymentUrl()` queried Vercel's deployments API for `prj_ZlAxFRUuxfowuTCAsjyiDngVBj0p`, it found no deployments matching the draft branch — because the coding agent pushed code to `v0-waldium-lander`, which only the original project was watching.

## Investigation Steps

1. Retrieved session data from `AW-ChatSessions` — `calledFunctions` showed `get_landing_page_preview_url` called 3x, `coding_agent` called 2x (retried after preview failure).
2. Confirmed draft branch `draft/2db6affe-75f1-45` existed in `AgentWebPro/v0-waldium-lander` with 4 commits.
3. Used Vercel API (token from `dev/AgentWeb/Vercel` in Secrets Manager) to list deployments on the DB-referenced project — found only `main` branch deployments from March 18, zero draft branch deployments.
4. Discovered a second Vercel project (`waldium-lander`) linked to the correct repo, which had READY deployments for all draft branches including `draft/2db6affe-75f1-45`.

## Fix

Updated `vercelProjectId` in `AW-LandingPages` DynamoDB table for all affected records:

**Waldium** (5 pages): `prj_ZlAxFRUuxfowuTCAsjyiDngVBj0p` → `prj_P6X3YHKGydAVFN3xtml1dxl1Haqo`
**Haven** (2 pages): `prj_CRoy9Bt1h23v4az2NrRvRpq5DsRz` → `prj_U38WBYiLKZdjh1IUcfyIBhQTtzaE`

Full prod scan of all 32 landing pages across 6 Vercel projects confirmed only Waldium and Haven were affected. Other customers (xCures, AgentWeb SEO, Your360, AgentWeb Main) had matching repo/project configurations.

## Lesson

When a customer's landing pages are consolidated into a single `v0-*` GitHub repo, the `vercelProjectId` in DynamoDB must be updated to match the Vercel project that is actually linked to that repo. The auto-generated `lp-*` Vercel project (created by `createVercelProject()` during initial page generation) becomes stale after consolidation.

To diagnose similar issues in the future:
- Compare `githubRepoUrl` in `AW-LandingPages` against the Vercel project's `link.repo` via `GET /v9/projects/{id}`
- If they point to different GitHub repos, the preview URL flow is broken

---

# March 26, 2026: Investigation — Recurring S3 DeleteObject Errors on Prod EB

## Problem

EB event notifications for the production environment (`Agentweb-backend-env-prod-3`, `e-ag9bmkfczz`) were reporting S3 permission errors. The `agentweb-test-env-ec2-role` lacked `s3:DeleteObject` on the EB bucket, causing cleanup failures for both tail logs and bundle logs:

**Tail logs** (from cron-based log monitoring):
```
Service:Amazon S3, Message:User: arn:aws:sts::992382574572:assumed-role/agentweb-test-env-ec2-role/i-07d440d734bbbcf55
is not authorized to perform: s3:DeleteObject on resource:
"arn:aws:s3:::elasticbeanstalk-us-west-2-992382574572/resources/environments/logs/tail/..."
```

**Bundle logs** (from manual `request-environment-info --info-type bundle`):
```
Service:Amazon S3, Message:User: arn:aws:sts::992382574572:assumed-role/agentweb-test-env-ec2-role/i-03e403b3c8620a994
is not authorized to perform: s3:DeleteObject on resource:
"arn:aws:s3:::elasticbeanstalk-us-west-2-992382574572/resources/environments/logs/bundle/..."
```

## Root Cause

When any IAM role calls `aws elasticbeanstalk request-environment-info`, EB uploads logs to S3 and later tries to clean up (delete) old log files **using the caller's IAM role**. The `agentweb-test-env-ec2-role` had `elasticbeanstalk:RequestEnvironmentInfo` and `elasticbeanstalk:RetrieveEnvironmentInfo` but **not** `s3:DeleteObject` on the EB bucket. EB successfully collected and returned logs, but cleanup failed every time, generating ERROR events.

## Fix

Added `s3:DeleteObject` permission to `agentweb-test-env-ec2-role`, scoped to the entire EB bucket:

```json
{
  "Sid": "AllowEBLogCleanup",
  "Effect": "Allow",
  "Action": "s3:DeleteObject",
  "Resource": "arn:aws:s3:::elasticbeanstalk-us-west-2-992382574572/*"
}
```

Verified the fix by successfully deleting a bundle log object that previously failed.

## Lesson

When granting EB log retrieval permissions to an IAM role, also grant `s3:DeleteObject` on `elasticbeanstalk-<region>-<account>/*` so EB can clean up temporary log fragments (both tail and bundle types).

---

# March 25, 2026: Investigation — LiteLLM Vulnerability Impact on AgentWeb

## Background

Multiple CVEs have been disclosed against **LiteLLM** (BerriAI's LLM proxy/gateway library):

| CVE | Score | Severity | Description |
|-----|-------|----------|-------------|
| CVE-2024-4888 | 8.1 | High | Arbitrary file deletion via `/audio/transcriptions` endpoint |
| CVE-2024-10188 | 7.5 | High | DoS via `ast.literal_eval` on user input |
| CVE-2025-45809 | 5.4 | Medium | SQL injection via `/key/block` and `/key/unblock` API endpoints |
| CVE-2025-11203 | 3.5 | Low | API key information disclosure via health endpoint |

## Investigation Findings

**AgentWeb is NOT impacted.** LiteLLM is neither a direct nor transitive dependency.

### What we checked

- `agent-engine/requirements.txt` — no litellm
- `agent-engine/environment.yml` — no litellm
- `backend/package.json` — no litellm
- Full codebase grep for "litellm" — zero code references
- Transitive dependency check: browser-use, ag2 (AutoGen), and langchain packages do not pull in litellm

### How AgentWeb integrates with LLMs instead

AgentWeb uses direct SDK integrations, not a proxy layer:
- **AWS Bedrock SDK** — for Claude models (via `@aws-sdk/client-bedrock-runtime`)
- **Azure OpenAI SDK** — for GPT-4o/GPT-4.1
- **Google GenAI SDK** — for Gemini models
- **OpenAI SDK** — direct API access
- **LangChain** — abstraction layer in agent-engine (does not depend on litellm)

### Conclusion

No remediation action required. AgentWeb's direct-SDK approach avoids the proxy-layer attack surface that LiteLLM exposes.

---

# March 24, 2026: Investigation — Meta Pixel / CAPI Detection on Landing Pages

## Problem

Agent mode session `6219e856-e54a-45cb-b82f-2d14598957bc` (Your360.ai) generated a Meta Ads optimization report that flagged "No conversion tracking" as a critical blocker — the "Results" columns in Meta Ads Manager were empty, suggesting the Meta Pixel or Conversions API was not firing on lead form submissions.

## Investigation Findings

Double-checked Facebook Ads Manager directly. The **Event Match Quality score is 8.3** — pixel tracking is actually working correctly. The pixel is implemented through **PixelFlow** (a third-party pixel management tool), which is why it was not detected by our agent during the page inspection. PixelFlow loads the pixel asynchronously/indirectly, making it invisible to standard DOM-based pixel detection methods.

### Root Cause

Our agent's analysis relied on inspecting the landing page source for Meta Pixel base code (`fbq('init', ...)` or `connect.facebook.net/en_US/fbevents.js`). Since PixelFlow injects the pixel through its own loader, the standard detection approach missed it entirely, leading to a false-positive "no pixel installed" finding in the report.

### Next Steps

Enhance the Meta Ads API integration to support loading **Event Match Quality** scores directly from the Facebook Marketing API. This will allow future analyses to verify pixel health programmatically rather than relying solely on page source inspection. Key endpoints to integrate:

- `GET /{pixel-id}?fields=data_use_setting,event_match_quality` — pixel-level match quality
- `GET /{ad-account-id}/customconversions` — custom conversion event health

This will make the agent's pixel/CAPI assessments more accurate and avoid false positives when third-party pixel managers (PixelFlow, Google Tag Manager, Segment, etc.) are used.

---

# March 23, 2026: Investigation — Supporting Vendor Role in the System

## Background

Currently the system has two roles: **admin** (`isAdmin: true`) and **user** (default). We want to add a **vendor** role so external partners (e.g., agencies, consultants) can access the platform with appropriate permissions.

## Investigation

### Current Role Model

- Users table (`AW-Users`) has an `isAdmin` boolean field
- Backend `authenticateToken` middleware sets `req.user.isAdmin` from the JWT
- Admin checks are scattered across routes using `if (!req.user.isAdmin)` guards
- Frontend checks `user.isAdmin` from AuthContext to show/hide admin features

### Options Considered

1. **Add a `role` enum field** (`"admin" | "user" | "vendor"`) — cleaner long-term but requires migrating all `isAdmin` checks across backend and frontend
2. **Add `isVendor` boolean** — minimal change, mirrors `isAdmin` pattern, but doesn't scale if more roles are added
3. **Grant vendor users admin role temporarily** — zero code changes, quickest path

### Decision

For now, we grant vendor user **Harshit** the admin role for simplicity. This avoids any code changes and unblocks vendor access immediately. A proper role system can be implemented later when requirements are clearer and more vendors need distinct permissions.

### Action Taken

- Harshit's user record updated with `isAdmin: true` in the Users table

---

# March 22, 2026: Investigation — Scheduled Chat "Lead Auto-Enrichment" Not Completing

## Problem

User reported that the "Lead Auto-Enrichment" scheduled chat (scheduleId: `35b7c3eb-9cf2-4a61-b259-5b12040a302e`) was "not completing the requested ask" for three days in a row.

## Investigation Findings

The schedule was actually completing successfully — all three runs (March 20 attempt 1, March 20 attempt 2, March 21 attempt 2) had `status: "success"` and `passed: true` with all work plan steps completed.

The user's concern was that lead enrichment "didn't happen." Root cause: **enriched fields were written to custom fields** in the CRM, not the standard fields the user was checking. The enrichment was working correctly, but the results were in a different place than expected.

### Schedule Details

- **Prompt:** Enrich leads from 6 CRM lists, recommend top 10 for LinkedIn outreach, draft 2 post-connection messages
- **Model:** `anthropic.claude-opus-4-6-v1`
- **Validation:** `functionCallMinCalls: { linkedin_outreach: 1 }` — note: this requirement exists but the prompt only asks to "draft" messages, not send them. All runs passed validation regardless.
- **Runs examined:** 3 sessions, all enriching 214-221 leads with 0 failures

### Resolution

No code change needed. User confusion about where enriched data appears in the CRM (custom fields vs standard fields).

---

# March 20, 2026: Investigation — UseHaven.ai Meta Marketing Connected Account Issue

## Problem

Two issues reported by UseHaven.ai (usehaven.ai) when connecting Meta Marketing accounts:

1. **Matt (existing user):** When connecting Meta Marketing, Facebook asks him to reconnect because he previously connected with a different account.
2. **Harsha (new user):** When attempting to connect, sees an "App does not exist" error.

## Investigation Findings

### Architecture Overview

- Meta OAuth flow: `metaAuth.ts` handles init → Facebook Login popup → callback → finalize (token exchange) → connect-ad-accounts
- Credentials stored in AWS Secrets Manager at `prod/AgentWeb/MetaApp` (contains `clientId`, `clientSecret`, `instagramClientId`, `instagramClientSecret`)
- Connected accounts stored in DynamoDB `AW-Users` table under `connected_accounts` array
- Token sessions stored in-memory with 10-minute TTL

### Root Cause: App in Development Mode

The "App does not exist" error for Harsha is caused by the **Meta/Facebook App being in Development Mode**. In Development Mode, only users listed as App Admins, Developers, or Testers in the Facebook App settings can use the OAuth flow. All other users see "App does not exist."

Matt could connect because he was likely added as a tester/developer on the app. The "reconnect" prompt is standard Facebook behavior when a user re-authorizes an app — Facebook remembers the prior authorization and asks to confirm.

### Actions Taken

1. **Made the app Live** — switched from Development to Live mode in Meta Developer Console
2. **Completed Data Use Checkup** — required for Live mode compliance
3. **Harshit submitted for App Review** — required for advanced permissions (ads_management, ads_read, pages_show_list)

### Key Files

- `backend/src/routes/metaAuth.ts` — OAuth init, callback, finalize, connect endpoints
- `backend/src/routes/metaV2.ts` — Ad creation API using connected account tokens
- `backend/src/config/integrations.ts` — OAuth URLs, scopes, redirect URIs
- `backend/src/utils/secretsManager.ts` — `getMetaCredentials()` and `getInstagramCredentials()`
- `backend/src/services/connectedAccountsDb.ts` — Account storage (createAccount, updateAccountTokens)
- `customer-portal/src/pages/MetaOAuthCallback.tsx` — Frontend OAuth callback handler
- `customer-portal/src/pages/Settings.tsx` — `startMetaOAuth()` initiates the flow

### Status

Pending App Review approval from Meta. Will revisit once review is complete. After approval, all users should be able to connect Meta Marketing accounts without the "app does not exist" error.

---

# March 20, 2026: Proposal — Token Limits Per Subscription Tier

## Context

We have four subscription tiers (Free, Starter, Pro, Enterprise) but no token usage limits. All tiers currently allow unlimited Agent Mode token consumption. With $0 in cloud credits (AWS, Google Cloud, Azure), every token is a direct cost. We need per-tier limits that:
- **Free:** Let users see enough value to convert, but cap usage to incentivize upgrades
- **Starter/Pro:** Be generous enough to retain paying users while maintaining healthy margins
- **Enterprise:** Unlimited or custom-negotiated

## Current State

- Token usage is tracked **per message** in `ChatSession.messages[].usage` (prompt_tokens, completion_tokens, total_tokens, estimated_cost)
- No aggregate monthly tracking per user exists
- No enforcement or limits exist — all tiers have unlimited consumption
- Internal tiers: Free, Basic (Starter), Super Premium (Pro). Enterprise not yet in code.

## LLM Cost Reference (per 1M tokens)

| Model | Input | Output | Blended* | Provider |
|-------|------:|-------:|---------:|----------|
| Claude Sonnet 4.5/4.6 | $3 | $15 | $10.20 | AWS Bedrock |
| Claude Opus 4.6 | $15 | $75 | $51.00 | AWS Bedrock |
| GPT-5 | $2.50 | $10 | $7.00 | Azure |
| GPT-5.2 | $3 | $12 | $8.40 | Azure |
| Gemini 3 Pro | $1.25 | $10 | $6.50 | Google |
| Gemini 3 Flash | $0.15 | $0.60 | $0.42 | Google |
| Gemini 3.1 Flash Lite | $0.075 | $0.30 | $0.21 | Google |

*Blended = weighted avg assuming ~40% input, ~60% output tokens (typical agent conversations)*

Default model: GPT-5 (`gpt-5-chat-2`), blended cost ~$7/1M tokens.

## Typical Session Token Usage

| Session Type | Tokens/Session | Examples |
|-------------|---------------:|---------|
| Simple Q&A | 30K–50K | Quick marketing question, 2-3 turns |
| Content creation | 80K–150K | Blog post, social posts, with revisions |
| Research/analysis | 100K–200K | Market analysis, competitor research |
| Complex workflow | 200K–500K | Multi-step task with tool calls |
| Scheduled chat | 50K–150K | Automated recurring tasks |

**Median session: ~100K tokens**

## Proposed Token Limits

| Tier | Price | Monthly Token Limit | ~Sessions/Month | Our Blended Cost (GPT-5) | Gross Margin |
|------|------:|--------------------:|----------------:|-------------------------:|-------------:|
| **Free** | $0 | **1M** | ~10–15 | ~$7 | -$7 (acquisition cost) |
| **Starter** | $199 | **15M** | ~100–150 | ~$105 | ~$94 (47%) |
| **Pro** | $499 | **50M** | ~300–500 | ~$350 | ~$149 (30%) |
| **Enterprise** | Custom | **Unlimited** | Unlimited | Negotiated | Negotiated |

### Free Tier Rationale ($0/mo → 1M tokens)
- Enough for ~10–15 meaningful sessions (blog post, social content, brand strategy)
- Users see value within first few days but hit the wall within the first week of active use
- At ~$7/user/month cost, even a 5% conversion rate to Starter ($199) is profitable after ~3–5 free users per paid conversion

### Starter Tier Rationale ($199/mo → 15M tokens)
- ~5–7 sessions/day on weekdays — comfortable for SMB marketing teams
- 47% gross margin at GPT-5 blended rates; 23% margin if users primarily use Sonnet
- Power users may hit the limit in week 3–4, creating natural upsell to Pro

### Pro Tier Rationale ($499/mo → 50M tokens)
- ~15–20 sessions/day — heavy automation, scheduled chats, multi-step workflows
- 30% margin at GPT-5; margin is thin/negative if users predominantly use Opus
- Rarely hit limit unless running Opus-heavy workloads

### Enterprise Rationale (Custom → Unlimited)
- Custom pricing presumably $1,000+/mo
- Internal soft alert at 100M tokens/month for monitoring
- SLA-backed with negotiated terms

## Model Cost Multiplier (Recommended)

To protect margins across tiers, apply a multiplier so expensive models consume more of the budget:

| Model Tier | Multiplier | Rationale |
|-----------|----------:|-----------|
| Gemini Flash / Flash Lite | 0.1x | 10–50x cheaper than baseline |
| GPT-5 / Gemini Pro | 1x (baseline) | ~$7/1M blended |
| GPT-5.2 | 1.2x | Slightly more expensive |
| Claude Sonnet 4.5/4.6 | 1.5x | ~50% more expensive than GPT-5 |
| Claude Opus 4.6 | 7x | ~7x more expensive than GPT-5 |

Example: A 50K-token Opus session counts as 350K "weighted tokens" toward the monthly limit.

**Alternative (simpler):** No multiplier, but restrict model availability per tier:
- Free/Starter: GPT-5, Gemini models, Claude Sonnet only
- Pro: All models including Opus
- Enterprise: All models

## Overage Behavior (Recommended)

1. **Warning at 80%** — In-app banner: "You've used 80% of your monthly token budget"
2. **Soft block at 100%** — New sessions blocked, but current in-progress session allowed to finish
3. **Grace period** — Allow up to 5% overage to avoid mid-session cutoffs
4. **Reset** — Monthly, aligned to Stripe billing period (`current_period_end`)

## Implementation Plan

### Phase 1: Tracking Infrastructure
1. Add `tokenUsage` fields to `AW-Users` table:
   - `tokenUsage.currentMonth.year`, `tokenUsage.currentMonth.month`
   - `tokenUsage.currentMonth.totalTokensUsed` (weighted)
   - `tokenUsage.currentMonth.rawTokensUsed` (unweighted)
   - `tokenUsage.currentMonth.estimatedCostUSD`
   - `tokenUsage.currentMonth.resetDate` (ISO)
2. Update `agentModeService.ts` to increment user token usage after each LLM call
3. Add monthly reset logic (check on each request if month has rolled over)

### Phase 2: Limit Enforcement
4. Add `monthlyTokenLimit` to tier configs in `AW-Settings` → `subscription_types`
5. Add pre-check in Agent Mode: reject new sessions if user is at/over limit
6. Add 80% warning emission via Socket.IO
7. Allow in-progress sessions to complete (grace overage up to 5%)

### Phase 3: User-Facing
8. Add token usage display to customer portal Settings page
9. Add usage bar/indicator in Agent Mode sidebar
10. Add upgrade prompts when approaching/hitting limits

### Files to Modify
- `backend/src/services/agentModeService.ts` — token tracking, limit checks, model multiplier
- `backend/src/services/chatbotService.ts` — add `tokenUsage` to User interface
- `backend/src/services/db.ts` — add `updateUserTokenUsage()`, `getUserTokenUsage()`
- `backend/src/services/subscriptionService.ts` — add `monthlyTokenLimit` to tier configs
- `backend/src/controllers/agentModeController.ts` — pre-session limit check
- `customer-portal/src/pages/Settings.tsx` — usage display
- `customer-portal/src/components/AgentMode/` — usage bar, warning banner

---

# March 20, 2026: Investigation — AgentWeb.pro Lead Gen Path Broken

## Context

The lead generation process from AgentWeb.pro (our Webflow landing site) was broken for weeks without detection. Investigated the full lead capture flow using browser testing to identify all issues.

## Critical Finding: Nav Menu "Get Started" Links to Job Application Form

The hamburger menu's **"Get Started"** button links to a **job application form** on Surface:
- **Menu CTA URL:** `https://forms.withsurface.com/s/cmhlafdiv0001js0bfy1qaxhh` → "AgentWeb Job Application" (asks about work authorization, what you've built, etc.)
- **Correct URL (used by hero + bottom CTAs):** `https://forms.withsurface.com/s/cmdzs6o9i007rky04xg1157yk` → "Train Emma" lead capture form (asks for work email, name, company, phone)

**Impact:** On mobile, the hamburger menu is the primary navigation. Any visitor clicking "Get Started" from the nav menu was sent to a hiring form instead of becoming a lead. They likely bounced immediately. This silently killed lead conversion with no visible error.

## Other Issues Found

### Cloudflare Turnstile Error (600010)
- Console repeatedly logs `[Cloudflare Turnstile] Error: 600010` and `Failed to load resource` errors on all pages
- Turnstile is the bot-protection widget likely guarding the newsletter signup form
- The `failure_retry` path also fails, so it doesn't recover
- May allow spam submissions or block legitimate users in certain browsers

### No Lead Capture CTA on Content Pages
- `/case-studies` page lists 5 case studies but has no "Get Started" CTA in main content
- Same for `/blog` pages — only the footer newsletter form is available
- Visitors reading about results (e.g., "417 demo requests", "328 add to carts") have no obvious path to the lead form

### /build Page Skips Lead Capture
- "Start Free Trial" goes directly to Stripe checkout ($199/mo after 7-day trial)
- No email capture before the paywall — visitors who aren't ready to pay leave with zero data captured

### rankai.ai External Script
- Every page loads `https://rankai.ai/apply.js` which rewrites alt text, anchor titles, Open Graph meta tags, and injects schema markup after page load
- This external dependency modifies the DOM — worth verifying it's not interfering with lead capture elements or causing the Turnstile issue

## Lead Capture Paths Summary

| Location | CTA Text | Destination | Status |
|---|---|---|---|
| Homepage hero | "Get Started" | Surface lead form | OK |
| Homepage bottom | "Get Started" | Surface lead form | OK |
| **Nav menu** | **"Get Started"** | **Surface JOB APPLICATION** | **BROKEN** |
| /build hero | "Start Free Trial" | Stripe checkout | OK (no lead capture) |
| Footer (all pages) | Newsletter "Submit" | Webflow newsletter | OK (with Turnstile errors) |
| Nav menu | "Log In" | app.agentweb.pro/login | OK |
| Nav menu | "Contact" | mailto:founders@agentweb.pro | OK |

## Fix Required

These fixes must be made in the **Webflow editor** (not in this codebase):
1. **P0:** Fix nav menu "Get Started" link to point to `cmdzs6o9i007rky04xg1157yk` (the lead form, not the job application)
2. **P1:** Investigate and fix Cloudflare Turnstile error 600010
3. **P2:** Add "Get Started" CTAs to case studies and blog pages
4. **P3:** Update copyright year from 2025 to 2026

---

# March 19, 2026: Investigation — X/Twitter Outreach via Unipile

## Context

Investigated adding X/Twitter outreach support via Unipile, mirroring our existing LinkedIn outreach integration. Unipile's SDK includes `TWITTER` as a supported provider (`AvailableAccountProvider` union), and the hosted auth link API accepts `providers: ['TWITTER']`.

## Findings

### Unipile SDK Support

- The `unipile-node-sdk` package lists `TWITTER` as a valid provider alongside `LINKEDIN`, `WHATSAPP`, `INSTAGRAM`, `MESSENGER`, `TELEGRAM`, `MAIL`, `GOOGLE`, `OUTLOOK`, and `IMAP`.
- Account creation types (`accounts-create.types.d.ts`) include Twitter-specific schemas.
- The messaging API (`messaging.startNewChat`, `messaging.sendMessage`) is provider-agnostic and would work for Twitter DMs.
- The users API (`users.sendInvitation`, `users.getAllRelations`) maps to follow/following on Twitter.

### Implementation Plan (Designed but Not Built)

The plan was to mirror the LinkedIn outreach pattern:
- New platform type `'unipile_twitter'` in `connectedAccountsDb.ts`
- New service `xTwitterOutreachService.ts` reusing the shared Unipile client
- New auth route `xTwitterOutreachAuth.ts` with `providers: ['TWITTER']`
- New emma tool `x_twitter_outreach` with actions: `send-dm`, `get-profile`, `follow`, `search-users`, `list-following`, `get-posts`
- Frontend: callback page, Settings platform card, ConnectedAccountsList section

### Blocker: Unipile Twitter Support Suspended

Per Unipile's website and support team (March 2026): **Twitter/X integration is no longer actively maintained.** Their support indicated it may return in a few months. The SDK types still include `TWITTER` but the backend service may reject connections.

### Unipile Actively Maintained Integrations (as of March 2026)

Per Unipile support, the following providers are currently actively maintained:
- **Emails** (MAIL, GOOGLE, OUTLOOK, IMAP)
- **WhatsApp**
- **LinkedIn**
- **Telegram**
- **Instagram**

Twitter/X and Messenger are not on the active list.

## Decision

Paused implementation. Will revisit when Unipile confirms Twitter support is restored. The implementation design is documented above and in `.claude/plans/whimsical-conjuring-stroustrup.md` for when we're ready to proceed.

---

# March 19, 2026: Investigation — Sessions with 0 Messages

## Context

Production data shows a high ratio of sessions with 0 messages. For example, in a 24-hour window there were ~54 sessions but only ~22 had messages. This investigation identifies the root cause.

## Findings

### Session Creation Flow

1. **Frontend** (`customer-portal/src/pages/AgentMode.tsx:2176-2253`): `createNewSession()` calls `POST /api/agent-mode/sessions` eagerly — on page load when no sessionId is in the URL, or when the user clicks "New Chat".

2. **Backend controller** (`backend/src/controllers/agentModeController.ts:1529-1568`): Creates the session record immediately with `portalType: 'agent'`.

3. **Database layer** (`backend/src/services/chatbotService.ts:455-550`): For Agent Mode sessions (`portalType === "agent"`), the system message is `null`, so the session is created with **`messages: []`** (empty array). Messages are only added later when the user actually sends a message, and they go into the separate `AW-ChatMessages` table.

### Why So Many Empty Sessions

The primary cause is **eager session creation on page load**. Every time a user navigates to `/agent-mode` (or `/agent-mode/new`), a new session is created before they type anything. Common scenarios that produce empty sessions:

- **Page refresh**: User refreshes the Agent Mode page → new session created, old one abandoned
- **Navigation bounce**: User opens Agent Mode, then navigates away without sending a message
- **Multiple tabs**: Each tab/window opening Agent Mode creates its own session
- **URL routing**: When no sessionId is in the URL, the frontend routes to `/agent-mode/new` which triggers `createNewSession()`

Additional creation points that may produce empty sessions:
- **Admin/GTM Plan** (`backend/src/routes/admin.ts:3558`): Creates sessions for GTM work items
- **GTM Plan Route** (`backend/src/routes/gtmPlan.ts:1309`): Creates sessions during GTM plan operations
- **Slack Bot** (`backend/src/routes/slack.ts:230`): Creates sessions on Slack events

### Key Data Points

- `messageCount` on the session record reflects the count of messages in the `AW-ChatMessages` table (separate from the legacy `messages` array on the session itself)
- Sessions with `messageCount = 0` never had any user or assistant messages sent
- This is not a data integrity issue — the sessions genuinely have no messages

## Recommended Fix: Lazy Session Creation

**Approach**: Don't create a session until the user sends their first message.

### Frontend Changes (`customer-portal/src/pages/AgentMode.tsx`)

1. When navigating to `/agent-mode/new`, show an empty chat UI without calling `createNewSession()`
2. On first message send, call `createNewSession()` first, then send the message
3. The "New Chat" button should reset the UI state locally without creating a backend session

### Backend Changes (minimal)

No backend changes needed — the `POST /api/agent-mode/sessions` endpoint works fine. The change is purely about **when** the frontend calls it.

### Expected Impact

This should reduce empty sessions by ~60% (the ratio seen in production). Sessions created by admin/GTM/Slack flows would still exist but are a much smaller volume.

---

# March 19, 2026: storywithai.info Blog Publishing — GoDaddy Website Builder Investigation

## Context

Customer site `storywithai.info` uses GoDaddy for CMS. Investigated whether we can support GoDaddy API or MCP for automated blog publishing.

## Site Details

- **Platform:** GoDaddy Website Builder 8.0 (Starfield Technologies)
- **Generator meta tag:** `<meta name="generator" content="Starfield Technologies; Go Daddy Website Builder 8.0.0000"/>`
- **Site ID:** `137516a9-3722-4cf9-8003-6a1c6c535872`
- **Blog URL:** `https://storywithai.info/blogs` (50 existing posts)
- **Read-only feeds:** `/blogs/f.json`, `/blogs/f.rss`, `/blogs/f.atom`
- **Content CDN:** `img1.wsimg.com/isteam/ip/{siteId}/` (images), `img1.wsimg.com/blobby/go/{siteId}/` (scripts)
- **Blog server:** DPS/2.0.0 (Digital Publishing System)

## GoDaddy API Investigation

GoDaddy offers 12 REST APIs at `developer.godaddy.com`, **none of which support CMS or blog content management**:

| API | Purpose |
|-----|---------|
| Domains | Domain registration, DNS, availability |
| Certificates | SSL certificate management |
| Abuse, Aftermarket, Agreements, ANS, Auctions, Countries, Orders, Parking, Shoppers, Subscriptions | Infrastructure/account management |

**Authentication:** API Key + Secret via `Authorization: sso-key [KEY]:[SECRET]` header. Rate limit: 60 req/min.

**Key limitation:** GoDaddy's ToS prohibits commercial use of their API behind a paywall.

## GoDaddy MCP Investigation

- **No CMS/blog MCP exists.** Only domain-related MCPs found.
- One community MCP (`Harshalkatakiya/godaddy-mcp`) — domain availability checks only, 2 GitHub stars.
- Nine auto-generated MCP wrappers — all cover registrar APIs (domains, orders, certs), not content.
- GoDaddy is not listed in the official MCP servers directory.

## Internal API Discovery

GoDaddy Website Builder uses `content.godaddy.com/api` internally:
- Responds with `"Missing X-App-Key header."` when called without auth
- CORS headers allow `GET,POST,PUT,PATCH,DELETE` — confirms write operations exist
- Required headers: `x-app-key`, `authorization`, `x-csrftoken`
- Requires GoDaddy SSO JWT token — not accessible externally
- **Undocumented, likely violates GoDaddy ToS.** No one has reverse-engineered it publicly.

## Recommendation

**Browser automation via our agent engine (Playwright)** is the most practical path:
1. Fits our existing architecture — this is what our platform does
2. Customer doesn't need to change their site
3. Log into `websites.godaddy.com`, navigate to blog editor, create/publish posts through UI
4. Fragile to GoDaddy UI changes, but no better alternative exists for this proprietary CMS

**Alternatives considered:**
- **Migrate blog to supported CMS** (Webflow/BaseHub/WordPress) — most reliable long-term, but requires customer buy-in and migration effort
- **Subdomain approach** (`blog.storywithai.info` on supported CMS) — good option since blog already exists at `/blogs`, but changes URL structure
- **Reverse-engineer internal API** — fragile, undocumented, ToS-violating, not recommended

---

# March 18, 2026: Suspicious Bot Account Signups — No Payment Gate on Registration

## Accounts Investigated

Three suspicious accounts signed up over consecutive days with gibberish Gmail addresses using the Gmail dot trick (dots in local part are ignored by Gmail, allowing unique-looking emails that deliver to one inbox):

| Email | Signed Up (UTC) | User ID |
|-------|-----------------|---------|
| `noqid.eho.b.6.4@gmail.com` | 2026-03-14 23:39 | `3f4a357e-ecb6-41c1-9ffd-40de73d27725` |
| `s.a.c.e.wo.mag.or2.8.1@gmail.com` | 2026-03-15 14:54 | `0b989e86-e5cf-4947-bb1e-46f337e23c89` |
| `l.i.j.o.ba.yug.ido.4.7@gmail.com` | 2026-03-17 21:06 | `cf9ab519-7592-424c-b75e-609283057248` |

All three accounts were deactivated (`isActive: false`).

## Behavior

All accounts followed an identical automated pattern:
- Signed up via email/password (not Google OAuth)
- Within 1–6 seconds of signup, 4 chat sessions were auto-created as the bot navigated: `dashboard` → `plan-Onboarding` → `plan/Onboarding` → `agent-mode`
- Zero user messages sent, zero tasks created, zero executions — no actual product usage
- One account also hit `forgot-password` 16s after signup
- Two accounts returned days later and visited the `settings` page

## Root Cause: Registration Endpoint Has No Payment Verification

The Stripe payment flow is entirely optional and easily bypassed:

1. **Intended flow:** User visits pricing → Stripe Checkout → redirect to `/register?session_id=cs_xxx` → email pre-filled and locked → set password → account created
2. **Actual exploit:** Bot goes directly to `POST /api/auth/register` with `{email, password}` — no `session_id` required. The backend creates the account with `roles: ["customer"]` unconditionally.

**Backend** (`POST /api/auth/register`): No Stripe session validation. Assigns `customer` role to all signups regardless of payment.

**Frontend** (`Register.tsx`): The `session_id` query param only pre-fills the email field; it's completely optional. Registration works without it.

**ProtectedRoute**: Only checks for `customer` role (which all registrants get). No subscription status or payment verification.

The only protection is a rate limiter (10 req/15min per IP), which the bots circumvented by signing up once per day.

## Future Fix (Deferred)

Options to prevent this:
1. **Require Stripe session validation** in the register endpoint — verify `session_id` with Stripe before creating the account
2. **Don't assign `customer` role at registration** — use a `pending` role and upgrade to `customer` only after Stripe webhook `checkout.session.completed`
3. **Add email verification** — require confirmation link click before activation
4. **Add CAPTCHA** (reCAPTCHA/hCaptcha/Turnstile) to the registration form

---

# March 11, 2026: LinkedIn API Limitations — Activity URNs, Post Monitoring, and Metrics Caching

## LinkedIn Activity URN vs Share URN

LinkedIn uses two different URN systems for posts:
- **Activity URNs** (`urn:li:activity:NNNNN`) — used in post URLs (e.g., `/posts/username_title-activity-NNNNN-hash`, `/feed/update/urn:li:activity:NNNNN/`)
- **Share URNs** (`urn:li:share:NNNNN`) or **ugcPost URNs** (`urn:li:ugcPost:NNNNN`) — used by LinkedIn's API internally

**Critical finding:** The numeric IDs in activity URNs are DIFFERENT from share URN numeric IDs. There is NO LinkedIn API to convert between them. LinkedIn's Posts API (`GET /rest/posts/{urn}`) only accepts share or ugcPost URNs and returns 400 for activity URNs.

## Why "Monitor Post by URL" Was Removed

We attempted to build a feature that lets users paste a LinkedIn post URL to start tracking its metrics. This was abandoned because:

1. **Most LinkedIn post URLs use activity URNs** — The `/posts/username_title-activity-NNNNN-hash` format (most common when sharing) contains an activity ID, not a share ID.
2. **LinkedIn Posts API rejects activity URNs** — `GET /rest/posts/urn:li:activity:NNNNN` returns 400 "not a valid urn type".
3. **No activity→share conversion API exists** — We tested `q=activity` finders, social metadata, and other endpoints. None return the share URN for a given activity URN.
4. **socialMetadata endpoint** (`GET /rest/socialMetadata/urn:li:activity:NNNNN`) is the only API that accepts activity URNs, but it only returns reaction counts and comment counts — no impressions, no post content, no share URN.
5. **Personal tokens get 403** on the Posts API (`UGC_FORBIDDEN`), so even for share URNs, personal posts can't be fetched directly.

**Conclusion:** Monitoring arbitrary LinkedIn posts by URL is not viable with the current LinkedIn API. Posts must be created through AgentWeb to be tracked.

## Metrics Caching Fix

When the LinkedIn API rate-limits or errors, the adapter's `getPostMetrics()` was returning all-zero metrics to the frontend. On subsequent page loads, if the cache TTL had expired, another API call would fail again, showing persistent 0s.

**Fix:** On API failure, fall back to stale cached metrics from DynamoDB instead of returning 0s. Only return 0s if no cached metrics exist at all.

## Activity URN Metrics Fallback

For posts stored with `urn:li:activity:` URNs (legacy data from the removed monitor feature), the `memberCreatorPostAnalytics` API throws "Invalid post URN format". The adapter now detects activity URNs and uses the `socialMetadata` endpoint as a fallback, providing likes and comments (but not impressions).

---

# March 8, 2026: Daily AI News - Amino Scheduled Chat Failure — Missing Tools for Basic Subscription

**User:** `sue@aminocapital.com` (Amino Capital, Basic subscription)

**Problem:** The "Daily AI News - Amino" scheduled chat failed to run because some required tools are not available under the Basic subscription. New skills were recently created (e.g., Landing Page skill for Advanced/Super Premium) that claimed tools previously available via the `__other_skills__` virtual skill. This moved those tools out of `__other_skills__`, causing Basic subscription users to lose access.

**Root cause:** The `__other_skills__` virtual skill dynamically resolves to tools NOT associated with any published skill. When new skills are published and claim tools, those tools leave `__other_skills__`. If a subscription type (e.g., Basic) relies on `__other_skills__` for tool access, users silently lose tools whenever new skills are created.

**How subscription → tools resolution works:**
1. User's `subscriptionType` → `getSubscriptionTypeConfig()` → `allowedSkills[]` (skill IDs)
2. `resolveSkillsToToolNames(skillIds)` → expands each skill ID to its `toolNames[]`
3. `__other_skills__` resolves to tools not claimed by any published skill (dynamic, shrinks as skills are added)
4. Foundation tools (18) are always available regardless of subscription
5. Scheduled chat pre-flight check (`agentModeController.ts:810-867`) validates `requiredFunctionCalls` against allowed tools, fails with error email if any are disallowed

**Action taken:** Created a new skill "Tools for Basic Subscription" via admin UI with 38 explicit tools and no system prompt. This skill is added to the Basic subscription's `allowedSkills`, ensuring Basic users have a stable set of tools regardless of how other skills change.

**Tools in "Tools for Basic Subscription" (38):**
```
create_blog_article, publish_blog_article, repair_blog_article, create_social_media_posts,
list_cms_categories, generate_image, create_image_task_from_prompt, generate_video,
list_task_templates, create_task_from_template, create_task_from_prompt, create_revision,
perform_deep_research, list_connected_account_posts, load_connected_account_metrics,
post_on_connected_account, get_post_analytics, create_knowledge_base, update_knowledge_base_file,
attach_knowledge_base_files, create_gtm_plan, read_gtm_plan, update_gtm_plan, list_gtm_plans,
add_gtm_phase, update_gtm_phase, add_gtm_work_items, update_gtm_work_item, delete_gtm_items,
get_gtm_common_items, add_gtm_common_items, send_gtm_status_report, comment_on_linkedin_post,
react_to_linkedin_post, linkedin_outreach, create_html_from_template, update_html_file,
list_html_templates
```

**Tools excluded from Basic (in other premium skills):**
- CRM/Leads (17 tools): get_leads, get_lead_details, create_lead_list, etc.
- Books (8 tools): create_book, generate_book_content, add_characters, etc.
- Email: email, send_for_review
- Meta Ads: get_meta_ads_metrics, list_meta_ads_campaigns

**Key files:**
- `backend/src/services/subscriptionService.ts` — subscription → skill → tool resolution
- `backend/src/services/skillService.ts` — skill CRUD (AW-Skills table)
- `backend/src/controllers/agentModeController.ts:810-867` — scheduled chat tool validation
- `backend/src/services/agentModeService.ts:1717` — FOUNDATION_TOOLS definition

**Lesson:** When creating new skills, always check if the tools being claimed are currently accessed by subscription tiers via `__other_skills__`. Prefer explicit tool skills per subscription tier over relying on `__other_skills__` for stable access.

---

# March 6, 2026: xcures SEO Config — GA Permission Denied

**User:** `agentwebintegration@xcures.com` (userId: `f958eb3e-4e82-4227-8aa8-634476498a62`)

**Config in DynamoDB (AW-Users):**
- `seoDomains`: `["xcures.com"]`
- `googleAnalyticsPropertyId`: `"277333489"`
- `gaFilteredDomains`: `[]`

**Findings:**
- **Google Search Console:** Working. No errors in prod logs for `sc-domain:xcures.com`.
- **Google Analytics:** `PERMISSION_DENIED` — service account does not have access to GA4 property `277333489`.

**Prod log (Mar 6):**
```
Error fetching Google Analytics metrics: Error: 7 PERMISSION_DENIED: User does not have sufficient permissions for this property.
```

**Action needed:** xcures team must grant **Viewer** access to the service account email in GA4 Admin → Property access management for property `277333489`. The same service account (from `prod/AgentWeb/Google/SearchConsole` secret) is used for both GSC and GA.

---

# March 6, 2026: MCP Server IDOR Vulnerability — userId Override in Tool Arguments

**Problem:** The Emma MCP server (`backend/src/mcp/server/mcpServerCore.ts`) allows tool callers to override the authenticated user's identity by passing a `userId` in tool call arguments. In the request handler:

```typescript
const context = {
  userId: userId || sessionContext?.agentUserId,
  // userId from tool args takes precedence over the authenticated user
};
```

Any authenticated user (with a valid API key, OAuth token, or static MCP token) can pass any `userId` and operate on another user's private data.

**Reproduction (tested on production `api.agentweb.pro`):**

1. Initialize MCP session with a valid API key:
   ```
   POST /mcp with Authorization: Bearer aw_<key>
   → Returns mcp-session-id header
   ```

2. Call `list_knowledge_base_files` with a different user's ID:
   ```json
   {"method":"tools/call","params":{"name":"list_knowledge_base_files","arguments":{"userId":"<other_user_id>"}}}
   ```

3. Result: Returns the target user's **private** knowledge bases (16 KBs, 116 files), including private persona data, LinkedIn posts, Google Drive folders, ClickUp docs, and signed GCS download URLs.

**Severity:** High — IDOR (Insecure Direct Object Reference). Affects all MCP tools that accept `userId` in arguments, potentially including leads, tasks, GTM plans, brand guidelines, connected accounts, etc.

**Root cause:** The MCP tool execution layer trusts caller-supplied `userId` over the authenticated identity (`agentUserId` from the API key). Standard REST API routes don't have this issue because `req.user` is derived from the JWT token and cannot be overridden by request parameters.

**Architecture context:** We evaluated two approaches for exposing Emma capabilities:
- **Approach A (current):** 90+ internal Emma tools exposed directly via MCP. Suffers from this IDOR issue, large tool surface area, and tight coupling to internal schemas.
- **Approach B (recommended):** Expose AgentWeb backend REST APIs as MCP tools. All requests go through JWT auth middleware where `req.user` is derived from the token, not caller parameters. Smaller tool surface (~20-30 tools), stable API contract, consistent auth model.

**Immediate fix needed:** In `mcpServerCore.ts`, stop allowing `userId` from tool arguments to override the authenticated user:
```typescript
// Before (vulnerable):
userId: userId || sessionContext?.agentUserId,

// After (fixed):
userId: sessionContext?.agentUserId,  // Always use authenticated identity
```

**Long-term fix:** Migrate to Approach B — backend API MCP wrapper with JWT-based auth for all operations.

**Production log analysis (no external attacks detected):**

Reviewed full bundle logs from production (`Agentweb-backend-env-prod-3`) for March 6, 2026. All `/mcp` requests came from only two source IPs:
- `98.46.137.148` — external user via `claude-code/2.1.69-2.1.70`. Two sessions (`b773311b`, `485aac4a`) at 02:48-02:49 UTC. Actions: `initialize` → `tools/list` only. No `tools/call` with userId override.
- `73.157.80.155` — our IP. Four sessions for testing: two via claude-code (session setup), two via curl (IDOR reproduction).

No evidence of exploitation by external users beyond our own security testing.

**Fix deployed and verified (PR #613, merged March 6):**

The fix allows `userId` override only for internal clients (`isInternal=true`, i.e. backend-to-backend via `MCP_ACCESS_TOKEN`). External clients (API keys, OAuth) always use the authenticated `agentUserId`.

Post-deploy verification on production:
1. Called `list_knowledge_base_files` with `userId: "1743956381327"` (different user) → returned the API key owner's 19 KBs / 20 files (not the target user's data).
2. Called `list_knowledge_base_files` without userId → returned identical 19 KBs / 20 files.
3. Before the fix, the same call with userId override returned the target user's 16 KBs / 116 files (including private data like "Harsha's persona", "Harsha's worst LinkedIn posts").

The userId parameter is now correctly ignored for external clients.

**Files:** `backend/src/mcp/server/mcpServerCore.ts` (tool request handler), `backend/src/mcp/server/mcpServer.ts` (session/auth management), `backend/src/__tests__/mcp.userIdOverride.test.ts` (regression tests)

**Approach B implemented (March 7, 2026):**

Migrated from Approach A (90+ internal tools exposed directly) to Approach B (REST API wrappers). The MCP server now exposes ~26 tools that call backend REST APIs via HTTP self-calls with short-lived JWTs, going through the same `authenticateToken` middleware as web UI requests. This eliminates the entire class of IDOR vulnerabilities by design.

**Why Approach A (direct internal tools) was problematic:**
1. **IDOR vulnerability** — caller-supplied `userId` in tool args overrode the authenticated identity, allowing cross-user data access.
2. **No audit trail** — direct service calls bypass the REST API layer where request logging, rate limiting, and usage tracking happen. Actions taken via MCP tools were invisible to the audit/analytics pipeline.
3. **No data recording** — REST API route handlers record metrics (response times, error rates, request counts per user) and trigger side effects (webhooks, notifications, activity feeds). Direct service calls skip all of this, creating data gaps between MCP and portal usage.
4. **Large attack surface** — 90+ tools exposed internal schemas and service methods that were never designed for external consumption.

**Key changes:**
- Replaced `tools.ts` (75 tools) and `portalTools.ts` (12 tools) with `apiTools.ts` (~30 tools). Each tool calls `mcpFetch()` which generates a short-lived JWT for the authenticated user and makes an HTTP request to `localhost` REST endpoints.
- Internal tools (`install_skills`, `list_available_skills`, `search_web`, `generate_image`, `send_email`, `save_file`) are registered with `internal: true` flag — available to Emma's agent engine internally but hidden from external MCP clients via `getToolDefinitions()` filtering.
- External agents access AI capabilities (image gen, web search, email) through Emma chat sessions (`emma_send_message`) rather than direct tool calls.
- MCP Emma sessions use the exact same skill-first flow as the customer portal — no MCP-specific behavior.
- Tool count: External MCP clients see 26 tools, Emma's internal registry has 32.

**Architecture:**
```
MCP Client → MCP Server (API key auth) → mcpFetch() → localhost REST API → authenticateToken middleware → route handler → service → DB
```

**Verification — 10 side-by-side MCP vs REST API comparison tests (all passed):**

| # | Test | MCP Result | REST Result (Portal) |
|---|------|-----------|---------------------|
| 1 | list_tasks | 18 tasks | 18 tasks |
| 2 | list_lead_lists | 3 lists | 3 lists |
| 3 | list_gtm_plans | dict (matching) | dict (matching) |
| 4 | manage_brand (read) | same company_name | same company_name |
| 5 | manage_market_strategy (read) | dict (matching) | dict (matching) |
| 6 | list_knowledge_bases | dict (matching) | dict (matching) |
| 7 | list_connected_accounts | dict (matching) | dict (matching) |
| 8 | emma_create_session | `associatedSkills=[]`, `portalType=agent` | identical |
| 9 | emma_list_sessions | 36 sessions | 36 sessions |
| 10 | list_task_executions | 1 execution | 1 execution |

**End-to-end Emma session tests via MCP (all use same skill-first flow as customer portal):**

| Test | Tool Calls | Result |
|------|-----------|--------|
| Image generation | `install_skills` (147ms) → `search_knowledge_base` (1533ms) → `generate_image` (189s) | S3 image URL returned |
| Market report | `search_web` (439ms) → `search_web` (617ms) | 1916-char report with market data |
| Blog article | `install_skills` (126ms) → `generate_blog_post` (42s) | Full blog post generated via AI pipeline |
| Short video | `install_skills` (181ms) → `list_available_skills` (78ms) | Correctly reported video gen not available (skill not published on test env) |

Bug found and fixed during testing: `generate_blog_post` tool had wrong input schema (`title_draft`/`content_draft` instead of `topic`), causing 400 errors. Fixed to match the actual REST API (`POST /api/blog/generate` expects `topic`, `keywords`, `tone`, `length`).

**Files:** `backend/src/mcp/server/apiTools.ts` (tool registrations), `backend/src/mcp/server/httpClient.ts` (JWT + fetch helper), `backend/src/mcp/server/registry.ts` (internal flag support), `backend/src/__tests__/mcp.apiTools.test.ts` (tests)

# March 5, 2026: Dev Env Launch Fails on Elastic Beanstalk

**Problem:** Notion-triggered cloud dev env launch failed with `ENOENT: no such file or directory, open '/var/app/test-env/user-data-dev-auto.sh'`. The `devEnvService.ts` reads the script via `fs.readFileSync` with a path relative to `__dirname`, but `test-env/` is at the repo root and not included in the backend deploy zip.

**Fix:** Copy `user-data-dev-auto.sh` into `dist/` during CI packaging (both `tests.yml` and `deploy.yml`), and update the path in `devEnvService.ts` from `../../../test-env/user-data-dev-auto.sh` to `../user-data-dev-auto.sh`.

**Collateral fix:** Deleted orphaned security group `sg-075b576a4253b70d4` created before the failure. Also added DynamoDB permissions to `agentweb-test-env-ec2-role` IAM policy (prod read-only, dev read-write, plus ListTables/DescribeTable).

**Files:** `backend/src/services/devEnvService.ts`, `.github/workflows/tests.yml`, `.github/workflows/deploy.yml`

**PR:** #608

# March 4, 2026: Admin Users Tab Performance Fix

**Problem:** Admin Users tab was slow — `getAllUsers()` called `getTasksByUserId()` per user, which fetched full task details AND 3 sub-queries per task (executions, schedules, subscribers). For U users with T tasks each: U × (1 + 3T) DynamoDB calls.

**Fix:** Added `taskDb.getUserTaskCount()` using `Select: "COUNT"` on the existing `UserTasksIndex` GSI. Now `getAllUsers()` makes exactly U × 1 count queries (plus workflow count + chat session count, all parallelized). Zero sub-queries.

**Impact:** For 50 users averaging 10 tasks each: **1,550 queries → 50 queries** (~97% reduction). Response time scales linearly with user count, not user × task count.

**Files:** `backend/src/services/db.ts` (new `getUserTaskCount`, updated `getAllUsers`), `backend/src/__tests__/admin.usersPerformance.test.ts`
# March 4, 2026: Speed Up Reports/Images/Videos Loading — Incremental Asset Caching

**Problem:** The Images and Reports pages took ~10.5s to load for a test user with only 36 images / 74 reports.

**Root Cause:** `getExecutionsWithAssets()` in `backend/src/routes/tasks.ts` loaded ALL agent-mode sessions with ALL their messages on every page view:
1. `getUserSessions(userId, 'agent')` loaded 208 sessions with all messages (208 DynamoDB queries)
2. For each session, `getChatSession()` redundantly reloaded the same messages (another 208 queries)
3. This happened separately for images, videos, and html-reports — so the same data was loaded 2-3x
4. Total: ~400-600 DynamoDB queries per page load, most redundant

**Solution:** Rui's incremental asset caching approach — store discovered assets directly on the `AW-ChatSessions` record and only scan new messages on subsequent loads. This was the optimal solution, beating the alternatives considered (separate cache table, Redis cache, frontend pagination) by being simpler, requiring no new infrastructure, and achieving near-zero latency on warm loads.

**Implementation:**

1. **New fields on `ChatSession`:** `assetCache` (images/videos/htmlReports arrays), `assetScanIndex` (message index scanned up to), `messageCount` (total messages, atomically incremented)
2. **New methods on `ChatbotDB`:**
   - `getSessionsWithoutMessages()` — metadata-only session query (no message table reads), with DynamoDB pagination
   - `getMessagesFromIndex(sessionId, fromIndex)` — partial message loading for delta scans
   - `updateAssetCache()` — fire-and-forget cache writes to session record
3. **Refactored `getExecutionsWithAssets()`:** Single session load shared across all asset types, with 3-tier cache logic:
   - Cache up-to-date (`assetScanIndex >= messageCount`) → zero DB reads
   - Delta scan (`assetScanIndex < messageCount`) → only load new messages
   - First time (no cache) → full scan, then cache
4. **`scanMessagesForAssets()` helper:** Single-pass extraction of images, videos, and HTML reports from messages (consolidates 3 separate scanning loops)
5. **`messageCount` tracking:** Atomically incremented on `addMessageToSession`, `addMessagesToSession`, and `migrateMessagesToMessagesTable`
6. **Frontend:** Added `loading="lazy"` to image grid in `customer-portal/src/pages/Images.tsx`

**Bugs Fixed During Testing:**
- `getSessionsWithoutMessages()` initially lacked DynamoDB pagination — sessions beyond the 1MB page limit were silently dropped
- Cache logic for legacy sessions (no `messageCount` field) caused image count discrepancy between first/second loads
- `migrateMessagesToMessagesTable()` didn't set `messageCount`, causing cache to miss new messages added to migrated sessions

**Test Results:**

| Scenario | Before | After |
|---|---|---|
| Images page (36 images, 15 tasks) | ~10.5s | **~1.0s** (warm cache) |
| Reports page (74 reports, 34 tasks) | ~10.5s | **~1.0s** (warm cache) |

Consistency verified: all loads return identical counts (36 images / 15 tasks, 74 reports / 34 tasks).

**Tests Added:**
- `chatbotService.assetCache.test.ts` — 10 tests covering getSessionsWithoutMessages, getMessagesFromIndex, updateAssetCache, incrementMessageCount
- `scanMessagesForAssets.test.ts` — 12 tests covering image/video/HTML extraction, deduplication, timestamps, uploads, default filenames
- Updated existing test files to use new mock patterns (agentModeMessageLoading, videoFavorites, imageFeedback, messagesTable)

**Files Modified:**
- `backend/src/services/chatbotService.ts` — ChatSession interface, 4 new methods, messageCount tracking in migration
- `backend/src/routes/tasks.ts` — Refactored getExecutionsWithAssets, new scanMessagesForAssets helper, addCachedAssetsToResult helpers
- `customer-portal/src/pages/Images.tsx` — loading="lazy" on img tags

---

# March 3, 2026: AWS Bedrock Cost Investigation ($7.7k in February)

**Problem:** February AWS bill was $7,742.75, majority from Claude Opus 4.6 and Sonnet 4.6 on Bedrock.

**Root Cause:** Chat sessions (agent mode) are the primary cost driver — not task executions.

**February Bedrock Usage (Chat Sessions):**
- **Claude Sonnet 4.6:** 224 sessions — top user: `juan@usehaven.ai` (232 sessions, 9,046 function calls)
- **Claude Opus 4.6:** 139 sessions — top user: `childrenstorywithai@gmail.com` (40 sessions, 504 fn calls), plus anon users and `agentweb@xcures.com`
- Task executions used almost zero Bedrock (10 calls total, all Claude 3.5 Sonnet v2)

**Other LLM usage (not on AWS bill):** GPT-5.2 (320 sessions), GPT-5 (157), Gemini-3-pro (292) — these are Azure/Google costs.

**Monitoring Enabled:** Bedrock Model Invocation Logging → `s3://agentweb-bedrock-logs/invocation-logs/` (enabled 2026-03-03). This logs caller identity, model, and token counts per request.

**Cost Reduction Options:**
1. Default anon/demo users to Sonnet instead of Opus (5x cheaper per token)
2. Cap function calls per session to prevent runaway usage
3. Track per-user token usage in DynamoDB for billing visibility
4. Consider session-level token budgets

**Querying Cost Data:**
- AWS Cost Explorer only works from the parent/management account (not member account 992382574572)
- The `facetoon_image_user` IAM user now has `ce:GetCostAndUsage` permission but can only see the member account's own costs (~$0.12/month)
- For per-user breakdown, query `AW-ChatSessions` table: filter by date, group by `userId` + `llmModel`, count `calledFunctions`

---

# February 28, 2026: Notion MCP Integration for Sprint Task Management

**Purpose:** Enable Claude Code to pull dev items directly from the Notion "Sprint Tasks - Argusoft" database via MCP.

**Setup:**

1. **Create a Notion internal integration** at https://www.notion.so/profile/integrations
   - Choose **"Internal integration"** (not public/OAuth)
   - Copy the **Internal Integration Secret** (starts with `ntn_`)
   - No webhooks or redirect URIs needed

2. **Connect the integration to your Notion pages:**
   - Open the "Sprint Tasks - Argusoft" database in Notion
   - Click "..." menu (top right) → **Connections** → **Connect to** → select the integration
   - Repeat for any other pages/databases you want accessible

3. **Configure `.mcp.json`** in the repo root (already gitignored):
   ```json
   {
     "mcpServers": {
       "notion": {
         "type": "stdio",
         "command": "npx",
         "args": ["-y", "@notionhq/notion-mcp-server"],
         "env": {
           "OPENAPI_MCP_HEADERS": "{\"Authorization\":\"Bearer <YOUR_NOTION_TOKEN>\",\"Notion-Version\":\"2025-09-03\"}"
         }
       }
     }
   }
   ```

4. **Restart Claude Code** to load the new MCP server

**How it works:**
- The Notion MCP server exposes tools for searching, reading, and querying Notion databases
- Claude Code calls these tools on demand (pull-based, no webhooks)
- `.mcp.json` is gitignored since it contains the API token

**Important: Database ID vs Data Source ID:**
- The Notion API has two ID types: `database_id` and `data_source_id`
- Use `mcp__notion__API-post-search` with `"filter": {"property": "object", "value": "data_source"}` to find the database
- For `mcp__notion__API-query-data-source`, use the **data_source_id** (found in relation properties), NOT the database_id
- Sprint Tasks database ID: `2bf09247-c951-8122-a327-ee39ef7a6ec7`
- Sprint Tasks data source ID: `2bf09247-c951-812a-bd0a-000bd4c05bbf` (use this for queries)

**Troubleshooting:**
- If Notion tools aren't available after restart, check `npx @notionhq/notion-mcp-server` runs without errors
- If queries return empty results, verify the integration is connected to the target page/database in Notion
- Token rotation: update the `ntn_` token in `.mcp.json` and restart Claude Code

---

# February 27, 2026: Agent Mode LLM Performance — Opus vs Sonnet Timing Investigation

**Problem:** A customer session (`5b1c1270-57b8-4de0-95c7-a787115b965e`) on `anthropic.claude-opus-4-6-v1` took ~49 minutes (29 min system time). No per-turn timing instrumentation existed to diagnose which LLM turns were slow.

**Investigation:**

Added per-turn timing instrumentation to `agentModeService.ts`:
1. **`callLLM()` timing** — logs model name, duration, token count after every LLM API call
2. **Iteration summary** — logs iteration number, model, tool names, sessionId per agent loop turn
3. **Tool execution timing** — logs tool name, duration, sessionId per tool call

Log format examples:
```
AgentMode: LLM call completed [model=anthropic.claude-opus-4-6-v1, duration=2883ms, tokens=N/A]
AgentMode: Iteration 1 [model=anthropic.claude-opus-4-6-v1, tools=search_web, sessionId=abc123]
AgentMode: Tool executed [name=search_web, duration=549ms, sessionId=abc123]
```

**Benchmark — same prompt ("What are the top 3 B2B lead generation strategies for SaaS companies?"):**

| Metric | Opus (`claude-opus-4-6-v1`) | Sonnet (`claude-sonnet-4-6`) |
|---|---|---|
| LLM call 1 | 2,883ms | 1,829ms |
| LLM call 2 | 2,808ms | 9,800ms (final) |
| LLM call 3 (final) | 19,656ms | — |
| Iterations | 3 | 2 |
| Tools used | search_web, read_page_source ×2 | install_skills |
| **Total wall clock** | **~28.3s** | **~11.8s** |

**Finding:** Opus is ~2.4x slower than Sonnet. The biggest bottleneck is the final response generation (19.6s vs 9.8s for Sonnet). Opus also uses more tools (3 iterations vs 2), compounding latency from extra LLM calls + tool execution.

**Performance improvement — parallel tool execution:** Tools within a single iteration were executed sequentially. When the LLM returns multiple tool_calls in one response, they are independent and can run concurrently. Changed the tool execution loop from sequential `for...await` to `Promise.all()` for parallel execution.

**Before/after comparison (Opus, Iteration 2 with 2× `read_page_source`):**

| | Before (sequential) | After (parallel) |
|---|---|---|
| read_page_source #1 | 1,208ms | 80ms |
| read_page_source #2 | 1,216ms | 1,291ms |
| **Tool phase wall clock** | **2,424ms** (sum) | **~1,291ms** (max) |

The parallel version runs both tools concurrently, so wall clock = max(individual durations) instead of sum. Savings grow with more concurrent tools and longer-running tools. In a full work plan session with dozens of multi-tool iterations, this compounds significantly.

**Full Opus session comparison (same prompt, same model):**

| Metric | Before (`abd13579`) | After (`240300f7`) |
|---|---|---|
| LLM call 1 | 2,883ms | 2,933ms |
| LLM call 2 | 2,808ms | 2,875ms |
| LLM call 3 (final) | 19,656ms | 19,177ms |
| Tool: search_web | 549ms | 347ms |
| Tool: read_page_source ×2 | 1,208 + 1,216ms (seq) | 80 + 1,291ms (parallel) |
| **Tool phase Iter 2** | **~2,424ms** | **~1,291ms** |

LLM call durations are consistent (network/model variability). The tool execution phase in Iteration 2 dropped from ~2.4s to ~1.3s — a **~47% reduction** in that phase.

**Heavy-context benchmark — production session `5b1c1270` (97 messages, "Facebook Marketing Strategy"):**

Same follow-up prompt ("Summarize the key findings from this session and give me 3 actionable next steps") sent to both models on the same session context:

| Model | LLM Call Duration | Tools | Relative |
|---|---|---|---|
| Opus | 29,855ms | none | 1.24x slower |
| Sonnet | 24,047ms | none | baseline |

On a heavy-context session, Opus is ~24% slower per LLM call — a smaller gap than the 2.4x on lightweight prompts because input processing (not generation) dominates. Across a full work plan with 20-30 iterations, this ~6s/call overhead compounds to minutes of extra wall time. Combined with Opus's tendency to use more tools per turn (3 iterations vs 2 in the lightweight test), total session time difference can be 2x+.

**Files changed:**
- `backend/src/services/agentModeService.ts` — timing logs + parallel tool execution
- `backend/src/__tests__/agentModeService.llmTiming.test.ts` — 10 tests (timing instrumentation + parallel execution)

---

# April 5, 2026: Do Parallel Tool Calls Consume More Tokens?

**Question:** When the LLM returns multiple tool calls in a single response (parallel), does that consume more tokens compared to making them one at a time (sequential)?

**Context:** Investigated a production session (`ce0f5737`) — "Daily Slack Check — All Channels". The agent made 1 `slack_list_channels` call followed by **65 `slack_get_recent_messages` calls** that all appeared grouped after Emma's final response in the share UI. This raised the question of whether those parallel calls came from the same LLM response and how they compare to sequential calls in terms of token cost.

**How parallel tool calls work in our backend:**

When a Gemini/Claude/GPT model returns a response with multiple `tool_calls` in one API response (e.g., 30 channel fetch requests at once), `agentModeService.ts` collects all of them in a single iteration and executes them concurrently via `Promise.all()` (see `agentModeService.ts:1502–1571`). This means **all N tool calls come from the same LLM API response** — the model generated all N tool-call JSON blocks in one shot.

**Token breakdown — parallel vs sequential for N tools:**

| | Parallel (what we do) | Sequential (hypothetical) |
|---|---|---|
| LLM API calls | 1 call returns all N requests | N calls, one per tool |
| Input tokens | Sent **once** | Resent + grows each round |
| Output tokens | More per call (N tool JSONs in one response) | Less per call, but N× calls |
| **Total tokens** | **Much lower** | **Much higher** (context accumulates N×) |

**Concrete example (the investigated session):**

The session made 30 `slack_get_recent_messages` calls in parallel from a single LLM response. Compared to doing them one at a time:

- **Parallel (actual):** 1 LLM call × (context + 30 tool-call outputs) + 1 final synthesis call
- **Sequential (hypothetical):** 30 LLM calls where each input = prior context + all prior tool results accumulated

For 30 channels, the sequential approach would have sent the full conversation context ~30 extra times, each iteration slightly larger. Parallel avoids that entirely — the context is sent once and the model generates all 30 requests in a single output.

**Answer:** Yes, the single LLM response that generates N parallel tool calls has **more output tokens** than a response with 1 tool call (it has to emit N tool-call JSON blocks). But the **total token cost across the conversation is dramatically lower** than sequential, because you avoid resending the full growing context N times. For the 30-channel session, parallel saved roughly 29× the input token cost of the mid-conversation context window.

**The 65 tool calls came from 2 LLM responses:**
1. First response: `slack_list_channels` → 1 tool call
2. Second response: all 30 `slack_get_recent_messages` at once → 30+ tool calls in parallel
3. Final response: synthesis/summary (no tool calls)

The share UI groups all tool calls after the final assistant message, which made it look like they all came from one response — they didn't. The sequential `slack_list_channels` was its own round trip.

---

# February 26, 2026: Instagram Business Login — "Unsupported request" in Production

**Symptom:** Connecting an Instagram Business account via Connected Accounts failed in production with `IGApiException` code 100: `"Unsupported request - method type: get"`. Both `getLongLivedToken` (`graph.instagram.com/.../access_token`) and `getInstagramBusinessMe` (`graph.instagram.com/.../me`) returned the same error. The initial OAuth token exchange (POST to `api.instagram.com/oauth/access_token`) succeeded.

**Investigation:**
- Confirmed `graph.instagram.com/v24.0/me` and `graph.instagram.com/v23.0/me` are valid endpoints (curl with invalid token returns code 190, not code 100).
- The code 100 "Unsupported request" error is not a version issue — it's specific to the access token being returned by the OAuth flow.
- Decoupled `META_INSTAGRAM_API_VERSION` from `META_API_VERSION` (PR #565) — did not fix the issue.

**Root cause:** The Facebook Developer App must have Instagram Business Login permissions approved through **App Review** for production use. Without approval, the OAuth flow still completes and returns a token, but that token cannot be used with `graph.instagram.com` API endpoints — all GET requests fail with code 100.

For **development/testing only**, adding the Instagram Business account in the "Generate access tokens" section under API Setup with Instagram Login allows the token to work without App Review. This is limited to accounts explicitly added in that section.

**Fix:**
- **Development/Testing:** In the Facebook Developer portal → your app → Instagram → API Setup with Instagram Login → "Generate access tokens" section: add the Instagram Business account. This grants test access for that specific account.
- **Production:** Submit the app for App Review with the required Instagram Business Login permissions (`instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_comments`, `instagram_business_manage_insights`). Once approved, any Instagram Business account can connect without being manually added.

**Key takeaway:** This is an app-level configuration, not a code issue. The OAuth flow succeeds without proper permissions setup, but the returned token is non-functional for API calls — making the error misleading.

---

# February 25, 2026: Long-Running Test Env & IP Allowlist Fix

- Added `--no-watchdog` flag to `./test-env/test-env.sh launch` to skip the 24-hour auto-shutdown cron. Use for long-running test environments that you teardown manually.
- Fixed bug where the test-env-access UI showed the developer's IP as "not accessible" on launch. The launch script added the IP to the AWS security group but not to `allowlist.json`. Now seeds the allowlist at launch.

---

# February 24, 2026: Growth Estimate — Month-over-Month Comparison

Ran `node src/scripts/growth-comparison.js 2026-02-24` to compare 3 rolling 30-day periods.

| Metric | Jan 25 - Feb 24 | Dec 25 - Jan 24 | Nov 25 - Dec 24 |
|---|--:|--:|--:|
| Agent Mode Sessions | 1,033 (+130, +14%) | 903 (+143, +19%) | 760 |
| Generated Articles | 989 (+485, +96%) | 504 (+264, +110%) | 240 |
| Approved Articles | 15 (+9, +150%) | 6 (+6, new) | 0 |
| Published Articles | 62 (+53, +589%) | 9 (+9, new) | 0 |
| Generated Posts | 298 (+37, +14%) | 261 (+198, +314%) | 63 |
| Approved Posts | 7 (-2, -22%) | 9 (+9, new) | 0 |
| Published Posts | 27 (+16, +145%) | 11 (+11, new) | 0 |
| Generated Images | 345 (+5, +1%) | 340 (+182, +115%) | 158 |
| Approved Images | 10 (-14, -58%) | 24 (+24, new) | 0 |

**Data sources:**
- Sessions & tool call counts: `AW-ChatSessions` (`calledFunctions` on each session, bucketed by session `createdAt`)
- Approved articles/posts/images: `AW-AssetApprovals` (status=`approved`, bucketed by `updatedAt`)
- Article = `blog-*` filename; Post = `social-media-post*`, `linkedin-post*`, `x_thread*`, `twitter-thread*` filenames; Image = `assetType=image`

**Script:** `backend/src/scripts/growth-comparison.js` — accepts an optional end date argument (defaults to today). Run from the `backend/` directory.

---

# February 24, 2026: SEO/GEO Engagement Time Is Total, Not Average

The "Top Pages by Engagement" table on the SEO/GEO page displays **total** engagement time, not average. The backend (`seo.ts`) requests GA4's `userEngagementDuration` metric, which is cumulative across all sessions. The frontend (`SEO.tsx`) renders it directly via `formatTime()` with no averaging. For product metrics, the backend separately computes `avgDuration` by dividing `totalDuration` by `pageViews`, but this is not used in the top pages table.

---

# February 24, 2026: `create_html_from_template` JSON Failure + Reports Model Admin Bug

## Problem 1 — Amino Daily News Template Failure

Production session `8400bace-...` (Daily AI News - Amino) using `gemini-3.1-pro-preview` failed 25 times on `create_html_from_template` with "LLM returned invalid JSON for variable substitution".

### Root Cause

Three issues combined:

1. **`tools.ts:1175` used `args.llmModel` but `llmModel` is in `context`, not `args`** — the model passed to `createHtmlFromTemplate` was undefined/wrong.
2. **Gemini doesn't reliably honor `response_format: { type: 'json_object' }`** — it returns JSON wrapped in markdown code blocks (`` ```json ... ``` ``), causing `JSON.parse()` to fail.
3. **No `max_completion_tokens` was set** — risking output truncation on large templates.

### Fix

- Changed `args.llmModel` → `context?.llmModel` in `tools.ts:1175`
- Added JSON code-block stripping fallback: first tries `JSON.parse`, then strips `` ```json ``` `` wrappers and retries, with raw response logging on failure
- Added `max_completion_tokens: 16384` to the `callLLM` call (matching `createHtmlFile` and `createHtmlTemplate`)

## Problem 2 — Reports Model Dropdown Shows All Models

The Reports Model dropdown in the admin page's Agent Mode tab showed all 8 agent mode models (GPT, Gemini, Claude) when it should only show models suitable for report generation.

### Root Cause

The `<Select>` at `AdminDashboard.tsx:7199` used `supportedModels` (from `/api/agent-mode/public/llm-models`) which returns all models in `llmModels`. This was always the case since commit `e324fb8f` (Jan 13), but became worse as models were added:
- Jan 13: 4 models → Feb 20: 8 models (every new model automatically appeared)

### Fix

- Added `getReportsModelOptions()` to `agentModeService.ts` — filters `llmModels` to `anthropic.*` keys only
- Added `GET /api/agent-mode/public/reports-model-options` endpoint
- Updated `AdminDashboard.tsx` to load and use the filtered list for the Reports Model dropdown (with fallback to `supportedModels` if endpoint fails)

---

# February 23, 2026: Updated User Guide — ClickUp & Google Drive Documentation

Added sections to the user-facing guide (Notion) documenting the ClickUp Knowledge Base integration and Google Drive Shared Folders integration. Covers setup instructions, agent capabilities, supported file types, and security.

---

# February 23, 2026: Enabled Branch Protection on Main

Neither `AgentWebPro/agentweb` nor `AgentWebPro/agentweb-customer-portal` had branch protection on `main`. Enabled protection on both repos via GitHub API with: strict status checks, force pushes blocked, branch deletion blocked, and enforce admins enabled. Required PR reviews was initially set to 1 but later removed.

**Verification:** After each change, read back the protection settings via `gh api repos/{owner}/{repo}/branches/main/protection` and confirmed `protected: true`, correct rule values, and `enforce_admins.enabled: true`. Also confirmed `required_pull_request_reviews` was absent from the response after removing the review requirement.

---

# February 21, 2026: Agent Mode — Dropped Assistant Messages (Aaron's Session)

## Problem
Production session `ec70e7f2-d42b-46df-a390-86c79879cfd5` (user Aaron, Claude Opus 4.6) failed with 400 errors after ~37 messages. All LLM models returned Bad Request.

## Root Cause
The assistant message between DB indices 22 (user "yes.") and 23 (tool result) was missing, creating an invalid user→tool sequence. Two orphaned `tool_call_id`s (`tooluse_s5lgU4Vkm2yK65qRQiodQ2` for `update_brand_guidelines`, `tooluse_ufMCSFsi6MNxI7pZByZr1T` for `update_market_strategy`) had no matching assistant message.

**Bug 1 — Stale `initialMessageCount`:** `generateMarketingResponse` captures `initialMessageCount = messages.length` once, then uses `messages.slice(initialMessageCount)` at the end to extract response messages. When `install_skills` fires mid-response, `updateConversationContext` splices context messages at the front of the array (net ±1 length change), but `initialMessageCount` was never adjusted. A net -1 (e.g., Available Skills removed, not re-added) causes the slice to skip the first assistant message.

**Bug 2 — Silent batchWrite drops:** `addMessagesToMessagesTable` ignored `UnprocessedItems` from DynamoDB `batchWrite`, silently losing throttled writes.

## Fix (PR #540)
1. Adjust `initialMessageCount += delta` after each `updateConversationContext` call
2. Retry `UnprocessedItems` with exponential backoff (up to 3 retries)

## Production Repair
After deploying the fix, the session still crashed because the corrupted data remained. Ran `/tmp/repair-session.py` to insert a synthetic assistant message at index 23 (with the two orphaned `tool_call_id`s) and shifted all subsequent messages up by 1. Session is now functional.

## Copied Session in Dev
Session was copied to dev tables (`Dev-AW-ChatSessions`, `Dev-AW-ChatMessages`) with userId `6c2ef3ca-c9fa-432e-b510-85127a0752f4` for testing. The dev copy was NOT repaired (same corrupted data as prod pre-repair).

**TODO: Delete the copied session from dev tables.**

---

# February 18, 2026: Runaway ts-node-dev Processes Overheating Machine

Two `ts-node-dev` processes (PIDs 70909, 70910) from the `agentweb` clone were stuck at 100% CPU each for ~10 hours, consuming ~200% CPU total. They were running `server.ts` via `ts-node-dev` and had accumulated 345+ minutes of CPU time. Regular `kill` was ignored; required `kill -9` to terminate. Machine cooled down immediately after.

**Lesson:** When running `npm run dev` in multiple repo clones, check for orphaned `ts-node-dev` processes if the machine gets hot. Use `ps aux | sort -k3 -rn | head -10` to find CPU hogs quickly.

# February 18, 2026: Subdomain Landing Page Setup for Haven (usehaven.ai)

## Approach
Use a CNAME record so we manage the subdomain on Vercel while the client's primary DNS stays untouched. No Nameserver access needed.

## Steps

1. **Add subdomain in Vercel**: Project Settings > Domains > add `start.usehaven.ai`. Vercel will show "Invalid Configuration" until DNS propagates.

2. **Client DNS request** — ask their IT/DNS admin to add one record:
   - **Type:** CNAME
   - **Name (Host):** `start`
   - **Value (Points to):** `ca0c21bca6304a7a.vercel-dns-016.com.`
   - **TTL:** 3600 (or default)

3. **SSL is automatic**: once the CNAME resolves to Vercel, they auto-provision a Let's Encrypt certificate and handle renewal every 90 days. No action needed.

## Creating a Vercel Project Synced to AgentWebPro Org

1. Go to [vercel.com/new](https://vercel.com/new)
2. Under "Import Git Repository", select the **AgentWebPro** GitHub org from the dropdown
3. Find and import the target repo (e.g. `haven-landing`)
4. Configure build settings (framework preset, build command, output directory) and environment variables as needed
5. Click **Deploy**

The project will now auto-deploy on every push to the default branch. To add the custom subdomain, go to Project Settings > Domains and follow the steps above.

**Make PR preview URLs public**: Project Settings > Deployment Protection > disable Vercel Authentication.

# February 18, 2026: Google Drive Integration — MCP vs Direct API

## Investigation
Explored options for integrating Google Drive into the knowledge base:

1. **Anthropic's `@anthropic-ai/google-drive-mcp`** — archived, no longer maintained
2. **Google Workspace MCP server** ([gemini-cli-extensions/workspace](https://github.com/gemini-cli-extensions/workspace)) — found via Google's official MCP list at https://github.com/Google/mcp
   - Provides Drive, Docs, Sheets, Slides, Calendar, Gmail, and Chat access
   - Uses OAuth with a built-in client ID — authenticates as a real Google user via browser login
   - **Incompatible with service account approach**: the admin-configured "shared folders" model requires a service account that has access to specific folders shared with it. The Workspace MCP server authenticates as the end user, so scoping access to admin-designated folders doesn't work.
   - Also requires an interactive browser session on first auth, which doesn't work headlessly on the agent engine
3. **`googleapis/gcloud-mcp`** — only covers GCP infrastructure (gcloud CLI, observability, Cloud Storage buckets), not Google Drive

## Decision
Integrate with the Google Drive API directly using a service account rather than relying on an MCP server. This allows:
- Admin configures folder IDs shared with the service account → stored on the user record
- Backend reads files from those folders via the Drive API using service account credentials
- No interactive browser login needed — works headlessly on the agent engine
- Access is scoped to only the folders explicitly shared by the admin

The Google Workspace MCP server can be reconsidered in the future if per-user OAuth MCP sessions are supported (see Feb 12 ClickUp investigation for similar pattern), or if a service-account-compatible Drive MCP server becomes available.

## Current State
- Admin endpoint and UI for configuring shared folder IDs on user records: done
- Customer portal Knowledge Base page shows configured folders with Drive links: done
- Direct Drive API integration for listing/reading files: TODO

# February 17, 2026: Foundation Tools Blocked by Subscription Filtering

## Problem
Scheduled chats failing with "required function calls are not allowed by your subscription" for `search_web` and other foundation tools. Multiple customer error emails sent. Additionally, foundation tools were hidden from the Skills config page and the customer-portal scheduled chat config, making them impossible to assign or select.

## Root Cause
Foundation tools (`search_web`, `read_file_content`, etc.) were never added to the allowed list returned by `getAllowedFunctionCalls()` in `subscriptionService.ts`. Three places were affected:
1. **Scheduled chat pre-flight check** (`agentModeController.ts:744`) — rejected foundation tools as disallowed
2. **`/api/agent-mode/function-calls` endpoint** — `filterFunctionCalls` stripped foundation tools for non-admin users, hiding them from customer-portal scheduled chat config
3. **Skills page** (`Skills.tsx`) — `?forSkillConfig=true` query param triggered a backend filter excluding foundation tools, preventing them from being assigned to skills

Bug introduced Dec 14, 2025 (`5bc0ad80`) but only surfaced after Feb 14, 2026 (`90005233`) when skills-based subscriptions replaced wildcard subscriptions.

## Fix
1. Scheduled chat check: filter out foundation tools from the disallowed list using `agentModeService.getFoundationToolNames()`
2. `getAvailableFunctionCalls` endpoint: inject foundation tools into the allowed list before filtering for non-admin users
3. Removed the `forSkillConfig` backend filter and frontend query param so all tools (including foundation) appear on the Skills page

Backend 27.6.4, partner-portal 12.7.2. Unit tests updated.

# February 16, 2026: Scheduled Chat Silent Failure Bug

## Problem
Session `097840bc-7338-4a09-8c90-bf112230e17b` ("What's Up with AI Daily") completed steps 1–4 of its work plan but step 5 ("Publish to LinkedIn") never executed. No error was recorded — messages array was empty, no run result saved, no email sent.

## Root Cause
In `agentModeController.ts`, the `runScheduledChat()` promise's `.catch()` handler (line ~3449) only called `console.error`. It never saved a failure `runResult` to DynamoDB or sent an error notification email. Runtime crashes (LLM timeouts, network errors) were silently lost.

## Fix
Added to the `.catch()` block:
1. Save a failure `runResult` via `scheduleDb.addRunResult()` so failures are visible in the UI
2. Send error notification email to configured recipients

Backend version bumped to 27.5.3. Unit test added to cover the new behavior.

# February 12, 2026: ClickUp Integration via MCP

## Investigation
- ClickUp provides a remote MCP server at `https://mcp.clickup.com/mcp` (OAuth 2.1, read-only scope)
- Supports 20+ tools: search, tasks, comments, time tracking, workspace hierarchy, members, chat, docs
- AgentWeb already has external MCP client infrastructure (`mcpClientService.ts`) — plan is to connect to ClickUp's MCP server directly with per-user OAuth tokens
- Main gap: current MCP client uses a single shared token per server; need to extend it to support per-user OAuth connections

## Approach
- Option A (chosen): Connect to ClickUp's remote MCP server directly, inheriting all their tools automatically
- Add ClickUp as a connected account type with OAuth flow
- Extend `mcpClientService` to support per-user MCP sessions

## Status
- Submitted ClickUp MCP Server Allowlist Request Form for redirect URIs:
  - `https://api.agentweb.pro/api/auth/clickup/callback` (Production)
  - `https://api-stage.agentweb.pro/api/auth/clickup/callback` (Staging)
  - `http://localhost:3001/api/auth/clickup/callback` (Development)
- Waiting for ClickUp approval before proceeding with implementation

# February 12, 2026: PixelFlow Form Tracking Audit — start.waldium.com

## Pages Checked
- `https://start.waldium.com/` (v1)
- `https://start.waldium.com/v2`

## Result: Form submission NOT tracked on either page

**Base script**: Installed correctly on both pages (same API key, site ID, endpoint).

**Missing event classes** (required per [PixelFlow docs](https://docs.pixelflow.so/articles/event-classes-on-html-websites-4c49z)):

| Element | Required Class | Status |
|---|---|---|
| Form container | `info-frm-cntr-pf` | Missing |
| Submit button | `action-btn-lead-011-pf` | Missing |
| Email input | `info-cust-em-pf` | Missing |

Both pages share the same `LeadForm` React component. Adding the three classes to that component will fix both pages.

# February 11, 2026: Staging Backend Down (Agentweb-backend-env-1)

## Problem
Staging EB environment `Agentweb-backend-env-1` was Severe/Red. Deployment of `backend_v26.6.1-staging-pr455` repeatedly failed with command timeout on instance `i-0645dba745fc59889`.

## Investigation
- Instance EC2 system checks passed (running, reachable) but EB agent was completely unresponsive
- All EB commands timed out: deployments, log retrieval, restart — nothing got through
- The first deployment of the version at 07:00 UTC succeeded, but a subsequent redeploy at 08:36 UTC hung and the instance never recovered
- 4 consecutive deployment attempts all timed out (600s command timeout)
- Root cause: `t3.small` (2GB RAM) exhausted memory — `npm install` during deployment + Node.js app exceeded available resources, freezing the EB agent

## Resolution
1. Rebooted the instance via EC2 Console — environment recovered to healthy
2. Upgraded instance types from `t3.small` to `t3.medium` / `t3.large` to prevent recurrence
3. Configuration update completed successfully, environment Green/Ok

# February 10, 2026: CRM Web Enrichment Production Failure Investigation (v26.2.0)

## Investigation Summary
- Environment checked: `Agentweb-backend-env-prod-3` (AWS Elastic Beanstalk, `us-west-2`)
- Logs inspected from full bundle and tail logs
- Main failing workflow: `POST /api/crm/lists/:listId/leads/enrich-web?mode=enrich`

## Key Findings
- Primary failure is Google Custom Search quota/rate limiting:
  - `Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user'`
  - Observed repeatedly in `web.stdout.log` during enrich runs.
  - Example lines:
    - `/tmp/eb-prod3-bundle/var/log/web.stdout.log:285`
    - `/tmp/eb-prod3-bundle/var/log/web.stdout.log:45596`
    - `/tmp/eb-prod3-bundle/var/log/web.stdout.log:46733`
- Nginx upstream timeout occurred for the enrich endpoint:
  - `/tmp/eb-prod3-bundle/var/log/nginx/error.log:247`
  - `upstream timed out ... POST /api/crm/lists/.../leads/enrich-web?mode=enrich`
- Secondary issue: occasional LLM JSON parsing failures:
  - `LLMService: Error generating content: SyntaxError...`
  - Examples:
    - `/tmp/eb-prod3-bundle/var/log/web.stdout.log:45`
    - `/tmp/eb-prod3-bundle/var/log/web.stdout.log:45252`
    - `/tmp/eb-prod3-bundle/var/log/web.stdout.log:46165`
- `connect() failed (111: Connection refused)` entries align with deployment restarts and are not the main enrich failure cause.

## Impact
- Enrichment batch jobs report many failed leads due to `searchWeb` quota errors.
- Some enrich requests run long enough to hit upstream timeout.
- JSON parse failures reduce successful enrichments further.

## TODO (Feb 10, 2026)
- [ ] Add server-side rate limiting and retry/backoff for `searchWeb` (respect Google per-minute quota).
- [ ] Reduce effective enrichment search concurrency in production (current burst is too high).
- [ ] Move enrich processing to async job execution with progress polling to avoid long blocking HTTP request timeouts.
- [ ] Add early circuit-breaker behavior when quota errors spike (fail fast with clear status instead of repeated retries).
- [ ] Harden JSON extraction path:
  - [ ] enforce strict JSON response mode/instructions
  - [ ] keep retry with stricter prompt
  - [ ] add safe fallback parse guardrails
- [ ] Add metrics and alerts:
  - [ ] quota error count
  - [ ] enrich timeout count
  - [ ] per-batch success/fail rate
- [ ] Document operational limits for enrichment batch size and recommended concurrency.

# February 08, 2026: MCP Session Concurrency Fix (v25.9.0)

## Problem
Scheduled chats failing with "Bad Request: No valid session ID provided" errors. Multiple concurrent chat sessions in the same worker process were sharing a single MCP client connection, causing session ID conflicts.

## Root Cause
- Worker process creates ONE AgentModeService with ONE McpClientService
- All concurrent chat sessions used the SAME MCP client with SAME session ID
- When multiple chats ran simultaneously, MCP server returned "has session: false"
- Production logs showed: `MCP session: abf29003-1882-423c-ba87-57ee2c9e7749, chat sessionId: 9816f8e4...` but `has session: false`

## The Fix
Implemented session-based client pooling in `backend/src/mcp/client/mcpClientService.ts`:
- Added `sessionClientPools: Map<chatSessionId, ClientPool>` to isolate clients per chat session
- Created `getSessionClient(serverName, chatSessionId)` method - each chat gets its own MCP client
- Modified tool execution to use `getSessionClient()` instead of shared client
- Added automatic cleanup of stale session pools (1 hour timeout, configurable via `MCP_CLIENT_SESSION_TIMEOUT_MS`)
- Added `releaseSessionClients(chatSessionId)` for manual cleanup

## Changes
**Files modified:**
- `backend/src/mcp/client/mcpClientService.ts` (~150 lines added)
- `backend/src/__tests__/mcp.mcpClientService.test.ts` (6 new tests)
- `backend/src/scripts/test-mcp-session-isolation.ts` (test script)
- `backend/src/docs/user-release.ts` (Feb 08 entry)
- `backend/package.json` (version bump to 25.9.0)

**Key change in tool execution:**
```typescript
// Before: All sessions share same client
execute: async (args, context) => {
  const result = await client.callTool(...);  // ← Shared
}

// After: Each session gets its own client
execute: async (args, context) => {
  const sessionClient = await this.getSessionClient(name, context.sessionId);
  const result = await sessionClient.callTool(...);  // ← Isolated
}
```

## Testing
Run verification test (10 concurrent sessions):
```bash
cd backend
npx ts-node src/scripts/test-mcp-session-isolation.ts
```

Expected output:
```
✓ Result: 10/10 unique MCP sessions
✓ Session creation time: ~595ms
✓ Active session pools: 10
✓ Total MCP clients created: 10 (10 sessions × 1 servers)
✓ SUCCESS: Each chat session has isolated MCP client
```

All unit tests pass:
```bash
npm test
# Test Suites: 185 passed, 185 total
# Tests:       2226 passed, 2226 total
```

## Performance & Safety
**Connection overhead with 10 concurrent sessions:**
- Before: 3 MCP connections (shared, broken)
- After: 30 MCP connections (10 sessions × 3 servers)
- Creation time: ~600ms for 10 session pools
- Memory: ~50-100MB additional overhead
- ✅ Acceptable for Node.js (can handle 100+ connections easily)

**Memory safety:**
- Tool implementations are stateless (async functions)
- Each session has isolated MCP client pool with unique session IDs
- Shared state is minimal (read-only configs, safe caches)
- No threading issues (Node.js async model)
- All data passed as parameters (no mutable globals)

**Scalability:**
- Works well with 2-20 concurrent sessions
- If >50 concurrent chats needed, consider worker pool architecture

## Deployment Verification
After deployment, monitor for:
- `[MCP-SESSION] Creating new client pool for session: {id}` (new logs)
- `[MCP-SESSION] Connected to {server} with MCP session ID: {mcpId} for chat session: {chatId}` (new logs)
- No "has session: false" errors (old bug eliminated)
- Connection count: `netstat -an | grep :3001 | wc -l`

# February 07, 2026: MCP Session ID Issue in Worker Process

## Problem
Production scheduled chats and agent mode tool calls were failing with error:
```
StreamableHTTPError: Streamable HTTP error: Error POSTing to endpoint:
{"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: No valid session ID provided"},"id":null}
```

## Investigation Timeline

### Symptoms
- Production backend (v25.6.0) on AWS Elastic Beanstalk experiencing multiple failures
- Errors occurred at 16:23:30 UTC and 16:25:28 UTC on Feb 7, 2026
- Affected tools: `read_brand_guidelines`, `read_market_strategy`, `search_knowledge_base`, `create_work_plan`
- All errors originated from `[Worker]` process, not main backend

### Root Cause
The **Worker process** (generateMarketingResponseWorker.ts) creates its own AgentModeService instance with an independent MCP client. The StreamableHTTPClientTransport was not properly establishing the MCP session before tool calls were made:

1. Worker initializes and creates MCP client
2. Client calls `connect(transport)`
3. Connection completes but session handshake may not be fully established
4. Tool calls are made immediately without valid `mcp-session-id` header
5. MCP server rejects requests with error code -32000

### The Fix
Added session validation in `backend/src/mcp/client/mcpClientService.ts`:
- Wait 100ms after connection for session initialization to complete
- Validate that `transport.sessionId` is set before proceeding
- Throw error if session ID is not established
- Added comprehensive logging for debugging

### Architecture Notes
- Main backend has its own MCP client with independent session
- Worker process has a separate MCP client with its own session
- Both connect to the internal MCP server at `http://localhost:PORT/mcp/server`
- Sessions timeout after 1 hour of inactivity (configurable via `MCP_SESSION_TIMEOUT_MS`)
- Session cleanup runs every hour (configurable via `MCP_CLEANUP_INTERVAL_MS`)

### Production Deployment Requirements
After this fix, deploy to production with version bump to include:
- Session validation logic
- Enhanced debug logging (`[MCP-DEBUG]`, `[MCP-SERVER-DEBUG]`, `[Worker-DEBUG]`)
- Session ID tracking throughout the tool call lifecycle

### Testing
Local testing showed the fix working correctly:
- Worker MCP session established successfully
- Tool calls (`read_brand_guidelines`, `create_work_plan`) executed without errors
- Session ID properly included in all HTTP requests

# Continue with Google not working in dev
It could be due to auth related code was changed and the change would require restart `npm run dev` in order for the Google Login to work again.

# prod deployment on AWS Beanstalk
June 03, 2025: a deployment to backend failed and it failed to revert back to previous version. Restarting the app server and rebuilt the environemnt not worked. To resolve the issue, we had to clone the environment and then pointed the dns record in route 53 to the new environment.

# March 23, 2026: Path Traversal Attack Investigation

## Problem

Production nginx logs showed a high volume of suspicious requests probing for common web vulnerabilities (PHP, Java, .env files, path traversal). Investigation needed to determine if any attacks were successful and whether the codebase is vulnerable.

## Attack Evidence from Production Logs

**1,114 malicious requests** across Mar 19–23 from automated vulnerability scanners. **All returned 404** — no successful exploitation.

### Attack Types (by volume)
| Type | Count | Description |
|------|-------|-------------|
| PHPUnit/eval-stdin | 949 | Probing for exposed PHP test suites (`/vendor/phpunit/.../eval-stdin.php`) |
| .env probe | 67 | Attempting to read environment variables (`GET /.env`) |
| Path traversal (LFI) | 47 | PHP Local File Inclusion via `index.php?lang=../../../../usr/local/lib/php/pearcmd` |
| Spring actuator | 7 | Probing for Java Spring endpoints (`/actuator/health`) |
| Other | 44 | Mixed scanner fingerprinting (`/webui/`, `/developmentserver/metadatauploader`, etc.) |

### Scanner Fingerprints
- `libredtail-http` — automated vulnerability scanner
- `Mozilla/5.0 zgrab/0.x` — zgrab network scanner
- Spoofed Chrome/Firefox user-agents for .env probes

### Key Attacker IPs
`110.35.80.116`, `75.119.137.153`, `82.24.64.32`, `118.196.74.89`, `165.154.232.244`, `34.158.79.105`, `145.223.47.104`, `45.39.7.12`, `20.163.2.150`, `20.64.106.28`, `65.49.1.142`, `48.214.144.34`

## Code Audit Findings

### No Filesystem Path Traversal Vulnerabilities
1. **No `express.static` serving** — backend doesn't serve static files from the filesystem
2. **No `res.sendFile` / `res.download`** — no file download endpoints using filesystem paths
3. **No user-input in `path.join`** — all `fs.readFileSync` calls use hardcoded paths (`docs/AGENT_API.md`, `docs/skill.md`, font files, UUID-generated temp files)
4. **Asset serving via S3** — `/asset/:assetHash` decodes a hash to S3 bucket/key, not filesystem paths
5. **File uploads go to S3** — no local filesystem storage of user uploads

### Landing Page GitHub File Endpoints — Low Risk
4 endpoints in `landingPageGeneration.ts` accept user-supplied file paths passed to GitHub API. They have `..` checks but could be hardened:
- `GET /api/landing-pages/v0/generated/:id/file-content` (line 629)
- `PUT /api/landing-pages/v0/generated/:id/github-edit` (line 415)
- `GET /api/landing-pages/v0/generated/:id/commits` (line 681)
- `GET /api/landing-pages/v0/generated/:id/file-at-commit` (line 726)

Risk is low: paths go to GitHub API (not filesystem), require auth + ownership, and Express's `qs` parser auto-decodes `%2e%2e` preventing URL-encoded bypasses.

## Conclusion

All attacks are **automated internet background noise** targeting PHP/Java/Python stacks. The Node.js/Express backend with no filesystem file serving is not vulnerable. All attack requests correctly return 404. Consider AWS WAF and nginx rate limiting for defense-in-depth.

June 04, 2025: another outage of the backend. To resolve the issue and improve reliability, updated the environment to use t3-small instead of t3-micro as first option and t3-medium as second option. It was t3-micro then t3-small.

June 16, 2025:
# Known issues of Gemini model with browser use
Gemini models cannot work with the BaseModel argument with function call. Also it has a strange issue that require minimum 1 argument. We needed to add patch to use simpler argument for gemini models.

June 19, 2025
The latest version of browser-use (0.2.7) has an issue of using the same persistent storage for session data which mixed the cookie files from different users. 

June 21, 2025
When restoring a previous good version of browser-use, an issue about old_history table or index crash arised. It was initially suspected to be issue with browser use or playwright but after several round of testings the issue was with the memory dependency of browser use. Uninstall the component solved the issue as this is not a hard dependency:
`pip uninstall -y mem0ai`
To reinstall it, run
`pip install "browser-use[memory]"`
# Update September 24, 2025: got the error again but realized we are using python3 at dev which seems not an issue until Rui's MacBook Pro accidentally crashed and probably crashed the python3 install. The issue has been fixed with a reinstall of all dependencies with requirements.txt and playwright reinstall. No prod change should be made. It was purely a dev issue.
To fix browser-use version - 
pip install "browser-use[memory]==0.1.48"
Force to install on dev
python3 -m pip install "browser-use[memory]==0.1.48" --break-system-packages
python3 -m pip install -r requirements.txt --break-system-packages
python3 -m playwright install chromium
## Test playwright afterwards
python3 -c "from playwright.sync_api import sync_playwright; p = sync_playwright().start(); browser = p.chromium.launch(); print('✅ Chromium browser launched successfully'); browser.close(); p.stop()"

Issue with reverted PRs: when there are reverted PRs, there is risk that changes may mess up, possibly due to accumulated changes are too many that github seems may start truncate. We encountered such issue when deploying the data analysis PR. A resolution was to start clean which causes much less confusion.

July 28, 2025
# DynamoDB Index Management

## Adding UserIdIndex to TaskExecutions Table

When deploying the Images feature, you may encounter an error: `ValidationException: The table does not have the specified index: UserIdIndex`. This happens because the TaskExecutions table is missing the UserIdIndex that's required for the `getAllTaskExecutionsByUserId` method.

### Manual Fix via AWS Management Console

1. **Access DynamoDB Console**
   - Go to AWS Management Console
   - Navigate to DynamoDB service
   - Click on "Tables" in the left sidebar

2. **Select the TaskExecutions Table**
   - Find the table named `Dev-AW-TaskExecutions` (development) or `AW-TaskExecutions` (production)
   - Click on the table name to open its details

3. **Add the Index**
   - In the table details page, scroll down to the "Indexes" section
   - Click "Create index" button
   - Fill in the following details:
     - **Partition key**: `userId` (String)
     - **Sort key**: `startTime` (String)
     - **Index name**: `UserIdIndex`
     - **Index capacity**: Copy from base table
     - **Attribute project**: All
   - Click "Create index"

4. **Wait for Index Creation**
   - The index will show "Creating" status initially
   - This process can take several minutes depending on table size
   - Monitor the status until it changes to "Active"

5. **Verify the Index**
   - Once the index is active, you can verify it by:
     - Going back to the table's "Indexes" section
     - Confirming `UserIdIndex` shows "Active" status
     - The index should have `userId` as partition key and `startTime` as sort key

### Prevention for Future Deployments

The `create-tables.ts` script has been updated to include the `UserIdIndex` by default for new deployments. This ensures that future table creations will automatically include the required index.

August 07, 2025
testing with gpt-5 models: Azure does offer gpt-5-chat but has insufficient quota error; OpenAI offers all models but gpt-5 require removal of temperature but even after it is removed, it is not responding to extract-content call. gpt-5-chat-latest has error about tools not supported

August 25, 2025
deploying Growth Genius: creating a beanstalk service could easily got stuck because it would just fail: create a new environment failed, copy from customer portal environment and then deploy the genius app failed. It may not be able to recover from failure. be able to fetch the log or not makes a difference. For example, the first time I was not able to fetch the log, which indicates a different problem when next time I was able to fetch it which showed a different problem, though from the deployment log they were like same failure.

August 28, 2025
supporting multiple image input for openai model require using latest openai model
> pip install --upgrade openai

We have issues creating new environment in elastic beanstalk. We tested using AWSEBSSecurityGroup for EC2 security groups because the service instances (EC2) needs to communicate with the load balancer but it still not working.

Sept. 14, 2025
Debug with full log from Elastic Beanstalk: web.stdout.log has the app log.

October 10, 2025
## DynamoDB: Add UserIdIndex to AW-TaskSchedules

If you need to add the `UserIdIndex` GSI to the `AW-TaskSchedules` table (used by Scheduled Chats), use these commands.

Prerequisites:
- AWS CLI configured for the target account/region (`aws configure`)
- Region: `us-west-2` (override with `--region` if different)

Add index in Development (Dev- prefixed table, provisioned capacity):

```bash
aws dynamodb update-table \
  --table-name Dev-AW-TaskSchedules \
  --attribute-definitions AttributeName=userId,AttributeType=S \
  --global-secondary-index-updates '[{"Create":{"IndexName":"UserIdIndex","KeySchema":[{"AttributeName":"userId","KeyType":"HASH"}],"Projection":{"ProjectionType":"ALL"}}}]' \
  --region us-west-2
```

Add index in Production (no prefix, PAY_PER_REQUEST billing mode):

```bash
aws dynamodb update-table \
  --table-name AW-TaskSchedules \
  --attribute-definitions AttributeName=userId,AttributeType=S \
  --global-secondary-index-updates '[{"Create":{"IndexName":"UserIdIndex","KeySchema":[{"AttributeName":"userId","KeyType":"HASH"}],"Projection":{"ProjectionType":"ALL"}}}]' \
  --region us-west-2
```

Verify index status (repeat until `IndexStatus` is `ACTIVE`):

```bash
aws dynamodb describe-table \
  --table-name Dev-AW-TaskSchedules \
  --region us-west-2 \
  --query 'Table.GlobalSecondaryIndexes[?IndexName==`UserIdIndex`].{IndexName:IndexName,IndexStatus:IndexStatus}'
```

List all GSIs on the table:

```bash
aws dynamodb describe-table \
  --table-name Dev-AW-TaskSchedules \
  --region us-west-2 \
  --query 'Table.GlobalSecondaryIndexes[].{IndexName:IndexName,IndexStatus:IndexStatus}'
```

Notes:
- GSI creation is asynchronous; queries against `UserIdIndex` work after status becomes `ACTIVE`.
- Replace `Dev-AW-TaskSchedules` with `AW-TaskSchedules` for production.

## DynamoDB: Add EmailDomainLeadEmailIndex to AW-EmailEvents

If you need to add the `EmailDomainLeadEmailIndex` composite GSI to the `AW-EmailEvents` table (for efficient lead engagement queries), use these commands.

Prerequisites:
- AWS CLI configured for the target account/region (`aws configure`)
- Region: `us-west-2` (override with `--region` if different)

Add index in Development (Dev- prefixed table):

```bash
aws dynamodb update-table \
  --table-name Dev-AW-EmailEvents \
  --attribute-definitions AttributeName=emailDomain,AttributeType=S AttributeName=leadEmail,AttributeType=S \
  --global-secondary-index-updates '[{"Create":{"IndexName":"EmailDomainLeadEmailIndex","KeySchema":[{"AttributeName":"emailDomain","KeyType":"HASH"},{"AttributeName":"leadEmail","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"},"ProvisionedThroughput":{"ReadCapacityUnits":5,"WriteCapacityUnits":5}}}]' \
  --region us-west-2
```

Add index in Production (no prefix):

```bash
aws dynamodb update-table \
  --table-name AW-EmailEvents \
  --attribute-definitions AttributeName=emailDomain,AttributeType=S AttributeName=leadEmail,AttributeType=S \
  --global-secondary-index-updates '[{"Create":{"IndexName":"EmailDomainLeadEmailIndex","KeySchema":[{"AttributeName":"emailDomain","KeyType":"HASH"},{"AttributeName":"leadEmail","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}}]' \
  --region us-west-2
```

Verify index status (repeat until `IndexStatus` is `ACTIVE`):

```bash
aws dynamodb describe-table \
  --table-name Dev-AW-EmailEvents \
  --region us-west-2 \
  --query 'Table.GlobalSecondaryIndexes[?IndexName==`EmailDomainLeadEmailIndex`].{IndexName:IndexName,IndexStatus:IndexStatus}'
```

List all GSIs on the table:

```bash
aws dynamodb describe-table \
  --table-name Dev-AW-EmailEvents \
  --region us-west-2 \
  --query 'Table.GlobalSecondaryIndexes[].{IndexName:IndexName,IndexStatus:IndexStatus}'
```

After the index is active, run the repair-tables script to update the table schema:

```bash
cd backend
NODE_ENV=development npx ts-node src/scripts/@repair-tables.ts
```

For production, use:
```bash
cd backend
NODE_ENV=production npx ts-node src/scripts/@repair-tables.ts
```

## DynamoDB: Add AdminUpdatedAtIndex to AW-ChatSessions

If you need to add the `AdminUpdatedAtIndex` GSI to the `AW-ChatSessions` table (for admin chat history pagination), use these commands.

Prerequisites:
- AWS CLI configured for the target account/region (`aws configure`)
- Region: `us-west-2` (override with `--region` if different)

Add index in Development (Dev- prefixed table):

```bash
aws dynamodb update-table \
  --table-name Dev-AW-ChatSessions \
  --attribute-definitions AttributeName=adminListPartition,AttributeType=S AttributeName=updatedAt,AttributeType=S \
  --global-secondary-index-updates '[{"Create":{"IndexName":"AdminUpdatedAtIndex","KeySchema":[{"AttributeName":"adminListPartition","KeyType":"HASH"},{"AttributeName":"updatedAt","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"},"ProvisionedThroughput":{"ReadCapacityUnits":5,"WriteCapacityUnits":5}}}]' \
  --region us-west-2
```

Add index in Production (no prefix):

```bash
aws dynamodb update-table \
  --table-name AW-ChatSessions \
  --attribute-definitions AttributeName=adminListPartition,AttributeType=S AttributeName=updatedAt,AttributeType=S \
  --global-secondary-index-updates '[{"Create":{"IndexName":"AdminUpdatedAtIndex","KeySchema":[{"AttributeName":"adminListPartition","KeyType":"HASH"},{"AttributeName":"updatedAt","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}}]' \
  --region us-west-2
```

Verify index status (repeat until `IndexStatus` is `ACTIVE`):

```bash
aws dynamodb describe-table \
  --table-name Dev-AW-ChatSessions \
  --region us-west-2 \
  --query 'Table.GlobalSecondaryIndexes[?IndexName==`AdminUpdatedAtIndex`].{IndexName:IndexName,IndexStatus:IndexStatus}'
```

Notes:
- Do not specify `ProvisionedThroughput` when the table billing mode is `PAY_PER_REQUEST` (production).
- After the index is active, backfill `adminListPartition` for existing items so they show up in the index.

Backfill in Development:

```bash
cd backend
NODE_ENV=development npx ts-node src/scripts/repair-chat-sessions-admin-index.ts
```

Backfill in Production:

```bash
cd backend
NODE_ENV=production npx ts-node src/scripts/repair-chat-sessions-admin-index.ts
```

## Port Management

### Finding and Killing Processes on Port 3001

When you need to free up port 3001 (commonly used by development servers), use these commands:

1. **Find processes using port 3001:**
   ```bash
   lsof -ti:3001
   ```
   This will return the Process IDs (PIDs) of all processes using port 3001.

2. **Kill the processes:**
   ```bash
   kill -9 <PID1> <PID2> ...
   ```
   Replace `<PID1>`, `<PID2>`, etc. with the actual PIDs returned from the previous command.

## Memory System Issues (October 14, 2025)

### Azure OpenAI Models Failing with Database Errors

If Azure OpenAI models (gpt-4o, gpt-4.1) fail with errors like:
- `"there is already another table or index with this name: old_history"`
- `"no such column: prev_value"`

This indicates corrupted memory database files in the mem0 system used by browser-use.

### Quick Fix

Run the memory cleanup script:
```bash
cd agent-engine
conda activate agent-engine
python memory_fix_v2.py
```

This will:
- Clean up all corrupted mem0 database files
- Configure memory system to use in-memory database
- Resolve database schema issues

### Manual Cleanup (if script not available)

```bash
# Remove all mem0 directories
rm -rf /tmp/mem0_*
rm -rf ~/.mem0

# Set environment variables
export MEM0_DATABASE_URL="sqlite:///:memory:"
export MEM0_BACKEND="sqlite"
```

### Prevention

The memory fix only needs to be applied once when the issue occurs. It doesn't need to run automatically on every startup.

### Alternative: Disable Memory Entirely

If memory issues persist, you can disable the memory system:
```bash
export MEM0_DISABLED="true"
export BROWSER_USE_MEMORY_DISABLED="true"
```

### Files Created for Reference

- `agent-engine/memory_fix_v2.py` - Enhanced memory fix script
- `agent-engine/tests/test_memory_fix_v2.py` - Comprehensive tests
- `agent-engine/MEMORY_FIX_V2_SUMMARY.md` - Detailed documentation

November 23, 2025
There was two outages in recent three days. To debug, I downloaded the full log files and then asked Cursor to look into and she found that Emma was running workflows for too long and thus blocked health checks from AWS which then got Elastic Beanstalk to go unhealthy and go crazy to mess up.

November 24, 2025
Added oncall alert on Agentweb-backend-env-prod-3 env as it is currently the prod backend and most risky outage.

November 29, 2025
## Azure Anthropic Foundry API Hanging Issue with Long Prompts

The Azure Anthropic Foundry API (via `@anthropic-ai/foundry-sdk`) experiences hanging behavior when processing long prompts, particularly when combined with large `max_tokens` values. Testing revealed that prompts exceeding approximately 500 characters can cause the API to hang indefinitely, with requests timing out after 30-90 seconds or never completing. This issue appears to be a limitation of the Azure Anthropic Foundry service itself rather than a bug in the SDK libraries, as both `@anthropic-ai/foundry-sdk` (v0.2.0) and `@anthropic-ai/sdk` (v0.71.0) are at their latest versions.

Because of this, it is hard to use Anthropic LLM via Azure.

December 02, 2025
VEO 3.1 integration doc: https://ai.google.dev/gemini-api/docs/video?example=dialogue#javascript_2

December 06, 2025
## CVE-2025-55182 (React2Shell) Security Check

### Assessment: Project is NOT directly impacted

**Status**: ✅ Not vulnerable

### Findings

1. **Frontend Applications (Safe)**:
   - `customer-portal`: React 18.3.1 ✅
   - `partner-portal`: React 18.3.1 ✅
   - `growth-chat`: React 18.3.1 ✅
   - All frontend applications use React 18.x, which is NOT affected by CVE-2025-55182

2. **Backend (Low Risk)**:
   - Has React 19.0.0 installed as a transitive dependency via `reactflow` and `@reactflow/core`
   - **NOT using React Server Components (RSC)** - no `react-server-dom-*` packages found
   - No Next.js or RSC frameworks detected
   - Backend is a standard Express.js server, not using RSC functionality

### Why It's Not Vulnerable

CVE-2025-55182 (React2Shell) is a critical pre-authentication remote code execution (RCE) vulnerability that specifically affects:
- React 19.0.0, 19.1.0, 19.1.1, and 19.2.0
- **React Server Components (RSC)** functionality
- Frameworks using RSC (Next.js 15.x/16.x, React Router, Waku, Parcel RSC, Vite RSC)

While the backend has React 19.0.0 installed, it does **not** use React Server Components, so the vulnerability does not apply.

### Recommendations

1. **Monitor for Future Changes**:
   - If you plan to add React Server Components or upgrade to Next.js 15.x/16.x, ensure you use patched React versions:
     - React 19.0.1, 19.1.2, or 19.2.1+
     - Next.js 15.0.5+, 15.1.9+, 15.2.6+, 15.3.6+, 15.4.8+, 15.5.7+, or 16.0.7+

2. **Optional Cleanup**:
   - Consider removing React 19.0.0 from backend dependencies if `reactflow` is not actively used
   - Or pin `reactflow` to a version that doesn't require React 19

3. **Regular Security Audits**:
   - Run `npm audit` regularly to check for security vulnerabilities
   - Monitor React and Next.js security advisories

### Verification Commands

To verify React versions in the future:
```bash
# Check frontend React versions
cd customer-portal && npm list react react-dom
cd partner-portal && npm list react react-dom
cd growth-chat && npm list react react-dom

# Check backend React version (if needed)
cd backend && npm list react react-dom
```

### References
- CVE-2025-55182 Scanner: https://cve-2025-55182.com/
- React Security Advisory: https://github.com/facebook/react/security

## MAL-2026-2307 (Axios Supply Chain Attack) Security Check

**Date:** 2026-04-02 | **Status:** ✅ Not affected

### Summary

On 2026-03-31, the `axios` npm package was compromised and malicious versions `0.30.4` and `1.14.1` were published to npm. The compromised versions included a malicious dependency called `plain-crypto-js` that installs a **Remote Access Trojan (RAT)**. The RAT phones home to `sfrclak.com:8000/6202033` (IP `142.11.206.73`).

According to the advisory: _"Any computer that has this package installed or running should be considered fully compromised. All secrets and keys stored on that computer should be rotated immediately from a different computer."_

### Affected Versions

- `axios@0.30.4`
- `axios@1.14.1`

### AgentWeb Findings

All three components were checked and are **not affected**:

| Component | Declared | Installed | Status |
|-----------|----------|-----------|--------|
| backend | `^1.9.0` | **1.9.0** | ✅ Safe |
| partner-portal | `^1.7.9` | **1.11.0** | ✅ Safe |
| customer-portal | `^1.9.0` | **1.11.0** | ✅ Safe |

Additional IOC checks (all clean):
- No `plain-crypto-js` found in any `package-lock.json` or `node_modules`
- No references to `sfrclak.com` or `142.11.206.73` anywhere in the codebase

### References

- OSV Advisory: [MAL-2026-2307](https://osv.dev/vulnerability/MAL-2026-2307)
- GitHub Advisory: [GHSA-fw8c-xr5c-95f9](https://github.com/advisories/GHSA-fw8c-xr5c-95f9)
- StepSecurity Blog: https://www.stepsecurity.io/blog/axios-compromised-on-npm-malicious-versions-drop-remote-access-trojan

## Dec 15, 2025
to support pdf file uploads for Knowledge Base, add OCR Parser for PDF file formats so that Vertex AI Search will uses this parser to parse PDF files.

## Dec 23, 2025
After resolving conflicts, we need to use force push to remote. On Github Desktop, instead of clicking on the pull and push button, we should select force push from it because otherwise a pull will happen again which will get the conflicts happen again.

## Dev 30, 2025
If tests fail in PR, we could rerun the step in the PR to see whether it is a random issue. This worked for customer-portal.

## Jan 2, 2026
### LinkedIn Configuration Update
Renamed LinkedIn credential functions and updated secret paths to clarify personal vs. company credentials.

- **Personal Profile Integration**:
  - Dev Secret: `dev/AgentWeb/LinkedIn/Personal`
  - Prod Secret: `prod/AgentWeb/LinkedIn/Personal`

- **Organization/Company Page Integration**:
  - Dev Secret: `dev/AgentWeb/LinkedIn/Company`
  - Prod Secret: `prod/AgentWeb/LinkedIn/Company`

## January 06, 2026
### Scheduled Chat Run History: Optimized Storage to Prevent DynamoDB Size Limits

#### Problem
The `runResults` array stored in `AW-TaskSchedules` table was hitting DynamoDB's 400KB item size limit. The `actualResponse` field (containing the full AI response text) was the primary contributor to item size, often taking 1-20KB per entry.

#### Solution
Instead of storing `actualResponse` in the database, we now:
1. **Exclude `actualResponse` when storing** run results to DynamoDB
2. **Reconstruct `actualResponse` on-demand** from session messages only when needed (when sending emails)
3. **Keep `actualResponse` in error cases** where there's no session to reconstruct from

#### Implementation Details
- Helper function `getActualResponseFromSession()` extracts the last assistant message from the session
- `actualResponse` is removed from the result object before calling `addRunResult()`
- Reconstruction happens in:
  - `sendScheduledChatTestEmail()` - when user clicks "Send Email" in Run History
  - `sendDailyDigestEmail()` - when sending daily digest emails

#### Size Estimates

**Per Entry (without `actualResponse`):**
- Base fields: ~530 bytes
  - scheduleId, runId, sessionId (UUIDs): ~120 bytes
  - status, passed, attempt, executionTime: ~30 bytes
  - createdAt (ISO string): ~30 bytes
  - Arrays (keywordMatches, keywordMisses, functionCallMatches, etc.): ~200-400 bytes
  - functionCallDetails object: ~100-500 bytes
- **Average: ~800 bytes per entry**

**Per Entry (with `actualResponse` - old method):**
- Base fields: ~530 bytes
- actualResponse: 1-20KB (average ~3-5KB)
- **Average: ~3,800-6,500 bytes per entry**

**Savings per entry: ~3-5KB**

#### Capacity Estimates

DynamoDB item size limit: **400KB**
- Base schedule data (scheduleName, description, startingMessage, etc.): ~2-5KB
- Available space for runResults: **~395-398KB**

**Old Method (with `actualResponse`):**
- 395KB ÷ 6.5KB (worst case) = **~60 entries**
- 395KB ÷ 3.8KB (average) = **~104 entries**

**New Method (without `actualResponse`):**
- 395KB ÷ 0.8KB = **~490 entries**

**Improvement: ~8x more entries can be stored** (from ~60-100 entries to ~490 entries)

#### Notes
- `actualResponse` is still available when needed (emails) via on-demand reconstruction
- Error cases (no session) still store `actualResponse` since it can't be reconstructed
- Frontend Run History display doesn't need `actualResponse`, so no performance impact on viewing history

Ran repair script to clean up actualResponse
NODE_ENV=production npx ts-node src/scripts/repair-scheduled-chat-run-results.ts 
Repairing TaskSchedules table to remove actualResponse from runResults: {
  environment: 'production',
  region: 'us-west-2',
  tablePrefix: '',
  tableName: 'AW-TaskSchedules'
}
Starting repair process...

(node:82443) NOTE: The AWS SDK for JavaScript (v2) is in maintenance mode.
 SDK releases are limited to address critical bug fixes and security issues only.

Please migrate your code to use AWS SDK for JavaScript (v3).
For more information, check the blog post at https://a.co/cUPnyil
(Use `node --trace-warnings ...` to show where the warning was created)
Processing batch: 14 schedules (Total scanned: 14)
Processing batch: 8 schedules (Total scanned: 22)
  ✓ Updated 10 schedules, cleaned 734 runResults entries so far...
Processing batch: 34 schedules (Total scanned: 56)
  ✓ Updated 20 schedules, cleaned 1066 runResults entries so far...
Processing batch: 20 schedules (Total scanned: 76)
  ✓ Updated 30 schedules, cleaned 1533 runResults entries so far...
Processing batch: 13 schedules (Total scanned: 89)
Processing batch: 19 schedules (Total scanned: 108)
  ✓ Updated 40 schedules, cleaned 2179 runResults entries so far...

Repair process completed!
Total schedules scanned: 108
Total schedules updated: 43
Total schedules skipped: 65 (no runResults or already cleaned)
Total runResults entries cleaned: 2179
Total errors: 0

✅ Repair completed successfully!

## Jan 14 2026
Configured Claude Code and use AWS Bedrock for the LLM: https://code.claude.com/docs/en/amazon-bedrock. In future, we could also use Azure as it starts to offer Claude models but no quota at the moment.

## Jan 29, 2026
Install playwright mcp for claude
claude mcp add playwright -- npx -y @playwright/mcp@latest

## Feb 2, 2026
### Google Analytics Not Receiving Data from app.agentweb.pro

#### Problem
After publishing GTM container updates to add tracking for app.agentweb.pro, no data was appearing in Google Analytics property 489864500. The Product Analytics API endpoint (`/api/seo/product-metrics`) returned zero data for app.agentweb.pro despite tracking being configured.

#### Initial Investigation
- GTM Preview showed events firing (page_view, scroll, user_engagement) ✅
- Network requests showed GA4 events being sent to `server-side-tagging-50006506707.us-central1.run.app/g/collect` ✅
- BUT no data appeared in GA4 Realtime reports or historical data ❌
- Even www.agentweb.pro stopped receiving data on Feb 2 (had data on Feb 1)

#### Root Cause Analysis

**Issue 1: Domain Configuration**
- GA4 data stream was configured with "exact match" for `agentweb.pro`
- This blocked app.agentweb.pro subdomain from being accepted
- **Fix**: Changed domain matching from "exact match" to "contains" with entries:
  - `agentweb.pro`
  - `withsurface.com`
  - `agentwebforms.com`
  - `app.agentweb.pro`

**Issue 2: GTM Tag Configuration (Primary Issue)**
- GTM had two GA4-related tags:
  1. `FB_CONVERSIONS_API-1430870751246428-Web-Tag-GA4_Config` (Type: "Google Tag")
  2. `FB_CONVERSIONS_API-1430870751246428-Web-Tag-GA4_Event` (Type: "Google Analytics: GA4 Event")
- The GA4_Event tag referenced a Google Tag named **"AgentWeb"** that didn't exist
- The GA4_Config tag was named differently and wasn't firing in GTM Preview
- Without the Config tag firing, Event tags had no configuration to send data to

**Issue 3: Incorrect Trigger**
- GA4_Config tag was using "DOM Ready" trigger
- "Google Tag" type must fire on "Initialization - All Pages" to load gtag.js before other tags

#### Debugging Process

1. **Verified tracking firing**: Used browser DevTools to confirm GA4 events in network tab
2. **Checked GA4 real-time data**: No activity showing for app.agentweb.pro
3. **Analyzed GTM Preview**: Found GA4_Config tag in "Tags Not Fired" section
4. **Discovered tag reference mismatch**: GA4_Event looking for "AgentWeb" tag that didn't exist
5. **Tested historical data**: Confirmed all tracking (even www.agentweb.pro) stopped on Feb 2

#### Solution

1. **Renamed GTM Tag**:
   - Changed `FB_CONVERSIONS_API-1430870751246428-Web-Tag-GA4_Config` to `AgentWeb`
   - This allowed GA4_Event tag to find and reference the correct config tag

2. **Fixed Trigger**:
   - Changed AgentWeb tag trigger from "DOM Ready" to **"Initialization - All Pages"**
   - "Google Tag" type must fire early to initialize gtag.js

3. **Updated GA4 Domain Settings**:
   - In GA4 Admin → Data Streams → Configure tag settings
   - Changed domain matching to "contains" instead of "exact match"
   - Added app.agentweb.pro to allowed domains list

4. **Published GTM Container**:
   - Saved all changes
   - Published new container version
   - Verified in GTM Preview that AgentWeb tag now fires at Initialization

#### Verification

**Immediate Results**:
- ✅ GTM Preview shows "AgentWeb" tag firing at Initialization
- ✅ GA4_Event tags firing successfully with configuration
- ✅ GA4 Realtime report shows activity from app.agentweb.pro
- ✅ Page titles like "AgentWeb - Marketing Operations" appearing in real-time data

**Expected Timeline**:
- Real-time data: Available immediately ✅
- Historical data (Product API): 24-48 hours for data to populate
- Full metrics backfill: Up to 72 hours

#### Configuration Details

**GA4 Property**:
- Property ID: `489864500`
- Measurement ID: `G-KKJE0Q33LF`
- Data Stream: "AgentWeb" (https://www.agentweb.pro)

#### Important Note on Localhost Traffic

**Localhost traffic is still sent to Google Analytics but filtered in Customer Portal**:
- Development traffic from `localhost` is currently being sent to GA4 property 489864500
- The backend Product Analytics API (`/api/seo/product-metrics`) filters out localhost traffic using dimension filters:
  ```typescript
  dimensionFilter: {
    andGroup: {
      expressions: [
        { filter: { fieldName: "hostName", stringFilter: { matchType: "CONTAINS", value: user.productDomain } } },
        { notExpression: { filter: { fieldName: "hostName", stringFilter: { matchType: "CONTAINS", value: "localhost" } } } }
      ]
    }
  }
  ```
- **Result**: Customer Portal shows accurate production-only metrics, but Google Analytics UI will show inflated numbers that include localhost traffic
- **Recommendation**: Follow the guide in `GA4_EXCLUDE_LOCALHOST_GUIDE.md` to prevent localhost traffic from reaching GA4 entirely (Method 3 or 4 recommended)

## February 04, 2026

### LinkedIn Import Stuck at 0% - WebSocket Connection Failure

**Symptom**: LinkedIn import feature in CRM page showed progress stuck at 0%, no data imported to database, WebSocket connection errors in browser console showing malformed URL: `ws://https/socket.io/`

**Root Causes**:

1. **Missing nginx WebSocket configuration in production**
   - Elastic Beanstalk's nginx proxy doesn't support WebSocket upgrade by default
   - Socket.IO connections were blocked at the nginx layer
   - Development worked because it connects directly to backend (no nginx proxy)

2. **Incorrect nginx configuration placement**
   - Initial fix placed `websocket.conf` in `.platform/nginx/conf.d/`
   - This directory is for `http` block context (global settings)
   - `location` blocks are NOT allowed in `http` context → deployment failed
   - Correct location: `.platform/nginx/conf.d/elasticbeanstalk/` (for `server` block context)

3. **Frontend Socket.IO URL parsing bug**
   - Code used: `buildApiUrl("").replace("/api", "")`
   - For staging URL `https://api-stage.agentweb.pro/api`:
     - Incorrectly replaced "api" everywhere including in "api-stage"
     - Result: `https://-stage.agentweb.pro` (broken URL)
     - Socket.IO saw malformed URL and created: `ws://https/socket.io/`
   - Fix: Use regex to only remove `/api` at the end: `.replace(/\/api\/?$/, "")`

**Resolution Steps**:

1. **Added WebSocket nginx configuration**:
   ```
   backend/.platform/nginx/conf.d/elasticbeanstalk/websocket.conf
   ```
   - Includes `location /socket.io/` block with WebSocket upgrade headers
   - `proxy_set_header Upgrade $http_upgrade`
   - `proxy_set_header Connection "upgrade"`
   - Extended timeouts for long-running imports (3600s)

2. **Fixed Socket.IO URL parsing** in `customer-portal/src/pages/CRM.tsx`:
   ```typescript
   const apiUrl = buildApiUrl("");
   const socketUrl = apiUrl.replace(/\/api\/?$/, ""); // Only remove /api at END
   ```

**Debugging Process**:

1. **Initial Investigation**:
   - Checked Elastic Beanstalk logs via AWS CLI
   - Required adding IAM permissions for CloudWatch Logs and Beanstalk access
   - Found no `mode=import` requests in nginx access logs (only `mode=preview`)
   - Realized import never started due to WebSocket connection failure

2. **Backend Log Analysis**:
   - Preview requests returned HTTP 200 with valid JSON (~2,185 bytes)
   - Successfully parsed 2,986-5,538 connections and 5,484-7,132 messages
   - No server-side errors logged
   - WebSocket server initialized correctly

3. **Deployment Failures**:
   - First attempt: Used `map` directive in `conf.d/` → failed (wrong context)
   - Second attempt: Used `location` block in `conf.d/` → failed (wrong context)
   - Third attempt: Moved to `conf.d/elasticbeanstalk/` → succeeded

4. **Frontend WebSocket Error**:
   - Browser console showed malformed WebSocket URL
   - Traced to `.replace("/api", "")` matching "api" in hostname
   - Fixed with regex to only match `/api` at end of string

**Key Learnings**:

- **Elastic Beanstalk nginx structure**:
  - `.platform/nginx/conf.d/` → `http` block (no location blocks allowed)
  - `.platform/nginx/conf.d/elasticbeanstalk/` → `server` block (location blocks allowed)
  - Refer to AWS docs: https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/platforms-linux-extend.proxy.html

- **IAM Permissions for Log Access**:
  - Need `AWSElasticBeanstalkReadOnly` policy
  - Need `CloudWatchLogsReadOnlyAccess` policy
  - Can also add `elasticbeanstalk:RetrieveEnvironmentInfo` permission

- **WebSocket Testing**:
  - Always test Socket.IO connections in staging before production
  - Check browser console for WebSocket connection errors
  - Verify correct URL format: `wss://domain.com/socket.io/` not `ws://https/socket.io/`

- **String Replace Gotchas**:
  - Be careful with `.replace()` when URL contains similar substrings
  - Use regex with anchors (`$` for end of string) for precise replacements
  - For staging URLs like `api-stage.agentweb.pro`, simple string replace is dangerous

## Research Session Investigation (2026-03-17)

Investigated session `b34576c1-70f9-40da-a628-6fc8f9a3b129` ("Test: Weekly Competitor News Researcher", user `f958eb3e`, schedule `6588424c`).

**Observation:** On attempt 3 the LLM ignored explicit instructions to perform a deeper re-search, simply repeating the previously generated output instead of running new searches.

**Root cause:** The schedule's `requiredFunctionCalls` includes `search_web`, but `search_web` is not actually required for this schedule — the LLM's research workflow already calls search tools organically. Having `search_web` as a required function causes `runVerifiedChat` to retry when the function hasn't been called yet, and on retries the LLM sees its previous output in the conversation history and repeats it rather than executing fresh searches.

**Mitigation:** Remove `search_web` from the schedule's `requiredFunctionCalls`. The schedule only truly requires `read_market_strategy` to load competitor info. The LLM will still call search tools as part of its natural research flow without needing them enforced as required calls.

**Broader notes:**
- The `runVerifiedChat` retry prompt (lines 583-618 of `agentModeController.ts`) intentionally avoids re-requesting tools that already ran. When all required functions have been called but the work plan isn't complete, it sends generic "complete pending steps" messages. This means retries don't force the LLM to use different search parameters.
- 229 sessions use `perform_deep_research`. Overall 84% succeed at producing blog articles. `gemini-3-pro-preview` has a 23% failure rate vs 1% for `gemini-3.1-pro-preview`.
- 42 sessions show durations >2 hours (stuck/zombie sessions), likely due to long-running deep research polls that don't properly clean up.

## Message Limit & Context Window Investigation (2026-03-19)

### Current State

Agent Mode sessions are capped at **300 messages** (`MAX_MESSAGE_SIZE_PER_SESSION` in `backend/src/config.ts`). Raised from 150 in a previous release.

### Bug Found: 10-User-Message Sliding Window

**`buildMarketingContext()`** (agentModeService.ts:1785) currently slices conversation history to only the **last 10 user messages** + associated assistant/tool responses. This means the LLM is blind to most of the conversation history in any session with more than ~10 exchanges. This is a bug — context from earlier messages is silently dropped.

**Code location:** Lines 1801-1813 in `buildMarketingContext()`:
```
let userCount = 0;
let startIdx = 1;
for (let i = filteredHistory.length - 1; i >= 0; i--) {
  if (filteredHistory[i].role === 'user') {
    userCount++;
    if (userCount === 10) { startIdx = i; break; }
  }
}
const sliced = filteredHistory.slice(startIdx);
```

**Fix:** Remove this sliding window entirely. All messages should be included in context.

### How Context is Built Today

```
1. System prompt
2. Skills context (available + installed skills)
3. Account memory (cross-session facts)
4. Last 10 user messages + their assistant/tool responses  <-- BUG: should be ALL messages
5. Task statuses
6. Work plan (if active)
7. Current user message
   |
trimToolMessagesForContext()  (truncate old tool outputs to 8000 chars)
   |
callLLM()
```

**Key files:**
- `agentModeService.ts:774` — `generateMarketingResponse()` main entry
- `agentModeService.ts:1785` — `buildMarketingContext()` slices to last 10 user msgs
- `agentModeService.ts:12015` — `trimToolMessagesForContext()` truncates old tool results
- `chatbotService.ts:806` — `getMessagesFromMessagesTable()` loads from DynamoDB
- `config.ts:4` — `MAX_MESSAGE_SIZE_PER_SESSION = 300`

### Proposed Solution: Summarization + `query_message_details` Tool

Two complementary mechanisms that together enable **unlimited messages**:

1. **Periodic Summarization:** Every 200 messages, generate a summary using Gemini Flash Lite and inject it as a system-level context message. Original messages are preserved in DB but replaced by summaries in the LLM context.

2. **`query_message_details` Tool:** A foundation tool that lets the LLM retrieve specific details from older messages on-demand. Uses Gemini Flash Lite (~$0.01/query, 1-2s latency) to answer questions against the full message history.

**Why this works:**
- Summaries give the LLM a high-level map of the full conversation
- The tool lets the LLM drill into details when needed (the LLM decides when)
- Gemini Flash Lite has ~1M token context window — can read hundreds of messages cheaply
- No new infrastructure needed — just another tool + cheap LLM call
- Scales infinitely — only summaries accumulate (~500 tokens each)

**Architecture:**
```
Messages 1-200:     [Summary A injected as system message]
Messages 201-400:   [Summary B injected as system message]
Messages 401-600:   [Summary C injected as system message]
Messages 601-700:   [Full detail messages in context]

System prompt says: "Use query_message_details to look up specific details
from earlier in the conversation when needed."

When LLM needs detail -> calls query_message_details("what was the blog URL?")
  -> Gemini Flash Lite reads relevant messages, answers the question
  -> Result returned as tool response
```

**Cost for a 1000-message session:** ~$0.18 extra (4 summaries + ~10 detail queries).

### Implementation Plan

**Phase 1: Core Changes**
1. Remove the 10-user-message sliding window in `buildMarketingContext()`
2. Add `generateConversationSummary()` method using Gemini Flash Lite
3. Add `query_message_details` foundation tool + `handleQueryMessageDetails()` handler
4. Inject summaries into context via `buildMarketingContext(summaries)` parameter
5. Store summaries on session record (`ChatSession.summaries[]`)
6. Add `updateSessionSummaries()` to `ChatbotDB`
7. Raise `MAX_MESSAGE_SIZE_PER_SESSION` to 10,000
8. Update system prompt with "Long Conversation Support" guidance

**Phase 2: Polish**
- Frontend: show "Conversation summarized up to message X" indicator
- Admin controls: summarization interval, enable/disable
- Smart triggers: summarize based on token count, not just message count

### Files to Modify
- `backend/src/config.ts` — raise message limit
- `backend/src/services/agentModeService.ts` — remove window, add summarization, add tool handler, add to foundation tools
- `backend/src/services/chatbotService.ts` — add `summaries` to ChatSession, add `updateSessionSummaries()`
- `backend/src/emma/tools.ts` — register `query_message_details` tool

---

## Token Usage Optimization (2026-03-25)

### Investigation Findings (231 tracked prod sessions, March 2026)

| Metric | Value |
|--------|-------|
| Total tokens consumed | 171M |
| Total cost | $1,315 |
| Avg tokens/session | 741K |
| Median cost/session | $0.59 |
| P95 cost/session | $34.96 |
| Prompt:completion ratio | 94:1 (98.5% prompt tokens) |

**Key insight:** prompt tokens dominate because each LLM call in the iteration loop (up to 20 per turn) resends the full conversation context. A 5-iteration turn with growing context pays prompt tokens on every iteration (e.g. 10K+20K+30K+40K+50K = 150K total).

Token growth by session length:
- Short (16 msgs): 1.8x growth per call
- Medium (71 msgs): 7.7x growth
- Long (142 msgs): 7.9x growth
- Heaviest (293 msgs, $51): 2.7x growth (started large from prior scheduled runs)

### Changes Implemented

**1. Anthropic Prompt Caching via Bedrock Converse API**
- Replaced LangChain `ChatBedrockConverse` with direct `ConverseCommand` from `@aws-sdk/client-bedrock-runtime`
- Added `cachePoint` markers: one after system prompt, one before the last message
- Within the tool-call iteration loop, each subsequent call only pays full price for the newest exchange; all prior turns hit the cache (90% discount on cached input tokens)
- Cache metrics logged: `AgentMode: Bedrock cache — read: X, write: Y, uncached input: Z, output: W`
- Cost estimation updated to account for cache read (10% of input price) and write (125% of input price) tokens
- Files: `agentModeService.ts` (getBedrockClient, convertToBedrockConverse, estimateCost)

**2. Aggressive Tool Result Summarization**
- Old tool results (beyond most recent 3) now compressed to ~200-char previews: `[Tool: tool_name — preview...]`
- Previously these were truncated to 8KB each — with 50+ tool results that's still 400KB of context
- New approach reduces old tool context by ~97% while preserving tool name and a content hint
- Files: `agentModeService.ts` (trimToolMessagesForContext)

### Estimated Savings
- Prompt caching: 30-50% on Claude model sessions (system prompt + conversation prefix cached)
- Tool summarization: 20-40% additional reduction on long sessions with many tool calls
- Combined: 50-70% cost reduction expected on typical sessions

### Future Optimization Opportunities
- Context window summarization (compress old turns into a recap instead of dropping them)
- Dynamic tool filtering (only send relevant tools based on conversation context)
- Scheduled session reset (start each run with summary of prior run instead of full history)
- See "Conversation Summarization Design" section above for the summarization design

## Known Limitation: `get_chat_history` Tool Crashes on Large Time Ranges (2026-03-27)

The `get_chat_history` admin tool (used by Emma to analyze usage) crashes when querying large time ranges (e.g. 7 days). Root cause:

1. `chatbotService.getRecentSessionsPage()` with a time range does an **unbounded fetch-all-then-slice** — a `do...while` loop paginates through ALL DynamoDB pages before applying `limit` as a post-fetch `Array.slice()`. For 7 days, this fetches ~1,100+ session records into memory.
2. The admin route (`GET /api/admin/chat-sessions`) then calls `getChatSession()` for each returned session (up to 100) via `Promise.all`, loading full message content — 100 parallel DynamoDB queries.
3. The full response (100 sessions with all messages) is returned as a tool result to the LLM, which can exceed context/memory limits and crash the agent mid-stream.

**Impact:** Session `1e5af232-1164-46cb-bce5-83d76edd6734` crashed when the user asked Emma to "fetch the chat history of last 7 days, then count the total usage and cost per accounts."

**Potential fixes (not yet implemented):**
- Push `Limit` into the DynamoDB query (early termination) instead of fetch-all-then-slice
- Add a `metadata_only` mode to skip loading full messages when only counts/costs are needed
- The tool's `limit` param defaults to 100, but the DynamoDB fetch still retrieves all 1,100+ sessions before slicing

## Usage & Cost Analysis — Week of March 21–27, 2026

### Summary

| Metric | Value |
|--------|-------|
| Total sessions | 987 |
| Sessions with cost tracking | 305 (31%) |
| Sessions without cost tracking | 682 (69%) |
| Total tracked cost | $1,414.14 |
| Projected monthly cost (×4.3) | ~$6,081 |
| Avg cost/session (tracked) | $4.64 |
| Median cost/session | $0.57 |
| Unique users | 62 |

**Note:** 69% of sessions have no cost data. These are likely sessions that either (a) errored out before any LLM call, (b) used models where cost tracking wasn't implemented, or (c) are predefined-work-plan previews from anonymous users that didn't complete.

### By Subscription Tier

| Tier | Users | Sessions | Cost | Avg/User (7d) | Avg/Session |
|------|------:|---------:|-----:|---------------:|------------:|
| Super Premium | 17 | 693 | $1,138.78 | $66.99 | $1.64 |
| Advanced | 4 | 47 | $131.21 | $32.80 | $2.79 |
| Free / Anonymous | 40 | 210 | $138.34 | $3.46 | $0.66 |
| Basic | 1 | 37 | $5.80 | $5.80 | $0.16 |

Super Premium users drive **80.5%** of total cost ($1,139 of $1,414). Advanced users are the most expensive per-session ($2.79 avg) — they tend toward complex research workflows. Free/anonymous users are mostly work-plan previews (single-session anonymous users) plus a few registered Free accounts.

### Cost Distribution (305 tracked sessions)

| Percentile | Cost |
|-----------|-----:|
| Min | $0.01 |
| P25 | $0.17 |
| Median | $0.57 |
| P75 | $3.32 |
| P90 | $11.05 |
| P95 | $23.25 |
| P99 | $56.25 |
| Max | $106.76 |

The distribution is heavily right-skewed: 75% of sessions cost under $3.32, but the top 5% cost $23+ each and drive a disproportionate share of total spend.

### Top Accounts by Cost (7 days)

| Account | Tier | Sessions | Cost | Avg/Sess | Primary Activity |
|---------|------|----------|------|----------|-----------------|
| renata@your360.ai | Super Premium | 112 | $324.64 | $2.90 | Regular chats, some scheduled |
| founders@agentweb.pro (internal) | Super Premium | 199 | $215.30 | $1.08 | Regular + 50 scheduled + testing |
| amrutha@structuredlabs.com | Super Premium | 36 | $204.38 | $5.68 | Regular chats (high complexity) |
| agentwebintegration@xcures.com | Super Premium | 70 | $156.07 | $2.23 | Scheduled + regular |
| juan@usehaven.ai | Advanced | 8 | $92.72 | $11.59 | Complex regular sessions |
| dyllan@rankai.ai | Super Premium | 54 | $57.15 | $1.06 | Regular chats |
| harsha@agentweb.pro (internal) | Super Premium | 71 | $49.35 | $0.70 | Regular + scheduled + work plans |

**Key observation:** The top 5 external users (all Super Premium / Advanced) account for $834.96 (59% of total cost). Since these tiers are not yet billed, this is pure cost with no revenue offset.

### By Session Type

| Type | Sessions | Cost | Avg/Session |
|------|----------|------|------------|
| Regular (live chat) | 752 | $948.06 | $1.26 |
| Scheduled | 180 | $265.27 | $1.47 |
| Predefined work plan | 49 | $188.31 | $3.84 |
| Result endpoint | 1 | $11.95 | $11.95 |
| Video/image gen | 5 | $0.56 | $0.11 |

Predefined work plans cost ~3× more per session than regular chats — they involve multi-step workflows with many tool calls.

### Daily Trend

| Date | Sessions | Cost |
|------|----------|------|
| Mar 21 | 60 | $132.04 |
| Mar 22 | 67 | $102.67 |
| Mar 23 | 82 | $208.82 |
| Mar 24 | 85 | $427.74 |
| Mar 25 | 213 | $92.86 |
| Mar 26 | 317 | $322.91 |
| Mar 27 | 163 | $127.09 |

Session volume is growing (~3× from Mar 21 to Mar 26). Mar 24 was the most expensive day ($427.74) despite having fewer sessions — likely driven by a few high-cost complex sessions. Mar 25 had the most sessions (213) but lowest cost ($92.86), likely due to prompt caching optimizations deployed that day.

### Top 10 Most Expensive Individual Sessions

| Cost | User | Type | Title |
|------|------|------|-------|
| $106.76 | renata@your360.ai | regular | Agent Mode Session |
| $78.05 | xcures.com | scheduled | Weekly Competitor News Researcher |
| $65.14 | renata@your360.ai | regular | Adding Videos to Landing Pages |
| $56.25 | dyllan@rankai.ai | regular | SEO/GEO/AEO Competitor Ad Scraping |
| $51.90 | amrutha@structuredlabs.com | regular | Waldium Hero Banner CSS Analysis |
| $51.35 | juan@usehaven.ai | regular | Competitor Meta Ads Analysis |
| $46.76 | renata@your360.ai | regular | Meta Campaign Overview |
| $43.45 | amrutha@structuredlabs.com | regular | Landing Page Hero Banner Redesign |
| $42.59 | amrutha@structuredlabs.com | regular | Waldium Hero Banner CSS Analysis |
| $37.36 | ruiwangwarm@gmail.com | regular | Ella's Book Sale Poster |

### Revised Token Limits (March 27, 2026)

Based on the usage data above and discussion, the revised token limits are:

| Tier | Current DB Value | Monthly Token Limit | Rationale |
|------|-----------------|--------------------:|-----------|
| **Free** | Free | **1M** | ~10–15 sessions. Enough to see value, caps within first week of active use |
| **Basic** | Basic | **20M** | ~130–200 sessions. Basic users are not yet active so current data is limited; 20M provides comfortable headroom for light-to-moderate daily use |
| **Pro** | Super Premium / Advanced | **100M** | ~650–1000 sessions. Covers most Pro users comfortably (avg Super Premium user projects to ~40-50M/month). Heavy users will approach the limit |
| **Enterprise** | Enterprise (new) | **500M** | Soft cap to prevent abuse. Effectively unlimited for any realistic usage pattern |

**Tier mapping (current DB `subscriptionType` → new tier names):**
- `Free` → Free
- `Basic` → Basic
- `Super Premium` / `Advanced` → Pro
- New: `Enterprise` (not yet in DB)

**How the top users fit under these limits:**

| Account | Current Tier | Monthly Cost (proj.) | Est. Monthly Tokens | Fits in? |
|---------|-------------|---------------------:|--------------------:|----------|
| renata@your360.ai | Super Premium → **Enterprise** | ~$1,396 | ~150–200M | Yes (Enterprise 500M) |
| founders@agentweb.pro (internal) | Super Premium → **Enterprise** | ~$926 | ~100–130M | Yes (Enterprise 500M) |
| amrutha@structuredlabs.com | Super Premium → Pro | ~$879 | ~100–120M | Tight — may hit 100M limit |
| agentwebintegration@xcures.com | Super Premium → Pro | ~$671 | ~80–90M | Yes, with room |
| juan@usehaven.ai | Advanced → Pro | ~$399 | ~50–60M | Yes |
| dyllan@rankai.ai | Super Premium → Pro | ~$246 | ~30–40M | Yes, comfortable |
| harsha@agentweb.pro (internal) | Super Premium → **Enterprise** | ~$49 | ~7M | Yes |

**Key decisions:**
- **renata@your360.ai** should be upgraded to Enterprise tier — her projected ~150–200M tokens/month exceeds the Pro 100M cap.
- **Internal accounts** (founders@, harsha@, ruiw@) should be Enterprise tier to avoid hitting limits during testing/development.
- **Basic users** are not currently active, so their usage data doesn't reflect real-world patterns. The 20M limit is set generously and can be adjusted once Basic users are onboarded and billing is active.
- **Model cost multipliers** (Opus = 7x, see March 20 proposal) are still recommended to protect margins on the Pro tier. Without multipliers, a Pro user running all-Opus sessions could consume $700+ in cost against a ~$499 price point.

**Margin analysis (post-caching, GPT-5 blended ~$2/1M effective):**

| Tier | Price | Limit | Max Cost to Us | Min Gross Margin |
|------|------:|------:|---------------:|-----------------:|
| Free | $0 | 1M | ~$2 | -$2 (acquisition) |
| Basic | $199 | 20M | ~$40 | ~$159 (80%) |
| Pro | $499 | 100M | ~$200 | ~$299 (60%) |
| Enterprise | Custom ($1K+) | 500M | ~$1,000 | Negotiated |

Post-caching margins are healthy across all paid tiers. The risk is Opus-heavy Pro users (effective cost ~$14/1M with caching) — at 100M tokens that's $1,400, well above the $499 price. Model multipliers or tier-restricted model access would mitigate this.

### Prompt Caching Impact (Mar 25 deployment)

The prompt caching optimization was deployed on Mar 25. Comparing per-session costs:
- Pre-caching (Mar 21–24, 294 sessions): $870.27 → $2.96/session avg
- Post-caching (Mar 25–27, 693 sessions): $542.86 → $0.78/session avg

**~74% reduction in avg cost per session.** Even accounting for session mix variation, caching is clearly delivering significant savings. The projected monthly cost of $6,081 already reflects the post-caching rates; without caching it would have been ~$16K+/month

## Meta Ad Spending Limit Investigation (2026-04-08)

### Context

Investigated options for controlling Meta ad spend to prevent overspending when the agent creates/modifies ad campaigns on behalf of users.

### Current State

- **Budget guardrails exist in `agentModeService.ts`** (hardcoded): daily budget max $5,000, lifetime max $50,000 per ad set
- **No user-configurable spending cap** — limits are hardcoded safety rails only
- Meta ad account config stored in `AW-Users` → `connected_accounts[]` (no spending cap field)
- Primary spend control is currently via Ramp virtual credit card with a hard limit set per card

### Options Evaluated

**Option A: App-level advisory cap per connected account**
- Store a `spendingCap` field in DynamoDB alongside each Meta ad account config
- Before creating/updating ad sets, query Meta Insights API for current month spend
- Reject if projected spend would exceed cap; show spend vs cap in Settings UI
- Pros: User-configurable, visible in UI, works alongside card limit
- Cons: Relies on Meta's reported spend (slight lag), doesn't hard-stop if Meta overbills

**Option B: Meta's native Account Spending Limit (ASL)**
- Meta's Marketing API supports `spend_cap` on the ad account (`/act_{id}?fields=spend_cap`)
- Surface this in Settings so users can set/update it via our UI
- Meta natively enforces it — pauses all ads when limit is hit
- Pros: Hard stop enforced by Meta, no lag, most reliable
- Cons: Requires manual reset after billing cycle, another API call surface

**Option C: Combined A + B**
- App-level soft cap (advisory, warns before creating) + Meta-level hard cap (ultimate backstop)

**Option D: Per-session budget envelope**
- User sets a max spend for the current agent session; agent tracks total allocated across ad sets
- Pros: Very simple, no schema changes, no Meta API calls
- Cons: Doesn't account for existing scheduled spend, resets each session

### Decision

**Continue using Ramp virtual card approach for now.** Each Meta ad account is funded via a Ramp virtual credit card with a hard spending limit configured on the card. This provides a reliable, externally-enforced hard stop without any additional code complexity. Revisit in-app controls (Option A or B) if:
- We manage ad accounts for customers where card-per-account isn't practical
- Users request the ability to self-configure limits without admin intervention

## Meta Marketing API Version Upgrade to v24.0 (2026-04-14)

Meta notified that all Marketing API versions prior to v24.0 will be deprecated on June 9, 2026 (v23.0 and below). Updated `META_API_VERSION` to `v24.0` in both staging and production Elastic Beanstalk environment configs.

**Code changes (on branch `rui/upgrade-meta-api-version`):** All hardcoded `v18.0` fallback defaults in source code will be updated to `v24.0` to match the env var. Affected files:
- `backend/src/routes/meta.ts` (3 locations)
- `backend/src/services/agentModeService.ts` (2 locations)
- `backend/src/services/clientHealthService.ts` (1 location)
- `backend/src/services/metaService.ts` (3 locations)
- Test files: `metaAuth.test.ts`, `instagramService.test.ts`, `agentModeService.metaMetrics.test.ts`, `agentModeService.listMetaAdsCampaigns.test.ts`

**Note:** `backend/src/config/integrations.ts` was already at `v24.0`. No customer-portal changes needed.

## Email Verification on Sign-Up — Decision to Postpone (2026-04-16)

### Context

Investigated and implemented email verification for email/password sign-ups (Option B — soft verification with a warning banner, no access gates). The implementation is complete and tested on branch `rui/support-email-verification-in-sign-up`.

### Decision: Postpone

**We are not shipping this now.** The team introduction email already serves a partial verification purpose — every new sign-up receives a personal email from the founders, which organically surfaces invalid/throwaway addresses. Adding a second verification email on top of that would create unnecessary friction for new users at a point where conversion matters most.

**The code is parked on the branch and can be picked up later if needed.** Revisit if:
- Spam/fake account volume becomes a real problem
- A compliance requirement demands explicit email confirmation
- The team introduction email flow changes or is removed

## CRM Enrichment Cost Investigation (2026-04-16)

### Context

Investigated the API cost structure for the lead enrichment feature (`crmEnrichmentService.ts`) to understand per-lead spend across web search, LLM extraction, and LinkedIn lookup.

### APIs and Cost per Lead

| Component | Provider | Calls/Lead | Est. Cost/Lead |
|-----------|----------|-----------|----------------|
| Web Search | Google Custom Search | 1–2 (fallback on empty) | ~$0.005–0.01 |
| LLM Extraction | Gemini 3.1 Flash Lite | 1–2 (retry on parse fail) | ~$0.00015 |
| LinkedIn Lookup | Unipile | 0–3 (if LinkedIn source enabled) | ~$0.03–0.15 |
| **Total** | | **2–7** | **~$0.005–0.16/lead** |

### Key Findings

- **Web search only:** ~$0.005–0.01/lead (dominant cost without LinkedIn)
- **With LinkedIn:** ~$0.04–0.16/lead (Unipile per-profile cost dominates)
- **LLM cost is negligible** (~$0.00015/lead) given Gemini Flash Lite pricing
- Concurrency: 20 parallel workers (no LinkedIn) or 5 (with LinkedIn) — peak burst can hit Google Custom Search quotas (known issue from Feb 2026)
- **No cost tracking or metering exists** for enrichment operations; usage is not counted against user token quotas

### Model Change (2026-04-16)

Switched `SUGGEST_MODEL` from `gemini-2.5-pro` to `gemini-3.1-flash-lite-preview` to match `ENRICH_MODEL`. Field suggestion is a structured extraction task (not complex reasoning), so the cheaper/faster model is sufficient.

### Cost Tracking Decision

**Delaying cost tracking for enrichment until the feature is used more widely.** Current usage volume does not justify the instrumentation overhead. When enrichment adoption grows, add per-enrichment token/API call accounting to `tokenUsageService.ts` and meter it against user subscription allowances. Revisit when:
- Enrichment is a standard part of multiple users' workflows
- Monthly enrichment API cost becomes visible in billing analysis
- Subscription tiers need to differentiate on enrichment volume

## Work Plan Parallel Step Execution — Investigation (2026-04-17)

### Context

Investigated whether work plan steps can be executed in parallel when they don't depend on each other.

### How Work Plans Execute Today

Work plans are **linear LLM-guided checklists**, not an execution engine. Steps are injected into the LLM's prompt context via `buildMarketingContext()` (`agentModeService.ts:2221`). The LLM reads the current pending step, does the work, calls `setWorkPlanStatus()` to mark it complete, then moves to the next. There is no dispatch loop — execution is driven by the single LLM conversation thread, one turn at a time.

`WorkPlanStep` has no dependency or grouping fields today (`stepCount`, `title`, `description`, `requiredFunctionCalls`, `skillIds`).

### Why True Step-Level Parallelism Is Not Well Supported

An Agent Mode session is a **single LLM conversation thread**: one LLM turn at a time, tools execute, then the next turn starts. Parallelizing multi-turn steps (steps that require multiple rounds of tool calls and LLM reasoning) would require each step to run its own independent LLM loop. The only mechanism for that is sub-agents (via the swarm infrastructure, `backend/src/services/swarm/`), but sub-agents have isolated contexts — they can't share session state mid-execution — and add significant spawn overhead. This makes step-level parallelism via sub-agents architecturally complex with limited practical benefit for the typical plan.

### Existing Parallelism: Tool Calls

**Claude already supports parallel tool calls within a single LLM turn.** When the LLM issues multiple tool calls in one response, they execute concurrently. This is the natural and well-supported parallelism primitive in Agent Mode.

### Decision

**We will not add a parallel step execution mechanism.** Instead, steps that could logically run in parallel should be **merged into a single step** with a description that instructs the LLM to accomplish both objectives. The LLM will naturally fire the required tool calls in parallel within that one step's turn, achieving the same concurrency without any infrastructure changes.

This keeps the work plan model simple (linear checklist) and leverages parallelism that already works reliably. Revisit if a future use case genuinely requires independent multi-turn parallel workstreams — at that point, sub-agent orchestration would be the right path.

## LinkedIn Outreach — Email Finding Investigation (2026-04-16)

### Context

Investigated whether the LinkedIn outreach feature can be used to find or retrieve email addresses for prospects.

### Findings

**LinkedIn does not expose email addresses via its API.** The Unipile SDK (used by `linkedInOutreachService.ts`) returns the following fields for a LinkedIn profile: `provider_id`, `public_identifier`, `first_name`, `last_name`, `headline`, `location`, `network_distance`, `is_open_profile`, `work_experience`, `summary`, `profile_picture_url`. Email is not among them — this is a deliberate LinkedIn platform restriction, not a gap in the Unipile integration.

All 10 LinkedIn outreach actions (`search-people`, `get-profile`, `send-invite`, `send-message`, `update-conversation-history`, etc.) operate on profile URLs and provider IDs only. The CRM lead record stores the LinkedIn profile URL in the `linkedin` field but no email derived from it.

### Decision

**Finding email from LinkedIn is not supported and will not be added to the LinkedIn outreach feature.** Email discovery is an enrichment concern, not an outreach concern. If email finding from a LinkedIn profile is needed, it should be implemented as part of the CRM enrichment feature (`crmEnrichmentService.ts`) using a third-party enrichment provider (e.g. Apollo.io, which accepts LinkedIn profile URLs and returns verified business emails). This keeps outreach and enrichment concerns cleanly separated.

## Goalden Hour Meta Ad Account — Ownership Investigation (2026-04-20)

### Context

Investigated who owns the Goalden Hour ad account in Meta (Facebook) Business Manager, and what steps are needed to transfer or grant access.

### Findings

The Goalden Hour Meta ad account is currently **owned by individual people**, not by a Business Manager. Only the AgentWeb team has full (Admin) control at this time.

### Short-Term Action: Grant Goalden Hour Admin Access

To give the Goalden Hour team full operational control without transferring ownership:

1. Go to [business.facebook.com](https://business.facebook.com) → **Business Settings**
2. Click **Accounts** → **Ad Accounts** → select the Goalden Hour ad account
3. Click **Add People** → search for the Goalden Hour contact by name or email
4. Set their role to **Admin** (full control: manage people, billing, settings, run ads)
5. Click **Confirm**

This gives them full operational access while ownership stays with the current individual.

### Future Action: Transfer Ownership to Business Manager

When ready to transfer formal ownership to the Goalden Hour Business Manager:

1. The current individual owner must be cooperative
2. **Option A (preferred):** In Meta Business Manager → Business Settings → Ad Accounts → Add → **Claim an Ad Account** → enter the account ID. The individual owner approves the claim.
3. **Option B:** The individual goes to their Ad Account Settings → Ad Account Roles → adds the Goalden Hour Business Manager as Admin, then initiates a transfer.
4. **Option C (last resort):** Contact Meta Support with proof of business ownership if the individual is unreachable.

> **Caveat:** Once an ad account is claimed by a Business Manager, it cannot be moved to another Business. Confirm the correct Business Manager before claiming.

### Decision

**Short term:** Grant the Goalden Hour contact Admin access so they have full operational control immediately. **Long term:** Initiate a formal ownership transfer/claim into their Business Manager when they are ready to do so.

## Security Breach Investigation — Lovable & Vercel (2026-04-21)

### Context

Investigated whether AgentWeb is impacted by two security incidents:
1. **Lovable security breach** — Lovable (vibe coding platform) disclosed a broken object-level authorization flaw in their API that allowed unauthorized access to user projects, source code, database credentials, and AI chat histories. The vulnerability was unpatched for 48 days after discovery on March 3, 2026.
2. **Vercel security breach** — Vercel disclosed a security incident. Vercel sent official email communication confirming: *"At this time, we do not have reason to believe that your Vercel credentials or personal data have been compromised."* **Status: Safe, no action required.**

### Lovable Exposure Analysis

The customer-portal repo originated as a Lovable project and remains connected to it. Artifacts found:

**1. External CDN script in `index.html:70`**
```html
<script src="https://cdn.gpteng.co/gptengineer.js" type="module"></script>
```
Loaded on every page, runs with full browser context. If Lovable's infrastructure is compromised this is a vector for client-side code execution. **Highest priority to remove.**

**2. `lovable-tagger` npm package (`package.json:112`, `vite.config.ts:4,38`)**
Sends component metadata to Lovable during dev builds. Not evidence of npm compromise, but is telemetry going to a breached vendor. Remove as hygiene.

**3. Fallback URL in `src/config.ts:9`** pointing to `https://preview--agentweb-customer-portal.lovable.app` — cosmetic, but should be cleaned up.

**Key clarification:** The Lovable breach is a **platform data leak** (their API exposed stored project data), not a CDN/supply chain attack. The primary risk to us is: if any real credentials (API keys, env vars, secrets) were ever entered into the Lovable project editor, those may have been exfiltrated.

### Status & Next Steps

- **Vercel:** Confirmed safe per official Vercel email. No action required.
- **Lovable:** Awaiting Lovable's official email notification to determine whether our specific project was accessed during the breach. Once received, assess whether any credentials need rotation.
- **Code cleanup (planned):** Remove CDN script, lovable-tagger, and Lovable URL fallback from customer-portal regardless of breach outcome — these are unnecessary Lovable dependencies.

## Meta Account Connection Failure — karthy@goaldenhour.com (2026-04-20)

### Context

karthy@goaldenhour.com (userId: `4027bc5c-0f89-4236-b63e-b0186c634a1c`) reported that connecting their Meta ad account failed.

### Root Cause

Production logs at `Apr 19 00:55:35` showed:

```
[Meta Finalize] getAdAccounts failed — code=n/a classification=n/a
message=Meta API Error: (#200) Requires business_management permission to manage the object
```

The OAuth flow (`flow=marketing`) exchanges the code and gets a valid access token, but the subsequent `/me/adaccounts` API call requires the `business_management` permission. Our current `marketingScopes` in `backend/src/config/integrations.ts` only requests `ads_management`, `ads_read`, and `pages_show_list`. The error is silently caught (`metaAuth.ts:248`) and returns 0 ad accounts, leaving the user unable to connect.

### Why `business_management` Was Not Added

Adding `business_management` to `marketingScopes` would fix the API error, but Meta only allows this permission under **Advanced Access** for customer-facing apps. Standard Access (which we currently have, status Active with 561 users) restricts the permission to users who have a developer/admin/tester role on the Facebook App — it does not work for general customers. Obtaining Advanced Access requires a Meta App Review with a detailed use-case submission and is slow/difficult to get. Decision made after discussion with Harshit@Argusoft.

### Short-Term Fix (Implemented)

The Goaldenhour ad account is now under our (AgentWeb's) control. **We granted karthy@goaldenhour.com full access to the ad account directly through Facebook Business Manager.** This means their user token already has access to the account without needing `business_management` — they can connect successfully today.

### Long-Term Fix

Pursue **transfer of ownership** of the Goaldenhour ad account to Goaldenhour itself via Facebook Business Manager. Once Goaldenhour owns the account, karthy (as an admin of that business) will be able to grant `ads_management` and `ads_read` access through normal OAuth without needing `business_management`. No code changes required for this path either.

## Google OAuth App Review — Gmail Connected Accounts (2026-04-24)

### Status

**App review submitted / in progress.** Review typically takes 4–6 weeks for restricted scopes.

### Google Cloud Project

- **Project Name:** AgentWeb
- **Project ID:** `gen-lang-client-0725723168`
- **Project Number:** `606140610214`
- **OAuth Client ID:** `606140610214-tqm4fkgp6o7m4e5aq4n13n09ijqfhaij.apps.googleusercontent.com`
- **Credentials stored in:** AWS Secrets Manager at `prod/AgentWeb/Google/Gmail`

### Scopes Under Review

| Scope | Classification | Purpose |
|---|---|---|
| `https://www.googleapis.com/auth/gmail.readonly` | **Restricted** | Read user's Gmail inbox for AI-assisted email management |
| `https://www.googleapis.com/auth/gmail.send` | **Restricted** | Send emails on the user's behalf in AI outreach workflows |
| `https://www.googleapis.com/auth/calendar.readonly` | **Sensitive** | Read calendar to avoid scheduling conflicts |

`userinfo.email` and `userinfo.profile` are non-sensitive and do not require review.

### How to Submit / Re-Submit

1. Go to [Google Cloud Console](https://console.cloud.google.com) → project **AgentWeb** (`gen-lang-client-0725723168`)
2. Navigate to **APIs & Services → OAuth consent screen**
3. Ensure app name, support email, homepage (`https://app.agentweb.pro`), privacy policy, and ToS URLs are filled in
4. Click **"Submit for Verification"**
5. Provide scope justifications:
   - **`gmail.readonly`**: Read inbox to surface relevant emails in the AgentWeb AI assistant for outreach management
   - **`gmail.send`**: Send emails on behalf of users as part of AI-assisted outreach workflows (user reviews before sending)
   - **`calendar.readonly`**: Read calendar to help schedule meetings and avoid conflicts
6. Record a **demo video** (required for restricted scopes): show the OAuth flow and how each scope is used in the UI
7. Submit. Review takes **4–6 weeks** for restricted scopes.

### Notes

- While pending review, only users listed under **Test users** on the consent screen can authorize the Gmail connection
- The privacy policy must explicitly state Gmail data is not shared or sold
- Redirect URI registered in the OAuth client: `https://api.agentweb.pro/api/oauth/gmail/callback`
- YouTube connected accounts reuse the same Google Cloud project and OAuth client (`prod/AgentWeb/Google/Gmail`)

## Emma Self-Improvement — Investigation (2026-04-25)

### Context

Investigated how to get Emma to self-improve over time, inspired by agent self-improvement patterns like Reflexion.

### What Already Exists

The memory system (`AW-AccountMemory`) already covers the core use case:

- Categories: `preference`, `history`, `insight`, `workflow`
- Emma tools: `save_memory` (save a fact mid-session), `delete_memory` (remove by ID)
- Full CRUD API at `/api/memory` for user management
- All active memories are injected into every new session's system prompt (up to 20, most recent)

Emma already self-improves incrementally **within** a session: she can detect corrections or "remember that…" instructions and save them immediately via `save_memory`. Users can manage their memories via the customer portal settings UI.

### Gap Considered: Post-Session Auto-Extraction

The one missing piece is a post-session job that sends the full conversation transcript to an LLM and asks it to extract net-new learnings, then writes them to `AW-AccountMemory` automatically.

### Why We're Not Building It Now

Post-session auto-extraction risks being **overly aggressive**: the LLM may extract low-quality, redundant, or incorrect facts from routine exchanges (e.g., "user asked about SEO" → saves "user is interested in SEO" every session). This would pollute the memory store with noise and degrade Emma's quality over time rather than improving it.

The existing in-session `save_memory` mechanism is more precise because it only fires when there is a clear signal (explicit user instruction or detected correction). Auto-extraction has no such signal — it runs on every session regardless of whether anything new was learned.

### Decision

No action. The current memory system is sufficient. Revisit post-session extraction if we add a quality-scoring or deduplication layer that can filter out noise before writing.

## Thunderbird Connected Account — Investigation (2026-04-27)

### Context

Investigated whether Thunderbird.net could be supported as a connected account (similar to Gmail, LinkedIn, etc.).

### What Thunderbird Actually Is

**Thunderbird is a local desktop email client, not a platform.** There is no "Thunderbird account" to OAuth into, no REST API, and no webhooks. It is analogous to Outlook the desktop app, not Outlook.com. The mail data lives on whatever IMAP/SMTP server the user configured (Gmail, Yahoo, a custom domain, etc.) — Thunderbird is just the local interface to it.

Mozilla launched **Thundermail** (tb.pro, 2024) as a paid cloud email hosting service, but it is a standard IMAP/SMTP provider with no published developer API or OAuth flow.

### Why Thunderbird as a Connected Account Is Not Practical

- No OAuth authorization server exists — there is nothing to redirect users to
- No REST API — no way for our backend to read or send email via Thunderbird
- No webhooks or event system accessible outside the local process
- The only programmatic access to Thunderbird is via a WebExtension Add-on running *inside* the local Thunderbird process — a fundamentally different architecture that requires users to install an extension and only works while Thunderbird is open on their machine

### What We Can Support Instead

The email accounts that Thunderbird users configure are standard providers that we can already support or could support through existing mechanisms:

- **Gmail accounts** — already fully supported as a connected account via Gmail OAuth
- **Outlook / Microsoft 365** — could be added via Microsoft OAuth (same pattern as Gmail)
- **Thundermail and other IMAP providers** — could be added as a generic IMAP/SMTP connected account using credential-based auth (not OAuth)

### Decision

Do not build a Thunderbird-specific connected account — it is not architecturally feasible without requiring users to install a local extension. Instead, direct Thunderbird users to connect the underlying email account they use in Thunderbird (e.g., Gmail via the existing Gmail connected account flow).

## AI Eval Work Plan Duration — Investigation (2026-04-30)

### Context

Investigated a predefined-work-plan session (`AI_GTM_Position_Eval`, session `85aabd21`) that appeared to be still running after several minutes.

### Findings

**The session completed successfully — no stall or bug.** Timeline:

- `06:31:49` — Session created, user sent their URL
- `06:38:16` — Work plan step completed (~6.5 minutes of actual work)
- `06:38:27` — Session record updated in DynamoDB
- `06:44:48` — Satisfaction score evaluated (triggered ~6 min later by admin `GET /api/admin/chat-sessions?sync=true` poll)

The 6.5 minutes was real work by the "AI GTM Positioning Audit" skill:
- 3× `read_page_source` calls (scraping homepage and blog)
- 2× legacy web search calls (one failed and retried)
- 1× `create_html_file` generating a full HTML audit report
- 1× `save_file` to S3
- 24,650 completion tokens of output (Sonnet 4.6 model)

### Backend Architecture Notes

- **Work plan step completion** is driven by `set_work_plan_status` tool, which validates `requiredFunctionCalls` counts before marking a step done.
- **No artificial delays** exist in the work plan execution path — no polling loops, sleep, or retries beyond per-tool exponential backoff on transient errors.
- **`install_skills` counted as 0** because the skill was auto-installed at session creation (`createSessionWithPlan` installs all associated skills upfront); the tool never needs to be called explicitly.
- **Satisfaction scoring is not automatic** — it only triggers when an admin hits `GET /api/admin/chat-sessions?sync=true` (batch) or `POST /api/admin/chat-sessions/score`. The 6-minute post-completion gap was the admin dashboard sync polling interval.

### Frontend Completion Detection

The customer portal detects completion via SSE `complete` event → 800ms `setTimeout` → `GET /api/agent-mode/session/{sessionId}` refresh. UI shows completion as soon as work plan steps are `status: 'completed'`, independent of `satisfactionScore`. If the session appeared "still running" after `06:38`, that likely reflects a stale tab or the share link being opened before the SSE event was received.

### Decision

No action required. The execution time is expected given the volume of tool calls and token output. If we want to reduce perceived latency, options are: (a) use a faster model (Haiku 4.5) for the audit, or (b) stream intermediate progress messages to the UI as each tool call completes.

## LinkedIn Outreach Rate Limits — Investigation (2026-05-04)

### Context

Session `998e3e33` ("Scheduled: Rui - Daily LinkedIn Connection Outreach") scored 2/5. The agent attempted a high volume of outreach actions, hit LinkedIn's "Cannot resend yet" / `errors/already_invited_recently` rate limit, and kept retrying rather than stopping. The execution log showed a large number of repeated failed `send-invite` tool calls, and the agent claimed to have "bypassed the safety limit" — suggesting it did not recognize the errors as hard stop signals.

The next day's scheduled run succeeded without issue, confirming LinkedIn's cooldown window had elapsed and there is no persistent issue in the schedule itself.

### Root Cause

The `errors/already_invited_recently` error from Unipile (HTTP 422) is **not caught specifically** in production code. It falls through to the generic `handleError()` in `linkedInOutreachService.ts` (lines 38–50), which classifies it as a generic `VALIDATION_ERROR` (same bucket as malformed input). The agent mode handler (`agentModeService.ts` ~line 20709) only special-cases `AUTH_ERROR` and disconnected account errors — it has no awareness that a `VALIDATION_ERROR` here means "rate limited, stop sending invites for now."

As a result, the agent received repeated "validation error" responses, did not interpret them as a stop signal, and looped.

### Code Gaps Found

| Gap | File | Lines |
|-----|------|-------|
| `errors/already_invited_recently` not caught — classified as generic `VALIDATION_ERROR` | `linkedInOutreachService.ts` | 38–50, 309–325 |
| No pre-flight check for pending invitations before `sendInvitation()` | `linkedInOutreachService.ts` | 331–355 |
| Agent mode handler only special-cases AUTH errors, not rate limit errors | `agentModeService.ts` | ~20709–20735 |

A test at `backend/src/__tests__/linkedInOutreachService.test.ts:163–178` covers the scenario and shows the correct Unipile error shape, but the corresponding production catch does not exist.

### Decision

No action yet. The schedule recovered on its own the next day. We will wait until this recurs before implementing fixes. If it does recur, the fix is:
1. Detect `errors/already_invited_recently` specifically in `handleError()` and return a distinct `RATE_LIMIT_ERROR` type (separate from generic `VALIDATION_ERROR`)
2. Surface a clear "rate limited — stop sending invitations" signal to the agent in the `send-invite` tool response
3. Optionally add a pending-invite pre-flight check in `sendInvitation()` before calling Unipile

## Quality Agent Tool for Emma — Design Decision (2026-05-04)

### Context

Explored adding a dedicated `assess_quality` tool that Emma could call after generating content (LinkedIn posts, blog articles, ad images, etc.) to score and justify the quality of her output. The existing `sessionScoringService.ts` already scores sessions on a 1–5 scale across three dimensions (goalCompletion, dataAccuracy, outputQuality) but operates at session level and is admin-only.

### Options Considered

1. **New `assess_quality` Emma tool** — standalone tool with per-content-type rubrics, called proactively or on-demand after content creation.
2. **Quality built into creation tools** — modify `create_social_media_posts`, `create_blog_article`, etc. to return a quality object alongside the content.
3. **Expose session scoring to Emma** — extend `scoreSessionIfNeeded` to extract and score individual artifacts from conversation history.

### Decision

**Defer all three options.** Chosen approach instead: add a Content Quality Standard section to Emma's system prompt (`agentModeSystemPrompt.ts`) instructing her to draw on brand/ICP context before generating content and briefly justify quality choices inline after generation. This is simpler, zero-latency, and directly addresses the root cause (generic/slop output) without added tooling complexity.

The quality agent tool approach was set aside for the following reasons:
- **UX impact**: Every content creation call would incur an additional LLM round-trip (~2–3s), visibly slowing Emma's responses.
- **Complexity**: Per-content-type rubrics require ongoing maintenance; scoring prompts would drift from actual quality criteria over time.
- **Diminishing returns**: The session scorer already captures output quality as a dimension. A separate per-artifact scorer adds infra without clear signal advantage until we have evidence the prompt-level fix is insufficient.

### Future Consideration

Revisit if prompt-level instruction proves insufficient — i.e., Emma continues producing generic content despite the quality standard directive. At that point, Option 1 (standalone `assess_quality` tool with content-type-specific rubrics) is the recommended starting point.

## Emma in Internal Slack Channels — Investigation (2026-05-08)

### Context

Investigated how to enable Emma to respond meaningfully when team members @mention her in AgentWeb's internal Slack workspace. The goal: a platform-wide Emma that can answer engineering and product questions in internal channels, not just serve customer accounts.

### The Core Tension

Emma's context pipeline is account-scoped. Every response call flows through:
1. `generateChatResponse()` (`chatbotService.ts:3610`) — requires a `userId` to anchor context
2. `searchPlatformKnowledgeBase(userId)` — queries Vertex AI Discovery Engine indexed per user
3. Per-session tool sets injected based on the current page URL and user account configs

In internal Slack channels there is no customer `userId` to anchor on. Calling Emma without this identity produces a context-starved response with no product knowledge, no KB results, and the wrong (customer-facing) system prompt tone.

### Existing Slack Infrastructure (Reusable)

The current `app_mention` event handler (`slack.ts:566`) already:
- Detects `@Emma` mentions and creates Agent Mode sessions
- Posts threaded replies via `handleSlackSessionResponse()`
- Maps threads to sessions (settings key: `slack_thread_{channel}_{ts}`)
- Has a Slack client instance and `postThinkingMessage()` / `postThreadResponse()` utilities

This plumbing is ~100% reusable. The work is in defining a new identity and context model for the internal context.

### Options Explored

**Option 1: Platform Admin Identity (Low effort)**
Designate a special internal identity (e.g. `emma-internal@agentweb.pro`). Route `app_mention` events from the internal workspace (`teamId` check) to this identity. Pre-populate its KB in Vertex AI with product docs, release notes, and runbooks. Emma's existing KB search pipeline works unchanged — just a different `userId`.

**Option 2: Dynamic Context Aggregation (Medium effort)**
Detect internal workspace via `teamId`, then compose context chunks before calling `generateChatResponse()`: recent PRs (`gh` API), deployment status, sprint tasks (Notion MCP), recent backend errors. Inject as structured context — same pattern Emma uses for page-aware tools.

**Option 3: Separate Internal System Prompt + Tool Set (Medium effort)**
Add `getInternalEmmaSystemContext()` alongside the existing `getEmmaSystemContext()`. Internal variant uses engineering-appropriate tone and exposes internal tools: `get_recent_prs`, `get_deployment_status`, `get_sprint_tasks`, `search_codebase_docs`. Add a parallel `handleInternalSlackSession()` path in the Slack event handler. Session storage and threading reused as-is.

**Option 4: Clarifying-Question Meta-Tool (High effort)**
Internal Emma gets a `clarify_context` tool. When context is insufficient, she asks a follow-up in the thread before answering. Combined with Option 3's tool set, she can answer "why is the LinkedIn connector failing?" by querying deployment logs, or ask "which user?" if she needs more info.

### Recommended Phased Approach

- **Phase 1 (Options 1 + 3):** Platform admin identity + internal system prompt. Gets Emma functional in internal channels with correct tone. ~1 day of work.
- **Phase 2 (Option 2):** Layer dynamic context: auto-inject release notes, recent PRs, sprint tasks. ~2 days.
- **Phase 3 (Option 4):** Clarifying questions + deeper tool integrations once pattern is proven. ~3 days.

### Decision

**Stick with the current account-scoped Emma implementation for now.** Internal Slack coverage is not a near-term priority. No changes planned in the immediate roadmap. Revisit when the team actively needs Emma to answer platform-level questions in Slack — at that point Phase 1 (admin identity + internal system prompt) is the recommended starting point given it reuses the most existing infrastructure.

---

## May 10, 2026: Lesson - CI Must Fail Cheaply When Tests Regress

### Incident

A customer portal PR had serious test-suite issues that exhausted GitHub Actions credits before the test job could finish. The suite had real failures, stale assertions, timer leakage, and a same-tab state synchronization loop, but the workflow allowed every run to consume the full job budget.

### Root Causes

- PR test workflow did not cancel older runs when newer commits were pushed.
- The test command did not fail fast, so one known failing area could leave the rest of the suite running.
- Vitest workers were too aggressive for a memory-heavy suite in CI.
- Fake timers leaked across files and caused unrelated tests to hang or time out later.
- A hook wrote localStorage, dispatched a same-tab event, re-read a fresh array, set state again, and repeated.
- Several tests were asserting obsolete UI output after the product had moved from raw JSON/debug text to humanized summaries.

### Guardrails To Apply

- Add PR workflow `concurrency` with `cancel-in-progress: true`.
- Run expensive suites with fail-fast behavior, for example `--bail=1`.
- Add a shell-level timeout shorter than the GitHub job timeout, so CI exits with useful logs before the platform kills the job.
- Keep CI worker counts conservative for large jsdom suites.
- Use fake timers only in tests that need them, and restore real timers in setup/cleanup.
- Treat stale tests as production risk when they hide real failures or force full-suite retries.
- Keep passing-test logs quiet enough that the first failure is obvious.

### Principle

Tests will occasionally fail or hang. CI must make that failure cheap, bounded, and easy to diagnose instead of letting a single regression consume the entire Actions budget.

## Emma "Forgot Brand" — Root Cause & Fix (2026-05-10)

### User Report

User `phoenixtech@agentweb.pro` (Phoenix Technologies) reported that Emma "forgot their brand" during a session (`a93853a9-923a-44bb-a176-6c6eaefbe587`). The user was asking Emma to generate Meta Image Ad Prompts. Emma replied asking *"What's the product or company these Meta image ads are for?"* — even though the user had a rich, fully-populated brand profile (Phoenix Technologies, Kevin Zhang, detailed tone of voice, key messages, etc.).

### Root Cause

Emma violated the system prompt rule at `agentModeSystemPrompt.ts:306`:

> "Before asking the user for business details... ALWAYS call `read_brand_guidelines` and `read_market_strategy` first."

The LLM skipped this rule and asked the user for context it already had access to via tools. This is a prompt-instruction compliance failure — the system prompt said what to do, but the model chose a clarifying-question flow instead.

Session transcript summary:
1. User: "Generate Meta Image Ad Prompts for ChatGPT Images 2.0"
2. Emma: "What's the product or company?" ← violated rule
3. User: "My brand!" (frustrated)
4. Emma: "Who is the target customer?" ← asked again
5. User: "Look at Market Strategy"
6. Emma: called `read_market_strategy`, then proceeded correctly

The brand data was present in DynamoDB (`AW-Users.brandGuidelines`) and would have been returned had Emma called `read_brand_guidelines` upfront.

### Fix Applied

Added `read_brand_guidelines` and `read_market_strategy` to the foundation tools list in the admin Agent Mode settings page. These tools were already in `DEFAULT_FOUNDATION_TOOLS` in `agentModeService.ts` (line 2817–2819) as the code-level fallback, but were not present in the DB-stored foundation tools config, which takes precedence over the default when set.

By ensuring these tools are present in the DB-configured foundation tools list, they are always available to Emma in every session — not just when the DB config falls back to defaults.

### Why This Helps (and Its Limits)

Guaranteeing tool availability prevents the "tool not available" failure mode, but does not prevent the LLM from choosing not to call the tool. The prompt instruction at line 306 remains the primary enforcement mechanism. If the "forgot brand" pattern recurs, the next step is **Option C** from the investigation: programmatic pre-flight injection of brand context into the context window at session start (same pattern as account memory injection at `agentModeService.ts:1635`), making brand context available without requiring any LLM tool call decision.

## Real Browser vs Headless for Emma (2026-05-12)

### Background

Emma uses `@playwright/mcp` as its browser automation tool, configured via the MCP Servers tab in the admin panel. The question was whether Emma could be switched to use a real (non-headless) Chrome instead of headless Playwright.

### How Playwright MCP is Launched

When the backend spawns a Playwright MCP stdio server, `mcpClientService.ts` (`createStdioTransport`, ~line 787) auto-detects the `@playwright/mcp` package and unconditionally injects `--headless`, `--no-sandbox`, and `--isolated` flags — even if the admin-panel config doesn't include them. The injection guard is:

```typescript
if (!resolvedArgs.includes('--headless')) {
  resolvedArgs.push('--headless');
}
```

So removing `--headless` from the MCP server config in the admin panel has no effect — the code re-adds it.

### Why Truly Headed Chrome Is Not Feasible on EB

The backend runs on AWS Elastic Beanstalk with no display server. A headed Chrome requires a real or virtual display (X11/Xvfb). Even with Xvfb it is still a virtual framebuffer, not a real browser, and adds significant operational complexity to the EB platform config.

### Bot Detection Mitigation Already in Place

The code already injects an extensive stealth script into every Playwright MCP session via a config file (`/tmp/playwright-mcp-configs/{key}.json`). It patches `navigator.webdriver`, `userAgentData`, `navigator.plugins`, `screen.colorDepth`, `document.visibilityState`, `IntersectionObserver`, and more. For most sites this is sufficient to avoid headless detection without needing a real browser.

### Using a Real Browser via the Local Agent

For use cases that genuinely need a real browser — particularly **testing or scraping public sites where no login is required** — the `run_local_agent_task` tool is the right path. This tool runs a task through the local agent relay (`local-agent-relay/`), which launches Playwright with `headless=False` against the user's local Chrome profile (`~/.codex-relay/chrome-profile`). Because the local agent runs on the user's machine, it has access to a real display and a persistent browser profile.

Relevant code: `local-agent-relay/src/codex_relay/browser.py`, `load_page_with_playwright()` at line 76 (`headless=False` by default, persistent profile via `profile_dir`).

**When to use `run_local_agent_task` vs Playwright MCP:**
- Public sites, no auth needed, real browser fidelity required → `run_local_agent_task`
- Any site where the user's saved cookies/session matter → `run_local_agent_task`
- Most automation tasks, API calls, content generation → Playwright MCP (headless, faster, no local agent needed)

## Drip Sequence Email — SVG Logo Display Issues (2026-05-14)

### User Report

A user reported that sequence emails sent from `founders@agentweb.pro` had a bad logo display in their email client. Two separate rendering bugs were discovered:

1. **Superhuman:** The bird logo SVG rendered at enormous size (native `viewBox` dimensions, ~500px wide).
2. **Slashy:** The bird logo appeared completely white (invisible on a white background).

### Investigation

**Superhuman (oversized SVG):**
Superhuman is an Electron/Chromium webview app that sanitizes email HTML before rendering. Its sanitizer strips `style` attributes from `<svg>` elements as an XSS precaution, so `style="max-width:100%;width:100%"` and even native `width` attributes were being removed, leaving the SVG to render at its `viewBox` intrinsic size.

**Slashy (white logo):**
Decoding the raw email HTML revealed the logo `<img>` (converted from SVG) had `filter:brightness(0) invert(1)` in its style attribute. This filter inverts the image to white, which is intentional for display on the purple gradient email header. Slashy strips the header's background color while preserving the filter, making the white logo invisible against the white background.

### Status

**Superhuman:** We contacted Superhuman support to report the SVG sanitization behavior. **Awaiting their response.** No fix has been applied at our end for this issue. If Superhuman confirms this is by design (i.e., SVGs will always have styles stripped), the mitigation would be to convert SVGs to PNGs server-side before sending (already prototyped: `convertEmailSvgsToPng` in `emailVariables.ts` using `sharp` + content-addressed S3 keys — `email-svgs/<sha256>.png`).

**Slashy:** A server-side fix was applied: `removeInvertedImgFilters()` in `emailVariables.ts` strips `filter:brightness(0) invert(1)` from `<img>` style attributes before send. This ensures the logo renders in its original colors on all clients. Trade-off: on clients that correctly render the purple header (Gmail, Apple Mail), the logo now appears dark against the purple background rather than white — acceptable since it remains legible. The proper long-term fix is a white-variant logo asset that does not rely on CSS filters.

## Session Judge Scoring — Bug-Reported Sessions (2026-05-16)

### Background

Session satisfaction scores were being computed too low for sessions where the assistant hit a known platform bug. The judge LLM was seeing friction and failures without understanding that the issue had been formally escalated — so it scored the session as if the user's problem was simply unresolved.

### Signal: `report_product_issues` Tool Call

The reliable signal that a bug was reported is the presence of `report_product_issues` in the serialized transcript's `[called tools: ...]` line. This is more deterministic than trying to parse natural-language acknowledgments ("I've filed a bug", etc.).

### Fix

The scoring judge prompt was updated (both the hardcoded `DEFAULT_SCORING_SYSTEM_PROMPT` in `sessionScoringService.ts` and the live prompt managed via the admin Settings → Scoring Judges page) to include:

> **IMPORTANT: Bug reported during session:**
> - If the transcript contains `[called tools: report_product_issues]`, a bug was formally reported
> - Treat the problematic behavior as a known platform limitation, not an assistant failure
> - Score the overall session as satisfied (score ≥ 4) unless the user expressed strong dissatisfaction **after** the tool was called
> - Dimension scores (e.g. `outputQuality`) may still reflect pre-report friction

### Live Prompt State

The prompt was manually updated in both dev and prod via the admin Scoring Judges page. No migration or deploy is needed — the page writes directly to the `default-scoring-prompt` DynamoDB setting at runtime. Custom judges were also updated to match.

## Large Brand Guidelines Files — Google Drive Workaround (2026-05-28)

### Context

Vivian Health provided their brand guidelines as a ~135 MB zip file. Our upload infrastructure has a 100 MB hard cap (`MAX_FILE_SIZE` in `backend/src/config.ts`) and a 50 MB Express body-parser limit, so the file could not be uploaded directly.

### Solution

Rather than increasing upload limits or adding server-side zip extraction (which would significantly increase backend complexity and S3 storage costs for large binary archives), the simpler approach is to use Google Drive as the storage layer:

1. Create a Google Drive folder for the client's brand assets.
2. Upload the brand guidelines zip (or its extracted contents) to that folder.
3. Share the folder with the client's AgentWeb account email so the Google Drive knowledge base connector can access it.
4. The files are then accessible through the existing Knowledge Base interface — the agent can read PDFs, DOCX files, images, etc. directly from Google Drive without any changes to our upload infrastructure.

### Why this is better than increasing upload limits

- No infrastructure changes required — no risk of destabilizing the upload path for all users.
- Google Drive is already integrated as a knowledge base source; files stored there are indexed and accessible to the agent the same way as any other KB file.
- Large zip files don't need to be stored redundantly in S3 — Google Drive handles storage and CDN delivery.
- The client retains direct access to their own files in Drive and can update them without going through our UI.

### Recommendation for the product

If large brand guideline uploads become a common need, consider adding a "Connect Google Drive folder" shortcut in the Brand Guidelines UI that guides users through sharing a folder with the service account — avoiding the upload flow entirely for large asset libraries.

---

# June 3, 2026: Investigation — LinkedIn "Invitation Accepted" Notifications Stopped Sending

## Symptom

The email notification a list owner should receive when a lead accepts their LinkedIn connection request stopped firing. Separately, when it *did* fire it also posted to Slack (which it should not), and it fired for lists that never sent the invite.

## Root causes

1. **Trailing-slash URL mismatch (the "stopped sending" bug).** `linkedInConnectionSyncCron.notifyNewConnections` looked up CRM leads via `crmDb.findLeadsByLinkedin(conn.publicProfileUrl)`. The connection URL is normalized by `unipileConnectionsDb.normalizeLinkedInUrl`, which **forces a trailing slash** (`.../in/john/`). But leads store their `linkedin` value **without** a trailing slash — CSV import (`crm.ts` normalizer) and enrichment (`enrichmentGroups.normalizeLinkedInUrl`) both strip it, and `db.createLead` only `.trim()`s. `findLeadsByLinkedin` does an **exact** GSI match on `LinkedinLookupIndex`, so the slash-terminated key never matched → zero leads → no email. The `__latest__` watermark had already advanced, so the connection was never reconsidered → permanent miss. (The sibling `enrollNewConnections` was unaffected because it normalizes *both* sides before comparing.)

2. **Slack notification.** `leadListAlertService.notifyLinkedInConnectionAccepted` posted to Slack via `sendLeadNotification` whenever the owner had a `slackChannel`. These acceptance alerts should be email-only.

3. **No sender gate.** The notification fired for any list containing the matching lead, regardless of whether the list had an assigned LinkedIn sender (`list.linkedInAccountId`).

## Fixes

- `notifyNewConnections` now queries both the slash and no-slash URL variants (deduping by `listId#leadId`) via a new `findLeadsForConnectionUrl` helper.
- It now only notifies when `list.linkedInAccountId` is set **and** equals the connection's `accountId` (the sender that actually sent the invite).
- Removed the Slack block from `notifyLinkedInConnectionAccepted`. Generic lead-list alerts in `notifyLeadListOwnerIfConfigured` still post to Slack.

## Tests

- `linkedInConnectionSync.notifyNewConnections.test.ts` — added slash-variant matching, variant dedup, and sender-gate cases; made the `normalizeLinkedInUrl` mock mirror the real (trailing-slash) behavior.
- `leadListAlertService.linkedInConnectionAccepted.test.ts` — added a case asserting Slack is never called even when a `slackChannel` is set.

## PRODUCTION INCIDENT — notification flood on initial backfill (2026-06-03 16:33–16:42 UTC)

While PR #1752 (above) was in review (NOT deployed), a live flood of "invitation accepted" emails hit `murray.newlands@gmail.com`.

### Diagnosis (from prod logs + DynamoDB)

- User `9fde4157-e73f-4f0e-9d3a-ac8fe97b35ec`, list `list_1776558909356_4e0g4dxrt` ("Master Contact Data with Enrichment"): **132,363 leads, 32,298 with LinkedIn URLs**, freshly imported.
- Unipile account `LIBGE2pYS1eckwgo7wUIGQ` (**3,447 cached connections**) ran a **one-time full backfill**. Commit `570dc302` (merged to `main` the same day) extended the forced full backfill from *empty* caches to *partial* caches too (gated on a new `__fullsync__` marker), so every pre-existing account backfills once. `notifyNewConnections` then treated every historical connection (e.g. `connectedAt` = Mar 22) as a freshly-accepted invitation → ~86 emails (+ Slack) in 9 minutes, all to one owner.
- The list had **no `linkedInAccountId` assigned**, yet it still notified (the missing sender gate).
- Dedup (`lead.system.linkedInConnectionNotifiedAt`) WAS working — each lead fired once — so it was a one-time burst, not a per-cron repeat. It self-terminated once the backfill completed (flat at 16:42; no growth across the 16:50 cron boundary).

### Root-cause fix (added to PR #1752)

`runLinkedInConnectionSync` now checks the `__fullsync__` marker (`getFullSyncCompletedAt`) BEFORE syncing each account. If absent, this run is the one-time full backfill — covering **both empty AND partial caches** (the partial-cache path is what actually flooded) — so it caches the connections silently and skips BOTH `notifyNewConnections` and `enrollNewConnections`. Keying off the fullsync marker (not the watermark) is essential: the flood account had a non-null watermark, so a watermark-based check would have missed it. Combined with the sender-gate fix, this list would have sent **zero** emails. Covered by `linkedInConnectionSync.initialBackfillNoNotify.test.ts` (includes a partial-cache case).

## POSTMORTEM — transparent-logo handling during newsletter HTML editing (2026-06-15)

Session `eadb9fda-d255-479f-b122-356ae36cbc50` (user Aquila). Task: header logo = 3-color brand mark on a purple gradient (#3F51B5→#6E49BF); footer logo = all-white mark on dark navy (#1a1a2e). Both needed a transparent background. The agent made four mistakes before the user manually supplied transparent PNGs.

### Mistakes & root causes

1. **Used `remove_c2pa_from_image` expecting transparency.** It only re-encodes to strip metadata (`imageService.removeC2PAMetadata` → Sharp `withMetadata:false`); it never touches pixels, so it cannot remove a background or create an alpha channel. The tool name/description implied more than it does.
2. **Used `generate_image` to "redraw the logo on a transparent background".** No real background-removal capability existed, so the only fallback was regenerating the mark — which risks icon/letter/color drift and cannot guarantee true alpha.
3. **Selector `p:contains(AQUILA):first` clobbered the wrong element.** "AQUILA BRIEFING" in the header appears first in DOM order, so a `:contains + :first` selector aimed at the *footer* wordmark hit the *header*. Required a corrective pass.
4. **Placed a black wordmark on the dark purple header** (illegible). No fg/bg contrast validation existed.

### What worked
User supplied real transparent PNGs (3-color for header, all-white for footer). Swapping `img src` via `update_html_file` CSS `setAttribute` preserved brand fidelity exactly, scoping by container background: header `td[style*="linear-gradient"] img[alt="Aquila"]`, footer `td[style*="#1a1a2e"] img[alt="Aquila"]`.

### Fixes (this branch)

- **New `remove_image_background` tool** (`imageGeneration.ts:removeImageBackground` + `agentModeService.removeImageBackground`, registered in `emma/tools.ts`). Edge-seeded flood fill over the original raw RGBA pixels via Sharp: detects the background color from the corner median, clears alpha on contiguous border-connected pixels within a tolerance. Produces a **genuine transparent-alpha PNG without redrawing the mark** — enclosed regions (e.g. a counter inside a letter) are preserved because the fill only follows border-connected pixels. Verified end-to-end: a real Google-logo PNG → 70.5% transparent / 26.4% opaque, `channels:4 hasAlpha:true`, foreground colors intact.
- **Optional `surface_color` contrast check.** Computes the WCAG contrast ratio between the logo's average opaque color and the target surface; warns below 3:1 (the "black logo on dark purple" failure). E2E run reported 4.39:1 against #1a1a2e for the colored Google mark → legible.
- **Description fixes.** `remove_c2pa_from_image` now states it does NOT remove backgrounds and points to the new tool. `generate_image` now forbids "redraw on transparent background" and routes such requests to `remove_image_background` / an existing transparent PNG.
- **Selector guidance.** `update_html_file` now instructs scoping by container/section background (not `:contains + :first`) when a brand word appears multiple times, with the header/footer examples above.
- **Bonus bug fix.** `removeC2PAFromImage`/`removeImageBackground` filename normalization truncated extension-less names (`"logo"` → `".png"`) because `lastIndexOf('.') || length` is dead code (`-1` is truthy). Fixed both to `dotIndex > 0 ? substring(0, dotIndex) : name`.

### Tests
`imageGeneration.backgroundRemoval.test.ts` (real Sharp — proves alpha, interior-counter preservation, tolerance, corner-median, WCAG helpers), `agentModeService.removeImageBackground.test.ts` (orchestration, filename, contrast, error paths), `remove_image_background.registration.test.ts` (tool registry + updated descriptions). 107 image-related tests pass; `npx tsc` clean.

## ENG-1063 — a human override for the Greptile 5/5 gate (2026-08-10)

`Require Greptile Review` is a required check on `main` and had no override. Measured across
`tests.yml` PR runs 2026-07-27..08-10: **35 gate failures to 32 passes** (30 skipped = drafts,
3 cancelled). **None was an outage** — the gate's own `unavailable` verdict (exit 75) appeared
zero times; every failure was a landed verdict below the bar. Sampling 14 of the 35: **ten 4/5,
four 3/5**. So the block was routine and quality-shaped, not flaky, and each refusal forced a
fix-and-repush to move 4 → 5.

### Assumptions checked, and one that was wrong

- **Branch protection could not deliver this.** `enforce_admins: true` on all three repos, so
  nobody can bypass — and the only admins are `harshmoney123` and `agentwebdeployer`. The
  Argusoft team has `push`. Flipping `enforce_admins` would therefore not have unblocked the
  team at all; it would only have unblocked Harsha, and would simultaneously have handed the
  bypass to the swarm, which authenticates as `harshmoney123`. Rulesets can express per-team
  bypass, but a bypass actor bypasses *every* rule in the ruleset, including the test checks.
  Hence: the override lives in the gate, scoped to exactly the Greptile bar.
- **GitHub auto-merge needed no change.** It never bypasses a required check, so "auto-merge
  only on a true 5/5" was already the behaviour; only the human half was missing.
- **WRONG, and caught before shipping:** the first implementation authorized the overrider via
  `GET /repos/{owner}/{repo}/collaborators/{login}/permission`. That endpoint requires push
  access, and `tests.yml` declares `permissions: contents: read, checks: read, issues: read,
  pull-requests: write` — no scope reaches it. The call would have 403'd on every run and the
  feature would have been dead on arrival while looking correct in tests, because the test mock
  was happily serving an endpoint production cannot call. Replaced with `author_association`,
  which is already on every comment in the payload the gate fetches: zero extra API calls, zero
  extra token scope. Verified against live comments on #2290/#2300/#2310/#2315/#2318 — the
  Argusoft team and Harsha all comment as `MEMBER`.

### What that authorization does and does not prove

`OWNER|MEMBER|COLLABORATOR` proves org membership or repo collaboration, **not** a repo write
bit. In this org that set is the seven accounts in `orgs/AgentWebPro/members` minus the denied
machine accounts, which is the intended audience. If the org grows past the point where every
member is trusted to merge backend code, this needs a real permission lookup and the token scope
to make it — do not quietly widen the trusted set instead.

### Residual gap (tracked)

The swarm commits as `harshmoney123`, the same principal as human-Harsha, so no gate can fully
separate them. Automation is blocked on its *own* PRs by two independent signals (a
`swarm/*`/`autofix/*` head branch, or an `Execution-Actor:` attribution line in the body), but on
a human-authored PR an agent acting as Harsha could still post an override. The structural fix is
the dedicated bot identity `automated-work-attribution.md` already calls for.

## ENG-967 — "two landing pages returned 0 leads": a real bug, and two lists that do not have it (2026-08-21)

Reported as one bug: two CRM lead lists returned 0 leads on every Inbound Website Lead
Engagement run since May 2026. Investigating it surfaced a genuine silent-lead-loss defect —
but **neither reported list is an instance of it.** Both halves are recorded here because the
fix and the report do not line up, and a future reader will otherwise assume they did.

### The defect that is real, and is fixed here

A landing page can be bound to a lead list that the platform will not accept public
submissions for. The generated capture route posts to `POST /api/webhooks/forward-lead`,
which rejects any list with `publicAccessEnabled !== true` with a 403 (`webhooks.ts`) — and
the visitor is still shown a success screen. The page reports "saving leads to X" while
dropping every submission, indefinitely.

`crmDb.createLeadList` defaults `publicAccessEnabled` to **false** (`db.ts`), and `/generate`
has enabled it on the list it binds since ENG-449 — but the two other paths that bind a list
did not: `PATCH /generated/:id/lead-list` (the portal picker and the agent's MCP equivalent)
and `/generated/:id/duplicate`. Either could wire a page to a list that could never accept a
lead.

`ensureLeadListAcceptsPublicSubmissions` now runs on all three paths. It is idempotent (no
write when the list is already public) and never throws — a failed enabling write returns a
warning that the PATCH response surfaces, rather than reporting a clean save.

⚠ **`publicAccessEnabled` gates WRITES only.** Its readers are `forward-lead`,
`crmPublic.ts`'s `POST /leads/:listId`, `crmAutoSyncService` and `admin.ts`; there is no
public READ path behind it. Enabling it opens an unauthenticated lead-insert on that list —
which is what a page-bound list is for — and exposes no stored lead to anyone.

### The two reported lists — checked against production, 2026-08-21

| list | name | publicAccess | bound page | live route |
| --- | --- | --- | --- | --- |
| `list_1779584823329_md99qvwnk` | LP Leads - 2026 State of AI Marketing | false | **none** | **404** |
| `list_1779822422539_l5yvansu2` | LP Leads - Emma Partner Network | true | 1 (`110edb3d…`) | 200 |

**Neither is explained by the bug above. Nothing posts to either list.**

- **2026 State of AI Marketing** — no `AW-LandingPages` record names it (`Scan` of all 167
  records), no code in the `AgentWebPro` org references it (GitHub code search, 0 hits), and
  `hireemma.ai/2026-state-of-ai-marketing` returns **404**. It is an orphaned list for a page
  that does not exist. Owned by `harsha@agentweb.pro`, not by the reporter.
- **Emma Partner Network** — the `AW-LandingPages` record names this list, but the live form
  does not use it. `/emma-partner-network` posts through `/api/partner-capture` →
  `PARTNER_LEAD_LIST_ID` → `LANDERS['/emma-partner-network'].listId` =
  **`list_1780522372186_ve7ebuzp8`** ("Partner Network Briefs"), read from `lib/landers.ts`
  in `agentweb-landing-page`, not from the doc that describes it. That list is public and has
  received a brief. The repo's own `LANDERS.md` already calls `l5yvansu2` a **duplicate** and
  says to delete it.

⚠ **An earlier revision of this section asserted that `md99qvwnk` "is bound to a landing page"
and that the backfill script below is "the one-time repair" for it. Both were wrong.** They
were written from the autofix runner, whose IAM role is denied `Scan`/`Query` on
`AW-LandingPages`, so the binding was inferred rather than read. The script enumerates lists
*from* `AW-LandingPages.leadListId` and would never have enumerated that list at all. **A
claim that could not be read was recorded as if it had been** — the failure mode this repo's
own evidence rules exist to prevent.

### How much of this class exists in production — measured, 2026-08-21

Read-only pass over the whole table, the same logic the backfill applies: **167 landing pages,
93 distinct page-bound lead lists.**

| | count |
| --- | --- |
| private list bound to a page (**the defect**) | **0** |
| already public, capturing | 27 |
| already public, zero leads | 63 |
| **bound list absent from `AW-LeadLists`** | **3** |

**Nothing needs repairing today** — the backfill script would write zero rows, so it does not
need running and does not need a data-plane request. It stays as the instrument for the next
time, and as the dry-run diagnostic.

⚠ **The 3 missing lists are the same failure one step further along** — a page POSTing into a
404 at `forward-lead` rather than a 403. `list_1779684022346_4pi8auc7f` (bound to a **live,
200-serving** generated page, `lp-demystifying-ai-agentweb-lead-18.vercel.app`),
`list_1779490637995_k743eormt` (two Every.io records — **a managed client**; its URL did not
respond to a probe, so its liveness is **unread, not dead**), and `list_1779299615576_cy7dj7h1i`
(page 404s). `ensureLeadListAcceptsPublicSubmissions` now returns a warning for this state
instead of reading it as success; repointing an existing page is a judgement call, not a
backfill.

### Remediation for pages that are already broken

`src/scripts/backfill-eng967-lead-list-public-access.ts`. The code fix only runs on a future
bind, so it repairs nothing already broken. The script scans `AW-LandingPages` and, for every
lead list a page names in `leadListId`, enables `publicAccessEnabled` where it is not already
true. Dry run by default; `--list=<id>` targets one list.

**Bulk production data mutation — needs Harsha's data-plane approval per `CLAUDE.md` before
anyone runs it with `--apply`.** It deliberately does not touch a list no page binds: a
private list nothing posts to is private on purpose.

### What is left, and who owns it

Both reported lists need **CRM cleanup, not code** — delete or rename the orphaned
`md99qvwnk`, and reconcile the Emma Partner Network page record onto the list its form
actually writes to (or delete the duplicate, as `LANDERS.md` already says). Both are
production data mutations behind the same data-plane gate.

## ENG-1490 — recommend_predefined_work_plan lost to the "produce drafts without asking" policy (2026-08-23)

Live DynamoDB trace (production `sessionId b71af8c0-afab-4cff-8417-d5148b05d286`) proved Emma calls
`list_predefined_work_plans`, searches the result across three turns, finds a genuine match, and
still calls `create_social_media_posts` directly — `recommend_predefined_work_plan` never fires.
This is NOT a tool-batching race (the list result WAS seen before drafting); it's a prompt conflict.

Root cause: two CRITICAL, apply-to-every-request policies sit much earlier in
`agentModeSystemPrompt.ts` than the Work Plan Capabilities section (line 488, ~55% through the
889-line file) and both tell the model to skip confirmation and just produce the deliverable:

- "Decision Framework" (line 70): CLARIFY → CHECK skills → INSTALL → EXECUTE ("use your tools to
  complete the request"). Never references the work-plan check at all.
- "When to Ask Questions" (line 122): explicitly names "producing a draft" as exempt from
  confirmation, and confirmation is required only for spend/publish/irreversible actions.

Fix (this PR): four targeted edits making the recommendation an explicit substitute for drafting,
not an extra step alongside it — (1) wired the work-plan check into the Decision Framework's
EXECUTE step, (2) added a named carve-out in "When to Ask Questions" so a matching-plan proposal is
not treated as a banned "should I proceed?" pause, (3) strengthened the Work Plan Capabilities
paragraph to state the recommendation replaces drafting, (4) reworded the LinkedIn reference-table
row from "before drafting" (sequencing) to "instead of ... in this same turn" (substitution). None
of the spend/publish/irreversible exemption categories were touched.

Verified via dev-environment before/after transcripts (not a single click-through) across 3
phrasings against a freshly launched test-env: a clear LinkedIn-goal match now calls
`recommend_predefined_work_plan` and does NOT also draft; a goal with no matching plan in the
catalog (Google reviews) answers directly with no spurious recommendation; an ad-hoc draft request
unrelated to any plan (birthday post) still drafts immediately with no pause. Full transcripts in
the ENG-1490 PR description.

**Known residual risk, not fixed here**: the agent loop's tool-calling is OpenAI-style batched
(`agentModeService.ts` `responseMessage.tool_calls` can contain N calls executed concurrently via
`Promise.all` in `toolDispatch.ts` before the next LLM turn) — nothing at the code level prevents a
future phrasing from batching `list_predefined_work_plans` together with a drafting tool in one
turn, which would reintroduce this failure mode even with the reworded prompt. The fix here is
prompt-level only; a code-level sequencing guard (e.g. forcing `recommend_predefined_work_plan`
decisions to complete before drafting tools are eligible in the same turn) is a larger change and
was explicitly out of scope for this PR.

**Also not fixed here**: ENG-1484's dev.md note flagged ~15 other "Page & Feature Tool Reference"
rows with the same latent goal-vs-feature ambiguity as the LinkedIn row. This PR only reworded the
LinkedIn row's own exception clause (already added in ENG-1484); it did not re-audit those other
rows for the "before" vs "instead of" framing gap. Flagged for a follow-up, not reproduced per-row.

## ENG-1490 follow-up — audited the other 18 "Page & Feature Tool Reference" rows (2026-08-23)

Full audit of every non-LinkedIn row against the same goal-vs-feature-reference ambiguity, using a
selection criterion (a row is a candidate only if its primary arrow-target tool CREATES/DRAFTS new
content or LAUNCHES a new campaign — a "producing a draft"-shaped action per the "When to Ask
Questions" exemption language, not a read-only/view/list/report row) and a live DynamoDB scan of
`AW-WorkPlans` for real catalog evidence. Verified via an 8-agent adversarial workflow (7 patches +
1 independent re-derivation of the "not a candidate" list) before applying — every proposed patch
came back APPROVE with no edits, exact-text matches confirmed against `origin/main`, zero pinned-test
collisions found.

**Patched (7 rows), same substitution-framed exception as the LinkedIn row**: paid social/ads
(strongest catalog evidence — 7+ real ad-campaign plans), landing pages (own trigger keywords already
include goal phrasing "create/build a landing page"; 3 real matching plans), research/reports/deep
research (4 real report plans), blog (real "AEO Article Engine" plan, structurally identical to the
already-production-verified LinkedIn fix), images, videos, and newsletter (last 3 on catalog-agnostic
reasoning — no exact-title plan confirmed today, but the mechanism no-ops harmlessly when
`list_predefined_work_plans` returns no match, confirmed live via the "Google reviews" negative-result
transcript in the original ENG-1490 PR, and the underlying instruction-precedence bug — a specific
keyword row beating the generic Work Plan Capabilities paragraph — exists independent of today's
catalog contents).

**Examined and deliberately NOT patched — different bug shape**:
- **GTM plan row** (`list_gtm_plans`/`read_gtm_plan`) — this row's own tools are read-only; the real
  gap is that `create_gtm_plan` lives in a separate "GTM Plan Capabilities" section never referenced
  by this row at all. That's a documentation/cross-reference gap, not the same specific-row-beats-
  generic-instruction conflict (there's no creation tool on this row to lose the race in the first
  place). Left as a distinct finding for a possible separate issue, not fixed here.
- **Tasks/automations row** (`create_task_from_template`) — genuinely creation-capable, but it's
  already a DIFFERENT templating system (AgentWeb's browser-automation Task Templates, unrelated to
  predefined Work Plans). Forcing the same exception here would create ambiguity between two
  competing guided-path systems rather than resolve one. Left unpatched.

**Confirmed correctly excluded (read-only/navigational, no creation tool on the row)**: SEO/GEO, CRM/
leads, general social-posts view, brand guidelines, website scan (diagnostic on an existing site, not
a deliverable), market strategy, knowledge base, templates (its own creation tool lives under the
separate newsletter row instead), books/ebook (row's own tools are read-only despite the word "ebook"
— possibly a separately stale/incomplete row, different bug class, not investigated further here).
Google Drive has genuine write tools (`create_folder`, `create_google_doc`) but its trigger phrases
name a storage location, not a content-creation goal a user would naturally state ("I want to make a
Google Drive" isn't a real request shape) — excluded on that basis, flagged as the one worth
rechecking first if this audit's premise is ever found wrong.

New regression test: `agentModeSystemPrompt.goalVsFeatureRowAudit.test.ts` pins all 7 rows' exception
wording (substitution framing only, never the "before drafting" sequencing that lost to other prompt
policies in the original bug), confirms the ads spend-confirmation and video CREATE-vs-ANALYZE
distinctions are preserved, and confirms the excluded read-only rows got no exception added.

**Dev-transcript verification (fresh test-env, real LLM calls, not a click-through)**: ran a
representative sample of 3 of the 7 patched rows plus a negative control against a freshly launched
dev environment.

| Phrasing | Tool trace | recommend called? | primary creation tool called? |
|---|---|---|---|
| "I want a landing page for my new product launch" | list→search×3→**recommend_predefined_work_plan** | true | `generate_landing_page`: false |
| "I want to write a blog post about our new feature" | list→read_brand_guidelines→read_market_strategy→search×5→read×7→**recommend_predefined_work_plan** | true | `create_blog_article`: false |
| "help me launch a Meta ad campaign" | list→search×3→read×5→**recommend_predefined_work_plan** | true | `list_meta_ads_campaigns`: false |
| "can you write me a haiku about coffee" (negative control) | (no tool calls) | false | n/a |

All three positive cases: Emma checked the plan catalog and proposed a matching plan instead of
proceeding with the row's primary tool, in the same shape already verified in production for the
LinkedIn row. Negative control: no spurious recommendation, no spurious tool calls, answered
directly. Full transcripts in the ENG-1490 follow-up PR.

## ENG-1643 — typed consent resolves only when deterministic (2026-08-29)

An awaiting `ask_user_question` card used to clear whenever the owner typed text, even when that
text was an unambiguous answer. The correction is a pure, controller-side resolver: one exact
option id/label match is persisted as a normal `answeredBy: 'user'` answer; a bare affirmative is
accepted only for a card with exactly one affirmative option (for example Approve/Reject). Bare
affirmatives on multi-choice cards, ambiguous text, and unrelated text retain the prior
clear-and-re-ask behavior.

This is an intentional consent-correctness change, not a model-routing or prompt change. It keeps
the existing optimistic `requireStillAwaiting` write condition, immutable-question gate,
delegation invariant, and no-model-answerer invariant. Typed provenance uses the existing optional
answer rationale field; it adds no table, schema, or new persistence path. Focused controller and
primitive tests cover the three affirmative paths plus multi-choice/ambiguity controls.
