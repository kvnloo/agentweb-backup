## ENG-2652: Emma inbound email trusted the From header and any [ref:<id>] (2026-10-23)

`emmaEmailService.processInboundEmail` resolved the account Emma acts for from the inbound
`From` address (`userDb.getUserByEmail`) and continued whatever session the subject's
`[ref:<uuid>]` named, without checking the session belonged to that account. A registered user could
put another account's chat id in the subject, run a turn inside that chat (its context, memory and
tools) and get the reply plus a `Continue in browser` iShare link (conversable token) for it by email.

Fixed: the referenced session is continued only when `session.userId === <resolved sender>`; anything
else (missing or foreign) starts a new session exactly like the not-found path, so the iShare link,
the email metadata write and the agent turn are always on the sender's own session. Owner-only for
admins too: email has no delegate context and its sender proof is weaker than a portal token. The
reply's `[ref:]` tag now names the session that answered instead of echoing the inbound one.

From spoofing: the Resend webhook itself is svix-verified (`webhookService.verifyWebhook`), but the
`from` it carries is just the message's From header. Resend's `GET /emails/receiving/{id}` returns
`authentication: { spf, dkim, dmarc }` verdicts (`pass | fail | gray | processing_failed | unknown`)
computed by its receiving server (docs: resend.com/docs/api-reference/emails/retrieve-received-email;
`gray` DKIM = unsigned or signed by a domain other than the From domain). `getReceivedEmailContent`
now passes it through, and Emma only acts when `dmarc === 'pass' || dkim === 'pass'` (a From-aligned
proof). SPF pass alone is not accepted (it covers the envelope sender). A missing/null verdict fails
closed. Refused mail gets no reply (a reply would mail the forged address); it is logged as
`[EmmaEmail] Ignoring inbound email <id>: sender not authenticated (authentication=...)`.
Not verified against a live production payload (no prod access from this change): if that log line
appears for genuine customer mail, check whether Resend populated `authentication` for it.
