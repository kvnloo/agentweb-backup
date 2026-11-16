## ENG-3094: termination guard no longer switches itself off after one failed metadata read (2026-11-16)

`backend/src/services/asgLifecycleGuard.ts` polls IMDS for `autoscaling/target-lifecycle-state`
and answers the ASG termination hook once the instance has drained. Until now ONE read that
came back "unavailable" (the IMDS token fetch failed, or the path returned 404) stopped the
poll for the life of the process and logged "not an ASG instance". On 2026-11-16 a prod
instance that was in the group logged that at boot; nothing answered its hook and it waited
out the full 900 s heartbeat (26m44s to terminate, against 14-16.5 min for its siblings).

- The guard now gives up only after `UNAVAILABLE_READS_BEFORE_DISABLE` (60) consecutive
  unavailable reads, i.e. five minutes at the 5 s poll. Any successful read resets the count.
- Both causes count toward the streak. AWS documents the path as present only once the
  instance has transitioned to a target lifecycle state ("otherwise ... you receive an HTTP
  404 error") and tells callers to poll and retry, so a 404 is not proof of "not in a group".
- The log names the cause: `IMDS token fetch failed` or
  `autoscaling/target-lifecycle-state returned 404`. A machine outside a group logs two lines
  in total (one warn on the first failed read, one "termination guard disabled" on give-up),
  not one per poll.
- An unavailable read also resets the two-read `Terminated` confirmation streak.

Post-deploy check: the next three prod instances should log no "termination guard disabled"
line at boot. A "lifecycle state unavailable (...); still polling" warn at boot is expected
if IMDS hiccups, and now says which cause it was.

Rollback: revert the PR. The guard is fail-safe either way: with it off the hook still times
out to CONTINUE.
