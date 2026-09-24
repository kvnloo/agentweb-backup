# Org lead notifications (ENG-2120)

`Organization.leadNotifications` opts an org into immediate Slack delivery for
**every successful CRM insert and every accepted LP form submission**, including
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
is optional/off by default: omit it for all three orgs so every LP and CRM insert
notifies. If explicitly configured, it matches persisted list ID/name or LP/source
identifiers case-insensitively; an empty array selects none.

Only email placeholders matching `noemail+*@waterheater.app` (case-insensitive)
are hidden automatically. The notification still sends. Other addresses are
visible; legacy `excludeEmailPatterns` values no longer broaden email hiding.

## Exact layout

```text
New lead:
Name: Jane Doe
Phone: +1 (415) 555-1234
Email: jane@example.com

Lead list: Inbound
Source: waterheater-landing
Created: 2026-09-23T12:00:00Z
<https://app.agentweb.pro/crm?listId=list-a&leadId=lead-a|Open in CRM>
landingPageName: New LP
landingUrl: https://example.com/path
landingPagePath: /path
campaignName: Launch
campaignId: campaign-1
utm_campaign: launch
utm_content: ad-name
utm_term: ad-set
adId: ad-1
fbclid: fb-click
gclid: g-click
utm_source: google
utm_medium: cpc
referrer: https://referrer.test
heater_type: tankless
```

The header is literally `New lead:`. The top block contains name, phone, email in
that order, with full unmasked contact values. Empty fields, placeholder emails,
and unavailable attribution are omitted; no `Unknown`, em-dash or empty labels.
The detail block includes available list name, source, company, timestamp, CRM
link, LP name/URL/path/ID, campaign name/ID and UTM campaign, ad/ad-set context
(`utm_content`, `utm_term`, ad IDs/names), click IDs, source/medium, referrer and
submitted scalar form fields. `firstTouch`/`lastTouch`, their `utm`, `clickIds` and
allowlisted `extraParams`, top-level click IDs/UTM fallbacks, and `customFields`
provide attribution. Repeat submissions prefer last touch and use `Submitted:`
with their server submission timestamp. No missing attribution is guessed.

Contact aliases and internal/system/credential fields are excluded from custom
fields. Nested objects/arrays are not stringified. Values are Slack-escaped;
line/control characters and formatting delimiters are neutralized. Optional
values are bounded to 300 input characters, labels to 60, and the whole message
to 12,000 escaped characters. Whole optional lines exceeding the budget are
omitted; there is no separate field-count cap. Configured Slack user-ID mentions
alone use active mention syntax. `CUSTOMER_FRONTEND_URL` sets the CRM link origin.

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
targets <60 seconds. Routing/config is revalidated on recovery. Acknowledged Slack
sends are not retried merely because saving the sent marker fails.

Limits: a crash between saving a lead and durable enqueue, or queue unavailability,
can lose a notification. Ambiguous Slack timeouts are not an exactly-once guarantee.
Recovery reads the latest persisted lead, so subsequent edits can change details
shown by a delayed notification. Large imports can exceed Slack channel rate limits.
Lead saves never wait for Slack. Queue payloads contain IDs/timestamps, not contacts.

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
  signup/lead form (the generic insert routes to the founders/signup list), then
  confirm one message in `#lead-capture` and open its CRM link.
- For each org, additionally submit an arbitrary newly-created/unknown LP form and a
  direct CRM insert. Verify one Emma alert per event in the correct channel within
  60s, exact top layout/full contacts, available details, empty-field omission and
  CRM link. Replay a queued event and verify no duplicate.
- Verify placeholder email is omitted while real email and full phone remain, and
  verify no delivery to another org. No live Slack smoke was performed here.

Rollback: disable the org config; pending jobs recheck before delivery.
Complexity impact: extends one generic formatter and existing queue; adds one
repeat-submission hook and removes arbitrary email-hiding/field-count behavior.
No dependency, new table, polling loop, production config or data mutation added.

## Verification for this revision

Focused Jest: **169 passed in 8 suites**. TDD reproduced 36 formatter/default
failures with 15 passing tests, then 2 repeat-submission failures with 9 passing
tests before their respective fixes. Final command from `backend/`:

```sh
node --max-old-space-size=2048 node_modules/.bin/jest --runInBand --runTestsByPath \
  src/__tests__/orgLeadNotificationService.test.ts \
  src/__tests__/leadListAlertService.orgNotifications.test.ts \
  src/__tests__/crmDb.createLead.userId.test.ts \
  src/__tests__/crmDb.batchCreateLeads.nameCompanyKey.test.ts \
  src/__tests__/leadListAlertService.apiEvents.test.ts \
  src/__tests__/slackLeadNotification.test.ts \
  src/__tests__/webhooks.forwardLead.customFields.test.ts \
  src/__tests__/webhooks.leadForwarding.test.ts
```

Scoped TypeScript compiler check: **6 changed TypeScript files, 0 diagnostics**.
Ran serially with `node --max-old-space-size=4096 /tmp/eng2120-scoped-typecheck.cjs`:
uses repository compiler options, explicit Node/Jest types, those six root files,
and syntactic/semantic diagnostics scoped to each changed file. The initial
harness omitted Jest type roots; correcting the harness resolved those diagnostics.
`git diff --check` passed. No full typecheck, build, live Slack send or deployment.
