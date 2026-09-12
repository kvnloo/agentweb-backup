# Cycle 232 — Sunday InstanceRefreshEnabled is Immutable, not rolling

**Date:** 2026-09-12T06:22:00Z
**Question:** Cycle 110/113 described Sunday
`InstanceRefreshEnabled` as **rolling on the surviving ASG**,
not a temporary Immutable group. Can old-instance Application
5xx (A-019 `tools/call` 503 + `runScheduledChats` 503) fail that
rolling batch’s health because they share one group?
**Answer:** **No.** The premise is wrong. AWS: when
`InstanceRefreshEnabled` is true, Elastic Beanstalk runs an
**immutable update every week**, whether or not a platform
version is available. Managed platform updates **always**
perform immutable updates. New instances take traffic alongside
the old; if the **new** set passes health checks, Elastic
Beanstalk terminates the old set. Dying-instance 5xx cannot
fail the new weekly instances for the same reason as cycle
231. The L4–6 “rolling, no downtime” comment is stale. Git has
zero `RollingUpdateType` / `RollingUpdateEnabled` /
`MaxBatchSize` / `MinInstancesInService`. Do not disable
`InstanceRefreshEnabled`. Do not set
`HealthCheckSuccessThreshold`. Do not 503 `/health`. Do not
add A-021.

## Evidence

### AWS, not the comment

```1:13:backend/.ebextensions/05-instance-recycling.config
# Instance recycling via EB managed platform updates.
#
# The outage instance had been running 11 days, accumulating logs/temp/version
# churn. Managed updates with InstanceRefreshEnabled recycle instances weekly
# (rolling, no downtime), so no instance lives long enough to silently fill its
# disk, and OS/platform security patches get applied automatically.
option_settings:
  aws:elasticbeanstalk:managedactions:
    ManagedActionsEnabled: true
    PreferredStartTime: "Sun:10:00"
  aws:elasticbeanstalk:managedactions:platformupdate:
    UpdateLevel: minor
    InstanceRefreshEnabled: true
```

AWS
[managed platform updates](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/environment-platform-update-managed.html):

> When this setting is enabled, Elastic Beanstalk runs an
> **immutable update** on your environment every week,
> regardless of whether there is a new platform version
> available.

Same page: “Managed platform updates perform **immutable
environment updates**.” New instances take requests alongside
the old. “If the new set of instances passes all health
checks, Elastic Beanstalk terminates the old set of
instances.” “Managed platform updates always perform immutable
updates, even when you apply them outside of the maintenance
window.” Burst-balance warning lists “Managed platform updates
with instance replacement enabled” next to “Immutable
updates.”

AWS
[immutable updates](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/environmentmgmt-updates-immutable.html):
second **temporary** Auto Scaling group; wait until **new**
instances pass; if they fail, terminate the **new** group
and leave the originals. That is cycle 231’s bar
(`HealthCheckSuccessThreshold` unset; default `Ok`).

### Git has no rolling-update namespace

`rg RollingUpdateType|RollingUpdateEnabled|MaxBatchSize|MinInstancesInService`
is empty in this tree. App deploys already pin Immutable in
`rolling.config` (`DeploymentPolicy: Immutable`,
`IgnoreHealthCheck: false`, Timeout 900). Sunday refresh is
the **managedactions** namespace, not
`aws:autoscaling:updatepolicy:rollingupdate`.

Cycle 110’s “app deploys are Immutable; recycle is rolling —
two shapes” took the L4–6 comment as AWS. The comment is
the only “rolling” string on that path. `deploy.yml` L199–204
is still true: GitHub does not start Sunday; EB does, every
`Sun:10:00`. Cycle 113 is still true that Sunday never calls
`eb-deploy.sh`, so A-020’s second `put-lifecycle-hook` after
verify is the only in-repo repair of a missing hook. The
**health** shape of Sunday is Immutable overlap, not
health-based rolling batches on one ASG.

### What A-019 503 can and cannot do on Sunday

A-019 503 still runs on the **old** process after
`disableCron()` (`server.ts` L384–387). The new weekly
instances still have cron enabled and `/health` 200
(`app.ts` L547–553) until their own close. Enhanced health
cannot ignore 5xx (cycle 230). That colors the dying row; it
does not fail the new Ok (cycle 231). Environment Red after
the old row is gone is still ENG-878 lag, and Sunday never
hits `underlying_health_verdict` (cycle 110).

Hermes / Oh My Pi: one process, no weekly Immutable pair.
AgentWeb’s cutting-edge SDLC is in-process refuse on the old
listen (A-019) plus Immutable’s new-group health on **both**
merge deploys and Sunday refresh — not a rolling
`MaxBatchSize` and not a fifth `listen()`.

## First-slice correction (A-019 stays ready)

Keep wait-then-`mcpShutdown` then unawaited `server.close`.
Add:

- Do **not** treat Sunday `InstanceRefreshEnabled` as
  health-based rolling on one ASG (AWS weekly immutable;
  L4–6 comment is stale).
- Do **not** disable `InstanceRefreshEnabled` (disk / patches;
  cycle 110).
- Do **not** set `HealthCheckSuccessThreshold` from A-019
  (would lower the **new** weekly instances’ bar).
- Do **not** 503 `/health` on either instance.

A-020 stays **park** (ops `eb-deploy.sh` after verify). Ready
status of Q-001 / Q-014 / Q-003 is not falsified. A-006 stays
discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: if the hook is missing on Sunday (A-020),
A-019 `disableCron` may never get `Terminating:Wait` (cycle
113/114). Does Sunday-without-hook still 503 via SIGTERM
`gracefulShutdown` (cycle 115: OS SIGTERM; cycle 213: sibling
`mcpServer.ts` closer currently runs first) so 5xx still
happens, just without Wait? Do not add `.platform` systemd. Do
not restore `.ebextensions/07-termination-lifecycle.config`
(ENG-818). Do not add A-021. Do not un-ready Q-001 / Q-014 /
Q-003. Do not revive A-006. Do not mint a timer unless Kevin
asks.
