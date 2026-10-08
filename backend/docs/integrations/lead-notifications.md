# Org lead notifications (ENG-2120)

`Organization.leadNotifications` opts an org into immediate Slack delivery for
**inbound form fills and new-lead bookings by default**, including
unknown/future landing pages, repeat email submissions and phone-only submissions
that merge into existing rows. No LP registry, org-name branch or source allowlist
is required. Unprocessed/failed CRM writes and ordinary CRM updates do not notify.

Configuration example (documentation only):

```json
{
  "enabled": true,
  "slackChannelId": "C0BB8HL1AC8"
}
```

This is AgentWeb's destination. Haven uses `#haven-agentweb`; SWH uses
`#smartwaterheater-agentweb`, with their actual channel IDs verified at activation.
**Do not set `maskPhone` for Haven, SWH or AgentWeb.** It is optional and defaults
to false. Explicit `true` remains available for other configurations. `sources`
is optional/off by default: omit it to allow every source within the selected
lead types. If explicitly configured, it matches persisted list ID/name or LP/source
identifiers case-insensitively; an empty array selects none.

Only email placeholders matching `noemail+*@waterheater.app` (case-insensitive)
are hidden automatically. The notification still sends. Other addresses are
visible; legacy `excludeEmailPatterns` values no longer broaden email hiding.

## Lead-type filter and Emma tools

`leadTypes` is optional on the existing org JSON config. Absent means
`["form_fill", "booking"]`; an explicit list replaces that default, and `[]`
selects none. Unknown values, malformed arrays, or duplicate values fail config
validation. Missing/unknown event origins never notify, including old queued jobs
without an origin. `enabled`, type selection, and `sources` must all allow delivery.
Existing orgs with no `leadTypes` therefore stop receiving discovery/import/manual/
integration alerts immediately after deployment. There is no backfill or replay
when an org later opts in.

Origin is a separate server argument, never read from lead data, form fields,
`source`, or caller-supplied custom fields. It travels through the DB insert hook
and into the existing queued job. No origin attribute is added to lead records.

| Origin | Server call sites |
| --- | --- |
| `form_fill` | `routes/webhooks.ts` forward-lead create and accepted repeat submission dispatch; `routes/crmPublic.ts` public form capture |
| `booking` | `routes/calendlyWebhook.ts` new lead created by a booking |
| `linkedin` | `services/linkedInInviteCrmMirror.ts`; `agentModeService.ts` LinkedIn discovery `importLeadsFromSearch` batch |
| `enrichment_import` | `routes/crm.ts` bulk/CSV/LinkedIn-file imports; `agentModeService.ts` `addLeadsToList` batch; `outreachOnboardingSaveService.ts` prospect-list save |
| `manual` | `routes/crm.ts` single UI/API add |
| `integration` | `utils/attioPersonWebhookEvent.ts`; HubSpot record-sync creates in `routes/webhooks.ts` and `routes/crmWebhook.ts`; `signupAutoEnrollService.ts`; `onboardingLeadSync.ts`; batches in Attio/HubSpot adapters, `crmAutoSyncService.ts`, `activationAnalysisCron.ts`, `routes/admin.ts`, and `routes/crm.ts` subscriber sync |

`crmWebhook.ts` is a provider record-sync endpoint, not a form-capture endpoint;
its HubSpot/Attio records use `integration`. Existing-lead Calendly updates and
ordinary CRM updates retain their existing behavior; they do not create new-lead
notifications. All batch origins are explicit through `batchCreateLeads` options
and `dispatchLeadsCreated`; neither defaults missing provenance to inbound.

Emma tools are registered as foundation tools:

- `get_lead_notification_settings({})` returns effective `leadTypes`,
  `availableOptions` (values/descriptions), `enabled`, `channel`, `mentions`,
  `sources` (`null` means all), and `maskPhone`. An unconfigured org returns
  disabled/defaults with a null channel. No Slack credentials are returned.
- `update_lead_notification_settings({"leadTypes":["form_fill"]})` implements
  “only form fills”. To “also notify me about LinkedIn leads”, read settings and
  add `linkedin` to the returned list (defaults become
  `["form_fill","booking","linkedin"]`). Optional `enabled` and `mentions` replace
  those fields. Channel, source filters, masking, and unrelated settings survive.

