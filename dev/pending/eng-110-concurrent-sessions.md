## ENG-110: Per-user cap on concurrently generating Emma chats (2026-10-08)

- Backend: interactive `/generate` and `/verified-generate` now count a user's
  concurrently generating sessions (keyed by the session owner's userId) and answer
  `429 {code:'TOO_MANY_CONCURRENT_RUNS', message, limit}` over the cap. Counter logic
  lives in `backend/src/services/agentMode/concurrentGenerationCap.ts`.
- The slot is taken after the session generation claim succeeds and released in the
  same `finally` as the session lock (success, throw, early return, 409s, disconnect).
- Excluded (never counted, never blocked): scheduled runs, auto-continuations, Slack,
  email, approval-inbox and other system `runVerifiedChat` callers. Compare keeps its
  own separate cap of 2.
- Limit: AW-Settings `max_concurrent_generations_per_user` (cached ~60s, last-known value
  on read failure). Absent/invalid => 3; `0` => unlimited. Rollback = set `0`. No flag.
  Admins are not exempt.
- Accepted limitation: the counter is in-memory per instance. It resets on restart and
  Immutable deploys briefly run two instances, so a user may hold up to `limit` slots on
  each during the overlap (bounded by the deploy window). No data-plane change.
- Portal (companion PR): live generating/finished indicators for background chats,
  friendly 409/429 handling, and a few ENG-110 race fixes.
- Answer/cancel turns (`deckAnswer`, `deckCancel`, `workPlanInputAnswer`) are exempt from the
  cap's refusal but still counted. In `/generate` these run BEFORE the session claim and cap check
  and already consumed state (approved writes dispatched, deck cleared), so a 429 afterwards lost
  the outcome and made a retry 409 APPROVAL_DECK_INVALID. They continue a paused conversation that
  holds no slot, so they take one via `acquireInteractiveGenerationSlot(..., {bypassLimit:true})`
  (may briefly exceed the soft cap by the number of such turns). Chosen over moving the cap check
  earlier because that would need a slot held across the pre-claim awaits and still leave the
  SESSION_BUSY ordering flaw untouched (out of scope). `questionAnswer` has no side effects any more.
