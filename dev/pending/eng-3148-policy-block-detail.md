## ENG-3148: Policy-blocked tool errors carry gate detail (2026-11-22)

`toolResultError` now appends a blocked result's `formattedContent` (e.g. set_work_plan_status naming the missing calls per step) to the model-visible error. Prod session e68025bf burned 13/40 steps on blind set_work_plan_status retries and hit the iteration limit. iterationLimitStopResult semantics unchanged.
