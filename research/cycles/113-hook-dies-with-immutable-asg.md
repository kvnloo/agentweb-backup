# Cycle 113 — last deploy’s hook dies with the Immutable ASG

**UTC:** 2026-09-11T22:58:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 112: settle `fail()` exits attempt 1 before
`ensure_termination_lifecycle_hook` (`eb-deploy.sh` L654–655).
A Sunday-collision CI run never re-puts the hook. Is Sunday
drain still the last successful deploy’s hook, or can a missing
hook terminate without `runDrain`?

## Finding

**Sunday drain is not the last successful deploy’s hook.** That
`put-lifecycle-hook` is on `AutoScalingGroups[0]` **before**
Immutable `update-environment`, so it protects *this* deploy’s
retiring instances and then dies with that ASG. The serving
group after swap was never hooked. Sunday `InstanceRefreshEnabled`
is rolling on **that** group and never calls `eb-deploy.sh`.

`ensure_termination_lifecycle_hook` (`eb-deploy.sh` L580–615)
exists because “a one-time manually created hook disappears if
Elastic Beanstalk ever replaces the ASG” (L583–587). Same fact
in `asgLifecycleGuard.ts` L51–57 (ENG-818 / ENG-1184:
`.ebextensions` cannot ride Immutable). The API is idempotent,
so every deploy repairs the hook **before** `update-environment`
is allowed to retire an instance (L586–587). Tests pin that
order: exactly **one** `put-lifecycle-hook`, and its line is
**before** `update-environment` (`eb-deploy.test.sh` L1066–1091).
The mock ASG name is a single file (`L180–181`); the suite cannot
see a post-swap second group.

`main()` after verify calls `ensure_deregistration_delay`
(L895–897) — ALB target-group repair on the **surviving**
infra (ENG-823). There is no matching second
`ensure_termination_lifecycle_hook`. Target groups survive ASG
replacement; lifecycle hooks do not.

A Sunday-collision CI `fail()` during settle does **not** create
this hole (recycle already started on the current group). It
also does not repair it. Cycle 110’s “same ASG hook” assumed
the hook persisted onto the live group. After Immutable, it
doesn’t.

Missing hook: ASG does **not** wait (`asgLifecycleGuard.ts`
L12–15). The guard still sees IMDS `Terminated` (L35–36) and
starts drain “earlier,” which is ENG-764 again: 3m19s kill,
not `Terminating:Wait`. A-019 refuse at `disableCron` never
runs if drain never gets that window. Do not restore
`.ebextensions/07-termination-lifecycle.config` (ENG-818).
Do not disable Sunday recycle. Hermes/OMP: one process, no
ASG. AgentWeb’s cutting-edge SDLC is a second put on the
surviving group after verify, plus A-019 when the hook actually
parks the instance.

## Queue effect

**Park A-020** (score 29): second `put-lifecycle-hook` after
`verify_deployment` so `AutoScalingGroups[0]` is the surviving
Immutable ASG. Change the “exactly one” test to one-before-update
**and** one after verify. Not instead of Q-014. Not A-006.

A-006 stays **discard**. Q-001 stays **ready**. Q-014 stays
**ready**. A-019 stays **park** (in-process gate when the hook
parks; A-020 is why Sunday may skip the park).

## Next

Cycle 114: cheapest remaining. Candidate: without the hook,
does `startAsgTerminationGuard` still invoke `drainForShutdown`
before SIGKILL, or is IMDS `Terminated` too late? Cite the poll
loop vs ENG-764 3m19s.
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
