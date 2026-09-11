# Cycle 123 — re-draft is NO_EVIDENCE; `gh pr checks` can still look green

**UTC:** 2026-09-11T23:31:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 122: detect-changes skips drafts, so ENG-836 never sees a
draft `/mcp` PR. `on.pull_request.types` includes
`ready_for_review` but not `converted_to_draft`. If a ready
`/mcp` PR is converted back to draft, does detect-changes stop,
or does the last ready run remain the evidence?

## Finding

**Missing `converted_to_draft` does not let a re-drafted PR
merge.** `merge-evidence.sh` L262–267: if `pr_draft` is true,
exit 3 `NO_EVIDENCE` immediately — “no run at this head is merge
evidence.” It does not read check-runs first. The last ready
ENG-836 pass can stay on the GitHub checks UI; this gate does
not treat it as a merge.

`tests.yml` L3–5: types are `opened, synchronize, reopened,
ready_for_review`. Converting ready→draft does not schedule a
new run (type not listed). Pushing while draft fires
`synchronize`, then L18 skips detect-changes. `gh pr checks`
can still exit 0 on skipped draft-time rows — that is why this
script exists (L14–25, live #2231). Discriminator job is
`Detect changed projects` (`DRAFT_JOB` L147; cycle 122’s L18).

A `/mcp` location PR that is ready, green, then converted to
draft is therefore: UI maybe green, merge-evidence **NO_EVIDENCE**,
ENG-836 not re-run. Flip ready to schedule a real run (L265).
Do not add `converted_to_draft` from this cycle instead of Q-014.
Do not add A-021. Hermes/OMP: no draft discriminator. AgentWeb’s
cutting-edge SDLC is this inversion, not a fifth `listen()`.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-006 stays
**discard**. Do not add A-021. Q-001 stays **ready**. Q-014 stays
**ready**.

## Next

Cycle 124: cheapest remaining. Candidate: merge-evidence.sh
`DRAFT_JOB` is `Detect changed projects` with no path filter
(L63–76). The conflict job **is** path-filtered (`ebconfig`).
Would a ready `/mcp` PR that also changes `backend/src` still
use detect-changes as discriminator, or could ENG-836 skip
via path-filter be misread as draft?
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
