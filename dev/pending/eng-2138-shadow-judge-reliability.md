## ENG-2138: Shadow-judge reliability (2026-10-13)

- The daily sampler (`shadowJudgeSamplerCron.ts`) now retries each session whose scoring threw once, after the main loop. Result and log line gain `retried` and `recovered`; a session that fails twice counts once in `errors`. Session-load failures are not retried.
- `extractJsonObject` returns the first balanced top-level `{...}` (string-aware), so trailing prose or a second object no longer breaks the parse. A never-balanced reply keeps the old first-`{`-to-last-`}` slice and fails as before.
- Shadow scores now store `promptVersion` (first 12 hex of sha256 of the judge system prompt). Scores written before this change have no `promptVersion`; non-shadow judges never get it.
- `evalOutcomeJudge` summary prints both "share of raw scores >= 4.95" and "share of scores that round to 5"; `shareAt5` is unchanged and `shareRoundingTo5` is new.
- Known limits: timeouts are still the only guard against slow judge calls (constants untouched); a failed attempt that reached the model has already spent its cost; rows scored before 2026-10-13 cannot be attributed to a prompt.