Both tools derive org membership from the authenticated user; neither accepts an
org/user override. Reads permit members; writes require the existing
`org:configure` owner/admin permission. Updating requires an existing valid channel
configuration (these tools do not connect Slack). Conditional writes reject
concurrent edits; re-read before retrying. Disabled configs can be re-enabled.

## Exact layout

```text
New lead:
Name: Jane Doe
Phone: +1 (415) 555-1234
Email: jane@example.com

Attribution:
Landing page: New LP — https://example.com/path
Lead list: Inbound
Campaign: Launch
Ad set: Property managers
Ad: Demo video
Source / Medium: google / cpc
Referrer: https://example.org/
Submitted: Sep 23, 2026, 5:00 AM PT

Form answers:
Heater type: tankless

<https://app.agentweb.pro/crm?listId=list-a&leadId=lead-a|Open in CRM>
```

The header is literally `New lead:`. Contact order is name, phone, email, with
full unmasked values by default. Empty fields, placeholder emails, and unavailable
attribution are omitted. `Form answers:` is omitted when there are no answers.
Labels humanize camelCase, snake_case and kebab-case, and equivalent keys dedupe.
Consumed attribution, contact aliases, and internal/system/credential fields never
repeat as form answers. Nested objects/arrays are not stringified.

First-touch attribution wins for new leads; repeat submissions prefer last touch.
Malformed or empty preferred fields fall back to the other touch, then custom
fields/top-level legacy attribution. Submitted time uses the accepted submission
time or the lead creation time, rendered in America/Los_Angeles with a `PT` suffix
and daylight-saving adjustment. Invalid timestamps are omitted.

Landing and referrer URLs normalize HTTP(S), reject embedded credentials, and
remove fragments. Query keys containing email, phone, token, code, session, auth,
password, secret or key (case-insensitive, ignoring separators) have their values
redacted, including repeated/encoded keys. Safe UTM/click parameters remain. Each
URL is limited to **2,048 escaped characters**: oversized queries lose whole pairs,
prioritizing UTM/click attribution, without slicing paths, values or escape entities.
An origin/path exceeding that budget, or raw input over 64 KiB, is omitted. Normal
URLs retain their full scheme, host, path and safe query, including those over 300
characters. This is query-key redaction, not arbitrary PII detection in paths or
values under unrelated keys.

Names use notification-only, read-only DynamoDB lookups. A supplied page ID uses
one primary-key get; its ID, persisted owner and non-archived state must match.
URL-only lookup uses the existing owner `UserIdIndex`, evaluating at most **25**
records in one request and matching exact origin/path. Incomplete results (a
`LastEvaluatedKey`), ambiguity or missing records retain supplied names.
Campaign IDs/UTM campaign names use one owner/date query of existing
`AW-AdsMetricsSnapshots` over the preceding 30 days, evaluating at most **100**
records. Incomplete, malformed or ambiguous results retain raw values. Both reads
use projected fields, no retries and no pagination. The shared **two-second overall
deadline aborts underlying SDK and provider requests**, rather than merely stopping
the wait; late completions cannot alter returned attribution or start more requests.
There is no new table, index, migration, global scan or data mutation.

There is no persisted AW-Ads name directory or click-to-ad index in this repo.
For numeric `ad_id`, `utm_content`, or `utm_term`, an unambiguous persisted **org**
Meta ad-account connection permits a read-only Graph lookup (1.5-second timeout per
candidate, at most three; two seconds overall for enrichment). The result must match both the requested ad ID and the
connected account ID; explicit campaign IDs must agree too. Its campaign/ad-set/ad
names can then enrich the message. No connection/token refresh or provider write
occurs. Missing/ambiguous accounts and lookup failures preserve raw identifiers;
`fbclid`/`gclid` remain labeled raw click identifiers in the Ad line and are never
treated as ad IDs. Non-Meta ads retain their submitted names/identifiers.

Values are Slack-escaped; control characters and formatting delimiters in free
text are neutralized. Optional text is bounded to 300 input characters, labels to
60, and the whole message to 12,000 escaped characters. URLs preserve punctuation
within their separate privacy and length limits.
Whole lines exceeding the budget are omitted; the CRM link has reserved space.
There is no separate field-count cap. Configured Slack user-ID mentions alone use
active mention syntax. `CUSTOMER_FRONTEND_URL` sets the CRM link origin.

## Routing and delivery

