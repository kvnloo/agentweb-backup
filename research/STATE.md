# Research loop state

```yaml
started_at: 2026-09-11T17:03:00Z
owner: cursor-cloud bc-658f6e8c-e6a2-4e2e-99d4-8bee7362c95b
branch: cursor/research-loop-c95b
coding_unlocked: false
briefing_ready: true
cycles_completed: 9
target_cycles: 7
stop_after: 2026-09-11T20:15:00Z
next_cycle: 10
focus: optional-refine-until-stop_after
next_focus_hint: |
  briefing_ready is true. Implementation order remains Q-001, Q-014,
  Q-003. Hygiene READY: Q-006, Q-015. Do not un-ready those without a
  new citation. Optional until 20:15 UTC: Q-007 Remotion compositions
  vs hyperframes (file-level), or Q-004 post_on_account brief. If
  stop_after passes, unsubscribe agentweb-research-cycle.
timer_name: agentweb-research-cycle
```

## Stop conditions

Timer may stop when now > `stop_after`. Do not unset `briefing_ready`.
Do not set `coding_unlocked` unless Kevin asks to code.
