# WhatsApp Business Platform (Cloud API) Contract

Last derived from code: 2026-08-04

Owner area: `ENG-273 / Anurag`

Primary risk: **Two Meta platform rules make otherwise-correct code undeliverable —
the 24-hour service window, and the pause on marketing templates to US (+1) numbers.
Neither is a preference we chose, and neither is visible in the request payload.**

## Agent Summary

Read this before touching anything WhatsApp.

1. **Free-form text is only legal inside a 24-hour service window** that opens when
   the contact messages us. Outside it, a send MUST use a template Meta pre-approved.
   `whatsappService.sendMessage` checks this locally and refuses early. Do not
   "simplify" that check away — Meta's rejection (131047) surfaces as a delivery
   failure far from the call site, and the customer simply never gets the message.
2. **Marketing templates cannot be delivered to US (+1) numbers.** Meta paused this
   on 2025-04-01; still paused as of 2026-08, no announced end date. Sends fail with
   131049. Every template in the registry is `utility` on purpose. Adding a
   `marketing` one is a compliance decision, not a code change.
3. **Do not put a conversational agent on this channel.** Since 2026-01-15 WhatsApp's
   Business Solution Terms prohibit general-purpose AI assistants where the AI is the
   primary functionality. Structured notifications, approvals and support automation
   are explicitly allowed. `routes/whatsappWebhook.ts` must never open a chat session
   the way `routes/slack.ts` does; a test asserts it never imports one.
4. **Template variables bind positionally.** Meta fills `{{1}}`, `{{2}}` by index.
   Reordering `TEMPLATES.*.variables` does not error — it renders the wrong words into
   the wrong slots. A count mismatch is refused before the request. Pass `''` for an
   absent optional value so the count stays right; `toTemplateParam` (applied inside
   `sendTemplate`) then makes each value acceptable to Meta: empty becomes `-`,
   newlines/tabs and space runs collapse to one space, invisible characters are
   stripped, and the value is capped at 1024 characters. Meta rejects each of those
   with a 400 that does not name the cause. These rules are from Meta's docs and have
   not yet been exercised against the live API.
5. **A destination is never messaged until its owner has proven control of it, and
   there is no endpoint that saves a typed-in number.** The user starts a verification,
   sends `Verify <CODE>` to AgentWeb's WhatsApp number, and the signed webhook connects
   the SENDER's number. Do not add a "save my phone" route, and do not resolve a
   WhatsApp destination without `optIn.verifiedAt` — see "Consent".

## Deployment Model

Single-tenant: AgentWeb sends from **one business number it owns**. This is not
Embedded Signup and there are no per-customer WABAs. Customers are addressed by E.164
phone. Multi-tenant onboarding was evaluated and deferred — see "Deferred" below.

## What AgentWeb Uses This For

| Capability | Supported? | Entry point | Notes |
| --- | --- | --- | --- |
| OAuth/connect | No | — | Single owned number; credentials come from Secrets Manager, not a per-user OAuth flow. |
| Connect a customer's number | Yes | `routes/messagingChannels.ts` `POST /whatsapp/verification`, then an inbound `Verify <CODE>` | The customer messages us first; we never message an unverified number. |
| Send free-form text | Yes | `services/whatsappService.ts` `sendText` | Only inside the 24h window. |
| Send template | Yes | `services/whatsappService.ts` `sendTemplate` | Required outside the window. |
| Window-aware send | Yes | `services/whatsappService.ts` `sendMessage` | Picks text vs template; this is what callers should use. |
| Webhooks | Yes | `routes/whatsappWebhook.ts` | Inbound messages and STOP/UNSTOP. Delivery-status events are acknowledged but ignored and not persisted. |
| Consent acknowledgement | Yes | `services/whatsappService.ts` `sendOptOutConfirmation` | The one message an opted-out number may receive. Sent AFTER the opt-out is recorded, and bypasses only the opt-out check — never the service window. |
| Approval requests | Notify only | `services/approvalChannelNotifier.ts` | Tells the reviewer an approval is waiting and links the asset. Approving still happens in Slack or the portal — WhatsApp has no Block Kit, and reply buttons need an approved interactive template we do not have. |
| Read history | **No** | — | Cloud API has no history endpoint. We know only what the webhook delivered. |
| Edit / delete a sent message | **No** | — | Not supported by the API at all. Callers send a follow-up. |
| Threads | **No** | — | Quoted replies only. |
| Modals | **No** | — | Deep-link to the customer portal instead. |
| User directory / mentions | **No** | — | A phone number and a profile name is all we get. |
| Groups | **No** | — | Requires an Official Business Account and caps at 8 participants. |

