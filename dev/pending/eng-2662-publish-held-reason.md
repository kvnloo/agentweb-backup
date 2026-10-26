## ENG-2662: Name the withheld publish tool in held-for-approval scheduled-run failures (2026-10-24)

`describeScheduledRunFailureReasons` now reports which publish tool the model withheld and after how many attempts, and points at the schedule's unattended-publish authorization. The ENG-947 press budget is unchanged: re-pressing cannot make a model publish. The text is description-only (no dedupe key).
