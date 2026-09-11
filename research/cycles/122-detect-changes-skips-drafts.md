# Cycle 122 — detect-changes skips drafts; ENG-836 never sees a draft `/mcp` PR

**UTC:** 2026-09-11T23:28:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 121: a `/mcp` location is instance-only; the conflict job
has no draft skip (`tests.yml` L246) unlike backend-build L70.
Would that catch a draft architecture PR — and does a pass still
refuse deployability (`eb-config-conflict.test.sh` L200–201)?

## Finding

**Cycle 121 overstated the draft ratchet.** `detect-changes`
itself is `if: github.event.pull_request.draft == false`
(`tests.yml` L16–18). The conflict job `needs: detect-changes`
(L244–246). A skipped needed job yields empty outputs, so
`outputs.ebconfig == 'true'` is false and L246 never runs.
Backend-build L70’s extra draft skip is redundant with L18.
Partner / relay / remotion (L94 / L158 / L193) repeat the same
parent skip.

A draft PR that adds `elasticbeanstalk/mcp.conf` therefore does
**not** run ENG-836. `ready_for_review` (workflow `types` L5)
starts detect-changes, then the job, then a **pass still refuses
deployability** (`eb-config-conflict.sh` L232–233; test L200–201
pins `does NOT verify deployability`). Instance-only pass means
“not the #2237 pair”, not “live nginx will proxy `/mcp` to 8080”.

Research PR #1 only touches `research/`, so `ebconfig` would be
false even when ready. Product #2 / #3 do not touch `.platform`.
The SDLC gate that exists is post-draft, file-pair only, and
honest about what a pass is. Do not add A-021. Do not vendor
`/mcp` from this correction instead of Q-014. Hermes/OMP: no
draft CI graph.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-006 stays
**discard**. Do not add A-021. Q-001 stays **ready**. Q-014 stays
**ready**. Cycle 121’s instance-only classification still holds;
only the draft-run claim is wrong.

## Next

Cycle 123: cheapest remaining. Candidate: `on.pull_request.types`
includes `ready_for_review` but not `converted_to_draft` — if a
ready `/mcp` PR is converted back to draft, does detect-changes
stop, or does the last ready run remain the evidence?
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
