# Cycle 111 — Sunday recycle and Immutable do not stack a third backend

**UTC:** 2026-09-11T22:55:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 110: Sunday `InstanceRefreshEnabled` overlaps without
`eb-deploy.sh`. Cycle 96’s overlap receipt is 3m19s. Can a
Sunday minor platform update and an Immutable app deploy run
*at once* and extend that to three processes?

## Finding

**No. EB allows one environment command at a time. Collision
fails or serializes the GitHub deploy; it does not add a third
`listen()`.** `update-environment` while Status ≠ Ready is
`InvalidParameterValue` “Must be Ready.” (`eb-deploy.sh`
L668–680). `wait_for_environment_ready` (L621–644) waits
`EB_SETTLE_TIMEOUT_SECONDS` — **1200s** in `deploy.yml` L211,
default 600 — then fails: version was **not** applied. GitHub
`concurrency: deploy-production` (`deploy.yml` L27–29,
`cancel-in-progress: false`) serializes Actions; it cannot
serialize EB managed updates (L199–204).

ENG-1127 (`eb-deploy.sh` L126–128): 2026-08-11 abort was an ASG
replacement that joined **31 seconds** before the deploy, not a
third serving fleet. Re-apply converged. That is subset abort,
not stacked overlap.

So Sunday + merge is **sequential** A-019 windows (recycle pair,
then Immutable pair) or a **failed CI deploy** while recycle
alone overlaps. The 3m19s receipt is still one pair. A fifth
`listen()` is not in either command and would not be the thing
that serializes them.

Do not add a Sunday deploy freeze from this cycle. Do not
HTTP-split to survive a stack that this tree already refuses.
Hermes/OMP: one process. AgentWeb’s cutting-edge SDLC is A-019
on each pair, plus wait-or-fail in `eb-deploy.sh`.

## Queue effect

A-006 stays **discard**. Q-001 stays **ready**. Q-014 stays
**ready**. A-019 stays **park**.

## Next

Cycle 112: cheapest remaining. Candidate: `EB_UPDATE_MAX_ATTEMPTS`
3 × 1200s settle — can CI sit in Must-be-Ready for 3600s while
Sunday recycle’s Hermes overlap continues, without A-019.
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
