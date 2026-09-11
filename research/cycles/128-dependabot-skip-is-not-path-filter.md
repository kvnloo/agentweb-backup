# Cycle 128 — merge-evidence labels Dependabot skip as a path-filter skip; #2491 PASSes with it skipped

**UTC:** 2026-09-11T23:44:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 127: Dependabot Integrity Check is required in comments
but skipped for non-Dependabot PRs. Does this tree document
GitHub skip-of-required semantics, or only merge-evidence’s
skip rule? File-level only.

## Finding

**This tree only documents merge-evidence’s skip rule.** That
rule already treats the Dependabot skip as legitimate. It
cannot answer whether GitHub branch protection would block a
human `/mcp` PR.

The real #2491 payload (`merge-evidence.test.sh` L432–441)
includes:

```
{"name":"Dependabot Integrity Check","status":"completed","conclusion":"skipped","check_suite":{"id":87513634173}}
```

every other job in that fixture is suite `87513641148`. The
integrity job is a **different workflow** (`pull_request_target`,
yml L27–29), skipped by `if: dependabot[bot]` (yml L46), not by
a path filter. The gate still PASSes (test L452).

Why it cannot block merge-evidence:

| Rule | Citation | Effect on this skip |
|---|---|---|
| `skipped` is `known` | script L607 | not `unknown` / FAIL |
| not in `evset` | L606: only `DRAFT_JOB` + `BACKEND_JOBS` | cancelled/skipped here is not NO_EVIDENCE |
| remaining skips after discriminator success | L970–975 | logged, not blocking |

L974–975 then names **every** remaining skip as
“skipped by path filter (legitimate — `'Detect changed projects'`
executed…)”. Dependabot’s skip is a job-level `if` on a
different workflow. Partner portal tests in the same fixture
(L440) *are* a path-filter skip. The log line cannot tell them
apart.

GitHub skip-of-required (does a skipped required context block
merge?) is not in this tree. Cycle 127 already showed the
“REQUIRED” claim is a comment, not a settings write. This
cycle shows merge-evidence would PASS either way.

Do not add A-021. Do not vendor `/mcp` instead of Q-014.
Hermes/OMP: no Dependabot integrity job.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-006 stays
**discard**. Do not add A-021. Q-001 stays **ready**. Q-014 stays
**ready**.

## Next

Cycle 129: cheapest remaining. Candidate: GitHub’s documented
skip-of-required semantics vs this tree. If skipped required
checks do not block, the Dependabot “REQUIRED” comment only bites
when the job actually runs (Dependabot PRs). If they do block,
either ENG-1373 never added that context (cycle 127) or human
`/mcp` PRs could not merge. File-level + published GitHub docs.
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
