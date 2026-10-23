## ENG-669: owner notices when an unattended run's model is refused, PR-D (2026-10-21)

**Problem.** With the tier allowlist on, a schedule pinned to a model outside the owner's plan recorded a `failure`
on every fire and told nobody (a plan-limit refusal deliberately pages no one, and the owner-email seam only knew the
"keeps failing / contact support" copy). A Work Plan step paused on its model in an unattended session left a chat
message nobody reads.

**Switch.** The same AW-Settings switch, `model_tier_allowlist_enabled`, not a new one: the notices are the
customer-facing half of the allowlist (it is what makes these refusals common), turning the allowlist on without them
recreates the silent failure, and one switch is one rollout and one rollback. Off = byte-identical to before: no new
run-result fields, no email, no extra schedule read.

**Schedules (`runScheduledChat`, model refusal path).** The run result gains `blockedBy: 'model_unavailable'`,
`blockedReason` (`not_in_plan` | `not_served` | `not_selectable`) and `blockedModel` (the pin as saved);
`runHealth.lastRunBlockedBy` / `lastRunBlockedReason` surface it on the card. The owner (the schedule's notification
list, else the owner; nobody when opted out) gets `sendScheduledRunFailedEmail` with `failureClass:
'model_unavailable'` ONCE per change into the state: `utils/unattendedModelNotices.isNewScheduleModelBlock` compares
with the most recent prior run that reached the model check (account / capacity gate skips are passed over). A run
that gets past the model (another model, an upgrade, an unpinned schedule) ends the state; a pin change to another
refused model is a new state. Test runs record the block but never email. On-call paging is unchanged (`not_in_plan`
pages nobody, `not_served` / `not_selectable` page as before). `didSourcingBlockStateChange` ignores model-blocked
runs: they never reached LinkedIn sourcing.

**Work Plan steps (`pauseWorkPlanForUnavailableStepModel`).** In an unattended session (`isUnattendedPause`: the
turn's `isUnattendedRun` when the caller passes it, else `sessionType === 'scheduled'`; never a "Test: " schedule run)
the owner is emailed once per (session, step): the pause message that carried the email is stamped
`metadata.ownerNotified: true` and any earlier stamp for that step in the transcript suppresses another (runVerifiedChat
re-nudges a paused plan up to 20 times). A session that is a run of the owner's schedule uses that schedule's
recipients and names it. Interactive sessions: the in-chat message only, as before.

**Copy.** Every new customer-facing string is in `backend/src/utils/unattendedModelNoticeCopy.ts` (no prices). Links:
`/agent-mode?tab=scheduled` (no per-schedule deep link exists yet), `/agent-mode/<sessionId>`, and `/pricing` for
`not_in_plan` only. Portal: `RUN_BLOCK_REASONS.model_unavailable` in `ScheduleList.tsx` / `TestHistoryPanel.tsx`.

**Moved.** `isTestScheduledSession` from `sessionScoringService.ts` to `utils/scheduledTestRunSession.ts` (unchanged
rule) so the controller can use it without loading the scoring service.
