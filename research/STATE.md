# Research loop state

```yaml
started_at: 2026-09-11T17:03:00Z
owner: cursor-cloud bc-658f6e8c-e6a2-4e2e-99d4-8bee7362c95b
branch: cursor/research-loop-c95b
coding_unlocked: true
briefing_ready: true
initialization_complete: true
cycles_completed: 245
target_cycles: 7
stop_after: 2026-09-12T06:00:00Z
next_cycle: 246
focus: architecture-sdlc-modular-monolith
next_focus_hint: |
  Cycle 245: DescribeLoadBalancerAttributes
  is also unnamed. ENG-823 TG Describe is
  used but not in L61-65; LB Describe is
  never called. Denied TG Describe mock
  exists but has zero tests. Cycle 246:
  ENG-823 skips Modify when current
  already equals desired (already-600s).
  Denied Describe fails before that skip.
  Would an XFF no-op require LB Describe
  on every backend SUCCESS path even when
  attributes are already append/false?
  Do not add that pin from A-019. Do not
  un-park A-020. Do not 503 /health. Do
  not add A-021. Do not un-ready Q-001 /
  Q-014 / Q-003. Do not revive A-006.
  stop_after has passed; leave
  briefing_ready. Do not mint a timer
  unless Kevin asks.
timer_name: agentweb-research-cycle
product_queue_frozen: false
```

## Stop conditions

Timer may stop when now > `stop_after`. Do not unset `briefing_ready`.
Do not set `coding_unlocked` unless Kevin asks to code.
Do not un-ready Q-001 / Q-014 / Q-003 without a falsifying citation.
Kevin asked 2026-09-12 to reprioritize — ranks may change; ready status
of those three does not. Cycle 228–229: Linear dump did not invert
order. Cycle 230–245: A-019 503 is color; dying 5xx does not fail new
Immutable; Sunday is Immutable; missing Wait still disableCron; Hermes
sees 503 while `/health` is 200; that 503 is a one-shot; 503 does not
poison `sessionId`; JSON 503 is enough for `send()`; this tree cannot
rewrite it; ALB passes Application 503 through (does not rewrite to
502); A-019 does not pin ALB XFF attributes (ENG-493); an XFF pin is
`modify-load-balancer-attributes` on the LB ARN, not A-019 or A-020;
that ARN stays across Immutable and Sunday (IdleTimeout does not
reapply weekly); that pin is the only in-tree reassert without
recreate; deploy IAM does not list the Modify grant (live-AWS-only);
LB Describe is also unnamed and never called. A-006 stays discarded.
