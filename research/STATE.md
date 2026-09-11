# Research loop state

```yaml
started_at: 2026-09-11T17:03:00Z
owner: cursor-cloud bc-658f6e8c-e6a2-4e2e-99d4-8bee7362c95b
branch: cursor/research-loop-c95b
coding_unlocked: false
briefing_ready: true
cycles_completed: 13
target_cycles: 7
stop_after: 2026-09-11T20:15:00Z
next_cycle: 14
focus: optional-refine-until-stop_after
next_focus_hint: |
  Drift check passed. Q-001 in-repo runbook is already written.
  Remaining optional until 20:15: another collision refresh if
  AgentWebPro/agentweb opens a PR that touches apiTools.ts or
  imageGeneration.ts. If stop_after passes, unsubscribe
  agentweb-research-cycle.
timer_name: agentweb-research-cycle
```

## Stop conditions

Timer may stop when now > `stop_after`. Do not unset `briefing_ready`.
Do not set `coding_unlocked` unless Kevin asks to code.
