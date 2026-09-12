# Research loop state

```yaml
started_at: 2026-09-11T17:03:00Z
owner: cursor-cloud bc-658f6e8c-e6a2-4e2e-99d4-8bee7362c95b
branch: cursor/research-loop-c95b
coding_unlocked: true
briefing_ready: true
initialization_complete: true
cycles_completed: 234
target_cycles: 7
stop_after: 2026-09-12T06:00:00Z
next_cycle: 235
focus: architecture-sdlc-modular-monolith
next_focus_hint: |
  Cycle 234: Hermes can see A-019 503
  while /health stays 200. Nginx 502
  is after server.close. 600s
  DeregistrationDelay starts at
  deregister, not disableCron. Cycle
  235: does any in-repo Hermes/MCP SDK
  client retry POST /mcp HTTP 503 onto
  the new instance, or is it a one-shot
  fail (cycle 220: Q-001 fixture is
  httpx)? Do not copy 3600000. Do not
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
order. Cycle 230–234: A-019 503 is color, not Wait replace; dying
5xx does not fail new Immutable; Sunday refresh is Immutable; missing
Wait still disableCron; Hermes sees 503 while `/health` is 200. A-006
stays discarded.
