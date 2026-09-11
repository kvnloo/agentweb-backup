# Research loop state

```yaml
started_at: 2026-09-11T17:03:00Z
owner: cursor-cloud bc-658f6e8c-e6a2-4e2e-99d4-8bee7362c95b
branch: cursor/research-loop-c95b
coding_unlocked: false
briefing_ready: false
cycles_completed: 5
target_cycles: 7
stop_after: 2026-09-11T20:15:00Z
next_cycle: 6
focus: architecture-teach-in
next_focus_hint: |
  Cycle 6: rewrite ARCHITECTURE.md as a teach-in Kevin can read (three
  runtimes, two tool registries, three browser stacks, money/models).
  Q-001 and Q-014 already have READY briefs.
  Cycle 7: freeze queue, set briefing_ready true, stop timer.
timer_name: agentweb-research-cycle
```

## Stop conditions

Stop the recurring timer when **any** of:

- `cycles_completed >= target_cycles`
- now > `stop_after`
- user says start coding
- a cycle finds we should not contribute (record DISCARD-all and brief anyway)

Then: update PR, write the architecture teach-in into `ARCHITECTURE.md`,
and message Kevin with how to help (no more research for its own sake).
