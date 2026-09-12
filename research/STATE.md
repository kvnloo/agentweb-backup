# Research loop state

```yaml
started_at: 2026-09-11T17:03:00Z
owner: cursor-cloud bc-658f6e8c-e6a2-4e2e-99d4-8bee7362c95b
branch: cursor/research-loop-c95b
coding_unlocked: true
briefing_ready: true
initialization_complete: true
cycles_completed: 235
target_cycles: 7
stop_after: 2026-09-12T06:00:00Z
next_cycle: 236
focus: architecture-sdlc-modular-monolith
next_focus_hint: |
  Cycle 235: A-019 POST /mcp 503 is a
  one-shot in this tree. Q-001 fixture
  asserts 200. SDK send() throws
  StreamableHTTPError; only 401
  recurses. mcpClientService retries
  browser tools only. Cycle 236:
  after HTTP 503, does the client keep
  transport.sessionId so a later
  tools/call can rehydrate on the new
  instance (ENG-114)? send() sets
  _sessionId from the header before
  !ok. Do not sessions.clear() on the
  503 path. Do not add A-021. Do not
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
order. Cycle 230–235: A-019 503 is color, not Wait replace; dying
5xx does not fail new Immutable; Sunday refresh is Immutable; missing
Wait still disableCron; Hermes sees 503 while `/health` is 200; that
503 is a one-shot in this tree. A-006 stays discarded.
