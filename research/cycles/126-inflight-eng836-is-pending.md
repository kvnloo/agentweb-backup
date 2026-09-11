# Cycle 126 — in-flight ENG-836 is PENDING; `cancel-in-progress` turns it into the cancelled PASS

**UTC:** 2026-09-11T23:37:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 125: hung ENG-836 is `cancelled` and merge-evidence PASSes.
Conflict job `cancel-in-progress: true` (`tests.yml` L251). A
second push cancels the in-flight classifier — same `cancelled`
PASS as a timeout. Does Backend build’s concurrency group
(L73–75) save the evidence set?

## Finding

**No. Separate groups; Backend success does not keep ENG-836
in the evidence set.** In-flight **does** block (PENDING). Cancel
is what removes the block.

`n_pending` counts **every** incomplete check-run (script L610,
L726–728), not only `BACKEND_JOBS`. Test L318–322: conflict
job `in_progress` alone is PENDING. Cycle 125’s cancelled PASS
is the settled form of that wait.

Concurrency groups are different strings:

| Job | Group (`tests.yml`) | `cancel-in-progress` |
|---|---|---|
| Backend build | `…-backend-build-${{ github.ref }}-${{ draft }}` L73–75 | true |
| ENG-836 | `…-eb-config-${{ github.ref }}-${{ draft }}` L249–251 | true |

They cannot cancel each other. A new `synchronize` cancels **both**
old jobs at the **old** SHA; evidence is the new head. Backend
`fetch-depth: 1` (L79) typically finishes first; conflict
`fetch-depth: 0` (L255) can still be running → PENDING until it
succeeds, fails (`n_bad`), or is cancelled (PASS).

The `draft` bit in the group means a ready-flip does **not**
cancel the draft run (different group). Ready-flip window is
already PENDING (test L295–308).

GitHub’s sole required context is `Detect changed projects`
(script L871–874). ENG-836 is not required. Agents use
merge-evidence; a cancelled classifier plus Backend build
success is PASS. Do not add A-021. Do not vendor `/mcp` instead
of Q-014. Hermes/OMP: no concurrency groups.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-006 stays
**discard**. Do not add A-021. Q-001 stays **ready**. Q-014 stays
**ready**.

## Next

Cycle 127: cheapest remaining. Candidate: script L871 says the
required set is only `Detect changed projects`. Is ENG-1373 still
open in this tree, or did something add Backend build to required
contexts? File-level only — no live GitHub settings.
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
