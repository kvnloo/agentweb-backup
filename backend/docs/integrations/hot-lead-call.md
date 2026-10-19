# Hot-lead auto-call (ENG-2271)

When a landing-page form lead arrives with a phone number, AgentWeb phones the
business owner from a Twilio number the org owns and says "New lead from
<business name>. Press 1 to connect to them now." On `1` it dials the lead and
bridges the two. The outcome and every step are written to the lead's timeline.

It is a second subscriber to the same moment as the Slack lead alert
([lead-notifications.md](./lead-notifications.md)). It never delays, replaces or
suppresses that alert: a skipped or failed call leaves the Slack message as the
fallback.

Status of this document: written against the feature branch with WP1-WP6 merged.
WP7 (the Emma setup tools: provision number, verify destination) was still in
review on branch `eng-2271/wp7` when this was written; the WP7 sections describe
that branch and must be re-checked against the merged code. Everything marked
**to confirm with Twilio** or listed under "Not verified" has never been run
against a real Twilio account.

## Call flow

```mermaid
sequenceDiagram
  autonumber
  participant Lead as Landing form
  participant App as AgentWeb backend
  participant Tw as Twilio
  participant Owner as Owner's phone
  participant LeadPhone as Lead's phone

  Lead->>App: form submit -> crmDb.createLead (or repeat submission)
  App->>App: dispatchLeadCreated -> dispatchHotLeadCall (kill switch, gates, limits)
  App->>App: LeadCallStore.create(state=dialing) is the lock
  App->>Tw: calls.create(to=owner, from=org number, url=/owner, statusCallback=/status, timeout=25s)
  App->>App: state=owner_ringing, event call.initiated
  Tw->>Owner: rings
  Owner-->>Tw: answers
  Tw->>App: POST /owner (signed)
  App-->>Tw: Gather TwiML (prompt, 8s, 1 digit) ; state=owner_answered, call.owner_answered
  Owner->>Tw: presses 1
  Tw->>App: POST /gather Digits=1 (signed)
  App-->>Tw: Say + Dial callerId=org number, Number=lead (statusCallback ...&leg=lead) ; state=bridging
  Tw->>LeadPhone: rings (25s)
  LeadPhone-->>Tw: answers
  Tw->>App: POST /status leg=lead CallStatus=in-progress
  Note over App: state=connected, event call.connected
  Tw->>App: POST /dial DialCallStatus=completed (action URL, after the bridge ends)
  Tw->>App: POST /status leg=lead completed + CallDuration  -> metered once
  Tw->>App: POST /status (owner) completed + CallDuration   -> metered once
  Note over App: last leg metered -> state=finished, outcome=completed, event call.completed
```

Branches (all end in `finished` once every leg that was dialed is metered):

| Situation | Webhook that decides | Outcome | Timeline events after `call.initiated` |
| --- | --- | --- | --- |
| Owner presses 1, lead answers | `/gather`, lead `/status` | `completed` | `call.owner_answered`, `call.connected`, `call.completed` |
| Owner presses another digit | `/gather` | `owner_declined` | `call.owner_answered`, `call.owner_declined`, `call.completed` |
| Owner hangs up on or ignores the prompt | owner `/status` terminal | `owner_declined` | `call.owner_answered`, `call.owner_declined`, `call.completed` |
| Owner never picks up (no-answer, busy, failed, canceled) | owner `/status` terminal | `owner_no_answer` | `call.owner_no_answer`, `call.completed` |
| Owner presses 1, lead does not answer | `/dial` with `no-answer`, `busy`, `failed` or `canceled` | `lead_no_answer` | `call.owner_answered`, `call.lead_no_answer`, `call.completed` |
| Lead number no longer valid at bridge time | `/gather` | `lead_phone_invalid` (record stays `owner_answered` until the owner leg ends) | `call.owner_answered`, `call.failed` (reason `lead_phone_invalid`), `call.completed` |
| Kill switch or config turned off while the owner is on the line | `/owner` or `/gather` | `aborted` | `call.failed` (reason `aborted`), `call.completed` |
| Bridge ended but `/dial` never reported a result | `finishIfComplete` | `bridge_unconfirmed` | `call.completed` |