## Code Pointers

| Area | Path | Purpose |
| --- | --- | --- |
| Credentials | `backend/src/utils/secretsManager.ts` `getWhatsAppCredentials` | `WHATSAPP_*` env vars, else `dev` or `prod` + `/AgentWeb/WhatsApp`, cached 5 min |
| Service | `backend/src/services/whatsappService.ts` | Send, window, consent, error mapping, template registry |
| Channel adapter | `backend/src/services/whatsappChannelAdapter.ts` | `IMessagingChannel` impl + capability record |
| Channel registry | `backend/src/services/messagingChannelService.ts` | Provider-neutral seam shared with Slack |
| Webhook | `backend/src/routes/whatsappWebhook.ts` | Signature, inbound, STOP |
| Number verification | `backend/src/services/whatsappVerificationService.ts` | One-time codes, single-use claim, throttling, confirmation reply |
| Business number | `backend/src/services/whatsappService.ts` `getDisplayPhoneNumber` | Asked of Meta (not configured) to build the `wa.me` link |
| Webhook mount | `backend/src/app.ts` | `express.raw` BEFORE `express.json` |
| Consumers | `services/shipNotifyService.ts`, `services/leadListAlertService.ts` | Customer-facing sends |
| Tests | `backend/src/__tests__/whatsapp*.test.ts`, `*.whatsapp.test.ts` | |

## Stored Internal Shape

WhatsApp is **not** a `connected_accounts` platform — there is no per-user OAuth. Two
places hold state:

```ts
// AW-Users — additive, normalized at READ time from the legacy slack* fields.
// No migration, no backfill (see messagingChannelService.normalizeUserChannels).
messagingChannels?: Array<{
  channel: 'slack' | 'whatsapp';
  destination: string;              // E.164 for WhatsApp, channel id for Slack
  enabled: boolean;
  optIn?: { at: string; source: string; verifiedAt?: string };  // verifiedAt: proved control of the number
}>
```

```ts
// AW-Settings — keyed on the PHONE, not a user. Both must work for a number
// that maps to no known contact.
`whatsapp:window:${e164}`  -> ISO timestamp of last inbound. Carries a 24h DynamoDB TTL.
`whatsapp:optout:${e164}`  -> ISO timestamp of a STOP. No TTL; an opt-out does not expire.
```

Verification adds three short-lived rows, all with a 10-minute (codes) or 1-hour
(throttle) TTL. **Expiry is decided from a timestamp stored in the row, never from the
row existing** — DynamoDB TTL deletion is asynchronous.

```ts
`whatsapp:verify:${sha256(code)}`    -> { userId, status, acknowledgedAt, expiresAt, phone?, verifiedAt? }
                                        status: pending -> claimed -> verified  (or opted_out)
`whatsapp:verify-user:${userId}`     -> sha256 of that user's current code (only the newest is live)
`whatsapp:verify-fail:${e164}`       -> failed-attempt count for a SENDER; locks out at 5 per hour
```

## Consent

Channel-scoped and deliberately separate from email. It is **not**
`unsubscribedFromGroupEmail` or `contactStatus` — those record consent for a different
channel, and conflating them would let an email unsubscribe silently revoke WhatsApp
consent, or the reverse.

### Verifying that a number belongs to the person who entered it

Meta does not require this — its opt-in rules ask only that the business is named,
the intent is clear, and the law is followed — but AgentWeb messages from ONE shared
business number, so a message to a mistyped or stranger's number risks blocks and
reports that lower the quality rating every customer depends on. So a number is not
messaged until its owner has messaged us:

1. `POST /whatsapp/verification` (needs `optIn: true`) returns a code and a `wa.me` link
   that opens WhatsApp with `Verify <CODE>` already typed.
2. The customer sends it. The webhook, having recorded the inbound message (which opens
   the free 24-hour window), binds the SENDER's number to the user who holds the code.
3. AgentWeb replies in that window naming itself and how to opt out. The number is
   stored with `optIn.verifiedAt`, and only then does `resolveDestination` return it.

