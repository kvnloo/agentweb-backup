## ENG-2748: DST-safe wall-clock + IANA zone -> zoned publishAt resolver (2026-10-29)

Added `resolveScheduledPublishAt` (backend/src/services/scheduledPosts): converts a local time + IANA zone to the ISO-with-offset string `validateScheduledPostRequest` accepts. Spring-forward gaps -> LOCAL_TIME_NONEXISTENT; fall-back overlaps resolve to the earlier instant. Pure, Intl-only, not yet wired to any tool.
