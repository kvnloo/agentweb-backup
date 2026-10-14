## ENG-2493: Scheduled chat email opt-out also suppresses alert emails (2026-10-14)

PR #3527 let `manage_scheduled_chat` honour `email_notifications: []` as an opt-out, but only as
a request-time flag: the stored schedule just had `emailNotifications: []`. Every alert sender
(run-failed, sourcing-block transition, disallowed-tool error, usage-limit) treats an empty list as
"fall back to the owner's account email", so the owner kept getting alert emails after opting out.

Fix: one persisted optional field, `emailOptOut` (absent = false; Harsha approved 2026-10-14, no
backfill/migration). Create sets it when the tool sends `[]`; update sets it when recipients are
cleared on purpose, sets it false when recipients are set, and omits it otherwise (partial SET keeps
the stored value). The four senders share `resolveScheduleAlertRecipients` in
`agentModeController.ts`: configured recipients, else nobody if opted out, else the owner.
Oncall alerts, run history, and the schedule-card badge are unchanged. The paused-for-input and
variable-request emails still fall back to the owner: they ask for an action the run needs, so
suppressing them would strand the schedule.
