## ENG-2533: Pure drip send-quota + warmup throttle decision (2026-10-18)

Added `backend/src/services/dripSequenceSendQuota.ts`: pure `decideDripSend` (daily_cap / warmup_cap / invalid_config fail-closed, retryAt = next UTC day). Not yet wired into dripSequenceWorker.
