# Org lead notifications

`Organization.leadNotifications` opts in to immediate Slack notifications after a
successful CRM insert. The landing-page `/api/webhooks/forward-lead` new-lead path
already uses `crmDb.createLead`; batch CRM inserts have a separate write hook.
Updates, merged submissions, and unprocessed DynamoDB batch rows do not notify.

Configuration (illustrative only; no live configuration is written by this change):

```json
{
  "enabled": true,
  "slackChannelId": "C123",
  "sources": ["crm-list-id", "persisted-list-name", "waterheater-landing", "lp-id"],
  "maskPhone": true,
  "mentions": ["U123"],
  "excludeEmailPatterns": ["noemail+*@waterheater.app"]
}
```

Omitting `sources` accepts all sources. An empty list accepts none. Matching is
case-insensitive (with surrounding whitespace ignored) against the persisted CRM
`listId`, list `name`, or string-valued `customFields.source`, `sourceId`,
`landingPageId`, and `lpId` (including underscore/case variants of those keys).
Missing `source` retains the generic `crm` match. Custom fields named `listId` or
`listName` cannot impersonate the persisted list. Malformed containers and
non-string identifiers are ignored, never coerced into source matches.

`excludeEmailPatterns` uses whole-email case-insensitive globs with only `*`
special. A match hides the email in Slack (shown as `—`); the lead notification
still sends with its other fields. Phone masking retains only the last four digits
(short numbers are fully masked). Messages contain name, email, phone, company,
source, creation time, and a list/lead-specific CRM link, plus submitted scalar
custom fields, LP identifiers, campaign and UTM fields. Structured `firstTouch.utm`
and `firstTouch.landingUrl` are rendered too, with `utmSource`/`utmMedium` fallback.

Rendering is bounded to 20 additional fields, 60 input characters per label, 300
input characters per value, and 12,000 total message characters after escaping.
Whole lines are omitted when the message budget is exhausted; escape sequences
are not cut. Structured attribution precedes custom fields, with normalized-key
deduplication. Core/contact aliases, internal/system keys, credentials, and nested
objects/arrays are excluded. Slack mentions/links are escaped, formatting delimiters
are neutralized, and line/control characters become spaces. Known hidden email
and masked phone values are redacted if repeated inside a scalar field. Configured
Slack mentions alone use active mention syntax and obey the same message budget.
`CUSTOMER_FRONTEND_URL` controls the link origin, defaulting to app.agentweb.pro.

