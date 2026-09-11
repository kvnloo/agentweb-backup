# Research loop state

```yaml
started_at: 2026-09-11T17:03:00Z
owner: cursor-cloud bc-658f6e8c-e6a2-4e2e-99d4-8bee7362c95b
branch: cursor/research-loop-c95b
coding_unlocked: false
briefing_ready: true
cycles_completed: 8
target_cycles: 7
stop_after: 2026-09-11T20:15:00Z
next_cycle: 9
focus: optional-refine-until-stop_after
next_focus_hint: |
  briefing_ready is true. READY is Q-001, Q-014, Q-003 (implementation
  order, not score). Do not un-ready those without a new citation.
  ENG-381 ownership still unconfirmable from this clone. Optional until
  20:15 UTC: Q-006/Q-015 MCP hide sketches, or Comfy/Remotion only if
  a new file-level fact appears. If stop_after passes, unsubscribe
  agentweb-research-cycle.
timer_name: agentweb-research-cycle
```

## Stop conditions

Timer may stop when now > `stop_after`. Do not unset `briefing_ready`.
Do not set `coding_unlocked` unless Kevin asks to code.
