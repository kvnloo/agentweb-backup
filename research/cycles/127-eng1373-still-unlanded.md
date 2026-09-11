# Cycle 127 — ENG-1373 is still an unlanded comment; nothing in git adds Backend build to GitHub required contexts

**UTC:** 2026-09-11T23:42:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 126: `merge-evidence.sh` L871 says the required set is
only `Detect changed projects`. Is ENG-1373 still open in this
tree, or did something add Backend build to required contexts?
File-level only — no live GitHub settings.

## Finding

**ENG-1373 is still an unlanded comment.** Nothing in git adds
`Backend build` or ENG-836 to GitHub required contexts.

Present tense, two files:

| File | What it says |
|---|---|
| `merge-evidence.sh` L869–875 | Sole REQUIRED context is `Detect changed projects`. Greptile was in the required set until ENG-1371; “that job is gone, so the required set now proves strictly less than it did. **ENG-1373 is the fix.**” |
| `dev.md` L152–157 | ENG-754 (2026-07-29): `main` required only `Detect changed projects`. “Branch protection is now **being fixed under ENG-1373**.” |

`dev.md` L708–711 is older: adding Greptile to branch protection
“this change does — code alone could not have closed it for
humans.” That was Greptile. ENG-1371 deleted the job. The
required-set *widening* ticket never landed as code.

Zero scripts in this tree call a protection updater
(`required_status_checks`, `gh api .../protection`). Live
settings remain live-GitHub-only.

Two other “required” strings are **not** that updater:

1. **`BACKEND_JOBS`** (`merge-evidence.sh` L160) is
   merge-evidence section 7. Test L1498–1505 only asserts the
   job *name* exists in `tests.yml`. That is script-local.
2. **`dependabot-integrity-check.yml` L20–25** (and script
   L84–89): “This is made a **REQUIRED** branch-protection
   check.” The job is `pull_request_target` and
   `if: dependabot[bot]` (yml L46). It does not run on a normal
   `/mcp` PR. Same class of comment as ENG-1373: a claim about
   GitHub settings, not a settings write.

`tasks/lessons.md` L237: `gh pr merge --auto` waits on
**branch protection’s required checks only**; backend test jobs
are not in that set. A cancelled ENG-836 + Backend build success
can still be merge-evidence PASS (cycles 124–126) and, if
humans / auto-merge only wait on required contexts, can merge
without the classifier.

Do not add A-021. Do not vendor `/mcp` instead of Q-014.
Hermes/OMP: no branch-protection comments.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-006 stays
**discard**. Do not add A-021. Q-001 stays **ready**. Q-014 stays
**ready**.

## Next

Cycle 128: cheapest remaining. Candidate: Dependabot Integrity
Check is required in comments but skipped for non-Dependabot
PRs (`if: dependabot[bot]`). The #2491 fixture already includes
that skip and merge-evidence PASSes. Does this tree document
GitHub skip-of-required semantics, or only merge-evidence’s
skip rule? File-level only.
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
