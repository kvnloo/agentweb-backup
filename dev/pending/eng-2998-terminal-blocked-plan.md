## ENG-2998: Stop unattended retries when every remaining plan step is blocked (2026-11-14)

The reported Luma run exhausted 20 attempts despite all three work-plan steps being blocked by an unavailable prerequisite (`no_key`). Scheduled verification now stops with failure when a plan contains blocked steps and no pending/in-progress step remains. The failure alert retains blocked step titles and notes. Completed/skipped plans and pending/deferred retries keep their existing paths. The completion-gate continuation uses the same check.

No customer credentials, schedules, persistence models, or outbound actions were changed. Offline regression evidence: three fixtures fail at 20 worker calls on the old code and stop at one call on the fix. Scheduler/automatic-continuation/failure-reason suites pass; typecheck passes. Deployment and live-model parity remain unverified.
