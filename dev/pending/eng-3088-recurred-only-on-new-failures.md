## ENG-3088: failure-cluster "Recurred" comments now need a new failure (2026-11-16)

- The agent-mode failure-cluster loop reads a rolling 7-day window, so a tool whose fix has merged stays over threshold until its old failures age out. Intake posted `Recurred on <date>` every day from the same failures. Checked on ENG-2938: all three `get_ads_thresholds` failures were 11-11 10:04Z to 10:33Z, #3983 merged 11-11 22:10Z, and the two calls after it succeeded. The 11-12 to 11-15 comments were those same three failures.
- `ClusterIntakeTool` now compares each cluster's failure times with the newest of: the canonical's creation time, and its `Recurred on` / `Reopened` comments. No failure newer than that: no comment and no reopen. Otherwise it posts as before with one more line, `New Since Last Comment: N of M failures`.
- The baseline is read back from Linear. Nothing new is stored. `failureTimes` sits on the proposal payload as a non-enumerable property because the proposal is JSON-serialised into the learning store and the fix spec; spreading or cloning the payload drops it, and intake then posts as before.
- Fails open: no timestamps, no canonical, or a comment read error all take the old path.
- Known gap: a failure recorded in the seconds between a run's event read and its comment is older than that comment, so it is never counted as new. It still counts toward the threshold.
