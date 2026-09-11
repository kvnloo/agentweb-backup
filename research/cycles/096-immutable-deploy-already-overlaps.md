# Cycle 96 — Immutable deploy already overlaps two instances

**UTC:** 2026-09-11T22:20:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 67: do not treat `socialPosts.ts` MinSize=MaxSize=1 or DR
MaxSize=4 as live AWS. Cycle 95: ENG-114 Dynamo is unset. Does
this tree still *pin* one instance, or do deploy/recycle scripts
already overlap two backends — the moment Hermes would need
rehydrate?

## Finding

**Git never pins Min=Max=1. It pins Immutable deploys and weekly
instance refresh — both add a second instance, then kill the
old one.** `socialPosts.ts` L16–21 and `loopEvents.ts` L45–47
speak as if “> 1 instance” is future. Prod-verified overlap is
already 3m19s (`asgLifecycleGuard.ts` L4–9). Cycle 95’s default
memory store 404s Hermes across that overlap. A fifth `listen()`
would be a third process in the same window.

### The comment is not in `.ebextensions`

`socialPosts.ts` L16–21: cooldown Map is enough while production is
“pinned at MinSize=MaxSize=1.” **Zero** `MinSize`/`MaxSize` in
`backend/.ebextensions/`, `eb-deploy.sh`, or `.env.example`.
`docs/disaster-recovery-investigation.md` L112 says MaxSize=4 —
also not in this tree (cycle 67). DR L103: EB scaling is **not
captured in code**.

`loopEvents.ts` L45–47: in-memory bucket “when this route sees
> 1 instance” — same future tense, same Map.

### What git *does* pin: overlap

`rolling.config` L3: `DeploymentPolicy: Immutable`. Every app deploy
launches a new instance, then removes the old. Guard L4–9 is the
2026-07-29 receipt: new at 10:17:06, old removed 10:22:06.

`05-instance-recycling.config` L13: `InstanceRefreshEnabled: true`
(weekly, “rolling, no downtime”). Same two-instance window.

`eb-deploy.sh` L580–609 installs `agentweb-drain-before-terminate`
on `EnvironmentResources.AutoScalingGroups[0]` — the environment
**has** an ASG. The hook exists because that overlap used to kill
in-flight work (cycle 68).

### Why this is not a nanoservice

During overlap, Hermes POSTs `/mcp` to whichever instance the ALB
picks (no sticky routing, cycle 67). Default memory (cycle 95) →
404 → SDK reinit (cycle 91). Q-001 already survives that. Q-014
`generate_image` mcpFetch is loopback on **this** instance of the
pair. A fifth image process is not in the ASG hook (cycle 68) and
would miss both the overlap drain and the ALB. OMP stays
in-process; they do not HTTP-split for a rolling deploy.

Do not flip `MCP_SESSION_STORE` from this cycle (Harsha / console
unverified). Do not “fix” the socialPosts comment as a product PR
on the research timer.

## Queue effect

A-006 stays **discard**. Q-014 stays **ready**. Q-001 stays **ready**
(404 reinit is the overlap path today). A-018 unchanged.

## Next

Cycle 97: cheapest remaining. Candidate: ALB target group during
immutable deploy — does `server.close` (cycle 73, not awaited)
happen while the new instance already serves `/mcp`? Do not
un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
