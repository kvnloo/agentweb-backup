# Research loop state

```yaml
started_at: 2026-09-11T17:03:00Z
owner: cursor-cloud bc-658f6e8c-e6a2-4e2e-99d4-8bee7362c95b
branch: cursor/research-loop-c95b
coding_unlocked: true
briefing_ready: true
initialization_complete: true
cycles_completed: 269
target_cycles: 7
stop_after: 2026-09-12T06:00:00Z
next_cycle: 270
focus: architecture-sdlc-modular-monolith
next_focus_hint: |
  Cycle 269: XFF ERROR| coverage needs delay
  unset; grep the XFF clause, not the shared
  prefix. Cycle 270: classic name (test L796)
  is the empty-after-grep path (L811). Probe
  uses it on a Red rollup without delay. Should
  an XFF empty-ARN test also unset delay,
  rather than reuse L796's Red+classic fixture?
  Do not copy the probe classic fixture as XFF
  empty-ARN coverage. Do not add that pin from
  A-019. Do not un-park A-020. Do not 503
  /health. Do not add A-021. Do not un-ready
  Q-001 / Q-014 / Q-003. Do not revive A-006.
  stop_after has passed; leave briefing_ready.
  Do not mint a timer unless Kevin asks.
timer_name: agentweb-research-cycle
product_queue_frozen: false
```

## Stop conditions

Timer may stop when now > `stop_after`. Do not unset `briefing_ready`.
Do not set `coding_unlocked` unless Kevin asks to code.
Do not un-ready Q-001 / Q-014 / Q-003 without a falsifying citation.
Kevin asked 2026-09-12 to reprioritize — ranks may change; ready status
of those three does not. Cycle 228–229: Linear dump did not invert
order. Cycle 230–269: A-019 503 is color; dying 5xx does not fail new
Immutable; Sunday is Immutable; missing Wait still disableCron; Hermes
sees 503 while `/health` is 200; that 503 is a one-shot; 503 does not
poison `sessionId`; JSON 503 is enough for `send()`; this tree cannot
rewrite it; ALB passes Application 503 through (does not rewrite to
502); A-019 does not pin ALB XFF attributes (ENG-493); an XFF pin is
`modify-load-balancer-attributes` on the LB ARN, not A-019 or A-020;
that ARN stays across Immutable and Sunday; that pin is the only
in-tree reassert without recreate; deploy IAM does not list the grant;
an XFF no-op still needs LB Describe; after-verify IAM miss is
GitHub-red / prod-green; a later pin can fail closed before apply;
that fail-closed slot does not run on Sunday; a pin-only `schedule:`
would be the git-native Sunday reassert and does not exist; Must be
Ready would not block that pin-only elbv2 call; during Updating
XFF must not copy `AutoScalingGroups[0]`; this tree and AWS
immutable do not return two `LoadBalancers[*]` ARNs during
Updating. If two ARNs appeared, copy ENG-823 pin-all; do
not fail closed on `count != 1`. Do not fork `grep '^arn:'`
into an `/app/` filter. A `net/` XFF modify fails the job;
do not add skip-non-app. NLB `xff_*` Describe is `None`,
then Modify, then fail; do not add a None-skip. Do not
`fail()` on ALB XFF Describe `None` before Modify. A later
XFF pin copies ENG-823’s None policy; do not add a fourth.
Treat empty current like `20`; do not add hook `[ -z ]`.
Unset XFF desired skips like partner; do not pin AWS
defaults. Do not piggyback XFF on the delay opt-in.
Do not stuff XFF into `ensure_deregistration_delay`.
Call XFF from `main()` next to delay; do not copy
dryrun cannot-fail. Delay first; do not reorder delay
behind XFF. XFF rediscovers after its own skip;
do not share LB discovery from `main()`.
XFF empty-ARN `fail()` uses its own string; do not
copy L811 or probe UNKNOWN. XFF CLI-fail `fail()` uses
its own string; do not copy L806. XFF `ERROR|` coverage
needs delay unset; do not grep only the shared prefix.
A-006 stays discarded.
