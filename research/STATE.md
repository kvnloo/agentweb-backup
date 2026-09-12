# Research loop state

```yaml
started_at: 2026-09-11T17:03:00Z
owner: cursor-cloud bc-658f6e8c-e6a2-4e2e-99d4-8bee7362c95b
branch: cursor/research-loop-c95b
coding_unlocked: true
briefing_ready: true
initialization_complete: true
cycles_completed: 246
target_cycles: 7
stop_after: 2026-09-12T06:00:00Z
next_cycle: 247
focus: architecture-sdlc-modular-monolith
next_focus_hint: |
  Cycle 246: an XFF no-op still needs LB
  Describe on every opted-in backend
  SUCCESS. ENG-823 skip is after
  Describe. Partner unset is the only
  zero-call path. Cycle 247: main() logs
  complete and verified (L895) then
  ensure_deregistration_delay (L897). A
  denied Describe would fail GitHub
  after the environment is already Ready.
  Is a later XFF pin therefore GitHub-red
  / prod-green on IAM miss, not an A-019
  503? Do not add that pin from A-019. Do
  not un-park A-020. Do not 503 /health.
  Do not add A-021. Do not un-ready Q-001
  / Q-014 / Q-003. Do not revive A-006.
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
order. Cycle 230–246: A-019 503 is color; dying 5xx does not fail new
Immutable; Sunday is Immutable; missing Wait still disableCron; Hermes
sees 503 while `/health` is 200; that 503 is a one-shot; 503 does not
poison `sessionId`; JSON 503 is enough for `send()`; this tree cannot
rewrite it; ALB passes Application 503 through (does not rewrite to
502); A-019 does not pin ALB XFF attributes (ENG-493); an XFF pin is
`modify-load-balancer-attributes` on the LB ARN, not A-019 or A-020;
that ARN stays across Immutable and Sunday (IdleTimeout does not
reapply weekly); that pin is the only in-tree reassert without
recreate; deploy IAM does not list the Modify grant (live-AWS-only);
LB Describe is also unnamed and never called; an XFF no-op still
needs that Describe on every opted-in backend SUCCESS. A-006 stays
discarded.
