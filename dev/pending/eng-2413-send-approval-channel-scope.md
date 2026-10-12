## ENG-2413: Scope /api/slack/send-approval to caller-entitled channels (2026-10-12)

POST /api/slack/send-approval now 400s a non-string channel and 403s non-admin callers targeting a channel outside getEffectiveAllowedChannels, before any Slack post or approvalDb write (ENG-2407 pattern).