Routing uses persisted list owner → org → org-owned Slack bot, never submitted
`tenantId`, `userId`, channel or website branding. Exactly one org Slack connection
must exist, with matching `account_id`/`team_id`, `account_type: bot`, and an `xoxb-`
token. Slack `auth.test` must verify the workspace. There is no shared/personal bot
fallback. `chat:write` and `chat:write.customize` support delivery as Emma.

CRM single/batch insert hooks handle new rows. The forward-lead webhook handles
accepted repeat submissions with a fresh server-generated submission ID, avoiding
a second notification for new rows. Existing async-job recovery, stable Slack
message UUIDs and atomic per-lead step claims deduplicate each event's retries.
Distinct submissions of the same lead intentionally produce separate alerts.
Org-enabled delivery suppresses legacy Slack new-lead and LP-update alerts;
ordinary update alerts and email/WhatsApp behavior remain unchanged.

Three immediate attempts use 1s/2s backoff, 8s request timeouts and bounded
Retry-After handling; recovery handles exhausted/interrupted jobs. Healthy delivery
targets <60 seconds. Routing/config and the type filter are revalidated before each delivery and on recovery. Acknowledged Slack
sends are not retried merely because saving the sent marker fails.

Limits: a crash between saving a lead and durable enqueue, or queue unavailability,
can lose a notification. Ambiguous Slack timeouts are not an exactly-once guarantee.
Recovery reads the latest persisted lead, so subsequent edits can change details
shown by a delayed notification. Opted-in large imports can exceed Slack channel rate limits.
Lead saves never wait for Slack. Queue payloads contain IDs/timestamps and the server-assigned origin, not contacts.

## Activation checklist — no production writes performed

- AgentWeb `#lead-capture`: **`C0BB8HL1AC8`**. Resolved read-only from
  `agentweb-backend` / `Agentweb-backend-env-prod-3`, region `us-west-2`, setting
  `LEAD_CAPTURE_ALERT_SLACK_CHANNEL` on 2026-09-24 UTC. Repository `dev.md` identifies
  that setting with `#lead-capture`. Its existing failure-alert purpose does not
  automatically activate success notifications; set the org destination separately
  when authorized. No production config was changed.
- Verify persisted owners' org and org-owned Emma bot, workspace, channel membership
  and scopes for Haven, SWH and AgentWeb. AgentWeb signup enrollment uses
  `FOUNDERS_USERID` and `FOUNDERS_SIGNUPS_LIST_NAME` from `signupAutoEnrollService.ts`;
  website leads use the same generic insert mechanism.
- With explicit production-config authorization, write these three org rows (resolve
  each org by its persisted org ID; verify the Haven channel ID at activation):

  | Org | Destination | `leadNotifications` value |
  | --- | --- | --- |
  | Haven | `#haven-agentweb` | `{ "enabled": true, "slackChannelId": "<verified #haven-agentweb ID>" }` |
  | Smart Water Heater | `#smartwaterheater-agentweb` (`C0BU679RTC5`) | `{ "enabled": true, "slackChannelId": "C0BU679RTC5" }` |
  | AgentWeb | `#lead-capture` (`C0BB8HL1AC8`) | `{ "enabled": true, "slackChannelId": "C0BB8HL1AC8" }` |

  Omit `maskPhone`, `sources`, `mentions`, and `excludeEmailPatterns` in all three.
- Live test Haven: open any active Haven landing page (not a hardcoded allowlist),
  submit a unique test name, real inbox address and full phone, then confirm exactly
  one `New lead:` message in `#haven-agentweb` within 60 seconds and open its CRM link.
- Live test SWH: submit the same unique real contact through each active
  WaterHeater.app form shape (standard email form, warranty-check and phone-only
  lead-gating form). Confirm each event in `#smartwaterheater-agentweb`; the generated
  `noemail+*@waterheater.app` address must be absent and the full phone must remain.
- Live test AgentWeb: submit a unique company-email lead through the public AgentWeb
  lead form, then confirm one message in `#lead-capture` and open its CRM link.
  Signup auto-enrollment is `integration` and does not notify by default.
- For each org, additionally submit an arbitrary newly-created/unknown LP form and a
  direct CRM insert. Verify one Emma alert for the form and none for the manual
  insert under defaults. Opt in to `manual` and repeat with a new lead to verify
  an alert in the correct channel within 60s, exact top layout/full contacts, available details, empty-field omission and
  CRM link. Replay a queued event and verify no duplicate.
- Verify placeholder email is omitted while real email and full phone remain, and
  verify no delivery to another org. No live Slack smoke was performed here.