The leg-metering rule behind "finished": the store refuses to move a terminal
record, so each leg is metered while the record is still live and the LAST leg
to be metered performs the terminal transition. A record therefore stays live
until the final status callback of every dialed leg has arrived.

## Components and file map

All paths are under `backend/src/`.

| Piece | File |
| --- | --- |
| Hook (second subscriber to the lead-created moment) | `services/orgLeadNotificationService.ts` `dispatchLeadCreated` calls `dispatchHotLeadCall` first, fire-and-forget. The batch path `dispatchLeadsCreated` deliberately does not. |
| Orchestrator: gates, limits, create-first, place call | `services/hotLeadCallService.ts` (queue source `hot_lead_call`, `maxAttempts: 1`, registered in `app.ts`) |
| Org config type and strict validator | `services/hotLeadCallConfig.ts` |
| Org/list/owner routing for the call | `services/voice/hotLeadCallContext.ts` |
| Global kill switch | `services/voice/hotLeadCallMode.ts` |
| Quiet hours, abuse limits, slot reservation | `services/voice/hotLeadCallLimits.ts`, `services/voice/limitStore.ts` (DynamoDB), `services/voice/fakeLimitStore.ts` (tests) |
| Call record (state machine storage) and timeline events | `services/voice/leadCallStore.ts`, `services/voice/leadCallStore.types.ts` |
| Twilio seam (`placeCall`, `buyNumber`, `releaseNumber`, `validateSignature`) | `services/voice/voiceProvider.ts` (the only file that imports `twilio`), `services/voice/fakeVoiceProvider.ts` |
| Webhook URLs | `services/voice/voiceUrls.ts` |
| TwiML builders (hand-built XML, XML-escaped) | `services/voice/twiml.ts` |
| Webhook routes, mounted at `/api/webhooks/twilio-voice` | `routes/twilioVoiceWebhook.ts` (`/owner`, `/gather`, `/dial`, `/status`) |
| Per-leg metering | `services/voice/voiceUsage.ts` `recordCallUsage` -> `recordVendorUsage` |
| Rate card and runtime rate overrides | `utils/vendorRateCard.ts`, `routes/adminVendorRates.ts` |
| Twilio credentials | `utils/secretsManager.ts` `getTwilioCredentials` |
| Emma settings tools | `emma/hotLeadCallTools.ts` |
| Emma setup tools (WP7, branch `eng-2271/wp7`) | `emma/hotLeadCallSetupTools.ts`, `services/voice/numberProvisioning.ts`, `services/voice/destinationVerification.ts`, `services/voice/setupWrites.ts` |
| Admin UI for rates | `partner-portal/src/components/admin/VendorRatesTab.tsx` (Admin > Revenue & billing > Vendor Rates) |

