# Research loop state

```yaml
started_at: 2026-09-11T17:03:00Z
owner: cursor-cloud bc-658f6e8c-e6a2-4e2e-99d4-8bee7362c95b
branch: cursor/research-loop-c95b
coding_unlocked: true
briefing_ready: true
initialization_complete: true
cycles_completed: 95
target_cycles: 7
stop_after: 2026-09-12T06:00:00Z
next_cycle: 96
focus: architecture-sdlc-modular-monolith
next_focus_hint: |
  Cycle 95: MCP_SESSION_STORE unset in this tree; default memory.
  Cycle 96: cheapest remaining. Candidate: socialPosts MinSize=1
  vs eb-deploy ASG hook. Do not un-ready Q-001 / Q-014 / Q-003.
  Do not revive A-006. If stop_after passes, unsubscribe
  agentweb-research-cycle.
timer_name: agentweb-research-cycle
product_queue_frozen: true
```

## Stop conditions

Timer may stop when now > `stop_after`. Do not unset `briefing_ready`.
Do not set `coding_unlocked` unless Kevin asks to code.
Do not un-ready Q-001 / Q-014 / Q-003 without a falsifying citation.