Rollback: revert the PR. Operationally, disable the org config to stop delivery; pending jobs recheck before sending.
Complexity impact: extends one generic formatter and existing queue; adds one
repeat-submission hook and removes arbitrary email-hiding/field-count behavior.
No dependency, new table, polling loop, production config or data mutation added.

## Verification for this follow-up

Privacy regressions first reproduced **3 failures with 117 existing tests passing**.
Final focused Jest: **195 passed in 5 suites**, covering formatter/privacy,
attribution, SDK request bounds/cancellation, forwarding and legacy notifications.
Commands from `backend/`:

```sh
NODE_OPTIONS=--max-old-space-size=1536 ./node_modules/.bin/jest --runInBand --runTestsByPath \
  src/__tests__/orgLeadNotificationService.test.ts \
  src/__tests__/leadNotificationAttribution.test.ts \
  src/__tests__/leadNotificationLookup.test.ts \
  src/__tests__/leadListAlertService.orgNotifications.test.ts \
  src/__tests__/webhooks.leadForwarding.test.ts

node --max-old-space-size=1536 ./node_modules/typescript/bin/tsc --noEmit
```

The **actual full backend typecheck** was attempted on Atem using the repository's
`tsconfig.json` and entire `src/**/*` graph. The command above is the full compiler
command from `npm run typecheck`, with its hardcoded 6144 MB heap replaced by the
requested 1536 MB cap (setting `NODE_OPTIONS` alone cannot override the script's
explicit cap). **It failed: exit 134, `Reached heap limit Allocation failed -
JavaScript heap out of memory`, before TypeScript diagnostics.** The cap was not
raised. Full backend type safety is therefore unverified; no scratch/scoped harness
is presented as full evidence. Jest uses the repository's isolated-module transform
and does not establish full type safety either.

`git diff --check` passed. No full build, live Slack send, commit, push or deployment.
Complexity impact: replaces unbounded shared-service pagination with one small
notification-only storage adapter; one sanitizer serves both URL fields. Adds no
dependency, schema, persistence or configuration change.

## Haven capture diagnosis (2026-09-24)

`https://learn.usehaven.ai/` currently serves Webflow, not the Next.js LP repo.
Its inline `wf-form-Main-Form` handler POSTs only to
`https://api.hsforms.com/submissions/v3/integration/submit/45038699/8df411dd-00aa-4051-8cb9-626fb64ff2d3`
and redirects to `https://calendly.com/havenapp/haven-demo` even on non-2xx or
network failure. A browser submission with outbound POSTs intercepted confirmed
this behavior; no actual lead was sent. The live `/api/capture` path returns 404.

The separate `/home/harsha/lp-work/lp-haven` repo already implements a valid capture
path in `app/haven-automate-tenant-communic/_components/lead-capture-form.tsx` →
`app/api/capture/route.ts` → AgentWeb `/api/webhooks/forward-lead`. Its configured
list `list_1785171395180_9k5a5nzny` exists and has `publicAccessEnabled: true`
(verified with a projected, read-only DynamoDB get). The local `domainMap.ts` is
empty, and changes to this repo cannot affect the currently served Webflow form.

Necessary LP-side patch if this hostname is intended to serve the generated LP:

```diff
--- domainMap.ts
+++ domainMap.ts
@@
-export const DOMAIN_MAP: Record<string, string> = {};
+export const DOMAIN_MAP: Record<string, string> = {
+  "learn.usehaven.ai": "/haven-automate-tenant-communic",
+};
```

Then attach the hostname to the LP's Vercel project and switch its domain routing
from Webflow to that deployment. The existing middleware stamps `aw_page` with the
mapped path; the existing capture route selects the correct list. No backend code
change is needed for this flow. This patch and hosting changes were **not applied**.

If retaining Webflow is intended, patch its actual form embed/integration instead:
add a server-side relay to AgentWeb's existing forward-lead endpoint with the list
ID above; map `First-Name` → `firstName`, `Last-name` → `lastName`, `mobilephone` →
`phone`, `email`/`company` unchanged, and the units/message/attribution fields into
the documented capture payload. Await successful CRM capture before showing success
or redirecting, and surface/retry failures. A browser-only cross-origin JSON POST
is insufficient: the AgentWeb preflight from this origin currently returns 403.
Do not weaken backend CORS to work around the missing server-side integration.
