# Research loop state

```yaml
started_at: 2026-09-11T17:03:00Z
owner: cursor-cloud bc-658f6e8c-e6a2-4e2e-99d4-8bee7362c95b
branch: cursor/research-loop-c95b
coding_unlocked: true
briefing_ready: true
initialization_complete: true
cycles_completed: 248
target_cycles: 7
stop_after: 2026-09-12T06:00:00Z
next_cycle: 249
focus: architecture-sdlc-modular-monolith
next_focus_hint: |
  Cycle 248: a later XFF pin can fail
  closed before update-environment (hook
  slot L655). Copying ENG-823 after-verify
  is a choice that makes IAM miss
  prod-green. Cycle 249: Sunday never
  calls eb-deploy.sh (cycle 110), so
  neither slot runs weekly. Does
  fail-closed-before-apply only help
  GitHub merges, leaving Sunday console
  XFF drift in the IdleTimeout class
  (cycle 242)? Do not un-park A-020 for
  a weekly XFF pin. Do not add that pin
  from A-019. Do not 503 /health. Do not
  add A-021. Do not un-ready Q-001 /
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
order. Cycle 230–248: A-019 503 is color; dying 5xx does not fail new
Immutable; Sunday is Immutable; missing Wait still disableCron; Hermes
sees 503 while `/health` is 200; that 503 is a one-shot; 503 does not
poison `sessionId`; JSON 503 is enough for `send()`; this tree cannot
rewrite it; ALB passes Application 503 through (does not rewrite to
502); A-019 does not pin ALB XFF attributes (ENG-493); an XFF pin is
`modify-load-balancer-attributes` on the LB ARN, not A-019 or A-020;
that ARN stays across Immutable and Sunday; that pin is the only
in-tree reassert without recreate; deploy IAM does not list the grant;
an XFF no-op still needs LB Describe; after-verify IAM miss is
GitHub-red / prod-green; a later pin **can** fail closed before apply
(hook slot). A-006 stays discarded.
