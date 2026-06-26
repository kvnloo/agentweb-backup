# Bug: Configured email sender cannot send email from Emma chat

## Reporter
- User: PMPS Official (info@pmps.ai), userId 1359ace4-0565-4018-9926-f51efdcf4c47
- Priority: High
- Report session: bde915a1-f6e3-48bb-a307-e4422365a3e5

## Validated Root Cause (grounded in prod data)

When a user asks Emma / agent mode to send an ad-hoc email ("send an email to X"),
the only reachable email-send tool is `email` (backend/src/emma/tools.ts:5601). Its
`send` action routes EXCLUSIVELY through `resolveEmailAccount` →
emailProviderService (emailProviderService.ts:61-77), which only supports **Gmail
connected accounts**. It has NO knowledge of the user's configured CRM senders
(Resend custom-domain senders or Gmail-account senders) stored in the AW-Settings
key `crm_sender_emails_<userId>`.

The configured CRM sender is only usable via `send_email_to_lead`
(agentModeService.ts:9983), which requires a CRM lead + a saved emailDraft in a
lead list — unusable for one-off / arbitrary-recipient sends.

Therefore: a user who has configured a sender (the supported, documented way to
"connect" an email sender for outbound) but has NOT connected a raw Gmail OAuth
account cannot send any ad-hoc email through chat. Emma replies "no email account
connected, go connect Gmail" — the reported "cannot send / silently fails" behavior.

### Production evidence
- Session 953c514f-2914-47cf-8e2c-d580daf2e3a6 (2026-06-25):
  - User: "Send an emaill to info@pmps.ai" then "Quick note, saying hello... approved"
  - Emma called list_connected_accounts, found no Gmail, refused:
    "there's no email account (Gmail or similar) connected right now ...
     connect a Gmail account in Settings → Connected Accounts."
- User's CRM sender config (AW-Settings `crm_sender_emails_<userId>`):
  - default: { email: info@mail.incentivpay.com, senderType: undefined } → Resend
  - other:   { email: shopify@pmps.ai, senderType: gmail, gmailAccountId: shopify@pmps.ai }
- User's connected_accounts: linkedin/instagram/unipile/meta only — NO gmail.
- 2 `email.delivered` events for domain mail.incentivpay.com on 2026-06-25 prove
  Resend delivery from the configured sender works.

### Secondary issue (also fixed)
`sendEmailToLead` (agentModeService.ts:10079) collapses a null Resend result into a
generic "Failed to send email via Resend" with no reason. Low impact for this user
(their default sender works), but worth surfacing the real error. NOT the primary
cause — left as-is to keep the change minimal, unless review says otherwise.

## Fix Design (minimal, elegant)

Add a new agent tool `send_email_from_sender` that sends a one-off email using the
user's configured CRM sender(s) — the same senders `send_email_to_lead` uses — so
chat can send ad-hoc email without a connected Gmail and without a CRM lead/draft.

- New method `AgentModeService.sendEmailFromConfiguredSender(userId, {to, subject,
  html/text, senderId?})` that:
  1. Resolves senders via existing `getCrmSenders(userId)`.
  2. Picks `senderId` if given, else defaultSenderId, else first.
  3. Routes gmail-type senders → gmailService.sendEmail; else → resendService.sendEmail.
  4. Returns structured success/error (surfacing real Resend failure).
- New tool `send_email_from_sender` registered in emma/tools.ts, added to the CRM
  skill-less reach: make it a foundation tool OR bridge appropriately so it is
  available in agent mode and Emma without requiring Gmail.
- Update the `email` tool description / add guidance so the LLM prefers the
  configured-sender tool when no Gmail account is connected.

## TDD
- Tests in agentModeService.crmTools.test.ts (new describe block) covering:
  - no senders configured
  - send via Resend default sender (happy path)
  - send via explicit senderId
  - send via gmail-type sender → gmailService
  - Resend returns null → error surfaced
  - missing to/subject/body validation