Tests worth knowing: `__tests__/hotLeadCall.e2e.test.ts` (whole flow, real
orchestrator + real webhooks + real store on an in-memory DB fake, signed with
Twilio's own HMAC), `__tests__/hotLeadCallService.test.ts`,
`__tests__/twilioVoiceWebhook.test.ts`, `__tests__/hotLeadCall.flagOff.test.ts`
(Slack path identical with the switch off), `__tests__/hotLeadCallLimits.dynamodbLocal.test.ts`
and `__tests__/leadCallStore.dynamodbLocal.test.ts` (real DynamoDB expressions
against DynamoDB Local).

### The at-most-once rule (create-first)

A phone call cannot be retried the way a Slack message can. The call RECORD is
the lock:

1. All gates pass and a limit slot is reserved.
2. `LeadCallStore.create` writes `lead.system.hot_lead_call` with `state=dialing`
   using a create-if-absent conditional write. `false` means a record already
   exists: do not dial. A lead gets at most one call record, ever (v1).
3. `placeCall`. Success: `owner_ringing` + `call.initiated`. Twilio rejected it
   (HTTP 4xx other than 408, `placed: 'no'`): terminal `failed` /
   `place_rejected` + `call.failed`. Anything ambiguous (timeout, 5xx, no
   response, no sid): the record stays `dialing` with `outcome=placement_unknown`
   + `call.failed` (reason `placement_unknown`), and is NEVER retried.
4. A `dialing` record can still be adopted: the first signed owner-leg callback
   (`/owner` or the owner `/status`) for the same `jobKey` supplies the CallSid,
   moves the record to `owner_ringing`, writes `call.initiated`, and the call is
   metered normally.

The queue job row also dedupes the same job key (`sha256(orgId, listId, leadId
[, submissionId])`).

## Org config: `Organization.hotLeadCall`

Validated by `hotLeadCallConfigOf` (strict: any invalid field, or an unknown key,
makes the whole config invalid; a stored config that fails validation means "no
call, Slack only"). Validation applies to every read, including the webhooks.

| Field | Rule |
| --- | --- |
| `enabled` | boolean, required. Enabled requires `destinationVerifiedAt`, `twilioNumber` and `quietHours`; a half-configured org can only be saved disabled. |
| `destinationPhone` | required. Canonical E.164, US or CA only (Puerto Rico, Guam and other +1 territories refused); premium, toll-free, personal, shared-cost, UAN and VOIP number types refused. Must differ from `twilioNumber`. |
| `destinationVerifiedAt` | system-managed, ISO timestamp (set by confirming the verification code). |
| `twilioNumber`, `twilioNumberSid` | system-managed. Same phone rules; sid must match `PN` + 32 hex. |
| `leadTypes` | non-empty subset of the lead origins; default `["form_fill"]`. In practice the orchestrator only ever calls for `form_fill`; other origins return before any read. |
| `maxAgeMinutes` | integer 1-60, default 10. A lead older than this when the job runs (`submittedAt`, else lead `createdAt`; a missing or unparseable time fails closed) is skipped as `too_old`. |
| `maxCallsPerHour` | integer 1-30, default 6. |
| `maxCallsPerDay` | integer 1-100, default 20. |
| `ownerCooldownMinutes` | integer 1-60, default 2. |
| `announcedName` | required, trimmed, 1-60 chars of letters, digits, space and `. , & ' -`. Spoken in `<Say>`; XML-escaped by the TwiML builder. |
| `quietHours` | `{ start, end, timezone }`, `HH:MM` 24h, `start != end`, defaults 08:00 / 21:00. It is the window in which calls ARE allowed, in the org's IANA `Area/Location` timezone (UTC, abbreviations and `Etc/` refused). `start > end` wraps past midnight. Start inclusive, end exclusive, minute granularity. The lead's own timezone is not considered. Required to enable. |
| `allowedCountries` | non-empty subset of `["US","CA"]` (default both); the lead's number must resolve to one of them. |

The lead's number is read from the lead row at dispatch AND again at bridge time;
national-format numbers are parsed as US. It never travels in a URL or a query.

## Emma tools

Registered as foundation tools. Org membership comes from the authenticated user
(never from arguments); reads need membership, writes need `org:configure`
(owner/admin). Not available in shared sessions.

Settings (merged):

- `get_hot_lead_call_settings({})` returns `configured`, `enabled`,
  `destinationPhone` (masked to the last 4 digits), `destinationVerified`,
  `callerNumberAssigned`, `leadTypes`, `announcedName`, `quietHours`,
  `allowedCountries` and the four limits (defaults when unset). No SIDs or full
  numbers.
- `update_hot_lead_call_settings({...})` takes any of `enabled`,
  `destinationPhone`, `leadTypes`, the four limit fields, `announcedName`,
  `quietHours`, `allowedCountries`. `destinationVerifiedAt`, `twilioNumber` and
  `twilioNumberSid` are refused (system-managed). The first save needs
  `destinationPhone` and `announcedName`. Changing `destinationPhone` drops the
  verification and forces `enabled:false`. Writes are conditional on the stored
  attribute being unchanged since it was read, so a concurrent edit fails
  instead of clobbering.

Setup tools (WP7, `eng-2271/wp7`, re-verify after merge). They work while the
global kill switch is off, and are also blocked in shared sessions:

- `provision_hot_lead_call_number({confirm: true, areaCode?})` buys one US local
  voice-enabled number (the cost is stated in the tool text, read from the live
  rate card). Needs saved settings, one number per org, at most 2 purchases per
  org per rolling 24h (reservation stored in `hotLeadCallProvisioning` before
  Twilio is called). `confirm` is advisory only: the model controls it. An
  ambiguous buy failure is logged as `ORPHAN RISK` and is not retried.
- `release_hot_lead_call_number({})` turns calling off, releases the number,
  clears `twilioNumber`/`twilioNumberSid`. At most 6 releases per day per org.
- `start_hot_lead_call_verification({})` rings the SAVED destination from the
  org number and reads a 6-digit code (inline TwiML, no webhook). The code is
  stored only as an HMAC in `hotLeadCallVerification`, valid 10 minutes, 5
  attempts; one start per 2 minutes, 5 per day. Metered as one estimated minute
  (leg `verify`).
- `confirm_hot_lead_call_verification({code})` checks the code and writes
  `destinationVerifiedAt`.

Order of setup, which the tool text also teaches Emma:

1. `update_hot_lead_call_settings`: destination phone, announced name, quiet
   hours (with timezone), optionally lead types and limits. Saved disabled.
2. `provision_hot_lead_call_number` (spends money, needs explicit user consent).
3. `start_hot_lead_call_verification`, then `confirm_hot_lead_call_verification`
   with the code the owner heard.
4. `update_hot_lead_call_settings({enabled: true})`. Refused unless the phone is
   verified, a number is assigned and quiet hours are set.

Verification limits: it proves a phone answered and the code was heard. A
voicemail that plays the message back can also pass it, and the spoken code is
visible in the Twilio call log to anyone with access to the Twilio account.

## Settings keys (AW-Settings)

| Key | Value | Meaning |
| --- | --- | --- |
| `hot_lead_call_mode` | `on` (case-insensitive, trimmed) | Global master switch. Anything else, a missing row, a read error, or a read slower than 1.5s means OFF. |
| `vendor_rate_overrides` | JSON string | Admin overrides of provisional Twilio rates (see Metering). |

`hot_lead_call_mode` semantics: read from DynamoDB `AW-Settings` (item
`settingName = hot_lead_call_mode`, attribute `settingValue`) and cached per
backend instance for 30 seconds, so a flip takes up to ~30s per instance to
apply, and the failure direction is off. Off means `dispatchHotLeadCall` returns
before any read or write (no lead read, no limit key, no event, no queue job),
and in-flight calls are cut short: an owner who picks up after the switch is
turned off hears a hangup (`aborted`) while the leg is still metered. Under
Jest (`NODE_ENV=test`) it is always off unless overridden.

## Secrets and configuration

- Twilio credentials: JSON secret `{"accountSid": "...", "authToken": "..."}` named
  `prod/AgentWeb/Twilio` in production and `dev/AgentWeb/Twilio` otherwise
  (AWS Secrets Manager). The pair `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` in
  the environment overrides the secret, but only when BOTH are set (never mixed;
  a partial pair is ignored with a warning). Cached 5 minutes, successes only.
  Missing fields throw. The auth token also verifies inbound webhook
  signatures, so rotating it takes effect within the cache TTL without a
  restart.
- `BACKEND_URL` must be the public origin Twilio can reach (scheme and host
  exactly as Twilio will call it, no trailing path). It builds every webhook URL
  AND is the base the signature is verified against, with `req.originalUrl`
  appended (never the Host header). In `production`, `staging` or any
  `NODE_ENV` other than `development`/`test`, an unset value throws before any
  record is created or call placed (the localhost fallback applies only in
  development/test).
- Webhook mount: `/api/webhooks/twilio-voice`, no auth middleware; every request
  must carry a valid `X-Twilio-Signature`. The route has its own 64 KB flat-form
  body parser, registered before the global 50 MB parsers.

### Twilio account prerequisites

What the code requires (verified from code):

- A Twilio account whose credentials are in the secret above.
- The caller ID must be a number the account owns (the TwiML `<Dial callerId>`
  and the REST `from`). The WP7 tool buys it: `availablePhoneNumbers('US').local`,
  voice-enabled, optionally by area code. The org's number is always a US local
  number, even for a Canadian owner.
- Outbound calls to US and Canadian numbers only (`allowedCountries`).
- Public HTTPS reachability of `BACKEND_URL` for the four webhooks.

To confirm with Twilio (not verifiable from this repo): Voice Geographic
Permissions must allow outbound calls to the United States and Canada; whether a
purchased US local number needs a regulatory bundle or address on this account;
whether A2P 10DLC applies (it is an SMS registration and this feature sends no
SMS, so it is believed not to apply); account balance and spend limits;
caller-ID reputation and STIR/SHAKEN attestation for the purchased numbers
(affects whether owners see the call as spam).

## Persistent data (data-plane list)

No new table or index. The feature writes:

| What | Where | Written by |
| --- | --- | --- |
| `hotLeadCall` (config) | org attribute on the org item | Emma settings tool, number provisioning, verification |
| `hotLeadCallVerification` (HMAC of pending code, attempts, start history) | org attribute (WP7) | verification tools |
| `hotLeadCallProvisioning` (purchase/release timestamps for the daily caps) | org attribute (WP7) | provisioning tools |
| `hot_lead_call_mode` | AW-Settings item | operators |
| `vendor_rate_overrides` | AW-Settings item | admin Vendor Rates tab |
| `system.hot_lead_call` (call record: `state`, `jobKey`, `startedAt`, `updatedAt`, `ownerCallSid`, `leadCallSid`, `outcome`, `meteredLegs`, `lastSequence`) | on the lead row (AW-Leads), no phone number | orchestrator and webhooks |
| Timeline events `call.*` | the lead's `engagements` list | `LeadCallStore.addEvent` |
| `hlc#phone#<hmac>`, `hlc#cool#<orgId>`, `hlc#cap#h#<orgId>#<UTC hour>`, `hlc#cap#d#<orgId>#<local date>` | existing table `AW-MCPSessions` (partition key `sessionId`, attribute `ttl`) | limit store |

Notes:

- Call-event details are scalar only, phone-like text is redacted, and values
  containing the words in `ENGAGED_EVENT_KEYWORDS` (`clicked`, `replied`,
  `received`) are dropped so a call event can never mark a lead as engaged.
- Phone numbers are not stored in the record, the limit keys (an HMAC keyed with
  `JWT_SECRET`; rotating `JWT_SECRET` forgets the 24h phone window) or any
  event, and are redacted to the last digits in logs.
- Putting limit rows in `AW-MCPSessions` reuses a table that has a native `ttl`
  attribute and is never scanned or listed. This needs ops to confirm in each
  environment: the table exists, DynamoDB TTL is enabled on `ttl` (create-tables
  does not enable it), and the backend IAM role may `UpdateItem`, `PutItem` and
  `DeleteItem` on it. Correctness never depends on the TTL reaper: counters are
  bucketed per window and claims are tested against their own expiry.

## Metering and spend

Every Twilio call is billed to AgentWeb's account and recorded through
`recordVendorUsage` (provider `twilio`, feature `hot_lead_call`), priced by
`rateKey` from the vendor rate card (`utils/vendorRateCard.ts`).

| Rate key | Unit | Provisional default | Metered |
| --- | --- | --- | --- |
| `voice_minute_outbound` | minute | $0.014 | per leg, from the `/status` webhook |
| `number_monthly_rent` | number_month | $1.15 | WP7 only, at purchase (first month) |

The defaults are PROVISIONAL placeholders at Twilio's public US list price
(checked 2026-10-19) pending the rate allocation from Harsha (get this before
go-live). They can be changed at runtime without a deploy: admin area >
Revenue & billing > **Vendor Rates** tab, or `GET/PUT /api/admin/vendor-rates`
(admin only). Overrides live in the `vendor_rate_overrides` setting; only
`twilio` keys that exist on the card can be overridden; a value must be a plain
decimal, > 0, <= 1000, at most 6 decimals; `null` removes an override. Rates are
cached ~60 seconds. Spend events carry the rate-card version, with an
`+ovr:<updatedAt>` suffix when an overridden rate priced them.

Rules the code enforces:

- Voice: one usage event per leg, with the leg's own CallSid, idempotency key
  `twilio:voice:<CallSid>:<owner|lead>`, quantity `ceil(CallDuration / 60)`
  minutes (round up per leg; Twilio's pricing page states a per-minute rate and
  no rounding rule, so rounding up is the conservative choice). A leg with
  `CallDuration` 0 records no event but is still marked metered so the call can
  finish. A missing or non-numeric `CallDuration` is never defaulted to 0: the
  leg is not billed and a warning is logged, so a malformed callback
  undercharges visibly rather than silently.
- The owner leg is billed as an outbound minute for the whole time the owner is
  on the line, including the bridged conversation, plus the lead leg's own
  minutes. Both are outbound dials from our number.
- The leg is marked metered in the same conditional transition that wins the
  right to bill, then billed. A crash between the two undercounts; it never
  double-bills. Twilio's status-callback retries are idempotent on the leg and on
  `lastSequence`.
- The verification call (WP7) has no status callback and is metered at an
  estimated one minute.
- **Recurring number rent is NOT metered.** Only the first month is recorded at
  purchase. A scheduled job that meters `twilio:number:<sid>:<YYYY-MM>` for every
  stored `twilioNumberSid` each month is a follow-up (see below).
- Calls made while the org is disabled or the switch is off (a call already in
  flight) are still metered from the list owner's id.

## Abuse limits and their known limits

Gates run cheapest first. Stateless gates run at dispatch and again in the job;
the limits that count run once, just before the record is created, and are given
back if the record is not created:

1. Kill switch, origin `form_fill`, org config valid and enabled, lead exists,
   not a smoke-test lead, not a progressive-capture draft, has a phone.
2. Skip gates with a `call.skipped` event: `no_caller_number`, `unsafe_id` (list
   or lead id outside `[A-Za-z0-9_.:-]{1,200}`, which the webhooks would
   reject), `invalid_phone`, `country_not_allowed`, `outside_quiet_hours`,
   `too_old`.
3. Limits, in this order: `duplicate_phone` (same org and number within 24h),
   `owner_cooldown`, `org_hourly_cap` (UTC clock hour), `org_daily_cap` (org's
   local calendar day). Each is one conditional write.
4. `limits_unavailable`: the limit store failed; nothing is dialed, the job
   fails (not retried), an event is written best-effort.

A repeat submission of a lead that already has a call record trips the phone
marker and is silent (the timeline already holds the call). After the 24h phone
window a repeat still cannot dial: the record is permanent.

Known limits, accepted:

- Fixed windows can admit up to 2x a cap across an hour or day boundary.
- Phone-rotating bots can consume the org's hourly and daily caps; the Slack
  alert still fires.
- Whoever submits a number first suppresses calls for that number for 24h.
- The cooldown skips a second genuine lead within `ownerCooldownMinutes`.
- A process crash between reserving and `create` leaves the 24h phone marker and
  the cooldown claim held with no record: a repeat of that number is refused as
  `duplicate_phone` with a silent timeline.
- A lead gets one call record ever. A failed attempt (`place_rejected`) is not
  retried automatically.
- `confirm: true` on the provisioning tool is advisory. The real controls are
  the per-org purchase and release caps.

## Outcomes and timeline events

Event types written to the lead timeline (`eventType`, with a scalar `eventData`):

| Event | Written when | Data |
| --- | --- | --- |
| `call.initiated` | Twilio accepted the owner call (orchestrator), or a signed owner callback adopted the CallSid of an unrecorded call | - |
| `call.owner_answered` | owner picked up (`/owner`), once | - |
| `call.owner_declined` | owner pressed a key other than 1, or hung up on the prompt | - |
| `call.owner_no_answer` | owner leg ended before pickup | - |
| `call.connected` | lead answered (lead `/status` in-progress, or `/dial` completed) | - |
| `call.lead_no_answer` | `/dial` reported no-answer, busy, failed or canceled | `dialStatus` |
| `call.completed` | last dialed leg metered; the record is `finished` | `outcome` |
| `call.failed` | `reason`: `place_rejected`, `placement_unknown`, `lead_phone_invalid`, `aborted` | `reason` |
| `call.skipped` | a gate or limit refused (no Twilio call made) | `reason` (list above) |

Record `state`: `dialing`, `owner_ringing`, `owner_answered`, `bridging`,
`connected` (live) and `finished`, `failed`, `skipped` (terminal; `skipped` is in
the type but the orchestrator records skips as events only). `outcome` values:
`completed`, `owner_declined`, `owner_no_answer`, `lead_no_answer`,
`lead_phone_invalid`, `bridge_unconfirmed`, `aborted`, `place_rejected`,
`placement_unknown` (informational on a live `dialing` record).

Webhook answers: a bad or missing signature is 401; credentials that cannot be
loaded 503; a signed request that is not for a live call this job owns gets a
bare `<Hangup/>` with 200 (TwiML endpoints) or an empty 200 (`/status`), and
writes nothing; `/status` answers 500 only when a finished leg cannot be billed
(no owner to bill, or metering lost its race three times). Status callback URLs
carry the Twilio retry override `#rc=3&rp=5xx,ct` so Twilio redelivers a 5xx.

## Failure modes and ops runbook

### Turn it off

- **Everywhere, instantly:** set the AW-Settings item `hot_lead_call_mode` to
  anything other than `on` (for example `off`), or delete it. Takes up to 30s to
  reach every instance. Nothing in flight is retried; an owner already on the
  prompt is hung up on and billed for the time used.
- **One org:** the org owner/admin (or Emma on their behalf) calls
  `update_hot_lead_call_settings({enabled: false})`, or an operator sets
  `hotLeadCall.enabled` to `false` on the org item. Read on every dispatch and
  webhook (an eventually consistent DynamoDB read, so seconds). The job re-runs
  the gates before it creates the record.
- **Release the number** (stops the monthly charge): `release_hot_lead_call_number`
  (WP7), which turns calling off first.
- **Rollback of the code:** revert the merge. With `hot_lead_call_mode` off the
  feature is inert; existing org attributes and lead records are ignored by older
  code.

### Stuck records

A record can stay live if a final status callback never arrives (Twilio outage,
5xx beyond the three retries, a `BACKEND_URL` problem). No cron cleans these up.
Look for `lead.system.hot_lead_call.state` in `dialing`, `owner_ringing`,
`owner_answered`, `bridging` or `connected` with an old `updatedAt`:

- `dialing` with `outcome=placement_unknown`: the placement was ambiguous. Check
  the Twilio call log for a call from the org number to the owner around
  `startedAt`. If one exists and its callbacks never arrived, the leg was
  probably billed by Twilio and not metered by us.
- `owner_ringing`/`owner_answered`: the owner leg's final callback is missing.
- `bridging`/`connected`: the bridge ended but a leg callback is missing; the
  call may be unmetered. Reconcile minutes from the Twilio call log (owner CallSid
  and its child) against the recorded spend events with idempotency key `twilio:voice:<CallSid>:<leg>`.
- A stuck record only affects that lead (it stays at most one call ever) and
  the metering for that call. It blocks nothing for other leads. Repairing the
  record or re-allowing a call for the lead is a production data change (Harsha
  gate); do not edit it without that.

### Orphan numbers

Buying and releasing are non-idempotent. Search the logs for `ORPHAN number` or
`ORPHAN RISK`: a number may be billed on the Twilio account and not recorded on
any org. Reconcile in the Twilio console (Phone Numbers > Active numbers)
against `hotLeadCall.twilioNumberSid` of every org, and release strays by hand.
Do not let Emma retry an ambiguous purchase.

### Other symptoms

| Symptom | Likely cause |
| --- | --- |
| Owner is called but hears "application error" | The `/owner` fetch failed: `BACKEND_URL` wrong or unreachable (check scheme and host), or credentials could not be loaded (503), or the signature failed (401). Twilio's call log shows the webhook response. |
| Calls never placed, timeline shows `call.skipped` | The `reason` names the gate. `outside_quiet_hours`, `duplicate_phone` and `owner_cooldown` are expected behavior. |
| No event and no call | Kill switch off, org disabled or config invalid, lead not `form_fill`, smoke-test lead, draft lead, or no phone: all silent by design. |
| `call.skipped` `limits_unavailable` | `AW-MCPSessions` missing, IAM denied, or throttled. Fails closed. |
| `no owner to bill for list` in logs | The list owner could not be resolved; the leg was not metered and `/status` answers 500. |
| Slack alert arrives but no call | Expected whenever any gate refuses; the two paths are independent. |

## Go-live checklist

Owner: Anurag. None of these may be skipped before `hot_lead_call_mode` is turned
on anywhere.

1. Compliance sign-off (decision D7): consent and disclosure for automated calls
   to business owners and for connecting leads, call recording stance (nothing is
   recorded by this feature), regional restrictions.
2. Twilio account: production credentials in `prod/AgentWeb/Twilio`, billing and
   spend limits set, Voice Geographic Permissions allow US and Canada, no other
   restriction on outbound calls (see "to confirm with Twilio").
3. `BACKEND_URL` set to the public HTTPS origin in the production environment and
   reachable from Twilio. Test one signed callback.
4. `AW-MCPSessions` exists in prod with DynamoDB TTL enabled on `ttl` and the
   backend role allowed `UpdateItem`, `PutItem`, `DeleteItem` on it.
5. Rate card from Harsha: replace or confirm the provisional $0.014/minute and
   $1.15/month, using the Vendor Rates tab or a code change with a
   `VENDOR_RATE_CARD_VERSION` bump.
6. Ship WP7 (setup tools), then set up Haven: save settings, provision a number,
   verify the owner's phone, enable (each step needs the org's explicit consent;
   Haven's org write needs the usual production-config authorization).
7. Staging end-to-end with real phones before production: submit a test lead from
   a real form, owner answers and presses 1, lead answers, both hang up; then
   repeat for decline, owner no-answer and lead no-answer. Confirm the timeline,
   one spend event per leg with plausible minutes, and that the Slack alert is
   unchanged. Fill in the "Not verified" items below from what Twilio actually
   sent.
8. Flip `hot_lead_call_mode` to `on` only after the org itself is enabled, watch
   the first real leads, keep the instant-off command to hand.

## Not verified without a real Twilio account

None of these has been observed against Twilio. They are assumptions taken from
Twilio's documentation and encoded in tests with synthetic payloads:

- `<Number>` status callbacks (`statusCallbackEvent="initiated ringing answered
  completed"`) for a lead that does not answer or is busy: that they arrive
  with `CallStatus` `no-answer`/`busy`, a `ParentCallSid` equal to the owner
  CallSid, a `SequenceNumber`, and a `CallDuration` (the code treats a missing
  `CallDuration` as unbilled and logs a warning).
- `<Dial action>` behavior when the owner hangs up in the middle of the bridge:
  whether `/dial` is still requested, with which `DialCallStatus`, and whether the
  lead leg is torn down. The code finishes such a call as `bridge_unconfirmed`
  if `/dial` never reports.
- The retry fragment `#rc=3&rp=5xx,ct` on `statusCallback` supplied through the
  REST `calls.create` call (documented for webhook URLs in general; the SDK
  passing the fragment through untouched is assumed), and that Twilio signs the
  URL without it.
- The owner leg's REST `statusCallbackEvent: ['completed']` delivering exactly
  one completed callback with `CallDuration`, including for no-answer (assumed
  `0`).
- Voicemail: the owner's voicemail answering the call. The prompt would play to
  the mailbox; there is no answering-machine detection and "press 1" will not be
  pressed, so it ends as `owner_declined` after the Gather times out, and the
  answered voicemail leg is billed.
- `BACKEND_URL` scheme and port: Twilio signs the exact URL it requested. A URL
  with a default port, a trailing slash or an `http`/`https` mismatch behind a
  proxy or load balancer would fail signature checks (401). Confirm with the
  first real callback.
- The `X-Twilio-Signature` for form bodies with repeated or empty parameters
  (empty values such as `FinishedOnKey` are signed by Twilio's algorithm; the
  test uses the library's own function).
- Per-minute rounding: whether Twilio bills each leg per started minute or per
  second, so whether `ceil` over- or under-counts against the invoice.
- Number purchase: A2P and regulatory-bundle requirements, and the local-number
  price.

## Known follow-ups

- **Recurring number rent metering.** A monthly job that records
  `number_monthly_rent` for every stored `twilioNumberSid` (key
  `twilio:number:<sid>:<YYYY-MM>`). Only the first month is metered today.
- **Stuck-record cleanup.** A documented sweep for records live longer than a
  call can last (and reconciliation of their Twilio legs). No cron exists.
- **Human-approval gate for paid tools.** If WP7 does not add one: buying and
  releasing a number are guarded by per-org caps and the model's `confirm`
  flag only. The existing approval mechanism is Meta-write specific.
- **Missed-call Slack line.** The Slack alert does not say whether the call was
  placed, answered or declined; deliberately deferred so the Slack path stays
  untouched.
- **Retry after `place_rejected`.** v1 gives every lead one call record ever, so
  a definitively rejected placement is never retried. A deliberate retry needs a
  new store operation.
- Voicemail detection and a post-call outcome summary in Emma.
