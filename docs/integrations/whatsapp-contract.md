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
   the wrong slots. A count mismatch is refused before the request.

## Deployment Model

Single-tenant: AgentWeb sends from **one business number it owns**. This is not
Embedded Signup and there are no per-customer WABAs. Customers are addressed by E.164
phone. Multi-tenant onboarding was evaluated and deferred — see "Deferred" below.

## What AgentWeb Uses This For

| Capability | Supported? | Entry point | Notes |
| --- | --- | --- | --- |
| OAuth/connect | No | — | Single owned number; credentials come from Secrets Manager, not a per-user OAuth flow. |
| Send free-form text | Yes | `services/whatsappService.ts` `sendText` | Only inside the 24h window. |
| Send template | Yes | `services/whatsappService.ts` `sendTemplate` | Required outside the window. |
| Window-aware send | Yes | `services/whatsappService.ts` `sendMessage` | Picks text vs template; this is what callers should use. |
| Webhooks | Yes | `routes/whatsappWebhook.ts` | Inbound messages, delivery statuses, STOP/UNSTOP. |
| Read history | **No** | — | Cloud API has no history endpoint. We know only what the webhook delivered. |
| Edit / delete a sent message | **No** | — | Not supported by the API at all. Callers send a follow-up. |
| Threads | **No** | — | Quoted replies only. |
| Modals | **No** | — | Deep-link to the customer portal instead. |
| User directory / mentions | **No** | — | A phone number and a profile name is all we get. |
| Groups | **No** | — | Requires an Official Business Account and caps at 8 participants. |

## Code Pointers

| Area | Path | Purpose |
| --- | --- | --- |
| Credentials | `backend/src/utils/secretsManager.ts` `getWhatsAppCredentials` | `dev|prod/AgentWeb/WhatsApp` |
| Service | `backend/src/services/whatsappService.ts` | Send, window, consent, error mapping, template registry |
| Channel adapter | `backend/src/services/whatsappChannelAdapter.ts` | `IMessagingChannel` impl + capability record |
| Channel registry | `backend/src/services/messagingChannelService.ts` | Provider-neutral seam shared with Slack |
| Webhook | `backend/src/routes/whatsappWebhook.ts` | Signature, inbound, STOP |
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
  optIn?: { at: string; source: string };
}>
```

```ts
// AW-Settings — keyed on the PHONE, not a user. Both must work for a number
// that maps to no known contact.
`whatsapp:window:${e164}`  -> ISO timestamp of last inbound. Carries a 24h DynamoDB TTL.
`whatsapp:optout:${e164}`  -> ISO timestamp of a STOP. No TTL; an opt-out does not expire.
```

## Consent

Channel-scoped and deliberately separate from email. It is **not**
`unsubscribedFromGroupEmail` or `contactStatus` — those record consent for a different
channel, and conflating them would let an email unsubscribe silently revoke WhatsApp
consent, or the reverse.

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
- **That the webhook can be mounted after `express.json()`.** Meta signs the exact
  bytes; a re-serialized parse produces a different HMAC.
- **That an inbound-looking payload is inbound.** `statuses` are our own outbound
  messages being delivered; counting one as inbound would open a service window and
  let us message someone who never wrote to us.

## Deferred (documented decisions, not oversights)

| Deferred | Why |
| --- | --- |
| Campaign / marketing sends | Meta's US (+1) marketing pause makes the primary use case undeliverable to AgentWeb's customer base. |
| Multi-tenant Embedded Signup | Needs Meta Tech Provider verification and App Review for advanced access — and its main use case is blocked by the same pause. |
| Group messaging | Needs an Official Business Account and caps at 8 participants. |
| Conversational Emma over WhatsApp | Prohibited by the Business Solution Terms since 2026-01-15. |

## Live Verification

Meta's sandbox test number works before business verification (up to 5 recipients),
which is how this was exercised without waiting on the production app registration:
send a template, reply from the handset, confirm the window opens, confirm a free-form
reply lands, send `STOP`, confirm the next send is refused locally.
