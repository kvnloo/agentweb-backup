## ENG-2821: Pure monthly allowance threshold-crossing evaluator (2026-11-05)

`backend/src/services/allowanceThresholds.ts` adds `evaluateAllowanceThresholds`, returning the
allowance thresholds (default 75%/90%) newly crossed this billing month given the ones already
fired. Dark: no persistence, notifications, or copy; not wired. Those stay with ENG-2812.
