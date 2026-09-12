# Research loop state

```yaml
started_at: 2026-09-11T17:03:00Z
owner: cursor-cloud bc-658f6e8c-e6a2-4e2e-99d4-8bee7362c95b
branch: cursor/research-loop-c95b
coding_unlocked: true
briefing_ready: true
initialization_complete: true
cycles_completed: 232
target_cycles: 7
stop_after: 2026-09-12T06:00:00Z
next_cycle: 233
focus: architecture-sdlc-modular-monolith
next_focus_hint: |
  Cycle 232: Sunday InstanceRefreshEnabled
  is weekly Immutable (AWS), not rolling.
  L4-6 comment is stale. Zero rolling-
  update namespace in git. Dying 5xx
  cannot fail the new weekly instances
  (same as 231). Cycle 233: if the hook
  is missing on Sunday (A-020), does
  A-019 still 503 via SIGTERM
  gracefulShutdown (cycle 115 / 213)
  so 5xx happens without Wait? Do not
  add .platform systemd. Do not restore
  07-termination-lifecycle.config
  (ENG-818). Do not add A-021. Do not
  un-ready Q-001 / Q-014 / Q-003. Do
  not revive A-006. stop_after has
  passed; leave briefing_ready. Do not
  mint a timer unless Kevin asks.
timer_name: agentweb-research-cycle
product_queue_frozen: false
```

## Stop conditions

Timer may stop when now > `stop_after`. Do not unset `briefing_ready`.
Do not set `coding_unlocked` unless Kevin asks to code.
Do not un-ready Q-001 / Q-014 / Q-003 without a falsifying citation.
Kevin asked 2026-09-12 to reprioritize — ranks may change; ready status
of those three does not. Cycle 228–229: Linear dump did not invert
order. Cycle 230: A-019 503 is not a Wait replace. Cycle 231: dying
5xx does not fail the new Immutable instance. Cycle 232: Sunday
`InstanceRefreshEnabled` is weekly Immutable, not rolling. A-006
stays discarded.
