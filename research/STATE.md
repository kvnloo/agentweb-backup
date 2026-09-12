# Research loop state

```yaml
started_at: 2026-09-11T17:03:00Z
owner: cursor-cloud bc-658f6e8c-e6a2-4e2e-99d4-8bee7362c95b
branch: cursor/research-loop-c95b
coding_unlocked: true
briefing_ready: true
initialization_complete: true
cycles_completed: 220
target_cycles: 7
stop_after: 2026-09-12T06:00:00Z
next_cycle: 221
focus: architecture-sdlc-modular-monolith
next_focus_hint: |
  Cycle 220: 60s is client
  Protocol.request(), not inbound
  CallTool. mcpClientService 3600000
  is AgentWeb as client. Q-001
  fixture is httpx; Hermes 315s is
  OAuth add. Default SDK callTool
  would abandon generate_image at
  60s while the leaf bills.
  Cycle 221: cancel() on that 60s
  sends notifications/cancelled
  which aborts extra.signal.
  AgentWeb ignores extra. File-level
  only: does that notification ride
  the same POST SSE already waiting
  for send(), or a new POST, and
  can it land after mcpShutdown
  close()? Do not add A-021. Do
  not start another S3/Referer
  matcher. Do not un-ready Q-001 /
  Q-014 / Q-003. Do not revive
  A-006. If stop_after passes,
  unsubscribe agentweb-research-cycle.
timer_name: agentweb-research-cycle
product_queue_frozen: false
```

## Stop conditions

Timer may stop when now > `stop_after`. Do not unset `briefing_ready`.
Do not set `coding_unlocked` unless Kevin asks to code.
Do not un-ready Q-001 / Q-014 / Q-003 without a falsifying citation.
Kevin asked 2026-09-12 to reprioritize — ranks may change; ready status
of those three does not.
