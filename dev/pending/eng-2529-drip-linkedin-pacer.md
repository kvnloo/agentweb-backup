## ENG-2529: Drip-sequence LinkedIn sends go through paceLinkedInWrite (2026-10-17)

- `dripSequenceWorker` now calls the shared LinkedIn write gate (daily volume cap + hourly pacer) before every LinkedIn send. Shared-pool accounts the owner does not hold are still held to the hourly pacer.
- A refusal defers the enrollment (snooze to UTC midnight for the daily cap, 30 min for the pacer) without sending, failing, or advancing, and logs the gate + reason.
- Account selection (pool fallback) unchanged; stays with ENG-1759/ENG-2347.
