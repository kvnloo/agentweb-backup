# Cycle 112 — 3×1200s settle is not a wait; `fail()` ends attempt 1

**UTC:** 2026-09-11T22:56:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 111: Sunday recycle and Immutable do not stack. Candidate:
`EB_UPDATE_MAX_ATTEMPTS` 3 × 1200s settle — can CI sit in
Must-be-Ready for 3600s while Sunday recycle’s Hermes overlap
continues, without A-019?

## Finding

**No. Multiplying attempts × settle is not a wait budget.** A
never-Ready recycle fails **attempt 1** and exits. It does not
retry into 3600s of sitting.

`wait_for_environment_ready` (`eb-deploy.sh` L621–644) waits
until Status=Ready, then returns. If the settle deadline hits
while still Updating, it calls `fail()` (L639–640) — `fail`
**`exit 1`s** (L155–158). That is **not** `return` to
`update_environment`’s loop. `EB_UPDATE_MAX_ATTEMPTS` (default 3,
L77; not overridden in `deploy.yml`) only increments when
`update-environment` itself returns Must be Ready **after** a
successful wait (L668–674). A stuck Updating Sunday never reaches
`aws … update-environment`. Test: `eb-deploy.test.sh` L496–501
(“never-settling … fails before claiming a deploy”).

The product of 3 × 1200s is also larger than the **absolute**
budget. `EB_TOTAL_TIMEOUT_SECONDS` is **2700** (`deploy.yml` L187).
Header L45–49: worst case cannot exceed it no matter how many
retries. `capped_deadline` (L201–209) clamps the 1200s settle to
`EB_RUN_DEADLINE`. Test L518–534: SETTLE=60, ATTEMPTS=3, TOTAL=2
stops at the **2s overall budget**, not 180s of settle.
`timeout-minutes: 50` (L180) is 3000s so the script names the
reason instead of a runner SIGKILL (ENG-1183, test L1281–1288).

ENG-1183 (`deploy.yml` L209–210, test L1322–1324) **reserves**
2700 − 1200 = 1500s for *our* Immutable apply after one settle.
That headroom is the measured max rollout (1352s), not a second
and third settle. Floor is EB command Timeout **900s**
(`rolling.config` L7).

So a Sunday collision is: CI waits ≤ 1200s (or remaining total),
then **“Version was NOT applied”**, while recycle’s two-process
Hermes overlap continues on its own (cycle 110). That is cycle
111’s failed-CI window, not a 3600s third clock. If recycle
becomes Ready inside the cap, CI applies Immutable next —
sequential A-019 windows, still not 3600s of Must-be-Ready.

Do not raise `EB_UPDATE_MAX_ATTEMPTS` to “cover Sunday.” Do not
HTTP-split so CI can wait longer. Hermes/OMP: one process.
AgentWeb’s cutting-edge SDLC is A-019 on the recycle pair; the
GitHub job is wait-or-fail, not a drain.

## Queue effect

A-006 stays **discard**. Q-001 stays **ready**. Q-014 stays
**ready**. A-019 stays **park**.

## Next

Cycle 113: cheapest remaining. Candidate: settle `fail()` is
**before** `ensure_termination_lifecycle_hook` (`eb-deploy.sh`
L654–655). A Sunday-collision CI run never re-puts the hook. Is
Sunday drain still the last successful deploy’s hook, or can a
missing hook terminate without `runDrain`?
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
