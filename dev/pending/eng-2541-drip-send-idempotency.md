## ENG-2541: Pure drip-step send idempotency key + duplicate-send guard (2026-10-19)

Added `backend/src/services/dripSendIdempotency.ts`: sha256-based header-safe idempotency key per (org, sequence, enrollment, step, attemptEpoch) and a pure `decideDuplicateSend` (sent -> already_sent, fresh queued -> in_flight, stale queued/failed -> retry). Not wired into the worker yet (ENG-2167 slice).
