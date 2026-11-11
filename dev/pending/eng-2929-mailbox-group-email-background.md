## ENG-2929: Mailbox group emails over 50 leads run in the background (2026-11-11)

- `POST /api/crm/lists/:listId/group-email/send` no longer rejects Gmail/Outlook sends over 50 eligible leads (`MAILBOX_SENDER_LEAD_CAP_EXCEEDED` removed). Above 50 it claims the list's pending-batch record (CAS), returns 202 `{ background: true, total }`, and sends in the background; sender `dailyLimit`/warmup still enforced per send by `sendAsSender`.
- At-most-once: each lead is removed from the durable remaining set before its send, so a crash/deploy never re-emails on resume. Live run ownership (`backgroundRunId` + 2-min heartbeat) blocks a concurrent send/resume on the same list with 409 `GROUP_EMAIL_ALREADY_SENDING`.
- Progress: existing `GET .../group-email/pending` record (`sentSoFar`/`totalOriginal`) plus socket `group-email-progress` / `group-email-complete`.
- Rollback: revert this PR (restores the 50 cap).
