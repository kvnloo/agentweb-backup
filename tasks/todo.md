# Project TODO

## Completed

### ENG-182: CRM ↔ LinkedIn invite dedup gap — RESOLVED

Both suggested fixes are now implemented on branch
`autofix/eng-182-crm-linkedin-invite-dedup-gap-newly-park`:

- **Fix (b) — per-recipient retry breaker scoping** (`backend/src/services/agentToolGatewayService.ts`,
  `failureScope` / `findTrippedFailure` / `recordToolFailure` / `clearToolFailures`):
  the run-level tool-failure breaker is now keyed on `(tool, recipient, error-head)`
  so a per-recipient "Cannot resend yet" refusal no longer blocks send-invite to
  genuinely different recipients in the same run.

- **Fix (a) — pre-invite LinkedIn dedup cross-check** (`backend/src/services/agentModeService.ts`,
  `send-invite` case + `linkedInPublicIdFromUrl`; `backend/src/services/unipileSentInvitationsDb.ts`,
  `getSentInvitationByPublicIdAndAccount`): before spending a run's invite quota,
  the agent send-invite path cross-checks the target against the account's PENDING
  sent-invitation cache (`AW-UnipileSentInvitations`, kept fresh by the ~10-min
  connection-sync cron straight from Unipile's live sent feed — so it also reflects
  invites made outside this system). A profile with an outstanding invite is skipped
  (`success: true, alreadyInvited: true`, no quota used) instead of hitting Unipile
  and getting "Cannot resend yet". Every successful agent invite is also written
  through to the cache immediately (strongly-consistent PK read on recheck) so a
  later invite for the same profile in the same run is deduped before the next cron.

## Known limitations / follow-ups

- Fix (a) can only dedup an invite sent by a `/in/{public-id}` profile URL (the cache
  is keyed by public id). A raw `provider_id` invite falls through to the live send;
  fix (b) still prevents it from cross-blocking other recipients. If provider_id
  invites become common, resolve provider_id → public id (extra profile fetch) before
  the cache check.
- The manual CRM send-invite route (`backend/src/routes/crm.ts`) still sends-then-caches
  without a pre-check, but the CRM UI already surfaces "Invitation pending" badges via
  `check-linkedin-connections`, so a user rarely clicks invite on an already-pending lead.
