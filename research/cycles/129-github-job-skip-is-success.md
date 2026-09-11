# Cycle 129 — GitHub treats a job-level `if` skip as Success; Dependabot’s “REQUIRED” comment only bites when the job runs

**UTC:** 2026-09-11T23:46:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 128: this tree only documents merge-evidence’s skip
rule. GitHub skip-of-required: if skipped required checks do
not block, the Dependabot “REQUIRED” comment only bites when
the job actually runs. If they do block, either ENG-1373
never added that context or human `/mcp` PRs could not merge.
File-level + published GitHub docs.

## Finding

**Job-level `if` skip does not block merge, even if required.**
Dependabot Integrity Check is that shape. The “REQUIRED”
comment, if true, only bites on Dependabot PRs.

GitHub docs (not in this tree):

| Skip kind | GitHub merge | Source |
|---|---|---|
| Job skipped by `jobs.<id>.if` | Reports Success. Does **not** prevent merge, even if required. | [Status checks](https://docs.github.com/en/pull-requests/reference/status-checks); [job conditions](https://docs.github.com/actions/using-jobs/using-conditions-to-control-job-execution) |
| Workflow skipped by path / branch / `[skip ci]` | Checks stay **Pending** and **do** block | [Troubleshooting required status checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks) |
| Required-check success set | `success`, `skipped`, `neutral` | Same troubleshooting page |

This tree chose the non-blocking skip:

- Workflow always fires: `on: pull_request_target` types
  `opened, synchronize, reopened` (yml L27–29). No path filter.
- Job `if: github.event.pull_request.user.login == 'dependabot[bot]'`
  (yml L46).

A human `/mcp` PR therefore gets a completed `skipped` check
(#2491 fixture, cycle 128). GitHub required-check merge treats
that as success. Merge-evidence also PASSes, but via a
different rule: API conclusion is `skipped` (not `success`),
and the name is not in `evset` (script L606–607).

Docs say a skipped job “reports its status as Success.” The
Actions API still returns `conclusion: skipped` (test L437).
Two layers, two vocabularies. Neither blocks a human PR.

The `yml` L20 “REQUIRED” claim therefore only constrains
Dependabot-authored PRs, which is the ENG-1382 design
(script L248–250: required + fail-closed was “permanently
unmergeable”). Cycle 127 still holds: the claim is a comment,
not a settings write.

Do not add A-021. Do not vendor `/mcp` instead of Q-014.
Hermes/OMP: no required-check skip table.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-006 stays
**discard**. Do not add A-021. Q-001 stays **ready**. Q-014 stays
**ready**.

## Next

Cycle 130: cheapest remaining. Candidate: the same GitHub rule
on `Backend build` (`tests.yml` L70: job-level `if` on path +
draft). If ENG-1373 added that name to required contexts, a
partner-only PR would skip it and GitHub would still merge.
The only always-reporting ready-PR job is `Detect changed
projects` (L16–18: draft only, no path filter). File-level.
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