The messaging goes this way round on purpose: it never sends an unsolicited message to
an unverified number, needs no extra Meta template, costs nothing, and cannot connect a
mistyped number because the number is taken from the sender. Properties worth keeping:
a code is 8 characters from a 32-symbol alphabet and single-use by compare-and-swap;
a crash between claiming it and saving the channel is resumed by Meta's retry
(`pending -> claimed -> verified`); failed guesses are capped per sender; a number that
texted STOP is not connected until it sends START; only the exact shape `Verify <CODE>`
is recognised, so this never becomes a conversation; the code is never logged.

The portal copy that starts this must name AgentWeb and say what will be sent — that is
what Meta's opt-in rule asks for.

Opt-out keywords match the WHOLE message (`stop`, `unsubscribe`, `cancel`, `end`,
`quit`), not a substring. "please stop by the office tomorrow" must not cut a customer
off from every future notification.

## Failure Modes Already Handled

| Meta subcode | Mapped error | Meaning |
| --- | --- | --- |
| 131049 | `WhatsAppMarketingPausedError` | Marketing template to a US number. Not retryable; the pause is indefinite. |
| 131047 | `WhatsAppWindowClosedError` | Outside the 24h window; a template is required. |
| 131026 | `WhatsAppUndeliverableError` | Recipient not reachable on WhatsApp. |
| 130429 / 80007 / HTTP 429 | `WhatsAppRateLimitError` | Throughput or quota limit. |
| anything else | `WhatsAppError` with the raw subcode in the message | Never collapses to "Unknown error". |

All of these extend `MessagingChannelError`, so callers catch the base class and a
future channel's errors are covered without editing every call site — the mistake
`emma/tools.ts` made by enumerating the five `Gmail*Error` classes (ENG-302).

## What a Coding Agent Should Never Guess

- **Template names, languages, or variable order.** They are constants in
  `TEMPLATES` because they must match what Meta approved, exactly.
- **That a send outside the window will "probably work".** It will not.
- **That marketing templates will reach a US number.** They will not.
- **That a phone number the user typed is theirs.** There is deliberately no endpoint
  that stores one; connecting a number goes through verification.
- **That the webhook can be mounted after `express.json()`.** Meta signs the exact
  bytes; a re-serialized parse produces a different HMAC.
- **That an inbound-looking payload is inbound.** `statuses` are our own outbound
  messages being delivered; counting one as inbound would open a service window and
  let us message someone who never wrote to us.

## Deferred (documented decisions, not oversights)

| Deferred | Why |
| --- | --- |
| Campaign / marketing sends | Meta's US (+1) marketing pause makes the primary use case undeliverable to AgentWeb's customer base. |
| Multi-tenant Embedded Signup | Half-unblocked as of 2026-10-08: the business is now **verified as a Tech Provider**, confirmed in the app's Verification page. Still needs App Review for advanced access (the app is Unpublished), and its main use case remains blocked by the same US marketing pause. |
| Group messaging | Needs an Official Business Account and caps at 8 participants. |
| Conversational Emma over WhatsApp | Prohibited by the Business Solution Terms since 2026-01-15. |

## Live Verification

Exercised end to end against Meta's sandbox on 2026-10-08, from `api-stage.agentweb.pro`
(which runs `NODE_ENV=development` and so reads `dev/AgentWeb/WhatsApp` and the `Dev-`
tables). Observed, not inferred:

- Meta delivered the inbound message to the staging webhook and the signature verified
  against the real app secret.
- `Verify <CODE>` bound the sender's number to the portal user, with
  `optIn.source: inbound_verification`.
- The service-window row was written with a TTL exactly 24h ahead, in epoch seconds.
- The confirmation reply arrived on the handset.
- `STOP` recorded the opt-out; `UNSTOP` cleared it and service resumed without
  re-verifying the number — consent and number-ownership are tracked separately.

**Settled by that run:** Meta's test number DOES accept a first inbound message from an
allowlisted recipient. No outbound priming is needed, and the earlier note that this was
unconfirmed no longer applies.

To repeat it: sign in, `POST /api/messaging-channels/whatsapp/verification` with
`{"optIn": true}`, open the returned `wa.me` link from the handset and send the
prefilled message, then poll `GET /api/messaging-channels/whatsapp/verification` until
it reports `verified`. The webhook and verification logic can also be driven without
Meta by posting a payload signed with the app secret.

Note that the test number only ever reaches the (max 5) allowlisted handsets, and
templates are per-WABA — ones approved against the test account do not carry over to a
production WABA.