The persisted list owner's org is authoritative, not submitted `tenantId`,
`userId`, or channel values. Routing is revalidated during job recovery. Only one
org-owned Slack entry in `Organization.connected_accounts` is accepted:
`platform: slack`, `account_id: <workspace ID>`, and config containing
`account_type: bot`, `team_id`, and `access_token: <Emma xoxb token>` (plus the
existing connection metadata fields). The token's `auth.test` workspace must
match. There is no fallback to a personal connection or `SLACK_BOT_TOKEN`.
This checkout previously had only shared Slack Connect routing, not a per-org
Slack OAuth installation flow. Installation/provisioning is outside this change;
Haven/SWH activation requires confirming their actual connection, channel and
source values first. `username: Emma` requires `chat:write.customize` alongside
`chat:write`; see [Slack's authorship documentation](https://docs.slack.dev/reference/methods/chat.postMessage/#sending-messages-as-other-entities).

Delivery starts immediately in the background. Three attempts use 1s/2s backoff,
8s SDK request timeouts, and bounded Retry-After handling. Healthy delivery and
short transient retries target under 60 seconds; outages/restarts cannot promise
that latency. Existing AW-AsyncJobQueue recovery handles interrupted/exhausted
jobs; no lead scan or new polling loop is added. Queue dedupe and atomic per-lead
step claims are scoped by org/list/lead IDs. A persisted sent marker suppresses
recovery repeats, and the same Slack client message UUID is reused on retries.
Success-marker retries never re-send the acknowledged Slack call.

Operational limits: a process crash between lead save and durable enqueue, or
queue unavailability, can lose a notification (logged; lead save still succeeds).
As with other external side effects, an ambiguous Slack timeout or a crash after
Slack accepts but before the sent marker persists is not a transactional
exactly-once guarantee; Slack's client message ID is additional dedupe protection,
not a substitute for an end-to-end acceptance smoke. Delivery errors never fail
or wait on the lead save. No tokens/contact details are added to queue payloads.

Activation smoke (not performed against production): for each org, submit one
real landing-page fixture and one CRM fixture, verify the correct Emma/channel,
fields, CRM deep link and <60s delivery; replay the same lead ID; then verify SWH
source filtering, placeholder-email hiding (with the alert still delivered), and masking and verify no delivery to the other org.
Rollback: disable the org configuration; pending jobs recheck it before sending.
No dependencies, new tables, provisioning, or config API were added. Complexity
impact: one notification service using the existing queue and lead-step primitive,
plus two write hooks. Org-enabled new-lead notifications suppress the legacy
per-list Slack send so it cannot duplicate or bypass masking/filtering. Other
legacy alert events and email/WhatsApp delivery are unchanged.

## AgentWeb's own inbound lists (ENG-2120 acceptance extension)

AgentWeb uses the same list-owner → org → `leadNotifications` → org-owned Slack
bot path as Haven/SWH. No org name, founders user ID, list ID, or internal channel
is special-cased in notification code. Configure the persisted owners' org;
do not infer ownership from a lead's `tenantId` or the website's branding.

Repository evidence for storage and intake:

- [`signupAutoEnrollService.ts`](../../src/services/signupAutoEnrollService.ts)
  resolves/creates **AgentWeb Signups**, owned by `FOUNDERS_USERID`
  (`be754b6c-767e-44ec-b181-4042cfe45ea9`), and inserts through `crmDb.createLead`.
  It does not stamp `customFields.source`; these inserts match the generic `crm`
  source. UTM source is a separate field. `onboardingLeadSync.ts` updates those
  rows, or creates missing ones through the same insert path.
- The local `AgentWebPro/agentweb-landing-page` checkout at
  `203a23cb4257d407a0aacdfa7a7b106b3961e63a` provides the website evidence:
  [`lib/landers.ts`](https://github.com/AgentWebPro/agentweb-landing-page/blob/203a23cb4257d407a0aacdfa7a7b106b3961e63a/lib/landers.ts)
  maps forms to CRM list IDs and source tags. Examples: Partner Network Briefs
  (`list_1780522372186_ve7ebuzp8`, `emma-partner-network`), booking funnel
  (`list_1773981007348_lq54vusp0`), and `/start`
  (`list_1784655666240_i2k3zauss`, `plg-start`). `lib/leadList.ts` and
  `app/(frontend)/api/{lead,partner-capture,booking-capture}/route.ts` forward
  to `/api/webhooks/forward-lead`. Booking email capture specifically stamps
  `booking_email_capture`, not the registry's `gtm-strategy-call` tag.
  Environment overrides and current production ownership are not proven by
  those literals; this is repository evidence, not a live inventory.
- [`webhooks.ts`](../../src/routes/webhooks.ts) stores the source in
  `customFields`, inserts new rows through `crmDb.createLead`, and merges existing
  submissions through `updateLead`. [`db.ts`](../../src/services/db.ts) stores
  list ownership in `AW-LeadLists` and contacts in `AW-Leads` (with the configured
  table prefix). Backend `dev.md`'s ENG-967 investigation independently records
  the Partner Network Briefs destination and warns about its unused duplicate.

Existing notifier reconciliation: the website intake files above contain no
separate Slack lead sender. Backend `leadListAlertService` already supports
`api.lead_added` when the list's `alertEvents` selects it and the owner has a
`slackChannel`; `slackService.sendLeadNotification` uses the shared internal bot.
For **every** org with `leadNotifications.enabled === true`, including AgentWeb,
that new-lead Slack send is suppressed in favor of the insert hook. Suppression
also applies when org filtering rejects the lead or its Slack connection is
missing, so the old sender cannot bypass filters or masking. No second dispatcher
is added at website/signup intake. Non-opted-in orgs retain their existing alerts;
other event types and email/WhatsApp behavior remain unchanged. Signup enrollment
does not itself call the legacy notifier and creates its list without explicit
`api.lead_added` alerts; the generic hook requires neither legacy setting.

**Production destination: the exact existing internal channel remains to be
confirmed.** Neither inspected repository establishes the relevant list owners'
persisted `slackChannel` or an AgentWeb lead-success channel ID. Backend `dev.md`
mentions `#lead-capture`, but `leadCaptureFailureService.ts` uses
`LEAD_CAPTURE_ALERT_SLACK_CHANNEL` for **capture failures**, not new-lead success.
The channel literal in `slackLeadNotification.test.ts` is a test argument, not
production routing evidence. Do not use either as the production destination.
Before activation, confirm the existing inbound-lead channel and bot membership,
then set that channel's actual ID in the owners' org `leadNotifications` config
and provision its org-owned bot connection. No production config was read or
written for this extension. Omit `sources` to include all AgentWeb org lists,
including signups; an allowlist can select their persisted list IDs/names or source
identifiers. Signups can match their list ID/name or the generic `crm` source. No config write is included in this diff.

The AgentWeb tests use repository-backed website list IDs and the exported signup
list name/owner, with explicitly synthetic org, channel, workspace, and token
fixtures. They exercise the real generic dispatcher and legacy alert service
together: exactly one org Slack send, correct source/masking/deep link, no legacy
bypass for source restrictions or a missing connection, placeholder emails hidden
without dropping the generic alert, and preserved update alerts. The existing DB-hook tests cover successful insert dispatch and no sends
for failed/deduplicated writes.

Prior extension verification (2026-09-23): the controller ran **73 tests locally
in six suites**, including seven AgentWeb cases. `ssh swarm` DNS was unavailable;
these were not Atem results.

Contract-correction verification (2026-09-23, local): **93 tests passed in six
suites**. Before the implementation correction, the focused notification suite
reproduced **11 failures with 28 passing tests**. Reproduce from `backend/`:

```sh
node --max-old-space-size=2048 node_modules/.bin/jest --runInBand --runTestsByPath \
  src/__tests__/orgLeadNotificationService.test.ts \
  src/__tests__/leadListAlertService.orgNotifications.test.ts \
  src/__tests__/crmDb.createLead.userId.test.ts \
  src/__tests__/crmDb.batchCreateLeads.nameCompanyKey.test.ts \
  src/__tests__/leadListAlertService.apiEvents.test.ts \
  src/__tests__/slackLeadNotification.test.ts
```

`git diff --check` and isolated transpilation of all nine changed TypeScript
files passed. No full semantic typecheck/build or live Slack test was run for
this extension. Complexity impact of the correction: source matching and a bounded formatter
extend the existing generic service; no new delivery path, dependency, or storage
primitive. Existing retry/idempotency and org routing remain unchanged. Working tree remains uncommitted; nothing was pushed.

Prior local verification: 66 tests passed across `orgLeadNotificationService`,
`crmDb.createLead.userId`, `crmDb.batchCreateLeads.nameCompanyKey`,
`leadListAlertService.orgNotifications`, `leadListAlertService.apiEvents`, and
`slackLeadNotification`. All nine changed TypeScript files passed isolated
transpilation and `git diff --check` passed. Semantic checking of the affected
files loaded the monolithic DB dependency graph and exhausted the 2/3 GB local
heap caps; no full typecheck/build or live Slack test is claimed.

Local CodeRabbit review: fixed the acknowledged-send/marker-failure retry finding.
Its two bulk-fan-out findings were retained for independent review: this contract
explicitly requests per-lead CRM insert notifications, so this change does not
silently replace them with a summary or exclude bulk inserts. Large eligible
imports can create concurrent delivery work and exceed Slack's channel rate
limits; source filtering should be configured before enabling an import-heavy org.
The review ran before the final legacy-alert suppression and marker tests.
