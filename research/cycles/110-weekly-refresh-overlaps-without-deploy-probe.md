# Cycle 110 — weekly refresh overlaps without the deploy-verify probe

**UTC:** 2026-09-11T22:52:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 96: Immutable *and* weekly refresh already overlap two
instances. Cycle 109: `underlying_health_verdict` is only
GitHub Actions `verify_deployment`. Does Sunday recycle still
overlap Hermes without ever hitting that probe?

## Finding

**Yes. Sunday recycle is EB managed actions, not
`eb-deploy.sh`.** `05-instance-recycling.config` L8–13:
`ManagedActionsEnabled: true`, `PreferredStartTime: "Sun:10:00"`,
`UpdateLevel: minor`, `InstanceRefreshEnabled: true`. Comment L4–6:
rolling, no downtime, weekly. `backend/src` has **zero**
`InstanceRefresh` / `managedactions` hits.

`deploy.yml` L199–204: nothing in GitHub Actions starts that
update (`concurrency: deploy-production` is serial). EB does, every
Sunday 10:00 UTC. A *human* deploy landing in that window is failed
today for a healthy environment — which is why
`EB_SETTLE_TIMEOUT_SECONDS: '1200'` exists. The ENG-878 probe
(`eb-deploy.sh` L745–748) is not on that path. Recycle never calls
`update-environment` from this repo, so it never reaches
`underlying_health_verdict`.

Overlap still uses the **same** ASG hook (`asgLifecycleGuard.ts`
L4–9 / `eb-deploy.sh` installs it on AutoScalingGroups[0]). IMDS
`Terminated` → four-way wait with `/health` 200 (cycle 108) →
unawaited `server.close` → Hermes 502 (cycle 107). A-019’s window
is weekly even when no PR deploys. App deploys are Immutable
(`rolling.config` L3); recycle is rolling — two shapes, one
in-process refuse.

Do not disable `InstanceRefreshEnabled` from this cycle (disk /
platform patches). Do not HTTP-split to survive Sunday. Hermes/OMP:
one process, no weekly pair. AgentWeb’s cutting-edge SDLC is A-019
on both overlap shapes, not a fifth `listen()` missing the
managed-update one.

## Queue effect

A-006 stays **discard**. Q-001 stays **ready** (404 reinit). Q-014
stays **ready**. A-019 stays **park** (weekly, not only on merge).

## Next

Cycle 111: cheapest remaining. Candidate: `UpdateLevel: minor`
managed update vs Immutable app deploy — can both run Sunday
and extend overlap past the 3m19s receipt. Do not un-ready
Q-001 / Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
