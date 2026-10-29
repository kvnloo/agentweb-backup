## ENG-2740: Drop unwired retargeting_audience_added engagement signal (2026-10-29)

- Removed `retargeting_audience_added` from `EngagementSignalName` (backend/src/services/serverSignalEmitter.ts); no platform hook adds AgentWeb's own users to a retargeting audience. No call sites, no schema/data change.
- Re-add with one fire-and-forget emit + mocked test when a platform-owned retargeting audience sync ships.
