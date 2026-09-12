# Research loop state

```yaml
started_at: 2026-09-11T17:03:00Z
owner: cursor-cloud bc-658f6e8c-e6a2-4e2e-99d4-8bee7362c95b
branch: cursor/research-loop-c95b
coding_unlocked: true
briefing_ready: true
initialization_complete: true
cycles_completed: 239
target_cycles: 7
stop_after: 2026-09-12T06:00:00Z
next_cycle: 240
focus: architecture-sdlc-modular-monolith
next_focus_hint: |
  Cycle 239: ALB passes Application 503
  through. Zero listener rules. AWS 502
  is TCP RST / malformed / target gone,
  not a rewrite. Do not add listener
  rules. Cycle 240: app.ts L169-176
  names two ALB attributes (xff mode
  append; xff_client_port disabled) that
  are not in git. Same class as cycle 119
  unnamed nginx.conf. Does A-019 need to
  pin those, or is that ENG-493 / later
  ops (not A-019)? Do not add aws:elbv2:
  next to .platform (ENG-836). Do not
  503 /health. Do not add A-021. Do not
  un-ready Q-001 / Q-014 / Q-003. Do not
  revive A-006. stop_after has passed;
  leave briefing_ready. Do not mint a
  timer unless Kevin asks.
timer_name: agentweb-research-cycle
product_queue_frozen: false
```

## Stop conditions

Timer may stop when now > `stop_after`. Do not unset `briefing_ready`.
Do not set `coding_unlocked` unless Kevin asks to code.
Do not un-ready Q-001 / Q-014 / Q-003 without a falsifying citation.
Kevin asked 2026-09-12 to reprioritize — ranks may change; ready status
of those three does not. Cycle 228–229: Linear dump did not invert
order. Cycle 230–239: A-019 503 is color; dying 5xx does not fail new
Immutable; Sunday is Immutable; missing Wait still disableCron; Hermes
sees 503 while `/health` is 200; that 503 is a one-shot; 503 does not
poison `sessionId`; JSON 503 is enough for `send()`; this tree cannot
rewrite it; ALB passes Application 503 through (does not rewrite to
502). A-006 stays discarded.
