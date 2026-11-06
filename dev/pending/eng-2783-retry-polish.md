## ENG-2783: Retry polish: /screen fallback, reschedule search from now, expiry through the real cron (2026-11-06)

Follow-up to the press-2 retry (PR #3920); no new persisted fields.

- `/screen` no longer hangs up on the lead when the retry-eligibility read (lead and org context) throws: it logs one warning (error name only)
  and serves the two-option prompt (no option 2).
- A due retry whose lead or org window is closed when the cron runs is moved to the next open minute counted from NOW (`retryDueAt` gained a
  `delayMs`; the press-time schedule keeps its 60 minutes). Previously the 60 minute delay was added again, which could skip an opening before
  the give-up time. The +15 minute floor for a transient refusal after the claim is unchanged.
- Bug fixed: the give-up check (more than 6 hours after `deferral.firstDueAt`) now runs BEFORE the "not due yet" return, so a deferral whose
  `dueAt` lies in the future but whose `firstDueAt` is older than 6 hours (an operator-written or older-shape record) is claimed and given up with
  `call.skipped` `retry_expired` instead of waiting. The other two reported fixtures (dueAt moved recently with an old `firstDueAt`; no
  `firstDueAt` and `dueAt` 6.5h ago) were already given up correctly; all three are now regression tests driving `runHotLeadCallRetryCron()`
  over the real store.
