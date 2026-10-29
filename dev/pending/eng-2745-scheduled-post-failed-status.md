## ENG-2745: Scheduled post list renders failed posts (2026-10-29)

formatScheduledPostList now imports the single ScheduledPostStatus from scheduledPostLifecycle and renders failed posts (always visible) in a trailing "Failed" group with platform and last-error preview. Pure formatter; no persistence/scheduler wiring.
