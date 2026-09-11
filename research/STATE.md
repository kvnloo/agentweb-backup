# Research loop state

```yaml
started_at: 2026-09-11T17:03:00Z
owner: cursor-cloud bc-658f6e8c-e6a2-4e2e-99d4-8bee7362c95b
branch: cursor/research-loop-c95b
coding_unlocked: false
briefing_ready: true
initialization_complete: true
cycles_completed: 15
target_cycles: 7
stop_after: 2026-09-11T20:15:00Z
next_cycle: 16
focus: collision-refresh-until-stop_after
next_focus_hint: |
  Cycle 15: no open PR on apiTools.ts or imageGeneration.ts.
  Repeat the file-filter collision check. Do not rewrite QUEUE.md
  unless a new PR hits those paths. If stop_after passes, unsubscribe
  agentweb-research-cycle.
timer_name: agentweb-research-cycle
```

## Stop conditions

Timer may stop when now > `stop_after`. Do not unset `briefing_ready`.
Do not set `coding_unlocked` unless Kevin asks to code.
