# Research loop state

```yaml
started_at: 2026-09-11T17:03:00Z
owner: cursor-cloud bc-658f6e8c-e6a2-4e2e-99d4-8bee7362c95b
branch: cursor/research-loop-c95b
coding_unlocked: true
briefing_ready: true
initialization_complete: true
cycles_completed: 217
target_cycles: 7
stop_after: 2026-09-12T06:00:00Z
next_cycle: 218
focus: architecture-sdlc-modular-monolith
next_focus_hint: |
  Cycle 217: mcpShutdown never
  cancels generate_image. _onclose
  does not abort; CallTool ignores
  extra; mcpFetch AbortController
  is timeout-only. A-019 wait is
  the billed hop.
  Cycle 218: after local close()
  mid-CallTool, send() still runs
  (signal not aborted). close()
  clears _streamMapping not
  _requestToStreamMapping so send
  throws No connection established
  (L672-694). File-level only: is
  that throw inside Protocol
  (Hermes hang) or mcpServerCore
  isError after the leaf billed?
  Do not add A-021. Do not start
  another S3/Referer matcher. Do
  not un-ready Q-001 / Q-014 /
  Q-003. Do not revive A-006. If
  stop_after passes, unsubscribe
  agentweb-research-cycle.
timer_name: agentweb-research-cycle
product_queue_frozen: false
```

## Stop conditions

Timer may stop when now > `stop_after`. Do not unset `briefing_ready`.
Do not set `coding_unlocked` unless Kevin asks to code.
Do not un-ready Q-001 / Q-014 / Q-003 without a falsifying citation.
Kevin asked 2026-09-12 to reprioritize — ranks may change; ready status
of those three does not.
